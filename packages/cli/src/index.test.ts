import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { specialistAutomaticTarget,type Clock,type RunRequest,type Runner,type RunnerCandidateResult } from "goah-ledger-contract";
import { SqliteLedger } from "goah-ledger-sqlite";
import { Supervisor } from "goah-supervisor";
import { CONTROL_LINE_LIMIT,interactFrames,isTurnPresentationEvent,streamControl } from "./control.js";
import { welcomeSnapshot } from "./welcome.js";
import { controlAvailable, controlEndpoint, diagnoseConfig, loadConfig, persistRunnerProfile, profilePath, readDefaultRunnerProfile, redactValue, statusSnapshot,SupervisorLock } from "./index.js";

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
let completedMessageSequence=0;
function completedResult(request:RunRequest,text:string,id=`cli-test:assistant:${++completedMessageSequence}`):RunnerCandidateResult{request.emit({type:"message.assistant.completed",data:{message:{id,role:"assistant",content:[{type:"text",text}]},commitState:"committed"}});return{outcome:"completed",finalMessageId:id};}

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
  assert.match(invoke(directory, "login", "--help"), /goah login \[PROVIDER\]/);
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

test("configuration commands strip global options and close cleanly without a TTY", () => {
  const directory = repository();
  const configPath = join(directory, "custom-goah.json");
  invoke(directory, "init", "--provider", "faux", "--model", "faux-goah", "--config", configPath);
  const env = { ...process.env, GOAH_STATE_HOME: join(directory, "state") };
  for (const command of [["model", "--config", configPath], ["auth", "--config", configPath], ["setup", "--config", configPath]]) {
    const result = spawnSync(process.execPath, [cli, ...command], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires an interactive terminal/);
    assert.doesNotMatch(result.stderr, /unsettled top-level await/);
  }
  assert.match(invoke(directory, "model", "list", "--config", configPath), /faux\/faux-goah/);
});

test("profile persistence rolls the default back when the workspace write fails", () => {
  const previous = process.env.GOAH_STATE_HOME; const directory = mkdtempSync(join(tmpdir(), "goah-profile-rollback-")); process.env.GOAH_STATE_HOME = join(directory, "state");
  try {
    assert.throws(() => persistRunnerProfile({ id: "default", runner: "pi", config: { provider: "faux", model: "faux-goah" } }, join(directory, "missing", "goah.json")));
    assert.equal(existsSync(profilePath()), false);
  } finally { if (previous === undefined) delete process.env.GOAH_STATE_HOME; else process.env.GOAH_STATE_HOME = previous; }
});

test("profile persistence recovers an interrupted two-file transaction", () => {
  const previous = process.env.GOAH_STATE_HOME; const directory = mkdtempSync(join(tmpdir(), "goah-profile-recovery-")); const state = join(directory, "state"); const workspace = join(directory, "goah.config.json"); process.env.GOAH_STATE_HOME = state;
  try {
    const oldProfile = `${JSON.stringify({ id: "default", runner: "pi", config: { provider: "faux", model: "old" } }, null, 2)}\n`;
    const oldWorkspace = `${JSON.stringify({ version: 2, stateDir: join(directory, ".goah"), runnerProfiles: [] }, null, 2)}\n`;
    mkdirSync(state, { recursive: true }); writeFileSync(profilePath(), `${JSON.stringify({ id: "default", runner: "pi", config: { provider: "faux", model: "partial" } })}\n`); writeFileSync(workspace, oldWorkspace);
    writeFileSync(join(state, "profile-transaction.json"), `${JSON.stringify({ version: 1, snapshots: [{ path: profilePath(), content: Buffer.from(oldProfile).toString("base64") }, { path: workspace, content: Buffer.from(oldWorkspace).toString("base64") }] })}\n`);
    assert.equal((readDefaultRunnerProfile()!.config as { model: string }).model, "old");
    assert.equal(readFileSync(workspace, "utf8"), oldWorkspace);
    assert.equal(existsSync(join(state, "profile-transaction.json")), false);
  } finally { if (previous === undefined) delete process.env.GOAH_STATE_HOME; else process.env.GOAH_STATE_HOME = previous; }
});

