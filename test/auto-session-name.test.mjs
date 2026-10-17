import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, flushAsyncWork, responseWithTitle } from "./harness.mjs";

// Test numbers track PROPOSAL.md's Test plan. Fixtures mutate global timers and
// a module-import seam, so keep the suite serial (including awaited subtests).
const serial = { concurrency: false, timeout: 5000 };

function assertNoNaming(h) {
  assert.equal(h.calls.length, 0);
  assert.equal(h.config.reads.length, 0);
  assert.equal(h.config.writes.length, 0);
  assert.deepEqual(h.generatedNames, []);
  assert.deepEqual(h.setNameAttempts, []);
}

async function dispatchNaming(h) {
  await h.startUser();
  await h.advanceTimers();
  assert.equal(h.calls.length, 1, "first eligible run must dispatch one naming request");
  return h.calls[0];
}

function assertListenerRemoved(h, runtime = h.runtime) {
  assert.equal(h.listenerCount("session_info_changed", runtime), 0);
  for (const registration of runtime.registrations.filter((r) => r.type === "session_info_changed")) {
    assert.equal(registration.removed, true, "listener must be explicitly unsubscribed");
  }
}

test("1. first eligible user run makes exactly one naming call and applies its title", serial, async (t) => {
  const h = createHarness(t);
  h.seedConfig({ provider: h.cheapModel.provider, model: h.cheapModel.id, temperature: 0.2 });
  const prompt = "Investigate cache refresh scheduling";
  await h.startUser(prompt);
  await h.startUser("Duplicate before the timer runs");
  await h.advanceTimers();

  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.model, h.cheapModel);
  assert.deepEqual(h.registryCalls.find, [{ provider: h.cheapModel.provider, id: h.cheapModel.id }]);
  assert.deepEqual(h.registryCalls.hasConfiguredAuth, [h.cheapModel]);
  assert.equal(call.options.temperature, 0.2);
  assert.equal(call.options.sessionId, h.session.id);
  assert.ok(call.options.signal instanceof AbortSignal);
  assert.equal(call.context.messages.length, 1);
  assert.equal(call.context.messages[0].role, "user");
  assert.ok(call.context.messages[0].content[0].text.includes(`"${prompt}"`));
  assert.equal(h.session.name, undefined, "the deferred completion has not resolved");

  await h.resolveTitle('"**Investigate cache refresh scheduling**"');
  assert.equal(h.session.name, "Investigate cache refresh scheduling");
  assert.equal(h.generatedNames.length, 1);
  await h.startUser("A later turn must not rename the session");
  await h.advanceTimers();
  assert.equal(h.calls.length, 1);
  assert.equal(h.config.reads.length, 1);
  assert.equal(h.config.writes.length, 0);
  assertListenerRemoved(h);
});

test("2. the title is applied while a long first run is still active", serial, async (t) => {
  const h = createHarness(t);
  // Awaiting before_agent_start must not await the provider's deferred response.
  await h.startUser();
  await h.beginRun();
  await h.advanceTimers();
  assert.equal(h.session.runActive, true);
  assert.equal(h.session.agentEndCount, 0);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].settled, false);
  assert.equal(h.calls[0].model, h.cheapModel, "unconfigured naming uses the cheapest available model");
  assert.equal(h.registryCalls.getAvailable.length, 1);

  await h.resolveTitle("Debug cache refresh behavior");
  assert.equal(h.session.name, "Debug cache refresh behavior");
  assert.equal(h.session.runActive, true, "the main run has not finished");
  assert.equal(h.session.agentEndCount, 0, "no agent_end was needed to apply the title");
  await h.endRun();
  await h.advanceTimers();
  assert.equal(h.calls.length, 1, "agent_end must not dispatch another request");
});

test("3. the recheck preserves a manual name even when the abort notification is missed", serial, async (t) => {
  const h = createHarness(t);
  const call = await dispatchNaming(h);
  assert.equal(h.listenerCount(), 1);
  // Deliberately omit session_info_changed to exercise change 3 independently
  // of the AbortController mitigation.
  h.setManualName("Owner chosen title", { emit: false });
  await h.resolveTitle("An unwanted generated title");
  assert.equal(call.options.signal.aborted, false);
  assert.equal(h.session.name, "Owner chosen title");
  assert.deepEqual(h.setNameAttempts, []);
  assertListenerRemoved(h);
});

