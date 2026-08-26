import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { controlStream,goalStream, replayTranscript, wakeStream, type Clock, type EventInput, type GoalSnapshot, type JsonValue, type ScheduleSnapshot, type WakeSnapshot } from "goah-ledger-contract";
import { SQLITE_SCHEMA_VERSION, SqliteLedger } from "./index.js";

function event(actor: string, type: string, data: JsonValue = {}, wakeId?: string): EventInput { return { streamId: wakeId ? wakeStream(wakeId) : controlStream(actor), ts: "2030-01-01T00:00:00.000Z", actor, type, data }; }
class FixedClock implements Clock { constructor(readonly value = "2030-01-01T00:00:00.000Z") {} now(): Date { return new Date(this.value); } }
function wake(id: string, agent = "agent-1"): WakeSnapshot { return { id, agent, triggerRef: `trigger:${id}`, status: "queued", attempt: 0, enqueuedSeq: 0, claimedAt:null,consumedAt:null,turnId:null }; }
function schedule(id:string,agent="a",goal?:{goalId:string}):ScheduleSnapshot{return{id,agent,nextWakeAt:"2030-01-01T00:00:00.000Z",reason:"test",setBy:agent,status:"pending",resolvedAt:null,...(goal??{})};}

test("Thread Turn and Item projections form one resumable execution history", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() }); const now = "2030-01-01T00:00:00.000Z";
  ledger.putThread({ id: "thread", agent: "ceo", parentThreadId: null, createdAt: now, updatedAt: now }, "supervisor");
  ledger.putTurn({ id: "turn", threadId: "thread", source: "human", goalId: null, goalRevision: null, status: "in_progress", attempt:1,error: null, startedAt: now, endedAt: null, leaseUntil: "2030-01-01T00:10:00.000Z", leaseToken: "lease", runnerPid: null }, "human");
  ledger.putTurnItem({ id: "user", turnId: "turn", ordinal: 1, type: "user_message", status: "completed", data: { text: "hello" }, createdAt: now, completedAt: now }, "human");
  ledger.putTurnItem({ id: "assistant", turnId: "turn", ordinal: 2, type: "assistant_message", status: "completed", data: { text: "hi" }, createdAt: now, completedAt: now }, "ceo");
  ledger.finishTurn("turn","completed",null,now,"supervisor");
  assert.equal(ledger.activeTurn("thread"), null); assert.equal(ledger.turns("thread").length, 1); assert.deepEqual(ledger.turnItems("turn").map((item) => item.type), ["user_message", "assistant_message"]);
  ledger.close();
});

test("terminal Turns reject late Items and active Turn control events remain replayable",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});activeTurn(ledger,"ceo","t");ledger.appendTurnEvent({streamId:"turn:t",ts:new FixedClock().value,actor:"ceo",type:"transcript.started",data:{formatVersion:1,provider:"f",model:"m",runner:"r",contextWindowTokens:1,maxOutputTokensPerTurn:1}},"lease");ledger.renewTurnLease("t","lease","2030-01-01T00:20:00.000Z",new FixedClock().value);assert.equal(replayTranscript(ledger.readStream("turn:t")).status,"running");assert.throws(()=>ledger.putTurn({...ledger.turn("t")!,status:"failed",error:{message:"raw"},endedAt:new FixedClock().value,leaseUntil:null,leaseToken:null,runnerPid:null},"supervisor"),/finishTurn/);ledger.finishTurn("t","completed",null,new FixedClock().value,"supervisor");assert.throws(()=>ledger.putTurnItem({id:"late",turnId:"t",ordinal:1,type:"assistant_message",status:"completed",data:{text:"late"},createdAt:new FixedClock().value,completedAt:new FixedClock().value},"ceo"),/terminal turn/i);ledger.close();});

