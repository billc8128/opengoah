import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { controlAvailable, controlEndpoint, diagnoseConfig, loadConfig, redactValue, SupervisorLock } from "./index.js";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "goah-cli-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "goah@example.test"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "GOAH Test"], { cwd: directory });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: directory });
  return directory;
}

function invoke(directory: string, ...args: string[]): string {
  return execFileSync(process.execPath, [cli, ...args], { cwd: directory, encoding: "utf8", env: { ...process.env, GOAH_STATE_HOME: join(tmpdir(), "goah-cli-test-state") } });
}
function invokeFailure(directory: string, ...args: string[]): string {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: directory, encoding: "utf8", env: { ...process.env, GOAH_STATE_HOME: join(tmpdir(), "goah-cli-test-state") } });
  assert.notEqual(result.status, 0);
  return result.stderr;
}

test("help and version work before workspace setup and command typos do not become goals", () => {
  const directory = mkdtempSync(join(tmpdir(), "goah-help-"));
  assert.match(invoke(directory, "--help"), /goah runner list/);
  assert.match(invoke(directory, "--version"), /^\d+\.\d+\.\d+/);
  assert.match(invokeFailure(directory, "statu"), /Did you mean "goah status"/);
  assert.equal(existsSync(join(directory, "goah.config.json")), false);
});

test("CLI initializes versioned config, resolves secret references, and enforces singleton lock", () => {
  const directory = repository();
  invoke(directory, "init");
  const initialized = JSON.parse(readFileSync(join(directory, "goah.config.json"), "utf8"));
  assert.equal(initialized.version, 2);
  assert.equal(initialized.workspace, undefined);
  assert.equal(initialized.stateDir.startsWith(directory), false);
  assert.equal(initialized.limits, undefined);
  assert.equal(initialized.profiles.some((profile: { agent: string; role: string }) => profile.agent === "ceo" && profile.role === "ceo"), true);
  const raw = JSON.parse(readFileSync(join(directory, "goah.config.json"), "utf8"));
  assert.equal(raw.runner, undefined);
  assert.equal(raw.runnerProfiles[0].runner, "pi");
  assert.equal(raw.profiles.every((profile: { runnerProfile?: string }) => profile.runnerProfile === "default"), true);
  const diagnosed = diagnoseConfig(loadConfig(join(directory, "goah.config.json")));
  assert.equal(diagnosed.checks.some((check: { name: string; ok: boolean }) => check.name === "runner" && check.ok), true);
  const lock = new SupervisorLock(join(directory, ".goah")); lock.acquire();
  assert.throws(() => new SupervisorLock(join(directory, ".goah")).acquire(), /already running/);
  lock.release();
  const next = new SupervisorLock(join(directory, ".goah")); next.acquire(); next.release();
});

test("version-one Pi config migrates in memory to an opaque Runner Profile", () => {
  const directory = repository();
  const path = join(directory, "goah.config.json");
  writeFileSync(path, JSON.stringify({ version: 1, stateDir: ".goah", runner: { command: process.execPath, args: ["$GOAH_PI_WORKER"], env: { GOAH_PI_PROVIDER: "faux", GOAH_PI_MODEL: "faux-goah" } }, profiles: [{ agent: "ceo", role: "ceo" }] }));
  const migrated = loadConfig(path);
  assert.deepEqual(migrated.runnerProfiles, [{ id: "default", runner: "pi", config: { provider: "faux", model: "faux-goah" } }]);
  assert.equal(migrated.profiles?.[0]?.runnerProfile, "default");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).runnerProfiles, undefined);
});

