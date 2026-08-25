import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { controlStream, replayTranscript, wakeStream, type ActionSnapshot, type Clock, type EventInput, type GoalSnapshot, type JsonValue, type WakeSnapshot } from "goah-ledger-contract";
import { SQLITE_SCHEMA_VERSION, SqliteLedger } from "./index.js";

const metric = { source: "test", window: "1h", direction: "at_least" as const, target: 1, freshnessMs: 60_000, onMissing: "abnormal" as const, onStale: "wake_owner" as const };
function event(actor: string, type: string, data: JsonValue = {}, wakeId?: string): EventInput { return { streamId: wakeId ? wakeStream(wakeId) : controlStream(actor), ts: "2030-01-01T00:00:00.000Z", actor, type, data }; }
class FixedClock implements Clock { constructor(readonly value = "2030-01-01T00:00:00.000Z") {} now(): Date { return new Date(this.value); } }
function wake(id: string, agent = "agent-1"): WakeSnapshot { return { id, agent, triggerRef: `trigger:${id}`, status: "queued", attempt: 0, enqueuedSeq: 0, claimedAt:null,consumedAt:null,turnId:null }; }
function action(id: string, evidence: number[],createdInTurn="turn-a"): ActionSnapshot { return { id, agent: "a", createdInTurn,kind: "mock.write", connector: "mock", payload: {}, reason: "evidence supports it", evidence, gated: false, status: "requested", reconciledAt: null, externalRef: null, auditAdvice: null, adviceAcked: false }; }

test("Thread Turn and Item projections form one resumable execution history", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() }); const now = "2030-01-01T00:00:00.000Z";
  ledger.putThread({ id: "thread", agent: "ceo", parentThreadId: null, createdAt: now, updatedAt: now }, "supervisor");
  ledger.putTurn({ id: "turn", threadId: "thread", source: "human", goalId: null, goalRevision: null, status: "in_progress", attempt:1,error: null, startedAt: now, endedAt: null, leaseUntil: "2030-01-01T00:10:00.000Z", leaseToken: "lease", runnerPid: null }, "human");
  ledger.putTurnItem({ id: "user", turnId: "turn", ordinal: 1, type: "user_message", status: "completed", data: { text: "hello" }, createdAt: now, completedAt: now }, "human");
  ledger.putTurnItem({ id: "assistant", turnId: "turn", ordinal: 2, type: "assistant_message", status: "completed", data: { text: "hi" }, createdAt: now, completedAt: now }, "ceo");
  ledger.putTurn({ ...ledger.turn("turn")!, status: "completed", endedAt: now, leaseUntil:null,leaseToken:null,runnerPid:null }, "supervisor");
  assert.equal(ledger.activeTurn("thread"), null); assert.equal(ledger.turns("thread").length, 1); assert.deepEqual(ledger.turnItems("turn").map((item) => item.type), ["user_message", "assistant_message"]);
  ledger.close();
});

test("terminal Turns reject late Items and active Turn control events remain replayable",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});const turn=activeTurn(ledger,"ceo","t");ledger.appendTurnEvent({streamId:"turn:t",ts:new FixedClock().value,actor:"ceo",type:"transcript.started",data:{formatVersion:1,provider:"f",model:"m",runner:"r",contextWindowTokens:1,maxOutputTokensPerTurn:1}},"lease");ledger.renewTurnLease("t","lease","2030-01-01T00:20:00.000Z",new FixedClock().value);assert.equal(replayTranscript(ledger.readStream("turn:t")).status,"running");ledger.putTurn({...turn,status:"completed",endedAt:new FixedClock().value,leaseUntil:null,leaseToken:null,runnerPid:null},"supervisor");assert.throws(()=>ledger.putTurnItem({id:"late",turnId:"t",ordinal:1,type:"assistant_message",status:"completed",data:{text:"late"},createdAt:new FixedClock().value,completedAt:new FixedClock().value},"ceo"),/terminal turn/i);ledger.close();});

