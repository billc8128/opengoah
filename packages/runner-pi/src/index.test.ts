import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantResponse, RunRequest, TurnSnapshot, WakeSnapshot, WakeOutput } from "goah-ledger-contract";
import { PiRunnerAdapter, ProcessRunner, piWorkerPath, type PiDriver } from "./index.js";
import { assistantResponseText, bashTimeoutMs, compactMessages, compactMessagesToTokenBudget, linuxSandboxArgs, resolveContextPolicy, runBashCommand, sandboxWorkspacePaths, scopedRunnerPath, snapshotModelConfig, validateNextWakeAt } from "./pi-worker.js";
import { createPiModel, modelCatalog, providerCatalog } from "./model-provider.js";

const wake: WakeSnapshot = { id: "w", agent: "a", triggerRef: "t", status: "running", leaseUntil: "2026-08-18T00:01:00.000Z", attempt: 1, startedAt: "2026-08-18T00:00:00.000Z", endedAt: null, enqueuedSeq: 1, leaseToken: "lease", runnerPid: null };
const execution: TurnSnapshot = { id:"w",threadId:"thread",source:"goal",goalId:"goal",goalRevision:0,status:"in_progress",error:null,startedAt:"2026-08-18T00:00:00.000Z",endedAt:null,leaseUntil:wake.leaseUntil,leaseToken:"lease",runnerPid:null };
const requestBase = { agent:wake.agent,execution,sourceWake:wake };
const goalTurn = { source: { kind: "goal" as const, round: 1 }, goalBinding: { goalId: "goal", goalRevision: 0 } };

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
    createRunnerSession: async () => ({
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
    ...requestBase, turn: goalTurn, context: {},
    now: () => now, emit: () => undefined,
  };
  const handle = new PiRunnerAdapter(faux).prepare(request);
  handle.begin();
  const result = await handle.result;
  assert.equal(result.outcome, "handoff");
});

test("an unbound Turn returns a normal assistant response without handoff", async () => {
  const request: RunRequest = { ...requestBase, execution:{...execution,source:"human",goalId:null,goalRevision:null}, turn: { source: { kind: "human" } }, context: {}, now: () => "2026-08-18T00:00:00.000Z", emit: () => undefined };
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
  const overflow = await runBashCommand(process.cwd(), { command: "head -c 1200000 /dev/zero", timeoutMs: 5_000 });
  assert.equal(overflow.isError, true);
  assert.equal((overflow.details as { outputOverflow?: boolean }).outputOverflow, true);
  assert.ok((overflow.content[0]?.text.length ?? 0) <= 50_000);
  const root = mkdtempSync(join(tmpdir(), "goah-sandbox-root-")); const outside = join(mkdtempSync(join(tmpdir(), "goah-sandbox-outside-")), "secret.txt"); writeFileSync(outside, "host-secret");
  const escaped = await runBashCommand(root, { command: `cat ${JSON.stringify(outside)}`, timeoutMs: 5_000 });
  assert.equal(escaped.isError, true); assert.doesNotMatch(escaped.content[0]?.text ?? "", /host-secret/);
  const tempVictim = join(tmpdir(), `goah-temp-victim-${process.pid}`); writeFileSync(tempVictim, "safe");
  const tempWrite = await runBashCommand(root, { command: `printf overwritten > ${JSON.stringify(tempVictim)}`, timeoutMs: 5_000 });
  assert.equal(tempWrite.isError, true); assert.equal(readFileSync(tempVictim, "utf8"), "safe");
  if (existsSync(join(homedir(), ".gitconfig"))) { const gitConfig = await runBashCommand(root, { command: `cat ${JSON.stringify(join(homedir(), ".gitconfig"))}`, timeoutMs: 5_000 }); assert.equal(gitConfig.isError, true); }
  for (const command of ["node --version", "npm --version", "git --version"]) {
    const tool = await runBashCommand(root, { command, timeoutMs: 10_000 });
    assert.notEqual(tool.isError, true, `${command}: ${tool.content[0]?.text ?? ""}`);
  }
  const marker = join(root, "background-marker");
  const background = await runBashCommand(root, { command: `(sleep 0.2; printf escaped > ${JSON.stringify(marker)}) >/dev/null 2>&1 &`, timeoutMs: 5_000 });
  assert.notEqual(background.isError, true); await new Promise((resolveWait) => setTimeout(resolveWait, 350)); assert.equal(existsSync(marker), false);
});