test("Turn failure atomically repairs open Items and commits its Transcript terminal",()=>{let armed=false;const ledger=new SqliteLedger(":memory:",{clock:new FixedClock(),faultInjector:()=>{if(armed)throw new Error("crash during terminal")}});activeTurn(ledger,"ceo","t");ledger.appendTurnEvent({streamId:"turn:t",ts:new FixedClock().value,actor:"ceo",type:"transcript.started",data:{formatVersion:1,provider:"f",model:"m",runner:"r",contextWindowTokens:1,maxOutputTokensPerTurn:1}},"lease");ledger.putTurnItem({id:"call",turnId:"t",ordinal:1,type:"tool_call",status:"in_progress",data:{callId:"c",tool:"write"},createdAt:new FixedClock().value,completedAt:null},"ceo");const before=JSON.stringify({turn:ledger.turn("t"),items:ledger.turnItems("t"),events:ledger.readStream("turn:t")});armed=true;assert.throws(()=>ledger.finishTurn("t","failed",{message:"boom"},new FixedClock().value,"supervisor"),/crash during terminal/);assert.equal(JSON.stringify({turn:ledger.turn("t"),items:ledger.turnItems("t"),events:ledger.readStream("turn:t")}),before);armed=false;ledger.finishTurn("t","failed",{message:"boom"},new FixedClock().value,"supervisor");assert.deepEqual(ledger.turnItems("t").map((item)=>[item.type,item.status]),[["tool_call","failed"],["tool_result","completed"]]);assert.equal(replayTranscript(ledger.readStream("turn:t")).status,"interrupted");ledger.close();});

test("Goal completion requires non-empty evidence",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"g",parentId:null,objective:"ship",observationMethod:"inspect",verificationMethod:"verify",owner:"ceo",phase:"active",revision:0},"human");assert.throws(()=>ledger.completeGoal({goalId:"g",revision:0,reason:"done",evidence:[]},"human"),/evidence is required/);ledger.close();});

test("pre-v19 development schemas are rejected explicitly", () => {
  for(const version of [1,6,9,10,11,15,16,17,18]){const path=join(mkdtempSync(join(tmpdir(),`goah-retired-${version}-`)),"ledger.sqlite");const raw=new DatabaseSync(path);raw.exec(`PRAGMA user_version=${version}`);raw.close();assert.throws(()=>new SqliteLedger(path,{clock:new FixedClock()}),/predates runtime schema 19/);}
});

test("event and projection roll back together at the injected transaction boundary", () => {
  const ledger = new SqliteLedger(":memory:", { faultInjector: () => { throw new Error("kill -9"); }, clock: new FixedClock() });
  assert.throws(() => ledger.putSchedule(schedule("s1"), "a"), /kill -9/);
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

test("schema has events plus the active projections and replay reproduces all of them", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  const tables = (ledger.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('actions','events','goals','mailbox','schedule','wakes','wake_triggers','work_records') ORDER BY name").all() as Array<{ name: string }>).map(({ name }) => name);
  assert.deepEqual(tables, ["events", "goals", "mailbox", "schedule", "wake_triggers", "wakes", "work_records"]);
  const root: GoalSnapshot = { id: "root", parentId: null, objective: "keep tests green", observationMethod: null, verificationMethod: null, owner: "agent-1", phase: "active", revision: 0 };
  ledger.putGoal(root, "human");
  ledger.putSchedule(schedule("s1","agent-1"), "agent-1");
  ledger.enqueueWake(wake("w1"), "supervisor");
  ledger.putMail({ id: "m1", to: "agent-1", from: "human", level: "decision", body: {}, readAt: null }, "human");
  const before = JSON.stringify({ goals: ledger.goals(), schedules: ledger.schedules(), wakes: ledger.wakes(),triggers:ledger.wakeTriggers("w1"), mailbox: ledger.mailbox() });
  ledger.rebuildProjections();
  assert.equal(JSON.stringify({ goals: ledger.goals(), schedules: ledger.schedules(), wakes: ledger.wakes(),triggers:ledger.wakeTriggers("w1"), mailbox: ledger.mailbox() }), before);
  assert.throws(() => ledger.db.prepare("DELETE FROM events").run(), /append-only/);
  ledger.close();
});

test("Wake queue is FIFO, deduplicated, claimable, and linked to a Turn", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.enqueueWake(wake("zzz", "a"), "supervisor");
  assert.deepEqual(ledger.wakeTriggers("zzz").map((trigger)=>[trigger.triggerRef,trigger.status]),[["trigger:zzz","pending"]]);
  assert.throws(()=>ledger.enqueueWake({...wake("zzz","b"),triggerRef:"different"},"supervisor"),/wake id/);
  ledger.enqueueWake(wake("aaa", "b"), "supervisor");
  assert.equal(ledger.enqueueWake({ ...wake("duplicate", "a"), triggerRef: "trigger:zzz" }, "supervisor").created, false);
  ledger.addWakeTrigger("zzz","trigger:alias","supervisor");
  assert.equal(ledger.wakeByTrigger("a", "trigger:alias")?.id, "zzz");
  assert.deepEqual(ledger.wakeTriggersForAgent("a").map((trigger)=>trigger.triggerRef),["trigger:zzz","trigger:alias"]);
  assert.equal(ledger.enqueueWake({ ...wake("alias", "a"), triggerRef: "trigger:alias" }, "supervisor").created, false);
  const first = ledger.claimNextWake("2030-01-01T00:00:00.000Z");
  assert.equal(first?.id, "zzz");
  ledger.addWakeTrigger("zzz","trigger:claimed","supervisor");
  const turn=activeTurn(ledger,"a","turn-zzz");ledger.consumeWake("zzz",turn.id,"2030-01-01T00:00:01.000Z");
  assert.equal(ledger.wake("zzz")?.turnId,turn.id);
  assert.equal(ledger.wakeTriggers("zzz").every((trigger)=>trigger.status==="resolved"),true);
  assert.equal(ledger.claimNextWake("2030-01-01T00:00:02.000Z")?.id, "aaa");
  ledger.close();
});

test("a claimed Wake cannot start after a Human Turn acquires priority",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putThread({id:"ceo-thread",agent:"ceo",parentThreadId:null,createdAt:new FixedClock().value,updatedAt:new FixedClock().value},"supervisor");ledger.putThread({id:"worker-thread",agent:"worker",parentThreadId:"ceo-thread",createdAt:new FixedClock().value,updatedAt:new FixedClock().value},"supervisor");ledger.enqueueWake(wake("w","worker"),"supervisor");ledger.claimNextWake(new FixedClock().value);ledger.putTurn({id:"human",threadId:"ceo-thread",source:"human",goalId:null,goalRevision:null,status:"in_progress",attempt:1,error:null,startedAt:new FixedClock().value,endedAt:null,leaseUntil:"2030-01-01T00:10:00.000Z",leaseToken:"human",runnerPid:null},"human");const automatic={id:"automatic",threadId:"worker-thread",source:"goal" as const,goalId:null,goalRevision:null,status:"in_progress" as const,attempt:1,error:null,startedAt:new FixedClock().value,endedAt:null,leaseUntil:"2030-01-01T00:10:00.000Z",leaseToken:"auto",runnerPid:null};assert.throws(()=>ledger.startTurnFromWake("w",automatic,new FixedClock().value),/Human Turn/);assert.equal(ledger.wake("w")?.status,"claimed");assert.equal(ledger.turn("automatic"),null);ledger.close();});