test("4. /new and /fork reset the guard; completions through stale handles are caught", serial, async (t) => {
  for (const reason of ["new", "fork"]) {
    await t.test(`${reason}: session_start resets the guard in the same factory`, serial, async (t) => {
      const h = createHarness(t);
      await dispatchNaming(h);
      await h.resolveTitle("");
      await h.startUser("No retry before a fresh session");
      await h.advanceTimers();
      assert.equal(h.calls.length, 1);
      const runtime = h.runtime;
      const firstSessionId = h.session.id;
      await h.resetSession(reason);
      assert.equal(h.runtime, runtime, "do not hide a missing reset by reloading the factory");
      assert.notEqual(h.session.id, firstSessionId);
      await h.startUser("The fresh session needs a title");
      await h.advanceTimers();
      assert.equal(h.calls.length, 2);
      assert.equal(h.calls[1].options.sessionId, h.session.id);
      await h.resolveTitle("Fresh session generated title");
      assert.equal(h.session.name, "Fresh session generated title");
    });

    await t.test(`${reason}: runtime disposal rejects a late old-session write`, serial, async (t) => {
      const h = createHarness(t);
      await dispatchNaming(h);
      const oldRuntime = await h.resetSession(reason, { replaceRuntime: true });
      await h.startUser("A replacement runtime's first prompt");
      await h.advanceTimers();
      assert.equal(h.calls.length, 2);
      await h.resolveTitle("Stale response must be discarded", 0);
      assert.equal(h.session.name, undefined);
      assert.deepEqual(h.generatedNames, []);
      assert.equal(h.calls[0].options.signal.aborted, true, "session shutdown cancels old work");
      assert.deepEqual(oldRuntime.staleAccesses, [], "late response must not touch a disposed runtime");
      assert.deepEqual(h.setNameAttempts, [], "the stale API must throw before any title mutation");
      assert.equal(h.warnings.filter(([message]) => message.includes("failed to generate session name")).length, 0, "lifecycle cancellation is silent");
      await h.resolveTitle("Replacement session title", 1);
      assert.equal(h.session.name, "Replacement session title");
      assertListenerRemoved(h, oldRuntime);
      assertListenerRemoved(h);
    });
  }
});

test("5. custom runs and empty user prompts are skipped without consuming the user attempt", serial, async (t) => {
  const h = createHarness(t);
  await h.emit("before_agent_start", {
    messageType: "custom",
    message: { role: "custom", customType: "fixture", content: "Background notification", display: false },
  });
  // A truthy prompt must not make a custom event eligible either.
  await h.emit("before_agent_start", { messageType: "custom", prompt: "Still not user input" });
  await h.startUser("");
  await h.advanceTimers();
  assertNoNaming(h);
  assert.equal(h.ctx.isIdle(), true);
  await dispatchNaming(h);
  await h.resolveTitle("Later idle user prompt");
  assert.equal(h.session.name, "Later idle user prompt");
});

test("6. --no-session is skipped without consuming the persisted-session attempt", serial, async (t) => {
  const h = createHarness(t);
  const persistedFile = h.session.file;
  h.session.file = undefined;
  await h.startUser();
  await h.advanceTimers();
  assertNoNaming(h);
  h.session.file = persistedFile;
  await dispatchNaming(h);
  await h.resolveTitle("A persisted session title");
  assert.equal(h.session.name, "A persisted session title");
});

test("7. non-TUI modes are skipped", serial, async (t) => {
  for (const mode of ["print", "json", "rpc"]) {
    await t.test(mode, serial, async (t) => {
      const h = createHarness(t, { mode });
      await h.startUser();
      await h.advanceTimers();
      assertNoNaming(h);
      await h.startUser("A later interactive run", { ...h.ctx, mode: "tui" });
      await h.advanceTimers();
      assert.equal(h.calls.length, 1, "skipped modes must not set the one-attempt guard");
      await h.resolveTitle("Interactive session naming works");
    });
  }
});

test("8. an already-named session is never renamed", serial, async (t) => {
  for (const reason of ["startup", "resume", "reload"]) {
    await t.test(reason, serial, async (t) => {
      const h = createHarness(t, { name: "Existing explicit session name" });
      await h.emit("session_start", { reason });
      await h.startUser();
      await h.advanceTimers();
      await h.endRun();
      await h.advanceTimers();
      assertNoNaming(h);
      assert.equal(h.session.name, "Existing explicit session name");
      assertListenerRemoved(h);
    });
  }
});