test("runner tools cannot read protected Goah state", async () => {
  const root = mkdtempSync(join(tmpdir(), "goah-protected-root-")); const state = join(root, ".goah"); mkdirSync(state);
  const auth = join(state, "auth.json"); writeFileSync(auth, "private-secret");
  const stateLink = join(root, "state-link"); symlinkSync(state, stateLink);
  const outside = mkdtempSync(join(tmpdir(), "goah-outside-")); const outsideLink = join(root, "outside-link"); writeFileSync(join(outside, "secret.txt"), "outside-secret"); symlinkSync(outside, outsideLink);
  assert.equal(sandboxWorkspacePaths(root, [state]).includes(outside), false);
  assert.throws(() => scopedRunnerPath(root, auth, [state]), /protected Goah state/);
  const result = await runBashCommand(root, { command: `cat ${JSON.stringify(auth)}`, timeoutMs: 5_000 }, undefined, [state]);
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0]?.text ?? "", /private-secret/);
  const overwrite = await runBashCommand(root, { command: `printf corrupted > ${JSON.stringify(auth)}`, timeoutMs: 5_000 }, undefined, [state]);
  assert.equal(overwrite.isError, true); assert.equal(readFileSync(auth, "utf8"), "private-secret");
  const linked = await runBashCommand(root, { command: `cat ${JSON.stringify(join(stateLink, "auth.json"))}`, timeoutMs: 5_000 }, undefined, [state]);
  assert.equal(linked.isError, true);
  assert.doesNotMatch(linked.content[0]?.text ?? "", /private-secret/);
  const escaped = await runBashCommand(root, { command: `cat ${JSON.stringify(join(outsideLink, "secret.txt"))}`, timeoutMs: 5_000 }, undefined, [state]);
  assert.equal(escaped.isError, true);
  assert.doesNotMatch(escaped.content[0]?.text ?? "", /outside-secret/);
  const safe = await runBashCommand(root, { command: "printf ok", timeoutMs: 5_000 }, undefined, [state]);
  assert.notEqual(safe.isError, true);
  assert.equal(safe.content[0]?.text, "ok");
});

test("Linux Bash sandbox never binds the host root", () => {
  const root = mkdtempSync(join(tmpdir(), "goah-bwrap-root-")); const state = join(root, ".goah"); const sandboxTemp = mkdtempSync(join(tmpdir(), "goah-bwrap-tmp-")); mkdirSync(state); writeFileSync(join(root, "work.txt"), "ok");
  const args = linuxSandboxArgs("true", root, [state], sandboxTemp);
  assert.equal(args.some((value, index) => value === "--bind" && args[index + 1] === "/"), false);
  assert.equal(args.some((value, index) => value === "--ro-bind" && args[index + 1] === "/"), false);
  assert.equal(args.some((value, index) => value === "--dir" && args[index + 1] === realpathSync(sandboxTemp)), true);
});

test("stopping without handoff is abnormal", async () => {
  const handle = new PiRunnerAdapter(driver([{ stop: true }])).prepare({
    ...requestBase, turn: goalTurn, context: {},
    now: () => "2026-08-18T00:00:00.000Z", emit: () => undefined,
  });
  handle.begin();
  const result = await handle.result;
  assert.deepEqual(result.outcome, "abnormal");
});

test("ProcessRunner may opt into its own timeout policy", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], killGraceMs: 25, timeoutMs: 50 });
  const handle = runner.prepare({
    ...requestBase, turn: goalTurn, context: {},
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
  const handle = runner.prepare({ ...requestBase, execution:{...execution,source:"human",goalId:null,goalRevision:null}, turn: { source: { kind: "human" } }, context: {}, now: () => new Date().toISOString(), emit: () => undefined });
  handle.begin();
  await handle.steer!("correct the budget");
  assert.deepEqual(await handle.result, { outcome: "response", response: { content: "correct the budget" } });
});

test("ProcessRunner rejects steering that the worker no longer accepts", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: [fileURLToPath(new URL("./steering-reject.test-fixture.js", import.meta.url))], steering: true });
  const handle = runner.prepare({ ...requestBase, execution:{...execution,source:"human",goalId:null,goalRevision:null}, turn: { source: { kind: "human" } }, context: {}, now: () => new Date().toISOString(), emit: () => undefined });
  handle.begin();
  await assert.rejects(handle.steer!("too late"), /no longer accepting/);
  assert.deepEqual(await handle.result, { outcome: "response", response: { content: "finished" } });
});

test("ProcessRunner bounds steering acknowledgement waits", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: [fileURLToPath(new URL("./steering-no-ack.test-fixture.js", import.meta.url))], steering: true, steerAckTimeoutMs: 50, killGraceMs: 25 });
  const handle = runner.prepare({ ...requestBase, execution:{...execution,source:"human",goalId:null,goalRevision:null}, turn: { source: { kind: "human" } }, context: {}, now: () => new Date().toISOString(), emit: () => undefined });
  handle.begin();
  await assert.rejects(handle.steer!("ignored"), /in time/);
  await handle.terminate();
});

test("the Pi worker accepts a pre-0.11 daemon request without Turn metadata", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: [piWorkerPath()], env: { GOAH_PI_PROVIDER: "faux", GOAH_PI_MODEL: "faux-goah", GOAH_PI_FAUX_HANDOFF: JSON.stringify({ observations: ["legacy"], results: [], nextSteps: [] }) } });
  const legacy = { ...requestBase, context: {}, now: () => "2026-08-18T00:00:00.000Z", emit: () => undefined } as unknown as RunRequest;
  const handle = runner.prepare(legacy);
  handle.begin();
  const result = await handle.result;
  assert.equal(result.outcome, "handoff");
});

test("the Pi worker preserves provider error messages from empty assistant responses", async () => {
  const runner = new ProcessRunner({ command: process.execPath, args: [piWorkerPath()], env: { GOAH_PI_PROVIDER: "faux", GOAH_PI_MODEL: "faux-goah", GOAH_PI_FAUX_ERROR: "provider rejected the request" } });
  const handle = runner.prepare({ ...requestBase, execution:{...execution,source:"human",goalId:null,goalRevision:null}, turn: { source: { kind: "human" } }, context: {}, now: () => "2026-08-18T00:00:00.000Z", emit: () => undefined });
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