test("Goal and system wakes preserve FIFO while active ownership stays per Agent", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.enqueueWake({ ...wake("goal", "ceo"), triggerRef: "schedule:ceo" }, "supervisor");
  ledger.enqueueWake({ ...wake("review", "ceo"), triggerRef: "mail:review" }, "supervisor");
  ledger.enqueueWake({ ...wake("child", "other"), triggerRef: "goal:child" }, "supervisor");
  assert.equal(ledger.claimNextWake("2030-01-01T00:00:00.000Z")?.id, "goal");
  assert.equal(ledger.claimNextWake("2030-01-01T00:00:00.000Z")?.id, "child");
  ledger.close();
});

test("Schedule consumption atomically creates one Wake and reaches a terminal state",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"g",parentId:null,objective:"work",observationMethod:null,verificationMethod:null,owner:"a",phase:"active",revision:0},"human");ledger.putSchedule(schedule("s","a",{goalId:"g"}),"a");const scheduledWake={...wake("wake:s","a"),triggerRef:"s@2030-01-01T00:00:00.000Z",goalId:"g"};const result=ledger.consumeSchedule("s",scheduledWake,new FixedClock().value);assert.equal(result.schedule.status,"consumed");assert.equal(ledger.dueSchedules(new FixedClock().value).length,0);assert.equal(ledger.wakes().length,1);assert.throws(()=>ledger.consumeSchedule("s",scheduledWake,new FixedClock().value),/pending/);ledger.close();});

test("Schedule consumption coalesces with an existing queued Wake for the same Goal",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"g",parentId:null,objective:"work",observationMethod:null,verificationMethod:null,owner:"a",phase:"active",revision:0},"human");ledger.enqueueWake({...wake("existing","a"),goalId:"g"},"supervisor");ledger.putSchedule(schedule("s","a",{goalId:"g"}),"a");const trigger="s@2030-01-01T00:00:00.000Z";const result=ledger.consumeSchedule("s",{...wake("wake:s","a"),triggerRef:trigger,goalId:"g"},new FixedClock().value);assert.equal(result.wake.id,"existing");assert.equal(ledger.wakes().length,1);assert.equal(ledger.wakeByTrigger("a",trigger)?.id,"existing");ledger.close();});

