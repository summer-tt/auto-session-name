import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { useConfigFixture } from "./config-fixture.mjs";

const testDirectory = fileURLToPath(new URL("./", import.meta.url));
const extensionURL = new URL("../auto-session-name.ts", import.meta.url).href;
const fixtureURL = new URL("./config-fixture.mjs", import.meta.url).href;

// Node 22.22.2 strips the extension's TS natively. Keep pi-ai's real, local
// clampThinkingLevel; replace only getAgentDir and the extension's config I/O.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL === extensionURL &&
      (specifier === "@earendil-works/pi-coding-agent" || specifier === "node:fs")
    ) {
      return { url: fixtureURL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
let extension;
try {
  extension = (await import(extensionURL)).default;
} finally {
  hooks.deregister();
}

export function makeModel(id, inputCost) {
  return {
    id,
    name: id,
    provider: "fixture-provider",
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: inputCost, output: inputCost, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

export function responseWithTitle(title) {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "This must not become part of the title." },
      { type: "text", text: title },
    ],
    api: "openai-completions",
    provider: "fixture-provider",
    model: "cheap",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// Drain promises and let Node observe any unhandled rejection. setImmediate
// is real: only setTimeout is frozen by each fixture.
export async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
}

export function createHarness(t, options = {}) {
  // Install before invoking the extension factory, not after registration.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const directory = mkdtempSync(join(testDirectory, ".tmp-agent-"));
  const config = {
    directory,
    path: join(directory, "auto-session-name.json"),
    reads: [],
    writes: [],
  };
  const releaseConfig = useConfigFixture(config);
  const cheapModel = makeModel("cheap", 0.1);
  const activeModel = makeModel("active", 2);
  const scopedModel = makeModel("scoped", 0.5);
  const models = [activeModel, scopedModel, cheapModel];
  const calls = [];
  const generatedNames = [];
  const setNameAttempts = [];
  const warnings = [];
  const unhandledRejections = [];
  const fetchCalls = [];
  const runtimes = [];
  const registryCalls = { find: [], hasConfiguredAuth: [], getAvailable: [] };
  let nextSession = 0;

  t.mock.method(console, "warn", (...args) => warnings.push(args));
  t.mock.method(globalThis, "fetch", (...args) => {
    fetchCalls.push(args);
    throw new Error("Network calls are forbidden in naming tests");
  });
  const onUnhandledRejection = (reason) => unhandledRejections.push(reason);
  process.on("unhandledRejection", onUnhandledRejection);

  const registry = {
    find(provider, id) {
      registryCalls.find.push({ provider, id });
      return models.find((model) => model.provider === provider && model.id === id);
    },
    hasConfiguredAuth(model) {
      registryCalls.hasConfiguredAuth.push(model);
      return !(options.unauthenticatedModels ?? []).includes(model.id);
    },
    getAvailable() {
      registryCalls.getAvailable.push(true);
      return options.availableModels ?? models;
    },
    complete(model, context, requestOptions) {
      const deferred = Promise.withResolvers();
      const signal = requestOptions.signal;
      const call = {
        model, context, options: requestOptions, abortEvents: 0, settled: false,
        resolve(response) {
          if (call.settled) return;
          call.settled = true;
          signal?.removeEventListener("abort", onAbort);
          deferred.resolve(response);
        },
        reject(error) {
          if (call.settled) return;
          call.settled = true;
          signal?.removeEventListener("abort", onAbort);
          deferred.reject(error);
        },
      };
      function onAbort() {
        call.abortEvents += 1;
        if (options.rejectOnAbort) {
          call.reject(new DOMException("Naming request aborted", "AbortError"));
        }
      }
      signal?.addEventListener("abort", onAbort);
      calls.push(call);
      if (signal?.aborted) onAbort();
      // Do not attach a harness catch: an extension missing its own catch must
      // fail node:test's unhandled-rejection checks.
      return deferred.promise;
    },
  };

  function newSession(overrides = {}) {
    nextSession += 1;
    return {
      id: `fixture-session-${nextSession}`,
      file: join(directory, `session-${nextSession}.jsonl`),
      name: undefined,
      runActive: false,
      agentEndCount: 0,
      turnController: new AbortController(),
      ...overrides,
    };
  }

  function installRuntime(session) {
    const runtime = {
      active: true, session, handlers: new Map(), registrations: [], metadataEvents: [], staleAccesses: [],
    };
    function assertRuntimeActive(operation) {
      // Pi 1.2.0 guards both name reads and writes, as well as registrations.
      if (!runtime.active) {
        runtime.staleAccesses.push(operation);
        throw new Error("Extension runtime is no longer active");
      }
    }
    const pi = {
      on(type, handler) {
        assertRuntimeActive("on");
        const handlers = runtime.handlers.get(type) ?? new Set();
        runtime.handlers.set(type, handlers);
        handlers.add(handler);
        const registration = { type, handler, removed: false };
        runtime.registrations.push(registration);
        return () => {
          registration.removed = true;
          handlers.delete(handler);
        };
      },
      getSessionName() {
        assertRuntimeActive("getSessionName");
        return runtime.session.name;
      },
      setSessionName(title) {
        setNameAttempts.push({ runtime, title });
        assertRuntimeActive("setSessionName");
        runtime.session.name = title;
        generatedNames.push({ sessionId: runtime.session.id, title });
        dispatchMetadata(runtime, title);
      },
    };
    runtime.pi = pi;
    runtimes.push(runtime);
    extension(pi);
    return runtime;
  }

  function context(runtime) {
    const session = runtime.session;
    return {
      mode: options.mode ?? "tui",
      model: activeModel,
      modelRegistry: registry,
      scopedModels: options.scopedModels ?? [],
      sessionManager: {
        getSessionFile: () => session.file,
        getSessionId: () => session.id,
      },
      signal: session.turnController.signal,
      isIdle: () => !session.runActive,
    };
  }

  function dispatch(runtime, type, event, ctx = context(runtime)) {
    // Snapshot registrations, matching Pi's unsubscribe-during-dispatch rule.
    return [...(runtime.handlers.get(type) ?? [])].map((handler) =>
      handler({ ...event, type }, ctx),
    );
  }

  function dispatchMetadata(runtime, name) {
    runtime.metadataEvents.push(name);
    const results = dispatch(runtime, "session_info_changed", { name });
    assert.ok(results.every((result) => !result?.then), "naming metadata listeners are synchronous");
  }

  const h = {
    config, calls, generatedNames, setNameAttempts, warnings, unhandledRejections,
    registryCalls, cheapModel, activeModel, scopedModel, runtimes,
    runtime: installRuntime(newSession({ name: options.name })),
    get session() { return h.runtime.session; },
    get ctx() { return context(h.runtime); },
    seedConfig(value) {
      writeFileSync(config.path, typeof value === "string" ? value : JSON.stringify(value));
    },
    readSavedConfig() { return JSON.parse(readFileSync(config.path, "utf8")); },
    listenerCount(type = "session_info_changed", runtime = h.runtime) {
      return runtime.handlers.get(type)?.size ?? 0;
    },
    dispatchUser(prompt = "Investigate cache refresh scheduling", ctx = h.ctx) {
      return dispatch(h.runtime, "before_agent_start", {
        messageType: "user", prompt, systemPrompt: "fixture system", systemPromptOptions: {},
      }, ctx);
    },
    async startUser(prompt, ctx) {
      for (const result of h.dispatchUser(prompt, ctx)) await result;
    },
    async emit(type, event = {}, ctx = h.ctx) {
      for (const result of dispatch(h.runtime, type, event, ctx)) await result;
    },
    async beginRun() {
      h.session.runActive = true;
      await h.emit("agent_start");
    },
    async endRun(outcome = "stop") {
      h.session.runActive = false;
      h.session.agentEndCount += 1;
      if (outcome === "aborted") h.session.turnController.abort();
      await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: outcome }] });
    },
    setManualName(title, { emit = true } = {}) {
      h.session.name = title;
      if (emit) dispatchMetadata(h.runtime, title);
    },
    async resetSession(reason, { replaceRuntime = false } = {}) {
      const previousRuntime = h.runtime;
      const previousSessionFile = h.session.file;
      if (replaceRuntime) {
        previousRuntime.active = false;
        previousRuntime.handlers.clear();
        h.runtime = installRuntime(newSession());
      } else {
        // Exercise the explicit session_start reset in the same factory.
        h.runtime.session = newSession();
      }
      await h.emit("session_start", { reason, previousSessionFile });
      return previousRuntime;
    },
    async advanceTimers() {
      t.mock.timers.tick(0);
      await flushAsyncWork();
    },
    async resolveTitle(title, index = calls.length - 1) {
      assert.ok(calls[index], "a naming request must have been dispatched");
      calls[index].resolve(responseWithTitle(title));
      await flushAsyncWork();
    },
  };

  t.after(async () => {
    // Resolve leftovers without attaching a rejection handler or starting any
    // queued timer, then restore globals and delete only this test's directory.
    for (const call of calls) call.resolve(responseWithTitle(""));
    await flushAsyncWork();
    process.off("unhandledRejection", onUnhandledRejection);
    t.mock.timers.reset();
    releaseConfig();
    rmSync(directory, { recursive: true, force: true });
    assert.equal(fetchCalls.length, 0, "no model request may reach the network");
    assert.deepEqual(unhandledRejections, [], "no naming rejection may escape");
  });
  return h;
}