test("Turn failure atomically repairs open Items and commits its Transcript terminal",()=>{let armed=false;const ledger=new SqliteLedger(":memory:",{clock:new FixedClock(),faultInjector:()=>{if(armed)throw new Error("crash during terminal")}});activeTurn(ledger,"ceo","t");ledger.appendTurnEvent({streamId:"turn:t",ts:new FixedClock().value,actor:"ceo",type:"transcript.started",data:{formatVersion:1,provider:"f",model:"m",runner:"r",contextWindowTokens:1,maxOutputTokensPerTurn:1}},"lease");ledger.putTurnItem({id:"call",turnId:"t",ordinal:1,type:"tool_call",status:"in_progress",data:{callId:"c",tool:"write"},createdAt:new FixedClock().value,completedAt:null},"ceo");const before=JSON.stringify({turn:ledger.turn("t"),items:ledger.turnItems("t"),events:ledger.readStream("turn:t")});armed=true;assert.throws(()=>ledger.finishTurn("t","failed",{message:"boom"},new FixedClock().value,"supervisor"),/crash during terminal/);assert.equal(JSON.stringify({turn:ledger.turn("t"),items:ledger.turnItems("t"),events:ledger.readStream("turn:t")}),before);armed=false;ledger.finishTurn("t","failed",{message:"boom"},new FixedClock().value,"supervisor");assert.deepEqual(ledger.turnItems("t").map((item)=>[item.type,item.status]),[["tool_call","failed"],["tool_result","completed"]]);assert.equal(replayTranscript(ledger.readStream("turn:t")).status,"interrupted");ledger.close();});

test("Goal completion requires non-empty evidence",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"g",parentId:null,objective:"ship",observationMethod:"inspect",verificationMethod:"verify",owner:"ceo",phase:"active",revision:0},"human");assert.throws(()=>ledger.completeGoal({goalId:"g",revision:0,reason:"done",evidence:[]},"human"),/evidence is required/);ledger.close();});

test("pre-v12 development schemas are rejected explicitly", () => {
  for(const version of [1,6,9,10,11]){const path=join(mkdtempSync(join(tmpdir(),`goah-retired-${version}-`)),"ledger.sqlite");const raw=new DatabaseSync(path);raw.exec(`PRAGMA user_version=${version}`);raw.close();assert.throws(()=>new SqliteLedger(path,{clock:new FixedClock()}),/predates Turn-owned execution/);}
});

test("event and projection roll back together at the injected transaction boundary", () => {
  const ledger = new SqliteLedger(":memory:", { faultInjector: () => { throw new Error("kill -9"); }, clock: new FixedClock() });
  assert.throws(() => ledger.putSchedule({ id: "s1", agent: "a", nextWakeAt: "2030-01-01T00:00:00.000Z", reason: "test", setBy: "a" }, "a"), /kill -9/);
  assert.deepEqual(ledger.events(), []);
  assert.deepEqual(ledger.schedules(), []);
  ledger.close();
});

test("global event order and per-stream order are both monotonic", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  const records = ledger.appendEvents([event("a", "one"), event("b", "other"), { ...event("a", "two"), ignorable: true }]);
  assert.deepEqual(records.map((record) => record.seq), [1, 2, 3]);
  assert.deepEqual(ledger.readStream(controlStream("a")).map((record) => record.streamSeq), [1, 2]);
  assert.equal(ledger.readStream(controlStream("a"))[1]?.ignorable, true);
  assert.deepEqual(ledger.readStream(controlStream("b")).map((record) => record.streamSeq), [1]);
  ledger.close();
});

test("schema has events plus six projections and replay reproduces all of them", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  const tables = (ledger.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('actions','events','goals','mailbox','schedule','wakes','work_records') ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(tables, ["actions", "events", "goals", "mailbox", "schedule", "wakes", "work_records"]);
  const root: GoalSnapshot = { id: "root", parentId: null, objective: "keep tests green", observationMethod: null, verificationMethod: null, owner: "agent-1", phase: "active", revision: 0 };
  ledger.putGoal(root, "human");
  ledger.putSchedule({ id: "s1", agent: "agent-1", nextWakeAt: "2030-01-01T00:00:00.000Z", reason: "start", setBy: "agent-1" }, "agent-1");
  ledger.enqueueWake(wake("w1"), "supervisor");
  ledger.putMail({ id: "m1", to: "agent-1", from: "human", level: "decision", body: {}, readAt: null }, "human");
  const evidence = ledger.appendEvent(event("a", "observed"));
  activeTurn(ledger,"a","turn-a");
  ledger.requestAction(action("a1", [evidence.seq]), "a");
  const before = JSON.stringify({ goals: ledger.goals(), schedules: ledger.schedules(), wakes: ledger.wakes(), mailbox: ledger.mailbox(), actions: ledger.actions() });
  ledger.rebuildProjections();
  assert.equal(JSON.stringify({ goals: ledger.goals(), schedules: ledger.schedules(), wakes: ledger.wakes(), mailbox: ledger.mailbox(), actions: ledger.actions() }), before);
  assert.throws(() => ledger.db.prepare("DELETE FROM events").run(), /append-only/);
  ledger.close();
});