test("Goal revision preserves pending Schedules as future execution opportunities",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"g",parentId:null,objective:"work",observationMethod:null,verificationMethod:null,owner:"a",phase:"active",revision:0},"human");ledger.putSchedule(schedule("s","a",{goalId:"g"}),"a");ledger.putGoal({id:"g",parentId:null,objective:"revised",observationMethod:null,verificationMethod:null,owner:"a",phase:"active",revision:1},"human");assert.equal(ledger.schedules()[0]?.status,"pending");assert.equal(ledger.dueSchedules(new FixedClock().value).length,1);ledger.close();});

test("a replacement Schedule supersedes the previous pending plan for the same Agent and Goal",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"g",parentId:null,objective:"work",observationMethod:null,verificationMethod:null,owner:"a",phase:"active",revision:0},"human");ledger.putSchedule(schedule("first","a",{goalId:"g"}),"a");ledger.putSchedule({...schedule("second","a",{goalId:"g"}),nextWakeAt:"2030-01-02T00:00:00.000Z"},"a");assert.deepEqual(ledger.schedules().map((item)=>[item.id,item.status]),[["first","superseded"],["second","pending"]]);ledger.close();});

test("mail is acknowledged only by an atomic successful handoff", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  const turn=goalTurn(ledger,"agent-1","turn-w");
  ledger.putMail({ id: "m", to: "agent-1", from: "human", level: "emergency", body: {}, readAt: null }, "human");
  ledger.putMail({ id: "later", to: "agent-1", from: "human", level: "decision", body: {}, readAt: null }, "human");
  assert.equal(ledger.unreadMail("agent-1").length, 2);
  ledger.commitHandoff(handoffCommit(ledger,turn.id,null,["m"]));
  assert.deepEqual(ledger.unreadMail("agent-1").map((mail) => mail.id), ["later"]);
  assert.equal(ledger.turn(turn.id)?.status,"completed");assert.equal(ledger.readStream(`turn:${turn.id}`).some((event)=>event.type==="transcript.completed"),true);
  ledger.close();
});

test("Mail identity is immutable and batch conflicts commit nothing",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});const original={id:"m",to:"a",from:"human",level:"decision" as const,body:{value:1},readAt:null};const first=ledger.putMail(original,"human");assert.equal(ledger.putMail(original,"human").seq,first.seq);assert.throws(()=>ledger.putMail({...original,to:"b"},"human"),/different content/);assert.throws(()=>ledger.putMails([{id:"new",to:"a",from:"human",level:"fyi",body:{},readAt:null},{...original,body:{value:2}}],"human"),/different content/);assert.equal(ledger.mailbox().some((mail)=>mail.id==="new"),false);ledger.close();});

test("Mail Goal routing is typed, immutable, and owned by the recipient",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"g",parentId:null,objective:"work",observationMethod:"o",verificationMethod:"v",owner:"a",phase:"active",revision:0},"human");const mail={id:"routed",to:"a",from:"sender",level:"decision" as const,goalId:"g",body:{goalId:"business-data"},readAt:null};ledger.putMail(mail,"sender");assert.equal(ledger.mailbox()[0]?.goalId,"g");assert.throws(()=>ledger.putMail({...mail,id:"wrong",to:"b"},"sender"),/not owned/);const{goalId:_,...unrouted}=mail;assert.throws(()=>ledger.putMail(unrouted,"sender"),/different content/);ledger.close();});

test("Goal-bound Turn cannot bypass Work Record and Handoff completion",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});const turn=goalTurn(ledger,"agent-1","goal-terminal");assert.throws(()=>ledger.finishTurn(turn.id,"completed",null,new FixedClock().value,"supervisor"),/commitHandoff/);assert.equal(ledger.turn(turn.id)?.status,"in_progress");ledger.close();});

test("Handoff rejects a contradictory Turn Item representation",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});const turn=goalTurn(ledger,"agent-1","goal-consistency","g");const commit=handoffCommit(ledger,turn.id,null);assert.throws(()=>ledger.commitHandoff({...commit,item:{...commit.item,data:{goalId:"other"}}}),/TurnOutput/);assert.equal(ledger.turn(turn.id)?.status,"in_progress");ledger.close();});

test("Handoff cannot reuse a Turn Item identity",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});const old=activeTurn(ledger,"agent-1","old","human");ledger.putTurnItem({id:"shared-item",turnId:old.id,ordinal:1,type:"assistant_message",status:"completed",data:{text:"old"},createdAt:new FixedClock().value,completedAt:new FixedClock().value},"agent-1");ledger.finishTurn(old.id,"completed",null,new FixedClock().value,"supervisor");const turn=goalTurn(ledger,"agent-1","goal-identities","g");const commit=handoffCommit(ledger,turn.id,null);assert.throws(()=>ledger.commitHandoff({...commit,item:{...commit.item,id:"shared-item"}}),/identity/);assert.equal(ledger.turn(turn.id)?.status,"in_progress");ledger.close();});