test("CLI runs the install-to-first-handoff path with the faux provider", () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "faux", "--agent", "worker");
  const doctor = JSON.parse(invoke(directory, "doctor", "--json"));
  assert.equal(doctor.ok, true);
  assert.match(doctor.checks.find((item: { name: string }) => item.name === "runner").detail, /default:pi/);
  const created = JSON.parse(invoke(directory, "goal-create", "--id", "first", "--owner", "worker", "--objective", "Complete the first handoff", "--wake-now"));
  assert.equal(created.goal.id, "first");
  assert.equal(created.wake.status, "queued");
  const run = JSON.parse(invoke(directory, "run-once"));
  assert.equal(run.wake.status, "done");
  const wakeId = run.wake.id;
  const status = JSON.parse(invoke(directory, "status"));
  assert.equal(status.goals[0].id, "first");
  assert.equal(status.wakes.length, 1);
  assert.equal(status.wakes[0].status, "done");
  assert.equal(status.modelCapabilities.provider, "faux");
  assert.equal(status.recentHandoffs.length, 1);
  const sessions = JSON.parse(invoke(directory, "session", "list"));
  assert.equal(sessions[0].wakeId, wakeId);
  assert.equal(sessions[0].sessionStatus, "completed");
  assert.equal(sessions[0].formatVersion, 1);
  const detail = JSON.parse(invoke(directory, "session", "show", "--config", "goah.config.json", wakeId));
  assert.equal(detail.eventTypes["request.prepared"], 1);
  assert.ok(detail.replay.messageCount > 0);
  assert.equal(JSON.stringify(detail).includes("apiKey"), false);
  const context = JSON.parse(invoke(directory, "context", "show", wakeId));
  assert.match(context.text, /Complete the first handoff/);
  const events = JSON.parse(invoke(directory, "events", "--stream", `wake:${wakeId}`));
  assert.equal(events.at(-1).type, "wake.done");
  const exportedPath = join(directory, "session.json");
  const exported = JSON.parse(invoke(directory, "session", "export", wakeId, "--output", exportedPath));
  assert.equal(exported.redacted, true);
  assert.equal(JSON.parse(readFileSync(exportedPath, "utf8")).format, "goah.session-export.v1");
  const queued = JSON.parse(invoke(directory, "wake", "worker", "--reason", "manual follow-up"));
  assert.equal(queued.wake.status, "queued");
  assert.equal(JSON.parse(invoke(directory, "run-once")).wake.status, "done");
  assert.equal(JSON.parse(invoke(directory, "status")).wakes.length, 2);
});

test("CLI rejects an unsupported legacy Ark provider", () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "ark-coding", "--model", "glm-test");
  const result = spawnSync(process.execPath, [cli, "run-once"], { cwd: directory, encoding: "utf8", env: { ...process.env, GOAH_STATE_HOME: join(tmpdir(), "goah-cli-test-state") } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Model not found/);
});