test("9. an empty normalized title leaves the session unnamed with no retry", serial, async (t) => {
  for (const title of ["", " \n\t ", '\"**   **\"']) {
    await t.test(`output ${JSON.stringify(title)}`, serial, async (t) => {
      const h = createHarness(t);
      await dispatchNaming(h);
      await h.resolveTitle(title);
      assert.equal(h.session.name, undefined);
      assert.deepEqual(h.setNameAttempts, []);
      assertListenerRemoved(h);
      await h.endRun();
      await h.startUser("A second prompt must not retry naming");
      await h.advanceTimers();
      assert.equal(h.calls.length, 1);
      assert.equal(h.config.reads.length, 1);
    });
  }
});

test("10. config regeneration and repair run before the first turn errors or aborts", serial, async (t) => {
  for (const outcome of ["error", "aborted"]) {
    for (const variant of ["missing", "invalid JSON", "unusable model", "repair fields"]) {
      await t.test(`${variant}; turn ${outcome}`, serial, async (t) => {
        const h = createHarness(t, { scopedModels: [] });
        // The scope pool, not the cheaper global catalogue, determines regen.
        const ctx = { ...h.ctx, scopedModels: [{ model: h.scopedModel, thinkingLevel: "off" }] };
        if (variant === "invalid JSON") h.seedConfig("{ definitely not JSON");
        if (variant === "unusable model") h.seedConfig({ provider: "", model: "" });
        if (variant === "repair fields") {
          h.seedConfig({
            provider: h.activeModel.provider, model: h.activeModel.id,
            temperature: "hot", thinking: "not-a-thinking-level",
          });
        }
        await h.startUser("This first turn will fail", ctx);
        await h.beginRun();
        await h.advanceTimers();
        assert.equal(h.session.runActive, true);
        assert.equal(h.session.agentEndCount, 0);
        assert.equal(h.config.reads.length, 1);
        assert.equal(h.config.writes.length, 1);
        assert.equal(h.calls.length, 1);
        const expectedModel = variant === "repair fields" ? h.activeModel : h.scopedModel;
        assert.equal(h.calls[0].model, expectedModel);
        assert.deepEqual(h.readSavedConfig(), { provider: expectedModel.provider, model: expectedModel.id });
        assert.equal(h.calls[0].options.temperature, undefined);
        assert.equal(h.registryCalls.getAvailable.length, 0, "scoped selection must not consult the global pool");
        await h.endRun(outcome);
        if (outcome === "aborted") {
          assert.equal(ctx.signal.aborted, true);
          assert.equal(h.calls[0].options.signal.aborted, false, "naming is independent of the main turn signal");
        }
        await h.resolveTitle("Name despite first turn failure");
        assert.equal(h.session.name, "Name despite first turn failure");
        await h.startUser("Do not retry after the failure");
        await h.advanceTimers();
        assert.equal(h.calls.length, 1);
        assert.equal(h.config.writes.length, 1);
      });
    }
  }
});

test("11. all synchronous config I/O and completion dispatch stay behind the timer boundary", serial, async (t) => {
  const h = createHarness(t); // freezes global setTimeout before factory invocation
  // Invalid JSON makes both a read and a regeneration write observable.
  h.seedConfig("{ invalid JSON");
  const results = h.dispatchUser();
  assert.ok(results.every((result) => !result?.then), "before_agent_start must return synchronously");
  assert.equal(h.config.reads.length, 0, "config reads must wait for the timer");
  assert.equal(h.config.writes.length, 0, "config writes must wait for the timer");
  assert.equal(h.calls.length, 0, "complete must wait for the timer");
  await flushAsyncWork();
  assertNoNaming(h); // yielding promises/setImmediate must not advance setTimeout

  await h.advanceTimers();
  assert.equal(h.config.reads.length, 1);
  assert.equal(h.config.writes.length, 1);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].settled, false);
  await h.advanceTimers();
  assert.equal(h.calls.length, 1, "advancing again must not dispatch twice");
  await h.resolveTitle("Deferred synchronous prefix works");
  assert.equal(h.session.name, "Deferred synchronous prefix works");
});