test("reading Mail preserves a coalesced Schedule trigger on the same Wake",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"g",parentId:null,objective:"work",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");ledger.putMail({id:"m",to:"ceo",from:"verifier",level:"decision",body:{},readAt:null},"verifier");ledger.enqueueWake({...wake("multi","ceo"),triggerRef:"mail:m",goalId:"g"},"supervisor");ledger.putSchedule(schedule("s","ceo",{goalId:"g"}),"ceo");ledger.consumeSchedule("s",{...wake("scheduled","ceo"),triggerRef:`s@${new FixedClock().value}`,goalId:"g"},new FixedClock().value);const human=activeTurn(ledger,"ceo","human","human");ledger.finishTurn(human.id,"completed",null,new FixedClock().value,"supervisor",["m"]);assert.equal(ledger.mailbox()[0]?.readAt!==null,true);assert.equal(ledger.schedules()[0]?.status,"consumed");assert.equal(ledger.wake("multi")?.status,"queued");ledger.close();});

test("handoff event and mail acknowledgement roll back together", () => {
  let armed = false;
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock(), faultInjector: () => { if (armed) throw new Error("kill during handoff"); } });
  const turn=goalTurn(ledger,"agent-1","turn-w");
  ledger.putMail({ id: "m", to: "agent-1", from: "human", level: "emergency", body: {}, readAt: null }, "human");
  const before = JSON.stringify(ledger.events());
  armed = true;
  assert.throws(() => ledger.commitHandoff(handoffCommit(ledger,turn.id,null,["m"])), /kill during handoff/);
  assert.equal(JSON.stringify(ledger.events()), before);
  assert.equal(ledger.unreadMail("agent-1").length, 1);
  ledger.close();
});

test("injected clock is authoritative and newer schemas are rejected", () => {
  const clock = new FixedClock("2020-01-01T00:00:00.000Z");
  const ledger = new SqliteLedger(":memory:", { clock });
  assert.equal(ledger.putSchedule(schedule("s"), "a").ts, clock.value);
  assert.equal((ledger.db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5_000);
  ledger.close();

  const path = join(mkdtempSync(join(tmpdir(), "goah-schema-")), "ledger.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA user_version=99");
  raw.close();
  assert.throws(() => new SqliteLedger(path), /newer than supported/);
});

test("schedule rejects invalid timestamps, unavailable Goal targets, and forged provenance",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});assert.throws(()=>ledger.putSchedule({...schedule("bad"),nextWakeAt:"not-a-date"},"a"),/valid time/);assert.throws(()=>ledger.putSchedule({...schedule("bad-target"),goalId:"g"},"a"),/inactive or owned/);assert.throws(()=>ledger.putSchedule({...schedule("forged"),setBy:"human"},"a"),/setBy/);ledger.close();});

test("schedule timestamps are normalized before lexical due-time queries",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putSchedule({...schedule("offset"),nextWakeAt:"2030-01-01T08:00:00+08:00"},"a");assert.equal(ledger.schedules()[0]?.nextWakeAt,new FixedClock().value);assert.equal(ledger.dueSchedules(new FixedClock().value).length,1);ledger.close();});

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

test("every Goal lifecycle mutation writes one authoritative goal.changed shape",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});const method="inspect";activeTurn(ledger,"ceo","turn:create","human");ledger.putGoal({id:"root",parentId:null,objective:"ship",observationMethod:method,verificationMethod:method,owner:"ceo",phase:"active",revision:0},"human",undefined,{operation:"create",reason:"Human requested shipping",evidence:[],authority:{kind:"human"},sourceTurnId:"turn:create"});ledger.putGoal({...ledger.goal("root")!,phase:"paused",revision:1},"human",undefined,{operation:"pause",reason:"wait",evidence:[],authority:{kind:"human"}});ledger.putGoal({...ledger.goal("root")!,phase:"active",revision:2},"human",undefined,{operation:"resume",reason:"continue",evidence:[],authority:{kind:"human"}});const evidence=ledger.appendEvent(event("human","observed",{}));ledger.completeGoal({goalId:"root",revision:2,reason:"verified",evidence:[evidence.seq],sourceTurnId:"turn:create"},"human");const changes=ledger.readStream(goalStream("root")).filter((event)=>event.type==="goal.changed").map((event)=>event.data as unknown as import("goah-ledger-contract").GoalChangedData);assert.deepEqual(changes.map((change)=>change.operation),["create","pause","resume","complete"]);assert.deepEqual(changes.map((change)=>change.previousRevision),[null,0,1,2]);assert.equal(changes[0]?.sourceTurnId,"turn:create");assert.equal(changes.at(-1)?.sourceTurnId,"turn:create");assert.deepEqual(changes.at(-1)?.evidence,[evidence.seq]);assert.equal(ledger.events().some((event)=>event.type==="goal.put"),false);const before=ledger.goal("root");ledger.rebuildProjections();assert.deepEqual(ledger.goal("root"),before);ledger.close();});