test("session export redaction preserves structure while removing common secrets and home paths", () => {
  const redacted = redactValue({ token: "top-secret", nested: { text: `Bearer abcdef /Users/example key-abcdefghijklmnop ${process.env.HOME}` } }) as { token: string; nested: { text: string } };
  assert.equal(redacted.token, "[REDACTED]");
  assert.doesNotMatch(redacted.nested.text, /abcdef|abcdefghijklmnop/);
  if (process.env.HOME) assert.doesNotMatch(redacted.nested.text, new RegExp(process.env.HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("CLI exposes the complete goal lifecycle with revisioned transitions", () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "faux", "--agent", "worker");
  invoke(directory, "goal-create", "--id", "lifecycle", "--owner", "worker", "--objective", "Initial objective", "--observation-method", "Accept a fresh evidence-backed handoff.");
  assert.equal(JSON.parse(invoke(directory, "goal-show", "lifecycle")).goal.revision, 0);
  const updated = JSON.parse(invoke(directory, "goal-update", "lifecycle", "--objective", "Updated objective", "--observation-method", "Accept a fresh handoff for the updated objective."));
  assert.equal(updated.goal.objective, "Updated objective");
  assert.equal(updated.goal.revision, 1);
  assert.equal(JSON.parse(invoke(directory, "goal-pause", "lifecycle")).goal.phase, "paused");
  assert.equal(JSON.parse(invoke(directory, "goal-resume", "lifecycle")).goal.phase, "active");
  invoke(directory, "wake", "worker", "--reason", "collect completion evidence");
  invoke(directory, "run-once");
  const evidenceSeq = JSON.parse(invoke(directory, "status")).recentHandoffs.at(-1).seq;
  const completed = JSON.parse(invoke(directory, "goal-complete", "lifecycle", "--reason", "fresh handoff satisfies the observation method", "--evidence", String(evidenceSeq)));
  assert.equal(completed.goal.phase, "complete");
  assert.equal(completed.goal.revision, 4);
  assert.match(invokeFailure(directory, "goal-resume", "lifecycle"), /completed goal/);
  assert.match(invokeFailure(directory, "goal-update", "lifecycle"), /requires objective, observation method, or owner/);
});

test("CLI runs a local operations goal without Git", () => {
  const directory = mkdtempSync(join(tmpdir(), "goah-operations-"));
  invoke(directory, "init", "--provider", "faux", "--agent", "operator");
  const doctor = JSON.parse(invoke(directory, "doctor", "--json"));
  assert.equal(doctor.ok, true);
  assert.match(doctor.checks.find((item: { name: string }) => item.name === "root").detail, /runner-owned local execution/);
  invoke(directory, "goal-create", "--id", "store", "--owner", "operator", "--objective", "Open a storefront", "--wake-now");
  assert.equal(JSON.parse(invoke(directory, "run-once")).wake.status, "done");
  assert.equal(JSON.parse(invoke(directory, "status")).wakes.length, 1);
});

test("CLI exposes one-objective CEO entry and coalesces human corrections", () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "faux");
  const started = JSON.parse(invoke(directory, "goal", "start", "--id", "company", "--objective", "Launch a company"));
  assert.equal(started.goal.owner, "ceo");
  assert.equal(started.wake.agent, "ceo");
  const sent = JSON.parse(invoke(directory, "ceo", "send", "--message", "Prioritize low inventory risk"));
  assert.equal(sent.mail.to, "ceo");
  assert.equal(sent.wake.id, started.wake.id);
  const status = JSON.parse(invoke(directory, "ceo", "status"));
  assert.equal(status.roots[0].id, "company");
  assert.equal(status.team.find((member: { agent: string }) => member.agent === "ceo").status, "queued");
  assert.deepEqual(JSON.parse(invoke(directory, "ceo", "inbox")), []);
});

test("CLI revises and confirms a root through the resident Supervisor control socket", async () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "faux");
  const config = loadConfig(join(directory, "goah.config.json"));
  const env = { ...process.env, GOAH_STATE_HOME: join(tmpdir(), "goah-cli-test-state") };
  const daemon = spawn(process.execPath, [cli, "start"], { cwd: directory, env, stdio: "ignore" });
  try {
    await waitFor(async () => controlAvailable(config.stateDir));
    if (process.platform !== "win32") assert.equal(statSync(controlEndpoint(config.stateDir)).mode & 0o777, 0o600);
    const started = JSON.parse(invoke(directory, "goal", "start", "--id", "live", "--objective", "Grow revenue"));
    assert.equal(started.goal.observationMethod, null);
    const observed = JSON.parse(invoke(directory, "goal-update", "live", "--observation-method", "Run the net revenue report every six hours."));
    assert.match(observed.observationMethod, /net revenue/);
    const revised = JSON.parse(invoke(directory, "goal-update", "live", "--objective", "Grow retained net revenue"));
    assert.equal(revised.observationMethod, null);
    assert.equal(JSON.parse(invoke(directory, "ceo", "status")).roots[0].objective, "Grow retained net revenue");
    assert.match(invoke(directory, "Review the revised goal and propose a new observation method"), /ceo wake/);
  } finally {
    daemon.kill("SIGTERM");
    if (daemon.exitCode === null) await once(daemon, "close");
  }
});

test("daemon lifecycle is inspectable and stoppable", () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "faux");
  assert.match(invoke(directory, "daemon", "status"), /stopped/);
  assert.match(invoke(directory, "web"), /^http:\/\/127\.0\.0\.1:/);
  assert.match(invoke(directory, "daemon", "status"), /running/);
  assert.match(invoke(directory, "daemon", "stop"), /stopped/);
});

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}