test("profile persistence refuses concurrent writers", () => {
  const previous = process.env.GOAH_STATE_HOME; const directory = mkdtempSync(join(tmpdir(), "goah-profile-lock-")); process.env.GOAH_STATE_HOME = join(directory, "state");
  try {
    mkdirSync(`${profilePath()}.lock`, { recursive: true });
    assert.throws(() => persistRunnerProfile({ id: "default", runner: "pi", config: { provider: "faux", model: "faux-goah" } }, null), /Another Goah process/);
    assert.equal(existsSync(profilePath()), false);
    rmSync(`${profilePath()}.lock`, { recursive: true, force: true });
  } finally { if (previous === undefined) delete process.env.GOAH_STATE_HOME; else process.env.GOAH_STATE_HOME = previous; }
});

test("interactive stream follows redelivery wakes through recovery", async () => {
  const clock: Clock = { now: () => new Date("2026-08-25T00:00:00.000Z") }; const ledger = new SqliteLedger(":memory:", { clock }); let attempts = 0;
  const runner: Runner = { isolation: "process", prepare: (request) => { const attempt = ++attempts;const finalMessageId="recovered"; return { pid: null, begin: () => { if (attempt > 1) { request.emit({ type: "message.assistant.delta", data: { messageId:finalMessageId,delta: { type: "text_delta", delta: "recovered response" } } }); request.emit({ type: "message.assistant.completed", data: { message: { id:finalMessageId,role: "assistant", content: [{ type: "text", text: "recovered response" }] }, commitState: "committed" } }); } }, result: Promise.resolve(attempt === 1 ? { outcome: "abnormal", reason: "temporary provider failure" } : { outcome: "completed", finalMessageId }), terminate: async () => undefined }; }, terminateProcess: async () => undefined };
  const supervisor = new Supervisor(ledger, runner, clock, { turnRetryPolicy: { maxAttempts: 3, baseDelayMs: 0 } });
  const framesPromise = (async () => { const frames = []; for await (const frame of interactFrames("hello", supervisor, ledger)) frames.push(frame); return frames; })();
  const frames = await framesPromise;
  assert.equal(frames.filter((frame) => frame.type === "accepted").length, 1);
  assert.equal(frames.some((frame) => frame.type === "event" && (frame.event as { type?: string }).type === "message.assistant.completed"), true);
  assert.equal(frames.findLast((frame) => frame.type === "result")?.type,"result");
  ledger.close();
});

test("interactive stream terminates when a Human turn completes with a canonical Assistant Item", async () => {
  const clock: Clock = { now: () => new Date("2026-08-25T00:00:00.000Z") }; const ledger = new SqliteLedger(":memory:", { clock });
  const runner: Runner = { isolation: "process", prepare: (request) => ({ pid: null, begin: () => undefined, result: Promise.resolve(completedResult(request,"normal answer")), terminate: async () => undefined }), terminateProcess: async () => undefined };
  const supervisor = new Supervisor(ledger, runner, clock);
  const framesPromise = (async () => { const frames = []; for await (const frame of interactFrames("create a goal", supervisor, ledger)) frames.push(frame); return frames; })();
  const frames=await framesPromise;assert.equal(frames.some((frame)=>frame.type==="event"&&(frame.event as {type?:unknown;data?:unknown}).type==="message.assistant.completed"),true);assert.equal(frames.at(-1)?.type,"result"); ledger.close();
});

test("an already-aborted control stream returns without opening a socket",async()=>{const controller=new AbortController();controller.abort();await streamControl("/missing-goah-state",{op:"ping"},()=>undefined,controller.signal);});

