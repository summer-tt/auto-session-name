import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness, flushAsyncWork, responseWithTitle } from "./harness.mjs";

const serial = { concurrency: false, timeout: 5000 };
const errorResponse = (errorMessage, title = "Partial must never be applied") => ({
  ...responseWithTitle(title), stopReason: "error", errorMessage,
});
async function start(t, options) {
  const h = createHarness(t, options);
  h.seedConfig({ provider: h.activeModel.provider, model: h.activeModel.id, thinking: "off", temperature: 0.2 });
  await h.startUser("First immutable prompt");
  await h.advanceTimers();
  return h;
}
async function fail(h, message, index = h.calls.length - 1) {
  h.calls[index].resolve(errorResponse(message));
  await flushAsyncWork();
}

for (const message of [
  "400 unsupported_value: expected max_tokens <= 500",
  "401 Unauthorized: provider returned an error",
  "403 Forbidden: please retry your request",
  "OpenAI API error (400): bad parameters 500",
  "HTTP 422: provider returned an error",
  "429 insufficient_quota", "429 billing required", "404 model_not_found",
  "413 Payload Too Large: provider returned an error",
  "OpenAI API error (413): provider returned an error",
  "maximum context length is 500 tokens",
  "prompt is too long: 500 tokens",
  "Unknown issue", "unsupported_value minimal is not supported",
]) {
  test(`permanent/unknown error fails once: ${message}`, serial, async (t) => {
    const h = await start(t);
    await fail(h, message);
    assert.equal(h.generatedNames.length, 0);
    assert.equal(h.listenerCount(), 0);
    assert.ok(h.warnings.some(([m]) => m.includes("failed to generate session name")));
    await h.startUser("No renewed budget");
    await h.advanceTimers(5000);
    assert.equal(h.calls.length, 1);
  });
}

for (const message of ["503 service temporarily unavailable", "429 rate limit", "network error", "stream ended before a terminal response event"]) {
  test(`transient error retries with immutable inputs: ${message}`, serial, async (t) => {
    const h = await start(t);
    await fail(h, message);
    assert.equal(h.listenerCount(), 1);
    assert.equal(h.generatedNames.length, 0);
    h.seedConfig({ provider: h.cheapModel.provider, model: h.cheapModel.id });
    await h.startUser("Later prompt must not replace first prompt");
    await h.advanceTimers(999);
    assert.equal(h.calls.length, 1);
    await h.advanceTimers(1);
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[1].model, h.calls[0].model);
    assert.deepEqual(h.calls[1].context, h.calls[0].context);
    assert.equal(h.calls[1].options.sessionId, h.calls[0].options.sessionId);
    assert.equal(h.calls[1].options.temperature, 0.2);
    assert.equal(h.calls[1].options.maxRetries, 0);
    assert.notEqual(h.calls[1].options.signal, h.calls[0].options.signal);
    assert.equal(h.config.reads.length, 1);
    await h.resolveTitle("Recovered session name");
    assert.equal(h.session.name, "Recovered session name");
    assert.equal(h.listenerCount(), 0);
  });
}

test("three attempts exhaust budget without renewal", serial, async (t) => {
  const h = await start(t);
  await fail(h, "503");
  await h.advanceTimers(1000);
  await fail(h, "503");
  await h.advanceTimers(1999);
  assert.equal(h.calls.length, 2);
  await h.advanceTimers(1);
  await fail(h, "503");
  await h.startUser();
  await h.advanceTimers(10000);
  assert.equal(h.calls.length, 3);
  assert.equal(h.listenerCount(), 0);
  assert.ok(h.warnings.some(([m]) => m.includes("attempts 3/3")));
});

for (const stopReason of ["length", "toolUse", "aborted", "pending"]) {
  test(`incomplete ${stopReason} is observable and never names`, serial, async (t) => {
    const h = await start(t);
    h.calls[0].resolve({ ...responseWithTitle("Unusable partial title"), stopReason });
    await flushAsyncWork();
    await h.advanceTimers(5000);
    assert.equal(h.calls.length, 1);
    assert.equal(h.generatedNames.length, 0);
    assert.ok(h.warnings.some(([m]) => m.includes("failed to generate session name")));
    assert.equal(h.listenerCount(), 0);
  });
}

test("normal empty title is observable without retry", serial, async (t) => {
  const h = await start(t);
  await h.resolveTitle(" ** ** ");
  assert.ok(h.warnings.some(([m]) => m.includes("empty title")));
  assert.equal(h.listenerCount(), 0);
  await h.advanceTimers(5000);
  assert.equal(h.calls.length, 1);
});