test("Wake queue is FIFO, deduplicated, claimable, and linked to a Turn", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.enqueueWake(wake("zzz", "a"), "supervisor");
  ledger.enqueueWake(wake("aaa", "b"), "supervisor");
  assert.equal(ledger.enqueueWake({ ...wake("duplicate", "a"), triggerRef: "trigger:zzz" }, "supervisor").created, false);
  ledger.appendEvent(event("supervisor", "wake.trigger_coalesced", { wakeId: "zzz", triggerRef: "trigger:alias" }, "zzz"));
  assert.equal(ledger.wakeByTrigger("a", "trigger:alias")?.id, "zzz");
  assert.equal(ledger.enqueueWake({ ...wake("alias", "a"), triggerRef: "trigger:alias" }, "supervisor").created, false);
  const first = ledger.claimNextWake("2030-01-01T00:00:00.000Z");
  assert.equal(first?.id, "zzz");
  const turn=activeTurn(ledger,"a","turn-zzz");ledger.consumeWake("zzz",turn.id,"2030-01-01T00:00:01.000Z");
  assert.equal(ledger.wake("zzz")?.turnId,turn.id);
  assert.equal(ledger.claimNextWake("2030-01-01T00:00:02.000Z")?.id, "aaa");
  ledger.close();
});

test("Goal and system wakes preserve FIFO while active ownership stays per Agent", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.enqueueWake({ ...wake("goal", "ceo"), triggerRef: "schedule:ceo" }, "supervisor");
  ledger.enqueueWake({ ...wake("review", "ceo"), triggerRef: "mail:review" }, "supervisor");
  ledger.enqueueWake({ ...wake("child", "other"), triggerRef: "goal:child" }, "supervisor");
  assert.equal(ledger.claimNextWake("2030-01-01T00:00:00.000Z")?.id, "goal");
  assert.equal(ledger.claimNextWake("2030-01-01T00:00:00.000Z")?.id, "child");
  ledger.close();
});

test("actions require real evidence and support approval plus audit delivery", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  activeTurn(ledger,"a","turn-a");
  assert.throws(() => ledger.requestAction(action("bad", [999_999]), "a"), /does not exist/);
  const evidence = ledger.appendEvent(event("a", "observed"));
  ledger.requestAction(action("a1", [evidence.seq]), "a");
  assert.throws(() => ledger.requestAction(action("spoof", [evidence.seq]), "other"), /actor/);
  assert.equal(ledger.approveAction("a1", "human", "approved", [evidence.seq]).status, "approved");
  ledger.transitionAction("a1", "dispatching");
  assert.equal(ledger.recoverDispatchingActions()[0]?.status, "unknown");
  assert.throws(() => ledger.transitionAction("a1", "confirmed"), /reconciliation/);
  ledger.transitionAction("a1", "confirmed", { reconciledAt: "2030-01-01T00:01:00.000Z" });
  ledger.putAuditAdvice("a1", { by: "verifier", body: { issue: "check" }, evidence: [evidence.seq] });
  assert.equal(ledger.unackedAuditAdvice("a").length, 1);
  ledger.ackAuditAdvice("a1", "a");
  assert.equal(ledger.unackedAuditAdvice("a").length, 0);
  ledger.close();
});

test("mail is acknowledged only by an atomic successful handoff", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.enqueueWake(wake("w"), "supervisor");
  ledger.claimNextWake("2030-01-01T00:00:00.000Z");const turn=activeTurn(ledger,"agent-1","turn-w");ledger.consumeWake("w",turn.id,"2030-01-01T00:00:01.000Z");
  ledger.putMail({ id: "m", to: "agent-1", from: "human", level: "emergency", body: {}, readAt: null }, "human");
  ledger.putMail({ id: "later", to: "agent-1", from: "human", level: "decision", body: {}, readAt: null }, "human");
  assert.equal(ledger.unreadMail("agent-1").length, 2);
  ledger.commitHandoff(handoffCommit(turn.id,"w",["m"]));
  assert.deepEqual(ledger.unreadMail("agent-1").map((mail) => mail.id), ["later"]);
  assert.equal(ledger.turn(turn.id)?.status,"completed");assert.equal(ledger.readStream(`turn:${turn.id}`).some((event)=>event.type==="transcript.completed"),true);
  ledger.close();
});