test("an internal empty assistant message does not suppress the canonical final Item",async()=>{const clock:Clock={now:()=>new Date("2026-08-25T00:00:00.000Z")};const ledger=new SqliteLedger(":memory:",{clock});const runner:Runner={isolation:"process",prepare:(request)=>({pid:null,begin:()=>{request.emit({type:"message.assistant.completed",data:{message:{id:"empty",role:"assistant",content:[]},commitState:"committed"}});request.emit({type:"message.assistant.completed",data:{message:{id:"final",role:"assistant",content:[{type:"text",text:"final answer"}]},commitState:"committed"}});},result:Promise.resolve({outcome:"completed" as const,finalMessageId:"final"}),terminate:async()=>undefined}),terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);const frames=[];for await(const frame of interactFrames("hello",supervisor,ledger))frames.push(frame);assert.equal(ledger.turnItems((frames.find((frame)=>frame.type==="accepted") as {type:"accepted";turnId:string}).turnId).filter((item)=>item.type==="assistant_message").length,1);ledger.close();});

test("canonical streamed assistant text is not repeated in the terminal result",async()=>{const clock:Clock={now:()=>new Date("2026-08-25T00:00:00.000Z")};const ledger=new SqliteLedger(":memory:",{clock});const runner:Runner={isolation:"process",prepare:(request)=>({pid:null,begin:()=>request.emit({type:"message.assistant.completed",data:{message:{id:"hello",role:"assistant",content:[{type:"text",text:"  hello\r\n"}]},commitState:"committed"}}),result:Promise.resolve({outcome:"completed" as const,finalMessageId:"hello"}),terminate:async()=>undefined}),terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);const frames=[];for await(const frame of interactFrames("hello",supervisor,ledger))frames.push(frame);const result=frames.findLast((frame)=>frame.type==="result") as {type:"result";value:{response?:{content?:string}}};assert.equal(result.value.response,undefined);assert.equal(frames.filter((frame)=>frame.type==="event"&&(frame.event as {type?:unknown}).type==="message.assistant.completed").length,1);ledger.close();});

test("Turn presentation includes Handoff and transcript terminal events",()=>{assert.equal(isTurnPresentationEvent("handoff.recorded"),true);assert.equal(isTurnPresentationEvent("transcript.interrupted"),true);assert.equal(isTurnPresentationEvent("rpc.goal.get"),false);});

test("welcome snapshot restores ordinary Human conversation", async () => {
  const state = mkdtempSync(join(tmpdir(), "goah-welcome-conversation-")); const clock: Clock = { now: () => new Date("2026-08-25T00:00:00.000Z") }; const ledger = new SqliteLedger(join(state, "ledger.sqlite"), { clock });
  const runner: Runner = { isolation: "process", prepare: (request) => ({ pid: null, begin: () => undefined, result: Promise.resolve(completedResult(request,"restored answer")), terminate: async () => undefined }), terminateProcess: async () => undefined }; const supervisor = new Supervisor(ledger, runner, clock); const accepted = await supervisor.startHumanTurn("remember this question"); await supervisor.waitForTurn(accepted.turnId);const now=clock.now().toISOString();const ceo=ledger.threads().find((thread)=>thread.agent==="ceo")!;ledger.putThread({id:"child-thread",agent:"worker",role:"verifier",parentThreadId:ceo.id,createdAt:now,updatedAt:now},"supervisor");putSyntheticTurn(ledger,"worker","child-thread","child-turn",now);ledger.putTurnItem({id:"child-message",turnId:"child-turn",ordinal:1,type:"user_message",status:"completed",data:{text:"internal worker prompt"},createdAt:now,completedAt:now},"worker");ledger.putTurnItem({id:"child-answer",turnId:"child-turn",ordinal:2,type:"assistant_message",status:"completed",data:{text:"internal worker answer"},createdAt:now,completedAt:now},"worker");ledger.commitTurnResponse("child-turn","child-answer",now,"supervisor");ledger.close();
  assert.deepEqual(welcomeSnapshot(state, { runner: "pi", target: "test/model" }).conversation.map((row) => row.text), ["remember this question", "restored answer"]);
});

