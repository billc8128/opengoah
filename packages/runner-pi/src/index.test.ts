import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantResponse, RunRequest, WakeSnapshot, WakeOutput } from "goah-ledger-contract";
import { PiRunnerAdapter, ProcessRunner, piWorkerPath, type PiDriver } from "./index.js";
import { assistantResponseText, bashTimeoutMs, compactMessages, compactMessagesToTokenBudget, resolveContextPolicy, runBashCommand, scopedRunnerPath, snapshotModelConfig, validateNextWakeAt } from "./pi-worker.js";
import { createPiModel, modelCatalog, providerCatalog } from "./model-provider.js";

const wake: WakeSnapshot = { id: "w", agent: "a", triggerRef: "t", status: "running", leaseUntil: "2026-08-18T00:01:00.000Z", attempt: 1, startedAt: "2026-08-18T00:00:00.000Z", endedAt: null, enqueuedSeq: 1, leaseToken: "lease", runnerPid: null };
const goalTurn = { source: { kind: "goal_driver" as const, round: 1 }, goalBinding: { goalId: "goal", goalRevision: 0 } };

test("assistant response excludes thinking and tool blocks", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "internal reasoning" },
      { type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
      { type: "text", text: "Visible answer." },
    ],
  } as never;
  assert.equal(assistantResponseText(message), "Visible answer.");
});

function driver(steps: Array<{ stop?: boolean; response?: AssistantResponse; handoff?: WakeOutput }>): PiDriver {
  return {
    createSession: async () => ({
      step: async () => {
        const step = steps.shift() ?? { stop: true };
        return { ...(step.stop ? { stopped: true } : {}), ...(step.response ? { response: step.response } : {}), ...(step.handoff ? { handoff: step.handoff } : {}) };
      },
      close: async () => undefined,
    }),
  };
}

test("runner policy is external and a multi-step driver can hand off", async () => {
  const now = "2026-08-18T00:00:00.000Z";
  const faux = driver([
    {},
    { handoff: { handoff: { observations: [], results: ["done"], nextSteps: [] }, mail: [], nextWakeAt: null } },
  ]);
  const request: RunRequest = {
    wake, turn: goalTurn, context: {},
    now: () => now, emit: () => undefined,
  };
  const handle = new PiRunnerAdapter(faux).prepare(request);
  handle.begin();
  const result = await handle.result;
  assert.equal(result.outcome, "handoff");
});

test("an unbound Turn returns a normal assistant response without handoff", async () => {
  const request: RunRequest = { wake, turn: { source: { kind: "human" } }, context: {}, now: () => "2026-08-18T00:00:00.000Z", emit: () => undefined };
  const handle = new PiRunnerAdapter(driver([{ response: { content: "你好" } }])).prepare(request);
  handle.begin();
  assert.deepEqual(await handle.result, { outcome: "response", response: { content: "你好" } });
});

test("bash commands are killed by process-group timeout and become visible tool errors", async () => {
  assert.equal(bashTimeoutMs(undefined, { GOAH_PI_BASH_TIMEOUT_MS: "500" }), 500);
  assert.equal(bashTimeoutMs(undefined, {}), 120_000);
  assert.equal(bashTimeoutMs(60_000_000, {}), 600_000);
  assert.equal(bashTimeoutMs(-5, {}), 120_000);

  const started = Date.now();
  const hung = await runBashCommand(process.cwd(), { command: "sleep 30", timeoutMs: 200 });
  assert.equal(hung.isError, true);
  assert.match(hung.content[0]?.text ?? "", /timed out/);
  assert.ok(Date.now() - started < 5_000);

  const fast = await runBashCommand(process.cwd(), { command: "printf ok", timeoutMs: 5_000 });
  assert.notEqual(fast.isError, true);
  assert.match(fast.content[0]?.text ?? "", /ok/);
});

test("runner tools cannot read protected Goah state", async () => {
  const root = mkdtempSync(join(tmpdir(), "goah-protected-root-")); const state = join(root, ".goah"); mkdirSync(state);
  const auth = join(state, "auth.json"); writeFileSync(auth, "private-secret");
  assert.throws(() => scopedRunnerPath(root, auth, [state]), /protected Goah state/);
  const result = await runBashCommand(root, { command: `cat ${JSON.stringify(auth)}`, timeoutMs: 5_000 }, undefined, [state]);
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0]?.text ?? "", /private-secret/);
  const safe = await runBashCommand(root, { command: "printf ok", timeoutMs: 5_000 }, undefined, [state]);
  assert.notEqual(safe.isError, true);
  assert.equal(safe.content[0]?.text, "ok");
});

test("stopping without handoff is abnormal", async () => {
  const handle = new PiRunnerAdapter(driver([{ stop: true }])).prepare({
    wake, turn: goalTurn, context: {},
    now: () => "2026-08-18T00:00:00.000Z", emit: () => undefined,
  });
  handle.begin();
  const result = await handle.result;
  assert.deepEqual(result.outcome, "abnormal");
});

test("ProcessRunner may opt into its own timeout policy", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], killGraceMs: 25, timeoutMs: 50 });
  const handle = runner.prepare({
    wake, turn: goalTurn, context: {},
    now: () => new Date().toISOString(), emit: () => undefined,
  });
  assert.ok(handle.pid);
  handle.begin();
  const result = await handle.result;
  assert.equal(result.outcome, "abnormal");
  assert.throws(() => process.kill(handle.pid!, 0));
});

test("ProcessRunner forwards steering messages over the live worker protocol", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: [fileURLToPath(new URL("./steering-worker.test-fixture.js", import.meta.url))], steering: true });
  const handle = runner.prepare({ wake, turn: { source: { kind: "human" } }, context: {}, now: () => new Date().toISOString(), emit: () => undefined });
  handle.begin();
  await handle.steer!("correct the budget");
  assert.deepEqual(await handle.result, { outcome: "response", response: { content: "correct the budget" } });
});