test("handoff event and mail acknowledgement roll back together", () => {
  let armed = false;
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock(), faultInjector: () => { if (armed) throw new Error("kill during handoff"); } });
  ledger.enqueueWake(wake("w"), "supervisor");
  ledger.claimNextWake("2030-01-01T00:00:00.000Z");const turn=activeTurn(ledger,"agent-1","turn-w");ledger.consumeWake("w",turn.id,"2030-01-01T00:00:01.000Z");
  ledger.putMail({ id: "m", to: "agent-1", from: "human", level: "emergency", body: {}, readAt: null }, "human");
  const before = JSON.stringify(ledger.events());
  armed = true;
  assert.throws(() => ledger.commitHandoff(handoffCommit(turn.id,"w",["m"])), /kill during handoff/);
  assert.equal(JSON.stringify(ledger.events()), before);
  assert.equal(ledger.unreadMail("agent-1").length, 1);
  ledger.close();
});

test("injected clock is authoritative and newer schemas are rejected", () => {
  const clock = new FixedClock("2020-01-01T00:00:00.000Z");
  const ledger = new SqliteLedger(":memory:", { clock });
  assert.equal(ledger.putSchedule({ id: "s", agent: "a", nextWakeAt: clock.value, reason: "r", setBy: "a" }, "a").ts, clock.value);
  assert.equal((ledger.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5_000);
  ledger.close();

  const path = join(mkdtempSync(join(tmpdir(), "goah-schema-")), "ledger.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version=99");
  raw.close();
  assert.throws(() => new SqliteLedger(path), /newer than supported/);
});

test("goal parent cannot be changed during an update", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "p1", parentId: null, objective: "p1", observationMethod: null, verificationMethod: null, owner: "owner", phase: "active", revision: 0 }, "human");
  ledger.putGoal({ id: "p2", parentId: null, objective: "p2", observationMethod: null, verificationMethod: null, owner: "other", phase: "active", revision: 0 }, "human");
  ledger.putGoal({ id: "child", parentId: "p1", objective: "c", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "child", phase: "active", revision: 0 }, "owner");
  assert.throws(() => ledger.putGoal({ id: "child", parentId: "p2", objective: "c", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "child", phase: "active", revision: 1 }, "owner"), /reparenting/);
  ledger.close();
});

test("goal phases are constrained by both contract and SQLite", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  const method = "Inspect a fresh shipping evidence event.";
  ledger.putGoal({ id: "root", parentId: null, objective: "ship", observationMethod: method, verificationMethod: method, owner: "owner", phase: "active", revision: 0 }, "human");
  ledger.putGoal({ id: "root", parentId: null, objective: "ship", observationMethod: method, verificationMethod: method, owner: "owner", phase: "paused", revision: 1 }, "human");
  ledger.putGoal({ id: "root", parentId: null, objective: "ship", observationMethod: method, verificationMethod: method, owner: "owner", phase: "active", revision: 2 }, "human");
  const evidence = ledger.appendEvent(event("owner", "shipping.observed", { ok: true }));
  ledger.completeGoal({ goalId: "root", revision: 2, reason: "shipping observation passed", evidence: [evidence.seq] }, "human");
  assert.throws(() => ledger.putGoal({ id: "root", parentId: null, objective: "ship", observationMethod: method, verificationMethod: method, owner: "owner", phase: "active", revision: 4 }, "human"), /completed goal/);
  assert.throws(() => ledger.db.prepare("UPDATE goals SET phase='active' WHERE id='root'").run(), /invalid goal transition/);
  ledger.close();
});

test("human root completion waits for every descendant to complete", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "root", parentId: null, objective: "company", observationMethod: "Inspect all child completion evidence.", verificationMethod: "Inspect all child completion evidence.", owner: "ceo", phase: "active", revision: 0 }, "human");
  ledger.putGoal({ id: "child", parentId: "root", objective: "research", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "research", phase: "active", revision: 0 }, "ceo");
  const childEvidence = ledger.appendEvent(event("research", "research.observed", { complete: true }));
  assert.throws(() => ledger.completeGoal({ goalId: "root", revision: 0, reason: "done", evidence: [childEvidence.seq] }, "human"), /descendants/);
  assert.throws(() => ledger.completeGoal({ goalId: "root", revision: 0, reason: "done", evidence: [childEvidence.seq] }, "ceo"), /only human/);
  ledger.completeGoal({ goalId: "child", revision: 0, reason: "research observed", evidence: [childEvidence.seq] }, "ceo");
  const rootEvidence = ledger.appendEvent(event("ceo", "organization.observed", { complete: true }));
  ledger.completeGoal({ goalId: "root", revision: 0, reason: "all descendants observed", evidence: [rootEvidence.seq] }, "human");
  assert.equal(ledger.goal("root")?.phase, "complete");
  ledger.close();
});