test("12. accepted-cost trace keeps the manual title after exactly one dispatched request", serial, async (t) => {
  // This transport deliberately ignores abort and eventually resolves: abort is
  // best-effort, and the accepted one-call cost must remain visible in this test.
  const h = createHarness(t, { rejectOnAbort: false });
  await h.startUser();
  await h.beginRun();
  await h.advanceTimers();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].settled, false);
  h.setManualName("Manual name during first run");
  assert.equal(h.calls[0].options.signal.aborted, true);
  await h.resolveTitle("Late ignored provider response");
  assert.equal(h.session.name, "Manual name during first run");
  assert.deepEqual(h.setNameAttempts, []);
  assertListenerRemoved(h);
  await h.endRun();
  await h.startUser("A later turn");
  await h.advanceTimers();
  assert.equal(h.calls.length, 1, "the accepted regression costs one request, not zero or two");
});

test("13. abort mitigation handles rejected and resolved aborts and cleans up all naming listeners", serial, async (t) => {
  await t.test("metadata aborts once; expected rejection is silent and handled", serial, async (t) => {
    const h = createHarness(t, { rejectOnAbort: true });
    const call = await dispatchNaming(h);
    assert.equal(h.listenerCount(), 1);
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.options.signal.aborted, false);
    const warningCount = h.warnings.length;
    h.setManualName("Explicit naming aborts request");
    assert.equal(call.options.signal.aborted, true);
    assert.equal(call.abortEvents, 1);
    assert.equal(call.settled, true, "the deferred transport must actually reject on abort");
    assertListenerRemoved(h);
    await h.emit("session_info_changed", { name: "Another manual metadata update" });
    await flushAsyncWork();
    assert.equal(call.abortEvents, 1, "the abort listener is one-shot");
    assert.equal(h.warnings.length, warningCount, "an expected abort must not warn");
    assert.deepEqual(h.unhandledRejections, []);
    assert.deepEqual(h.setNameAttempts, []);
    assert.equal(h.session.name, "Explicit naming aborts request");
  });

  await t.test("metadata abort with a resolved partial response is silent and does not apply a title", serial, async (t) => {
    const h = createHarness(t);
    const call = await dispatchNaming(h);
    assert.equal(h.listenerCount(), 1);
    const warningCount = h.warnings.length;
    h.setManualName("Explicit title before partial response");
    assert.equal(call.options.signal.aborted, true);
    assert.equal(call.abortEvents, 1);
    assert.equal(call.settled, false, "transport resolves an aborted message rather than rejecting");
    const partialResponse = responseWithTitle("Partial generated title");
    partialResponse.stopReason = "aborted";
    call.resolve(partialResponse);
    await flushAsyncWork();
    assert.deepEqual(h.setNameAttempts, []);
    assert.equal(h.session.name, "Explicit title before partial response");
    assert.equal(h.warnings.length, warningCount, "a resolved abort must not warn");
    assertListenerRemoved(h);
  });

  await t.test("success detaches before setSessionName emits its own metadata event", serial, async (t) => {
    const h = createHarness(t);
    const call = await dispatchNaming(h);
    await h.resolveTitle("Successful naming listener cleanup");
    assert.deepEqual(h.runtime.metadataEvents, ["Successful naming listener cleanup"]);
    assert.equal(call.options.signal.aborted, false, "own metadata must not abort the successful request");
    assertListenerRemoved(h);
  });

  await t.test("a non-abort model failure is caught, warned, and detached without retry", serial, async (t) => {
    const h = createHarness(t);
    const call = await dispatchNaming(h);
    const error = new Error("Synthetic provider failure");
    call.reject(error);
    await flushAsyncWork();
    assert.ok(h.warnings.some(([message]) => message.includes("failed to generate session name") && message.includes("request exception")));
    assert.ok(h.warnings.every((args) => !args.includes(error)), "untrusted exceptions are not logged verbatim");
    assertListenerRemoved(h);
    assert.deepEqual(h.unhandledRejections, []);
    assert.deepEqual(h.setNameAttempts, []);
    await h.startUser("No retry on model failure");
    await h.advanceTimers();
    assert.equal(h.calls.length, 1);
  });

  for (const reason of ["new", "fork"]) {
    await t.test(`${reason}: an old pending listener cannot abort the next session's request`, serial, async (t) => {
      const h = createHarness(t, { rejectOnAbort: true });
      const previous = await dispatchNaming(h);
      const previousRegistration = h.runtime.registrations.find((r) => r.type === "session_info_changed");
      assert.equal(previousRegistration.removed, false);
      await h.resetSession(reason);
      assert.equal(previousRegistration.removed, true);
      assert.equal(h.listenerCount(), 0);
      await h.startUser("Fresh session request");
      await h.advanceTimers();
      assert.equal(h.calls.length, 2);
      assert.equal(h.listenerCount(), 1, "only the current naming attempt may retain a listener");
      const current = h.calls[1];
      h.setManualName("New session manual title");
      await flushAsyncWork();
      assert.equal(current.options.signal.aborted, true);
      assert.equal(current.abortEvents, 1);
      assert.equal(previous.options.signal.aborted, true, "shutdown already aborted the previous request");
      assert.equal(previous.abortEvents, 1, "new metadata cannot abort the previous request again");
      assertListenerRemoved(h);
      await h.resolveTitle("Previous request finally completes", 0);
      assert.equal(h.session.name, "New session manual title");
      assert.deepEqual(h.setNameAttempts, []);
    });
  }
});