for (const rejectOnAbort of [false, true]) {
  test(`attempt timeout enforced locally; late result isolated; rejecting transport=${rejectOnAbort}`, serial, async (t) => {
    const h = await start(t, { rejectOnAbort });
    await h.advanceTimers(20000);
    assert.equal(h.calls[0].options.signal.aborted, true);
    await h.advanceTimers(1000);
    assert.equal(h.calls.length, 2);
    if (!rejectOnAbort) await h.resolveTitle("Old timeout response", 0);
    assert.equal(h.session.name, undefined);
    assert.equal(h.listenerCount(), 1);
    await h.resolveTitle("Current attempt title", 1);
    assert.equal(h.session.name, "Current attempt title");
  });
}

test("task deadline bounds the last attempt even when abort is ignored", serial, async (t) => {
  const h = await start(t);
  await h.advanceTimers(20000);
  await h.advanceTimers(1000);
  await h.advanceTimers(20000);
  await h.advanceTimers(2000);
  assert.equal(h.calls.length, 3);
  await h.advanceTimers(17000);
  assert.equal(h.calls[2].options.signal.aborted, true);
  assert.equal(h.listenerCount(), 0);
  assert.ok(h.warnings.some(([m]) => m.includes("task deadline exceeded")));
  await h.resolveTitle("Late deadline response", 2);
  assert.equal(h.generatedNames.length, 0);
});

for (const phase of ["defer", "request", "backoff"]) {
  for (const operation of ["name", "clear", "new", "fork", "resume", "reload", "quit"]) {
    test(`${operation} cancels during ${phase}`, serial, async (t) => {
      const h = createHarness(t);
      h.seedConfig({ provider: h.cheapModel.provider, model: h.cheapModel.id });
      await h.startUser();
      if (phase !== "defer") await h.advanceTimers();
      if (phase === "backoff") await fail(h, "503");
      const count = h.calls.length;
      if (operation === "name" || operation === "clear") h.setManualName(operation === "name" ? "User title" : undefined);
      else await h.emit("session_shutdown", { reason: operation });
      await h.advanceTimers(60000);
      assert.equal(h.calls.length, count);
      assert.equal(h.listenerCount(), 0);
      for (const call of h.calls) call.resolve(responseWithTitle("Late cancelled title"));
      await flushAsyncWork();
      assert.equal(h.generatedNames.length, 0);
      assert.equal(h.warnings.filter(([m]) => m.includes("failed to generate session name")).length, 0);
    });
  }
}

test("deferred old prompt never names replacement session", serial, async (t) => {
  const h = createHarness(t);
  await h.startUser("Old prompt");
  const old = await h.resetSession("resume", { replaceRuntime: true });
  await h.startUser("New prompt");
  await h.advanceTimers();
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].context.messages[0].content[0].text.includes("New prompt"));
  assert.deepEqual(old.staleAccesses, []);
  await h.resolveTitle("New session title");
});

test("late rejection after timeout is handled, logs never echo provider text", serial, async (t) => {
  const h = await start(t);
  await h.advanceTimers(20000);
  h.calls[0].reject(new Error("SECRET user prompt and credential"));
  await flushAsyncWork();
  await h.advanceTimers(1000);
  await fail(h, "400 unsupported_value SECRET user prompt and credential\nforged log");
  assert.ok(h.warnings.every((args) => !JSON.stringify(args).includes("SECRET")));
  assert.deepEqual(h.unhandledRejections, []);
});

for (const level of ["off", "low", "xhigh", "max"]) {
  test(`simple reasoning option uses clamped ${level}`, serial, async (t) => {
    const h = createHarness(t);
    Object.assign(h.activeModel, { reasoning: true, thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } });
    h.seedConfig({ provider: h.activeModel.provider, model: h.activeModel.id, thinking: level });
    await h.startUser();
    await h.advanceTimers();
    assert.equal(h.calls[0].options.reasoning, level === "off" ? undefined : level);
    assert.equal(h.calls[0].options.reasoningEffort, undefined);
    await h.resolveTitle("Simple adapter title");
  });
}

test("unsupported off clamps to minimal rather than forcing none", serial, async (t) => {
  const h = createHarness(t);
  Object.assign(h.activeModel, { reasoning: true, thinkingLevelMap: { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null } });
  h.seedConfig({ provider: h.activeModel.provider, model: h.activeModel.id, thinking: "off" });
  await h.startUser();
  await h.advanceTimers();
  assert.equal(h.calls[0].options.reasoning, "minimal");
});