test("Goal observation and verification methods are durable, revisioned, and required for children", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "root", parentId: null, objective: "grow revenue", observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 0 }, "human");
  assert.equal(ledger.goal("root")?.observationMethod, null);
  assert.throws(() => ledger.putGoal({ id: "child", parentId: "root", objective: "find baseline", observationMethod: null, verificationMethod: null, owner: "analyst", phase: "active", revision: 0 }, "ceo"), /observation method/);
  assert.throws(() => ledger.putGoal({ id: "child", parentId: "root", objective: "find baseline", observationMethod: "Read the baseline report.", verificationMethod: null, owner: "analyst", phase: "active", revision: 0 }, "ceo"), /verification method/);
  ledger.putGoal({ id: "root", parentId: null, objective: "grow net revenue", observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 1 }, "human");
  ledger.putGoal({ id: "root", parentId: null, objective: "grow net revenue", observationMethod: "Run the revenue report every six hours.", verificationMethod: "Run the revenue report every six hours.", owner: "ceo", phase: "active", revision: 2 }, "human");
  assert.throws(() => ledger.putGoal({ id: "root", parentId: null, objective: "grow gross revenue", observationMethod: "Run the revenue report every six hours.", verificationMethod: "Run the revenue report every six hours.", owner: "ceo", phase: "active", revision: 3 }, "human"), /replace or invalidate/);
  const before = ledger.goal("root");
  ledger.rebuildProjections();
  assert.deepEqual(ledger.goal("root"), before);
  ledger.close();
});

test("Work Records are versioned Goal documents backed by replayable events", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "root", parentId: null, objective: "ship", observationMethod: "Inspect the release.", verificationMethod: "Run the release smoke test.", owner: "ceo", phase: "active", revision: 0 }, "human");
  const initial = ledger.workRecord("root");
  assert.equal(initial?.recordRevision, 0);
  assert.equal(initial?.goalRevision, 0);
  assert.match(initial?.content ?? "", /Goal created/);

  const evidence = ledger.appendEvent(event("ceo", "release.observed", { ok: true }));
  const turn=activeTurn(ledger,"ceo","turn-1");ledger.putTurn({...turn,goalId:"root",goalRevision:0},"supervisor");
  const updated = ledger.updateWorkRecord({ goalId: "root", expectedRevision: 0, goalRevision: 0, content: "# Current State\n\nRelease candidate verified.\n\n# Observations\n\nSmoke test passed.\n\n# Work Completed\n\nPrepared release.\n\n# Decisions\n\nShip.\n\n# Blockers\n\nNone.\n\n# Next Steps\n\nPublish.\n", reason: "record verified release state", evidence: [evidence.seq], turnId: "turn-1", sourceWakeId: "wake-1" }, "ceo");
  assert.equal(updated.recordRevision, 1);
  assert.equal(updated.lastEventSeq > evidence.seq, true);
  assert.deepEqual(ledger.workRecordHistory("root").map((record) => record.recordRevision), [0, 1]);
  assert.match(ledger.workRecordDiff("root", 0, 1).text, /\+Release candidate verified/);
  assert.equal(ledger.searchWorkRecords("Release").some((record) => record.goalId === "root"), true);
  assert.throws(() => ledger.updateWorkRecord({ goalId: "root", expectedRevision: 0, goalRevision: 0, content: "stale", reason: "stale", evidence: [evidence.seq], turnId: "turn-1" }, "ceo"), /CAS/);
  assert.throws(() => ledger.updateWorkRecord({ goalId: "root", expectedRevision: 1, goalRevision: 0, content: "unauthorized", reason: "unauthorized", evidence: [evidence.seq], turnId: "turn-1" }, "other"), /owner/);

  const before = ledger.workRecord("root");
  ledger.rebuildProjections();
  assert.deepEqual(ledger.workRecord("root"), before);
  ledger.close();
});