test("goal.changed rejects forged operation, authority, and provenance",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});const root={id:"root",parentId:null,objective:"ship",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active" as const,revision:0};assert.throws(()=>ledger.putGoal(root,"human",undefined,{operation:"pause",reason:"forged",evidence:[],authority:{kind:"human"}}),/operation/);assert.throws(()=>ledger.putGoal(root,"human",undefined,{operation:"create",reason:"forged",evidence:[],authority:{kind:"system",reason:"fake"}}),/authority/);assert.throws(()=>ledger.putGoal(root,"human",undefined,{operation:"create",reason:"forged",evidence:[],authority:{kind:"human"},sourceTurnId:"missing"}),/source Turn/);assert.equal(ledger.goal("root"),null);ledger.close();});

test("raw business fields cannot drive projections and rebuild fails closed on poisoned internal metadata",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"root",parentId:null,objective:"real",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");const forged={projection:"goals",snapshot:{...ledger.goal("root")!,objective:"forged",revision:1}};ledger.appendEvent({streamId:"business",ts:new FixedClock().value,actor:"author",type:"forecast.created",data:forged});ledger.rebuildProjections();assert.equal(ledger.goal("root")?.objective,"real");ledger.db.prepare("INSERT INTO events(stream_id,stream_seq,ts,actor,type,data,projection_name) VALUES (?,?,?,?,?,json(?),?)").run("evil",1,new FixedClock().value,"attacker","unrelated.event",JSON.stringify({snapshot:forged.snapshot}),"goals");assert.throws(()=>ledger.rebuildProjections(),/cannot drive goals projection/);const columns=(ledger.db.prepare("PRAGMA table_info(events)").all() as Array<{name:string}>).map((column)=>column.name);assert.equal(columns.includes("projection_snapshot"),false);ledger.close();});

test("Runner trace payload fields cannot smuggle projection writes",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});activeTurn(ledger,"worker","trace-turn");const before=ledger.turn("trace-turn");ledger.appendTurnEvent({streamId:"turn:trace-turn",ts:new FixedClock().value,actor:"worker",type:"runner.note",data:{projection:"turns",snapshot:{...before,status:"failed"}} as unknown as JsonValue},"lease");ledger.rebuildProjections();assert.deepEqual(ledger.turn("trace-turn"),before);ledger.close();});

