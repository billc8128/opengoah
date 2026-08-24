import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessRunner, resolveEnvSpec } from "./index.js";
import { wakeContext } from "./test-helpers.js";

function printEnvRunner(): ProcessRunner {
  return new ProcessRunner({ command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({type:'result',result:{outcome:'abnormal',reason:process.env.GOAH_TEST_CRED ?? 'unset'}})+'\\n')"] });
}

test("resolveEnvSpec resolves references through the process environment at call time", () => {
  const spec = { GOAH_PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "env:GOAH_SPEC_TEST_KEY" };
  process.env.GOAH_SPEC_TEST_KEY = "first";
  assert.equal(resolveEnvSpec(spec, { root: tmpdir() }).ANTHROPIC_API_KEY, "first");
  process.env.GOAH_SPEC_TEST_KEY = "rotated";
  assert.equal(resolveEnvSpec(spec, { root: tmpdir() }).ANTHROPIC_API_KEY, "rotated");
  delete process.env.GOAH_SPEC_TEST_KEY;
});

test("resolveEnvSpec reads workspace .env and ~/.goah/.env with workspace precedence", () => {
  const root = mkdtempSync(join(tmpdir(), "goah-envspec-"));
  writeFileSync(join(root, ".env"), "GOAH_SPEC_TEST_KEY=from-workspace\nOTHER=ws\n");
  const spec = { ANTHROPIC_API_KEY: "env:GOAH_SPEC_TEST_KEY", EXTRA: "env:OTHER" };
  delete process.env.GOAH_SPEC_TEST_KEY;
  delete process.env.OTHER;
  const resolved = resolveEnvSpec(spec, { root });
  assert.equal(resolved.ANTHROPIC_API_KEY, "from-workspace");
  assert.equal(resolved.EXTRA, "ws");
});

test("resolveEnvSpec throws an honest error naming the missing variable", () => {
  delete process.env.GOAH_SPEC_MISSING_KEY;
  assert.throws(() => resolveEnvSpec({ K: "env:GOAH_SPEC_MISSING_KEY" }, { root: tmpdir() }), /GOAH_SPEC_MISSING_KEY/);
});

test("a runner envSpec is re-resolved on every spawn, so .env edits apply to the next wake", async () => {
  const root = mkdtempSync(join(tmpdir(), "goah-envspec-live-"));
  writeFileSync(join(root, ".env"), "GOAH_TEST_CRED=first-value\n");
  const runner = new ProcessRunner({ command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify({type:'result',result:{outcome:'abnormal',reason:process.env.GOAH_TEST_CRED ?? 'unset'}})+'\\n')"], envSpec: { GOAH_TEST_CRED: "env:GOAH_TEST_CRED" }, cwd: root });
  const first = await runner.prepare(wakeContext()).result;
  assert.equal(first.outcome === "abnormal" ? first.reason : "unexpected handoff", "first-value");
  writeFileSync(join(root, ".env"), "GOAH_TEST_CRED=rotated-value\n");
  const second = await runner.prepare(wakeContext()).result;
  assert.equal(second.outcome === "abnormal" ? second.reason : "unexpected handoff", "rotated-value");
});