test("config filename: only pi-auto-rename.json is read and written", serial, async (t) => {
  const activeConfig = {
    provider: "fixture-provider", model: "active", temperature: 0.2, thinking: "off",
  };
  const oldConfig = {
    provider: "fixture-provider", model: "scoped", temperature: 0.9,
  };
  const invalidOptions = {
    provider: "fixture-provider", model: "active",
    temperature: "hot", thinking: "invalid-level",
  };
  const defaultConfig = { provider: "fixture-provider", model: "cheap" };
  const repairedConfig = { provider: "fixture-provider", model: "active" };
  const cases = [
    {
      name: "valid new config", value: activeConfig, kind: "valid",
      expected: activeConfig,
    },
    {
      name: "no config files", kind: "regen", expected: defaultConfig,
    },
    {
      name: "invalid new JSON", value: "{ invalid JSON", kind: "regen",
      expected: defaultConfig, invalid: true,
    },
    {
      name: "invalid new options", value: invalidOptions, kind: "repair",
      expected: repairedConfig, invalid: true,
    },
    {
      name: "old config only", old: true, kind: "regen", expected: defaultConfig,
    },
    {
      name: "both files use new config", old: true, value: activeConfig,
      kind: "valid", expected: activeConfig,
    },
    {
      name: "invalid new JSON never falls back to old config", old: true,
      value: "{ invalid JSON", kind: "regen", expected: defaultConfig, invalid: true,
    },
    {
      name: "new options repair never changes old config", old: true,
      value: invalidOptions, kind: "repair", expected: repairedConfig, invalid: true,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, serial, async (t) => {
      const h = createHarness(t);
      const newPath = join(h.config.directory, "pi-auto-rename.json");
      const oldPath = join(h.config.directory, "auto-session-name.json");
      const oldBytes = Buffer.from(`${JSON.stringify(oldConfig, null, 2)}\n`);
      assert.equal(h.config.path, newPath);
      if (scenario.old) writeFileSync(oldPath, oldBytes);
      if (scenario.value !== undefined) h.seedConfig(scenario.value);
      const beforeNew = existsSync(newPath) ? readFileSync(newPath) : undefined;

      await h.startUser("Verify the renamed configuration path");
      assertNoNaming(h);
      await h.advanceTimers();

      assert.equal(h.calls.length, 1);
      const expectedModel = scenario.expected.model === "active" ? h.activeModel : h.cheapModel;
      assert.equal(h.calls[0].model, expectedModel);
      assert.equal(h.calls[0].options.temperature, scenario.expected.temperature);
      assert.deepEqual(h.config.reads.map((entry) => entry.path), [newPath]);
      const expectedWrites = scenario.kind === "valid" ? [] : [newPath];
      assert.deepEqual(h.config.writes.map((entry) => entry.path), expectedWrites);
      assert.deepEqual(h.readSavedConfig(), scenario.expected);
      if (scenario.kind === "valid") {
        assert.deepEqual(readFileSync(newPath), beforeNew, "valid new config must not be rewritten");
        assert.equal(h.warnings.length, 0);
      } else {
        assert.ok(h.warnings.some(([message]) => message.includes("pi-auto-rename.json")));
      }
      if (scenario.invalid) {
        assert.ok(h.warnings.some(([message]) => message.includes("invalid pi-auto-rename.json")));
      }
      assert.equal(existsSync(oldPath), Boolean(scenario.old));
      if (scenario.old) {
        assert.deepEqual(readFileSync(oldPath), oldBytes, "old config bytes must stay unchanged");
      }
      await h.resolveTitle("Configuration filename regression verified");
      assert.equal(h.session.name, "Configuration filename regression verified");
      assertListenerRemoved(h);
    });
  }
});