test("Goal provenance must be causally bound and generic idempotency is stable",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});activeTurn(ledger,"other","other-turn","system");const root={id:"root",parentId:null,objective:"ship",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active" as const,revision:0};assert.throws(()=>ledger.putGoal(root,"human",undefined,{operation:"create",reason:"forged",evidence:[],authority:{kind:"human"},sourceTurnId:"other-turn"}),/Human authority/);const first=ledger.putGoal(root,"human",undefined,{operation:"create",reason:"real",evidence:[],authority:{kind:"human"},idempotencyKey:"root:create"});assert.equal(ledger.putGoal(root,"human",undefined,{operation:"create",reason:"real",evidence:[],authority:{kind:"human"},idempotencyKey:"root:create"}).seq,first.seq);assert.throws(()=>ledger.putGoal({...root,objective:"different",revision:1},"human",undefined,{operation:"revise",reason:"different",evidence:[],authority:{kind:"human"},idempotencyKey:"root:create"}),/different mutation/);ledger.close();});

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
  assert.deepEqual(ledger.completeGoal({ goalId: "root", revision: 0, reason: "artifact inspection passed", evidence: [fresh.seq] }, "human"),completed);
  assert.throws(()=>ledger.completeGoal({goalId:"root",revision:0,reason:"different",evidence:[fresh.seq]},"human"),/different completion decision/);
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
    assert.throws(() => ledger.commitDelegation({ id: "d1", parentGoalId: "root",expectedParentRevision:0, childGoal: { id: "research", objective: "research market", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "researcher" }, brief: { deliverable: "report" }, reason: "independent evidence boundary", evidence: [evidence.seq] }, "ceo"), /kill delegation/);
    assert.equal(JSON.stringify({ events: ledger.events(), goals: ledger.goals(), mail: ledger.mailbox(), wakes: ledger.wakes() }), before, `fault point ${failAt}`);
    ledger.close();
  }

  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "root", parentId: null, objective: "operate", observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 0 }, "human");
  const evidence = ledger.appendEvent(event("ceo", "observation", { fact: true }));
  const request = { id: "d1", parentGoalId: "root",expectedParentRevision:0, childGoal: { id: "research", objective: "research market", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "researcher" }, brief: { deliverable: "report" }, reason: "independent evidence boundary", evidence: [evidence.seq] };
  const result = ledger.commitDelegation(request, "ceo");
  assert.equal(result.goal.parentId, "root");
  assert.equal(result.goal.verificationMethod, request.childGoal.verificationMethod);
  assert.equal(ledger.workRecord(result.goal.id)?.recordRevision, 0);
  assert.equal(result.mail.level, "decision");
  assert.equal(result.wake.status, "queued");
  assert.equal(ledger.events().filter((item) => item.type === "delegation.created").length, 1);
  const delegatedChange=ledger.readStream(goalStream("research")).find((event)=>event.type==="goal.changed")!.data as unknown as import("goah-ledger-contract").GoalChangedData;assert.equal(delegatedChange.operation,"create");assert.equal(delegatedChange.idempotencyKey,"d1");assert.deepEqual(delegatedChange.authority,{kind:"parent_goal",goalId:"root",goalRevision:0});
  assert.deepEqual(ledger.commitDelegation(request, "ceo"), result);
  assert.throws(() => ledger.commitDelegation({ ...request, childGoal: { ...request.childGoal, owner: "other" } }, "ceo"), /reused/);
  assert.throws(()=>ledger.commitDelegation({...request,brief:{deliverable:"changed"}},"ceo"),/different request/);
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
  ledger.enqueueWake({...wake("old-wake", "old"),goalId:"launch"}, "supervisor");
  const evidence = ledger.appendEvent(event("ceo", "observation", { blocked: true }));
  const request = { id: "r1", goalId: "launch",expectedGoalRevision:0, newOwner: "new", brief: { constraint: "recover" }, reason: "old owner blocked", evidence: [evidence.seq] };
  const result = ledger.commitReassignment(request, "ceo");
  assert.equal(result.goal.owner, "new");
  assert.equal(result.goal.revision, 1);
  const reassignedChange=ledger.readStream(goalStream("launch")).findLast((event)=>event.type==="goal.changed")!.data as unknown as import("goah-ledger-contract").GoalChangedData;assert.equal(reassignedChange.operation,"reassign");assert.equal(reassignedChange.reason,request.reason);
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