test("Goal completion requires current-revision observation evidence", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  const oldEvidence = ledger.appendEvent(event("human", "observation.old", { ok: true }));
  ledger.putGoal({ id: "root", parentId: null, objective: "publish", observationMethod: "Inspect the published artifact and cite the observation.", verificationMethod: "Inspect the published artifact and cite the observation.", owner: "ceo", phase: "active", revision: 0 }, "human");
  assert.throws(() => ledger.completeGoal({ goalId: "root", revision: 0, reason: "old evidence", evidence: [oldEvidence.seq] }, "human"), /predates/);
  assert.throws(() => ledger.completeGoal({ goalId: "root", revision: 1, reason: "stale revision", evidence: [oldEvidence.seq] }, "human"), /stale/);
  const fresh = ledger.appendEvent(event("ceo", "artifact.observed", { published: true }));
  const completed = ledger.completeGoal({ goalId: "root", revision: 0, reason: "artifact inspection passed", evidence: [fresh.seq] }, "human");
  assert.equal(completed.phase, "complete");
  assert.deepEqual((ledger.events().find((item) => item.type === "goal.completion_decided")?.data as { evidence: number[] }).evidence, [fresh.seq]);
  ledger.close();
});

test("completion decision and Goal projection roll back together", () => {
  let armed = false;
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock(), faultInjector: () => { if (armed) throw new Error("kill during completion"); } });
  ledger.putGoal({ id: "root", parentId: null, objective: "publish", observationMethod: "Inspect the published artifact.", verificationMethod: "Inspect the published artifact.", owner: "ceo", phase: "active", revision: 0 }, "human");
  const evidence = ledger.appendEvent(event("ceo", "artifact.observed", { published: true }));
  const before = JSON.stringify(ledger.events());
  armed = true;
  assert.throws(() => ledger.completeGoal({ goalId: "root", revision: 0, reason: "artifact passed", evidence: [evidence.seq] }, "human"), /kill during completion/);
  assert.equal(JSON.stringify(ledger.events()), before);
  assert.equal(ledger.goal("root")?.phase, "active");
  ledger.close();
});

test("delegation atomically commits its fact, child goal, decision mail, and wake", () => {
  for (const failAt of [1, 2, 3, 4, 5]) {
    let armed = false;
    let calls = 0;
    const ledger = new SqliteLedger(":memory:", { clock: new FixedClock(), faultInjector: () => { if (armed && ++calls === failAt) throw new Error(`kill delegation ${failAt}`); } });
    ledger.putGoal({ id: "root", parentId: null, objective: "operate", observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 0 }, "human");
    const evidence = ledger.appendEvent(event("ceo", "observation", { fact: true }));
    const before = JSON.stringify({ events: ledger.events(), goals: ledger.goals(), mail: ledger.mailbox(), wakes: ledger.wakes() });
    armed = true;
    assert.throws(() => ledger.commitDelegation({ id: "d1", parentGoalId: "root", childGoal: { id: "research", objective: "research market", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "researcher" }, brief: { deliverable: "report" }, reason: "independent evidence boundary", evidence: [evidence.seq] }, "ceo"), /kill delegation/);
    assert.equal(JSON.stringify({ events: ledger.events(), goals: ledger.goals(), mail: ledger.mailbox(), wakes: ledger.wakes() }), before, `fault point ${failAt}`);
    ledger.close();
  }

  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "root", parentId: null, objective: "operate", observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 0 }, "human");
  const evidence = ledger.appendEvent(event("ceo", "observation", { fact: true }));
  const request = { id: "d1", parentGoalId: "root", childGoal: { id: "research", objective: "research market", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "researcher" }, brief: { deliverable: "report" }, reason: "independent evidence boundary", evidence: [evidence.seq] };
  const result = ledger.commitDelegation(request, "ceo");
  assert.equal(result.goal.parentId, "root");
  assert.equal(result.goal.verificationMethod, request.childGoal.verificationMethod);
  assert.equal(ledger.workRecord(result.goal.id)?.recordRevision, 0);
  assert.equal(result.mail.level, "decision");
  assert.equal(result.wake.status, "queued");
  assert.equal(ledger.events().filter((item) => item.type === "delegation.created").length, 1);
  assert.deepEqual(ledger.commitDelegation(request, "ceo"), result);
  assert.throws(() => ledger.commitDelegation({ ...request, childGoal: { ...request.childGoal, owner: "other" } }, "ceo"), /reused/);
  const beforeMissingMethod = JSON.stringify({ events: ledger.events(), goals: ledger.goals(), mail: ledger.mailbox(), wakes: ledger.wakes() });
  assert.throws(() => ledger.commitDelegation({ ...request, id: "missing-method", childGoal: { ...request.childGoal, id: "missing", observationMethod: "" } }, "ceo"), /incomplete/);
  assert.throws(() => ledger.commitDelegation({ ...request, id: "missing-verification", childGoal: { ...request.childGoal, id: "missing-verification", verificationMethod: "" } }, "ceo"), /incomplete/);
  assert.equal(JSON.stringify({ events: ledger.events(), goals: ledger.goals(), mail: ledger.mailbox(), wakes: ledger.wakes() }), beforeMissingMethod);
  ledger.close();
});

