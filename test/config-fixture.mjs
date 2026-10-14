import assert from "node:assert/strict";
import * as fs from "node:fs";

// Only the extension's imports are redirected here. The harness uses real fs
// for seeding/inspecting fixtures, so those operations do not inflate the spies.
let activeFixture;

export function useConfigFixture(fixture) {
  assert.equal(activeFixture, undefined, "config fixtures must run serially");
  activeFixture = fixture;
  return () => {
    assert.equal(activeFixture, fixture);
    activeFixture = undefined;
  };
}

export function getAgentDir() {
  assert.ok(activeFixture, "getAgentDir must never use the real agent directory");
  return activeFixture.directory;
}

function configFixture(path) {
  assert.ok(activeFixture, "config I/O outside an active test");
  assert.equal(path, activeFixture.path, "extension I/O must stay inside its fixture");
  return activeFixture;
}

export function readFileSync(path, ...args) {
  configFixture(path).reads.push({ path, args });
  return fs.readFileSync(path, ...args);
}

export function writeFileSync(path, data, ...args) {
  configFixture(path).writes.push({ path, data, args });
  return fs.writeFileSync(path, data, ...args);
}