test("reassignment cancels only Wakes targeting the reassigned Goal",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"root",parentId:null,objective:"operate",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");for(const id of ["target","other"])ledger.putGoal({id,parentId:"root",objective:id,observationMethod:"observe",verificationMethod:"verify",owner:"old",phase:"active",revision:0},"ceo");ledger.enqueueWake({...wake("other-wake","old"),goalId:"other"},"supervisor");const evidence=ledger.appendEvent(event("ceo","observed",{}));ledger.commitReassignment({id:"move",goalId:"target",expectedGoalRevision:0,newOwner:"new",brief:{},reason:"move target",evidence:[evidence.seq]},"ceo");assert.equal(ledger.wake("other-wake")?.status,"queued");ledger.close();});

test("delegation idempotency returns the original committed snapshots after later mutations",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"root",parentId:null,objective:"operate",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");const evidence=ledger.appendEvent(event("ceo","observed",{}));const request={id:"stable",parentGoalId:"root",expectedParentRevision:0,childGoal:{id:"child",objective:"work",observationMethod:"observe",verificationMethod:"verify",owner:"old"},brief:{},reason:"delegate",evidence:[evidence.seq]};const first=ledger.commitDelegation(request,"ceo");const later=ledger.appendEvent(event("ceo","observed",{}));ledger.commitReassignment({id:"move-child",goalId:"child",expectedGoalRevision:0,newOwner:"new",brief:{},reason:"move",evidence:[later.seq]},"ceo");const retry=ledger.commitDelegation(request,"ceo");assert.deepEqual(retry,first);assert.equal(retry.goal.owner,"old");assert.equal(retry.wake.status,"queued");ledger.close();});

test("Delegation cannot overwrite a pre-existing deterministic Wake id",()=>{const ledger=new SqliteLedger(":memory:",{clock:new FixedClock()});ledger.putGoal({id:"root",parentId:null,objective:"operate",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");ledger.enqueueWake({...wake("delegation-wake:d","victim"),triggerRef:"original"},"supervisor");const evidence=ledger.appendEvent(event("ceo","observed",{}));assert.throws(()=>ledger.commitDelegation({id:"d",parentGoalId:"root",expectedParentRevision:0,childGoal:{id:"child",objective:"work",observationMethod:"observe",verificationMethod:"verify",owner:"worker"},brief:{},reason:"delegate",evidence:[evidence.seq]},"ceo"),/wake id/);assert.equal(ledger.wake("delegation-wake:d")?.agent,"victim");assert.equal(ledger.goal("child"),null);ledger.close();});

test("FTS searches event facts and raw business payloads may use projection as a field", () => {
  const ledger = new SqliteLedger(":memory:", { clock: new FixedClock() });
  ledger.putGoal({ id: "root", parentId: null, objective: "generic policy", observationMethod: null, verificationMethod: null, owner: "a", phase: "active", revision: 0 }, "human");
  const evidence = ledger.appendEvent(event("a", "observation", { note: "uniquenebulafact" }));
  assert.equal(ledger.searchEvents("uniquenebulafact").map((event) => event.seq).includes(evidence.seq), true);
  const business=ledger.appendEvent(event("a","forecast.created",{projection:"quarterly",snapshot:{value:60}}));
  assert.deepEqual(business.data,{projection:"quarterly",snapshot:{value:60}});
  ledger.rebuildProjections();
  assert.equal(ledger.goal("root")?.objective,"generic policy");
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

function claimed(ledger: SqliteLedger): void {
  ledger.enqueueWake(wake("w"), "supervisor");
  ledger.claimNextWake("2030-01-01T00:00:00.000Z");
}
function activeTurn(ledger:SqliteLedger,agent:string,id:string,source:"human"|"goal"|"system"="system"):import("goah-ledger-contract").TurnSnapshot{let thread=ledger.threads().find((candidate)=>candidate.agent===agent);if(!thread){const now="2030-01-01T00:00:00.000Z";thread={id:`thread:${agent}`,agent,parentThreadId:null,createdAt:now,updatedAt:now};ledger.putThread(thread,"supervisor");}const existing=ledger.turn(id);if(existing)return existing;const turn={id,threadId:thread.id,source,goalId:null,goalRevision:null,status:"in_progress" as const,attempt:1,error:null,startedAt:"2030-01-01T00:00:00.000Z",endedAt:null,leaseUntil:"2030-01-01T00:10:00.000Z",leaseToken:"lease",runnerPid:null};ledger.putTurn(turn,"supervisor");return turn;}
function goalTurn(ledger:SqliteLedger,agent:string,turnId:string,goalId=`goal:${turnId}`):import("goah-ledger-contract").TurnSnapshot{ledger.putGoal({id:goalId,parentId:null,objective:"work",observationMethod:"observe",verificationMethod:"verify",owner:agent,phase:"active",revision:0},"human");const turn=activeTurn(ledger,agent,turnId,"goal");ledger.putTurn({...turn,goalId,goalRevision:0},"supervisor");const evidence=ledger.appendEvent(event(agent,"observation",{ok:true}));ledger.updateWorkRecord({goalId,expectedRevision:0,goalRevision:0,content:"# Current State\n\nObserved current work.\n",reason:"record current work",evidence:[evidence.seq],turnId},agent);return ledger.turn(turnId)!;}
function handoffCommit(ledger:SqliteLedger,turnId:string,sourceWakeId:string|null,mailIds:string[]=[]):import("goah-ledger-contract").HandoffCommit{const ts="2030-01-01T00:00:02.000Z";const turn=ledger.turn(turnId)!;const record=ledger.workRecord(turn.goalId!)!;const handoff={goalId:turn.goalId!,goalRevision:turn.goalRevision!,recordRevision:record.recordRevision,outcome:"progress" as const,evidence:record.evidence};return{agent:ledger.thread(turn.threadId)!.agent,turnId,sourceWakeId,mailIds,ts,output:{handoff},item:{id:`handoff:${turnId}`,turnId,ordinal:ledger.turnItems(turnId).length+1,type:"handoff",status:"completed",data:handoff,createdAt:ts,completedAt:ts}};}