test("reassignment changes ownership, notifies both sides, and wakes only the new owner", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "root", parentId: null, objective: "operate", observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 0 }, "human");
  ledger.putGoal({ id: "launch", parentId: "root", objective: "launch", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "old", phase: "active", revision: 0 }, "ceo");
  ledger.enqueueWake(wake("old-wake", "old"), "supervisor");
  const evidence = ledger.appendEvent(event("ceo", "observation", { blocked: true }));
  const request = { id: "r1", goalId: "launch", newOwner: "new", brief: { constraint: "recover" }, reason: "old owner blocked", evidence: [evidence.seq] };
  const result = ledger.commitReassignment(request, "ceo");
  assert.equal(result.goal.owner, "new");
  assert.equal(result.goal.revision, 1);
  assert.deepEqual(result.mail.map((item) => item.to), ["old", "new"]);
  assert.equal(result.wake.agent, "new");
  assert.equal(ledger.wakes().some((item) => item.agent === "old" && item.status === "queued"), false);
  assert.equal(ledger.wake("old-wake")?.status, "cancelled");
  assert.deepEqual(ledger.commitReassignment(request, "ceo"), result);
  assert.throws(() => ledger.updateWorkRecord({ goalId: "launch", goalRevision: 1, expectedRevision: 0, content: "old owner write", reason: "stale owner", evidence: [evidence.seq], turnId: "old-turn" }, "old"), /owner/);
  const turn=activeTurn(ledger,"new","new-turn");ledger.putTurn({...turn,goalId:"launch",goalRevision:1},"supervisor");
  assert.equal(ledger.updateWorkRecord({ goalId: "launch", goalRevision: 1, expectedRevision: 0, content: "# Current State\n\nNew owner resumed work.\n", reason: "accept reassignment", evidence: [evidence.seq], turnId: "new-turn" }, "new").updatedBy, "new");
  ledger.close();
});

test("FTS searches event facts and actions keep payload policy external", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "root", parentId: null, objective: "generic policy", observationMethod: null, verificationMethod: null, owner: "a", phase: "active", revision: 0 }, "human");
  const evidence = ledger.appendEvent(event("a", "observation", { note: "uniquenebulafact" }));
  activeTurn(ledger,"a","turn-a");
  assert.equal(ledger.searchEvents("uniquenebulafact").map((event) => event.seq).includes(evidence.seq), true);
  ledger.requestAction({ ...action("generic", [evidence.seq]), payload: { domainSpecificPolicy: { quota: 60 } } }, "a");
  assert.equal(ledger.approveAction("generic", "human", "policy is handled outside the ledger", [evidence.seq]).status, "approved");
  ledger.close();
});

test("fault injection rolls back every Wake scheduling mutation point", () => {
  const cases: Array<{ name: string; setup(l: SqliteLedger): void; mutate(l: SqliteLedger): void }> = [
    { name: "enqueue", setup: () => undefined, mutate: (l) => { l.enqueueWake(wake("w"), "supervisor"); } },
    { name: "claim", setup: (l) => { l.enqueueWake(wake("w"), "supervisor"); }, mutate: (l) => { l.claimNextWake("2030-01-01T00:00:00.000Z"); } },
    { name: "release", setup: claimed, mutate: (l) => { l.releaseWake("w","2030-01-01T00:00:01.000Z"); } },
    { name: "cancel", setup: (l) => { l.enqueueWake(wake("w"),"supervisor"); }, mutate: (l) => { l.cancelWake("w","2030-01-01T00:00:01.000Z"); } },
    { name: "consume", setup: (l) => { claimed(l);activeTurn(l,"agent-1","turn-w"); }, mutate: (l) => { l.consumeWake("w","turn-w","2030-01-01T00:00:01.000Z"); } },
  ];
  for (const item of cases) {
    let armed = false;
    const ledger = new SqliteLedger(":memory:", { clock: new FixedClock(), faultInjector: () => { if (armed) throw new Error(`kill at ${item.name}`); } });
    item.setup(ledger);
    const before = JSON.stringify({ events: ledger.events(), wakes: ledger.wakes() });
    armed = true;
    assert.throws(() => item.mutate(ledger), /kill at/);
    assert.equal(JSON.stringify({ events: ledger.events(), wakes: ledger.wakes() }), before, item.name);
    ledger.close();
  }
});