test("ProcessRunner rejects steering that the worker no longer accepts", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: [fileURLToPath(new URL("./steering-reject.test-fixture.js", import.meta.url))], steering: true });
  const handle = runner.prepare({ wake, turn: { source: { kind: "human" } }, context: {}, now: () => new Date().toISOString(), emit: () => undefined });
  handle.begin();
  await assert.rejects(handle.steer!("too late"), /no longer accepting/);
  assert.deepEqual(await handle.result, { outcome: "response", response: { content: "finished" } });
});

test("ProcessRunner bounds steering acknowledgement waits", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: [fileURLToPath(new URL("./steering-no-ack.test-fixture.js", import.meta.url))], steering: true, steerAckTimeoutMs: 50, killGraceMs: 25 });
  const handle = runner.prepare({ wake, turn: { source: { kind: "human" } }, context: {}, now: () => new Date().toISOString(), emit: () => undefined });
  handle.begin();
  await assert.rejects(handle.steer!("ignored"), /in time/);
  await handle.terminate();
});

test("the Pi worker accepts a pre-0.11 daemon request without Turn metadata", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: [piWorkerPath()], env: { GOAH_PI_PROVIDER: "faux", GOAH_PI_MODEL: "faux-goah", GOAH_PI_FAUX_HANDOFF: JSON.stringify({ observations: ["legacy"], results: [], nextSteps: [] }) } });
  const legacy = { wake, context: {}, now: () => "2026-08-18T00:00:00.000Z", emit: () => undefined } as unknown as RunRequest;
  const handle = runner.prepare(legacy);
  handle.begin();
  const result = await handle.result;
  assert.equal(result.outcome, "handoff");
});

test("the Pi worker preserves provider error messages from empty assistant responses", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: [piWorkerPath()], env: { GOAH_PI_PROVIDER: "faux", GOAH_PI_MODEL: "faux-goah", GOAH_PI_FAUX_ERROR: "provider rejected the request" } });
  const handle = runner.prepare({ wake, turn: { source: { kind: "human" } }, context: {}, now: () => "2026-08-18T00:00:00.000Z", emit: () => undefined });
  handle.begin();
  assert.deepEqual(await handle.result, { outcome: "abnormal", reason: "provider rejected the request" });
});

test("mid-turn compaction changes only the model view and preserves boundary messages", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: `constraint-${index}`, timestamp: index }));
  const original = JSON.stringify(messages);
  const compacted = compactMessages(messages, 4);
  assert.equal(JSON.stringify(messages), original);
  assert.equal(compacted[0], messages[0]);
  assert.deepEqual(compacted.slice(-4), messages.slice(-4));
  assert.match((compacted[1] as { content: string }).content, /Source message indexes/);
});

test("Pi runner exposes the upstream provider and model registries", () => {
  assert.ok(providerCatalog().length >= 39);
  assert.ok(modelCatalog("openai").length > 10);
  assert.equal(createPiModel("openai", "gpt-5.5").model.provider, "openai");
  assert.throws(() => createPiModel("ark-coding", "glm-test"), /Model not found/);
});

test("context policy derives compaction from the selected model manifest", () => {
  assert.deepEqual(resolveContextPolicy(1_000_000, {}), { compactAtTokens: 700_000, retainAfterCompactTokens: 200_000 });
  assert.deepEqual(resolveContextPolicy(256_000, { GOAH_PI_COMPACT_AT_TOKENS: "180000", GOAH_PI_RETAIN_CONTEXT_TOKENS: "48000" }), { compactAtTokens: 180_000, retainAfterCompactTokens: 48_000 });
  assert.throws(() => resolveContextPolicy(0, {}), /context window/);
  assert.throws(() => resolveContextPolicy(100, { GOAH_PI_COMPACT_AT_TOKENS: "80", GOAH_PI_RETAIN_CONTEXT_TOKENS: "90" }), /context policy/);
});

test("token-budget compaction keeps the first message and a bounded recent tail", () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ role: "user" as const, content: `message-${index}-${"x".repeat(200)}`, timestamp: index }));
  const compacted = compactMessagesToTokenBudget(messages, 250);
  assert.equal(compacted[0], messages[0]);
  assert.match((compacted[1] as { content: string }).content, /Original trace is unchanged/);
  assert.equal(compacted.at(-1), messages.at(-1));
  assert.ok(compacted.length < messages.length);
  assert.ok(Math.ceil(JSON.stringify(compacted.slice(1)).length / 4) <= 350);
});

test("handoff rejects stale next-wake times", () => {
  const startedAt = "2026-08-19T00:00:00.000Z";
  assert.equal(validateNextWakeAt(undefined, startedAt), null);
  assert.equal(validateNextWakeAt("2026-08-19T01:00:00Z", startedAt), "2026-08-19T01:00:00.000Z");
  assert.throws(() => validateNextWakeAt("2025-08-19T01:00:00Z", startedAt), /later than/);
  assert.throws(() => validateNextWakeAt("not-a-date", startedAt), /later than/);
});

test("request snapshots allowlist model behavior and never persist credentials", () => {
  const snapshot = snapshotModelConfig({ transport: "auto", toolExecution: "sequential", temperature: 0.4, apiKey: "secret-key", signal: {}, headers: { authorization: "Bearer secret" }, model: { id: "m" } });
  assert.deepEqual(snapshot, { transport: "auto", toolExecution: "sequential", temperature: 0.4 });
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|apiKey|authorization/i);
});