test("welcome snapshot excludes every Item from a failed Human Turn",()=>{const state=mkdtempSync(join(tmpdir(),"goah-welcome-provisional-"));const clock:Clock={now:()=>new Date("2030-01-01T00:00:00.000Z")};const ledger=new SqliteLedger(join(state,"ledger.sqlite"),{clock});const now=clock.now().toISOString();const thread={id:"ceo",agent:"ceo",role:"ceo" as const,parentThreadId:null,createdAt:now,updatedAt:now};ledger.putGoal({id:"g",parentId:null,objective:"g",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");const turn={id:"t",threadId:"ceo",triggerKind:"user_message" as const,goalId:null,goalRevision:null,status:"in_progress" as const,attempt:1,error:null,startedAt:now,endedAt:null,leaseUntil:"2030-01-01T00:10:00.000Z",leaseToken:"lease",runnerPid:null};ledger.admitHumanTurn({thread,turn,messageItem:{id:"human",turnId:"t",ordinal:1,type:"user_message",status:"completed",data:{text:"work"},createdAt:now,completedAt:now},replaceTurnId:null});ledger.commitTurnToGoal("t",{goalId:"g",goalRevision:0},"supervisor");ledger.putTurnItem({id:"provisional",turnId:"t",ordinal:2,type:"assistant_message",status:"completed",data:{text:"not committed"},createdAt:now,completedAt:now},"ceo");ledger.finishTurn("t","failed",{message:"Handoff rejected"},now,"supervisor");ledger.close();assert.deepEqual(welcomeSnapshot(state,{runner:"pi",target:"test/model"}).conversation,[]);});

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
  invoke(directory,"goal-create","--id","first-root","--owner","ceo","--objective","Coordinate the first handoff");
  const created = JSON.parse(invoke(directory, "goal-create", "--id", "first", "--parent","first-root","--owner", "worker", "--objective", "Complete the first handoff", "--observation-method","Inspect the fresh handoff.","--wake-now"));
  assert.equal(created.goal.id, "first");
  assert.equal(created.wake.status, "queued");
  const run = JSON.parse(invoke(directory, "run-once"));
  assert.equal(run.wake.status, "consumed");
  const wakeId = run.wake.id;const turnId=run.wake.turnId;
  const status = JSON.parse(invoke(directory, "status"));
  assert.equal(status.goals.some((goal:{id:string})=>goal.id==="first"),true);
  assert.equal(status.wakes.length, 1);
  assert.equal(status.wakes[0].status, "consumed");
  assert.equal(status.modelCapabilities.provider, "faux");
  assert.equal(status.recentHandoffs.length, 1);
  const threads = JSON.parse(invoke(directory, "thread", "list"));
  const workerThread = threads.find((thread: { turnCount: number }) => thread.turnCount === 1);
  assert.equal(workerThread.status, "idle");
  const threadId = workerThread.threadId;
  const detail = JSON.parse(invoke(directory, "thread", "show", "--config", "goah.config.json", threadId));
  assert.ok(detail.turns[0].items.length > 0);
  assert.equal(JSON.stringify(detail).includes("apiKey"), false);
  const context = JSON.parse(invoke(directory, "context", "show", turnId));
  assert.match(context.text, /Complete the first handoff/);
  const events = JSON.parse(invoke(directory, "events", "--stream", `turn:${turnId}`));
  assert.equal(events.some((event:{type:string})=>event.type==="transcript.completed"),true);
  const exportedPath = join(directory, "thread.json");
  const exported = JSON.parse(invoke(directory, "thread", "export", threadId, "--output", exportedPath));
  assert.equal(exported.redacted, true);
  assert.equal(JSON.parse(readFileSync(exportedPath, "utf8")).format, "goah.thread-export.v1");
  const queued = JSON.parse(invoke(directory, "wake", "worker", "--reason", "manual follow-up"));
  assert.equal(queued.wake.status, "queued");
  assert.equal(JSON.parse(invoke(directory, "run-once")).wake.status, "consumed");
  assert.equal(JSON.parse(invoke(directory, "status")).wakes.length, 2);
});

test("CLI rejects an unsupported legacy Ark provider", () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "ark-coding", "--model", "glm-test");
  const result = spawnSync(process.execPath, [cli, "run-once"], { cwd: directory, encoding: "utf8", env: { ...process.env, GOAH_STATE_HOME: join(tmpdir(), "goah-cli-test-state") } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Model not found/);
});

test("thread export redaction preserves structure while removing common secrets and home paths", () => {
  const redacted = redactValue({ token: "top-secret",leaseToken:"fencing-secret",lease_token:"snake-secret", nested: { text: `Bearer abcdef /Users/example key-abcdefghijklmnop ${process.env.HOME}` } }) as { token: string;leaseToken:string;lease_token:string;nested: { text: string } };
  assert.equal(redacted.token, "[REDACTED]");
  assert.equal(redacted.leaseToken,"[REDACTED]");assert.equal(redacted.lease_token,"[REDACTED]");
  assert.doesNotMatch(redacted.nested.text, /abcdef|abcdefghijklmnop/);
  if (process.env.HOME) assert.doesNotMatch(redacted.nested.text, new RegExp(process.env.HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("status reports model capabilities per Agent and keeps CEO as the primary summary",()=>{const clock:Clock={now:()=>new Date("2030-01-01T00:00:00.000Z")};const ledger=new SqliteLedger(":memory:",{clock});const now=clock.now().toISOString();ledger.putThread({id:"ceo-thread",agent:"ceo",role:"ceo",parentThreadId:null,createdAt:now,updatedAt:now},"supervisor");ledger.putThread({id:"worker-thread",agent:"worker",role:"verifier",parentThreadId:"ceo-thread",createdAt:now,updatedAt:now},"supervisor");for(const [agent,threadId,model] of [["ceo","ceo-thread","ceo-model"],["worker","worker-thread","worker-model"]] as const){const id=`${agent}-turn`;putSyntheticTurn(ledger,agent,threadId,id,now);ledger.appendTurnEvent({streamId:`turn:${id}`,ts:now,actor:agent,type:"transcript.started",data:{formatVersion:1,provider:agent,model,runner:"pi",contextWindowTokens:1,maxOutputTokensPerTurn:1}},id);const responseId=`${id}:answer`;ledger.putTurnItem({id:responseId,turnId:id,ordinal:ledger.turnItems(id).length+1,type:"assistant_message",status:"completed",data:{text:"done"},createdAt:now,completedAt:now},agent);ledger.commitTurnResponse(id,responseId,now,"supervisor");}const status=statusSnapshot(ledger) as {modelCapabilities:{model:string};modelCapabilitiesByAgent:Record<string,{model:string}>};assert.equal(status.modelCapabilities.model,"ceo-model");assert.deepEqual(Object.fromEntries(Object.entries(status.modelCapabilitiesByAgent).map(([agent,value])=>[agent,value.model])),{ceo:"ceo-model",worker:"worker-model"});ledger.close();});

test("CLI exposes the complete goal lifecycle with revisioned transitions", () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "faux", "--agent", "worker");
  invoke(directory,"goal-create","--id","lifecycle-root","--owner","ceo","--objective","Coordinate lifecycle work");
  invoke(directory, "goal-create", "--id", "lifecycle", "--parent","lifecycle-root","--owner", "worker", "--objective", "Initial objective", "--observation-method", "Accept a fresh evidence-backed handoff.");
  assert.equal(JSON.parse(invoke(directory, "goal-show", "lifecycle")).goal.revision, 0);
  const updated = JSON.parse(invoke(directory, "goal-update", "lifecycle", "--objective", "Updated objective", "--observation-method", "Inspect a fresh handoff for the updated objective.", "--verification-method", "Accept the fresh evidence-backed handoff."));
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
  assert.match(invokeFailure(directory, "goal-update", "lifecycle"), /requires objective, observation method, or verification method/);
  assert.match(invokeFailure(directory,"goal-update","lifecycle","--owner","other"),/atomic CEO reassignment/);
});

test("CLI runs a local operations goal without Git", () => {
  const directory = mkdtempSync(join(tmpdir(), "goah-operations-"));
  invoke(directory, "init", "--provider", "faux", "--agent", "operator");
  const doctor = JSON.parse(invoke(directory, "doctor", "--json"));
  assert.equal(doctor.ok, true);
  assert.match(doctor.checks.find((item: { name: string }) => item.name === "root").detail, /runner-owned local execution/);
  invoke(directory,"goal-create","--id","store-root","--owner","ceo","--objective","Coordinate storefront operations");
  invoke(directory, "goal-create", "--id", "store", "--parent","store-root","--owner", "operator", "--objective", "Open a storefront", "--observation-method","Inspect the storefront result.","--wake-now");
  assert.equal(JSON.parse(invoke(directory, "run-once")).wake.status, "consumed");
  assert.equal(JSON.parse(invoke(directory, "status")).wakes.length, 1);
});

test("CLI exposes one-objective CEO entry and coalesces human corrections", () => {
  const directory = repository();
  invoke(directory, "init", "--provider", "faux");
  const started = JSON.parse(invoke(directory, "goal", "start", "--id", "company", "--objective", "Launch a company"));
  assert.equal(started.goal.owner, "ceo");
  assert.equal(started.wake.agent, "ceo");
  const sent = JSON.parse(invoke(directory, "ceo", "send", "--message", "Prioritize low inventory risk"));
  assert.equal(typeof sent.turnId,"string");
  assert.equal(sent.steered,false);
  const status = JSON.parse(invoke(directory, "ceo", "status"));
  assert.equal(status.root.id,"company");
  assert.equal(status.roots[0].id, "company");
  assert.equal(status.team.find((member: { agent: string }) => member.agent === "ceo").motion, "queued");
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
    const oversized=await new Promise<string>((resolveResponse,reject)=>{const socket=createConnection(controlEndpoint(config.stateDir));let response="";socket.on("connect",()=>socket.write("x".repeat(CONTROL_LINE_LIMIT+1)));socket.on("data",(chunk)=>{response+=chunk.toString();});socket.on("error",reject);socket.on("close",()=>resolveResponse(response));});
    assert.match(oversized,/exceeded 1 MB/);
    assert.equal(await controlAvailable(config.stateDir),true);
    const started = JSON.parse(invoke(directory, "goal", "start", "--id", "live", "--objective", "Grow revenue"));
    assert.equal(started.goal.observationMethod, null);
    const observed = JSON.parse(invoke(directory, "goal-update", "live", "--observation-method", "Run the net revenue report every six hours."));
    assert.match(observed.observationMethod, /net revenue/);
    const revised = JSON.parse(invoke(directory, "goal-update", "live", "--objective", "Grow retained net revenue"));
    assert.equal(revised.observationMethod, null);
    assert.equal(JSON.parse(invoke(directory, "ceo", "status")).roots[0].objective, "Grow retained net revenue");
    assert.match(invoke(directory, "Review the revised goal and propose a new observation method"), /Hello from Goah/);
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

function putSyntheticTurn(ledger:SqliteLedger,agent:string,threadId:string,id:string,now:string):void{const common={id,threadId,goalId:null,goalRevision:null,status:"in_progress" as const,attempt:1,error:null,startedAt:now,endedAt:null,leaseUntil:new Date(Date.parse(now)+600_000).toISOString(),leaseToken:id,runnerPid:null};if(agent==="ceo"){const turn={...common,triggerKind:"user_message" as const};const thread=ledger.thread(threadId)!;ledger.admitHumanTurn({thread,turn,messageItem:{id:`message:${id}`,turnId:id,ordinal:1,type:"user_message",status:"completed",data:{text:"synthetic"},createdAt:now,completedAt:now},replaceTurnId:null});return;}const wakeId=`wake:${id}`;ledger.enqueueWake({id:wakeId,...specialistAutomaticTarget(agent,"verifier"),triggerRef:`test:${id}`,status:"queued",attempt:0,enqueuedSeq:0,claimedAt:null,consumedAt:null,turnId:null},"supervisor");if(ledger.claimNextWake(now)?.id!==wakeId)throw new Error("test failed to claim synthetic Wake");ledger.startTurnFromWake(wakeId,{...common,triggerKind:"wake"},now);}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 25)); }
}