test("fault injection rolls back every action, audit, and approval transition", () => {
  const targets = ["request", "approve", "reject", "dispatch", "dispatchFailed", "confirm", "unknown", "retry", "reconcileConfirmed", "reconcileFailed", "audit", "ack"] as const;
  for (const target of targets) {
    let armed = false;
    const ledger = new SqliteLedger(":memory:", { clock: new FixedClock(), faultInjector: () => { if (armed) throw new Error(`kill at ${target}`); } });
    const evidence = ledger.appendEvent(event("a", "observed"));
    activeTurn(ledger,"a","turn-a");
    if (target !== "request") ledger.requestAction(action("a", [evidence.seq]), "a");
    if (["dispatch", "dispatchFailed", "confirm", "unknown", "retry", "reconcileConfirmed", "reconcileFailed"].includes(target)) ledger.approveAction("a", "human", "ok", [evidence.seq]);
    if (["dispatchFailed", "confirm", "unknown", "retry", "reconcileConfirmed", "reconcileFailed"].includes(target)) ledger.transitionAction("a", "dispatching");
    if (["retry", "reconcileConfirmed", "reconcileFailed"].includes(target)) ledger.recoverDispatchingActions();
    if (target === "ack") ledger.putAuditAdvice("a", { by: "verifier", body: {}, evidence: [evidence.seq] });
    const before = JSON.stringify({ events: ledger.events(), actions: ledger.actions() });
    armed = true;
    const mutate = () => {
      if (target === "request") return ledger.requestAction(action("a", [evidence.seq]), "a");
      if (target === "approve") return ledger.approveAction("a", "human", "ok", [evidence.seq]);
      if (target === "reject") return ledger.rejectAction("a", "human", "no", [evidence.seq]);
      if (target === "dispatch") return ledger.transitionAction("a", "dispatching");
      if (target === "dispatchFailed") return ledger.transitionAction("a", "failed");
      if (target === "confirm") return ledger.transitionAction("a", "confirmed");
      if (target === "unknown") return ledger.recoverDispatchingActions();
      if (target === "retry") return ledger.transitionAction("a", "dispatching");
      if (target === "reconcileConfirmed") return ledger.transitionAction("a", "confirmed", { reconciledAt: "2030-01-01T00:01:00.000Z" });
      if (target === "reconcileFailed") return ledger.transitionAction("a", "failed", { reconciledAt: "2030-01-01T00:01:00.000Z" });
      if (target === "audit") return ledger.putAuditAdvice("a", { by: "verifier", body: {}, evidence: [evidence.seq] });
      return ledger.ackAuditAdvice("a", "a");
    };
    assert.throws(mutate, /kill at/);
    assert.equal(JSON.stringify({ events: ledger.events(), actions: ledger.actions() }), before, target);
    ledger.close();
  }
});

function claimed(ledger: SqliteLedger): void {
  ledger.enqueueWake(wake("w"), "supervisor");
  ledger.claimNextWake("2030-01-01T00:00:00.000Z");
}
function activeTurn(ledger:SqliteLedger,agent:string,id:string):import("goah-ledger-contract").TurnSnapshot{let thread=ledger.threads().find((candidate)=>candidate.agent===agent);if(!thread){const now="2030-01-01T00:00:00.000Z";thread={id:`thread:${agent}`,agent,parentThreadId:null,createdAt:now,updatedAt:now};ledger.putThread(thread,"supervisor");}const existing=ledger.turn(id);if(existing)return existing;const turn={id,threadId:thread.id,source:"system" as const,goalId:null,goalRevision:null,status:"in_progress" as const,attempt:1,error:null,startedAt:"2030-01-01T00:00:00.000Z",endedAt:null,leaseUntil:"2030-01-01T00:10:00.000Z",leaseToken:"lease",runnerPid:null};ledger.putTurn(turn,"supervisor");return turn;}
function handoffCommit(turnId:string,sourceWakeId:string|null,mailIds:string[]=[]):import("goah-ledger-contract").HandoffCommit{const ts="2030-01-01T00:00:02.000Z";const output={handoff:{observations:[],results:[],nextSteps:[]},mail:[],nextWakeAt:null};return{agent:"agent-1",turnId,sourceWakeId,mailIds,ts,output,outgoingMail:[],schedule:null,item:{id:`handoff:${turnId}`,turnId,ordinal:1,type:"handoff",status:"completed",data:output.handoff,createdAt:ts,completedAt:ts}};}
