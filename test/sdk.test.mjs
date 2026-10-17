import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Set PI_AUTO_RENAME_SDK_ROOT to the host's @earendil-works directory to run
// against its actual SDK rather than the development peers. No real config,
// credential store or provider is used.
process.env.PI_OFFLINE = "1";
let unexpectedFetches = 0;
globalThis.fetch = async () => { unexpectedFetches++; throw new Error("Network forbidden"); };
const root = process.env.PI_AUTO_RENAME_SDK_ROOT;
const load = (name) => import(root
  ? pathToFileURL(`${root}/${name}/dist/index.js`).href
  : `@earendil-works/${name}`);
const { ModelRuntime, ModelRegistry, discoverAndLoadExtensions } = await load("pi-coding-agent");
const { InMemoryCredentialStore, clampThinkingLevel } = await load("pi-ai");
test("public host loader loads standalone source without development node_modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-rename-load-"));
  try {
    const path = join(dir, "auto-session-name.ts");
    copyFileSync(new URL("../auto-session-name.ts", import.meta.url), path);
    const result = await discoverAndLoadExtensions([path], dir, dir);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const { handlers } = result.extensions[0];
    for (const event of ["session_start", "session_shutdown", "before_agent_start"]) {
      assert.equal(handlers.get(event)?.length, 1);
    }
    for (const handler of handlers.get("session_start")) await handler({ type: "session_start", reason: "startup" }, {});
    for (const handler of handlers.get("before_agent_start")) await handler({ type: "before_agent_start", messageType: "user", prompt: "Synthetic input" }, { mode: "print" });
    for (const handler of handlers.get("session_shutdown")) await handler({ type: "session_shutdown", reason: "quit" }, {});
    assert.equal(unexpectedFetches, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
const registry = new ModelRegistry(runtime);
const base = {
  id: "synthetic-model", name: "Synthetic model", provider: "openai",
  api: "openai-responses", baseUrl: "https://fixture.invalid/v1", reasoning: true,
  input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192, maxTokens: 1024,
};
const context = { messages: [{ role: "user", content: [{ type: "text", text: "Synthetic naming prompt" }], timestamp: 0 }] };
for (const level of ["off", "low", "xhigh", "max", "gpt5-off"]) {
  test(`real SDK serializer: ${level}`, async () => {
    const model = { ...base, thinkingLevelMap: level === "gpt5-off"
      ? { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null }
      : { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } };
    const clamped = clampThinkingLevel(model, level === "gpt5-off" ? "off" : level);
    let payload;
    let calls = 0;
    let requestHeaders;
    let requestSignal;
    const controller = new AbortController();
    const response = await registry.streamSimple(model, context, {
      apiKey: "sk-synthetic-only", env: {}, maxRetries: 0,
      temperature: 0.2, sessionId: "synthetic-session", signal: controller.signal,
      reasoning: clamped === "off" ? undefined : clamped,
      onPayload(p) { payload = structuredClone(p); },
      fetch: async (url, init) => {
        calls++;
        requestSignal = init.signal;
        requestHeaders = new Headers(init.headers);
        return new Response(JSON.stringify({ error: { message: "Synthetic unsupported_value", code: "unsupported_value" } }), {
          status: 400, headers: { "content-type": "application/json" },
        });
      },
    }).result();
    assert.equal(calls, 1);
    assert.ok(requestSignal instanceof AbortSignal);
    assert.equal(requestHeaders.get("session_id"), "synthetic-session");
    assert.equal(requestHeaders.get("x-client-request-id"), "synthetic-session");
    assert.match(response.errorMessage, /Synthetic unsupported_value/);
    assert.equal(payload.temperature, 0.2);
    assert.equal(payload.reasoning.effort, level === "off" ? "none" : level === "gpt5-off" ? "minimal" : level);
    assert.equal(response.stopReason, "error");
    assert.equal(response.content.length, 0);
    assert.equal(unexpectedFetches, 0);
  });
}
