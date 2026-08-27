import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import test from "node:test";
import { controlStream,goalRoute,goalStream,goalExecutionBinding,humanInboxRoute,humanBinding,specialistInboxRoute,specialistBinding,wakeStream,type Clock,type EventInput,type GoalSnapshot,type JsonValue,type RunRequest,type Runner,type TurnSnapshot,type WakeSnapshot } from "goah-ledger-contract";
import { piWorkerPath, ProcessRunner, verificationWorkerPath } from "goah-runner-pi";
import { calibrateVerificationThreshold,deriveRecoveryViews,evaluateVerification,ProcessVerifierModel,renderDashboard,runSupervisorDaemon,Supervisor,VerificationPlane,type VerifierModel } from "goah-supervisor";
import { assertLedgerConformance, createMemoryLedger, fauxRunnerWorkerPath, SimulatedClock } from "./index.js";

function queuedWake(id:string,agent="worker",triggerRef=`trigger:${id}`):WakeSnapshot{const target=agent==="ceo"?humanBinding():specialistBinding(agent,agent==="audit"?"audit":"verifier");return{id,...target,triggerRef,status:"queued",attempt:0,enqueuedSeq:0,claimedAt:null,consumedAt:null,turnId:null};}
function goalWake(id:string,agent:string,goalId:string,triggerRef=`trigger:${id}`):WakeSnapshot{return{id,...goalExecutionBinding(agent,goalId),triggerRef,status:"queued",attempt:0,enqueuedSeq:0,claimedAt:null,consumedAt:null,turnId:null};}
function goal(): GoalSnapshot { return { id: "root", parentId: "parent", objective: "produce a checked artifact", observationMethod: "Inspect the produced artifact.", verificationMethod: "Verify the produced artifact.", owner: "worker", phase: "active", revision: 0 }; }
function createWorkerGoal(ledger:ReturnType<typeof createMemoryLedger>):GoalSnapshot{if(!ledger.goal("parent"))ledger.putGoal({id:"parent",parentId:null,objective:"coordinate worker",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");if(!ledger.goal("root"))ledger.putGoal(goal(),"ceo");return ledger.goal("root")!;}
function event(actor: string, type: string, data: JsonValue = {}, turnId?: string): EventInput { return { streamId: turnId ? wakeStream(turnId) : controlStream(actor), ts: "2026-08-18T00:00:00.000Z", actor, type, data }; }
function repository(): string {
  const path = mkdtempSync(join(tmpdir(), "goah-runner-root-"));
  git(path, ["init", "-b", "main"]); git(path, ["config", "user.email", "goah@example.test"]); git(path, ["config", "user.name", "GOAH Test"]);
  writeFileSync(join(path, "README.md"), "# runner root\n"); git(path, ["add", "README.md"]); git(path, ["commit", "-m", "initial"]);
  return path;
}

test("public ledger conformance suite validates the SQLite implementation", () => {
  assertLedgerConformance((clock) => createMemoryLedger({ clock }));
});

test("vertical slice commits handoff while the runner owns local files", async () => {
  const repo = repository();
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const contextFile = join(mkdtempSync(join(tmpdir(), "goah-context-")), "context.json");
  const runner = fauxRunner([
    { write: { path: "artifact.txt", content: "verified\n" }, trace: [{ type: "tool.called", data: { callId: "write",name:"write",arguments:{path:"artifact.txt"} } },{ type: "tool.completed", data: { callId: "write", result: { name: "write_artifact" } } }] },
    { handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } },
  ], contextFile, repo);
  const supervisor = new Supervisor(ledger, runner, clock);
  createWorkerGoal(ledger);
  ledger.putMail({ id: "mail-1", to: "worker", from: "ceo", level: "decision", ...goalRoute("root"),body: {}, readAt: null }, "ceo");
  supervisor.planWake("worker", clock.now().toISOString(), "initial run");
  const completed = await supervisor.tick();
  assert.equal(completed?.status, "consumed");
  assert.equal(readFileSync(join(repo, "artifact.txt"), "utf8"), "verified\n");
  assert.deepEqual(ledger.turnItems(completed!.turnId!).slice(-2).map((item)=>item.type),["assistant_message","handoff"]);
  assert.match(String((ledger.turnItems(completed!.turnId!).findLast((item)=>item.type==="assistant_message")?.data as {text?:unknown})?.text),/Goal work recorded/);
  assert.match((JSON.parse(readFileSync(contextFile, "utf8")) as { text: string }).text, /# Incoming/);
  assert.equal(ledger.unreadMail("worker").length, 0);
  assert.equal(ledger.events().some((event) => event.type.startsWith("workspace.")), false);
  ledger.close();
});

test("a Human Turn can create a Root Goal and become Goal-bound through tools", async () => {
  const repo = repository();
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const record = "# Current State\n\nGoal accepted.\n\n# Observations\n\nInitial Human request recorded.\n\n# Work Completed\n\nCreated the operating record.\n\n# Decisions\n\nContinue.\n\n# Blockers\n\nNone.\n\n# Next Steps\n\nInspect implementation.\n";
  const runner = fauxRunner([
    { rpc: { method: "goal.create", params: { id: "human-goal", objective: "finish authentication" } } },
    { rpc: { method: "work_record.update", params: { expectedRevision: 0, content: record, reason: "start durable work", evidence: ["$LATEST_SOURCE_SEQ"] } } },
    { handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } },
  ], undefined, repo);
  const supervisor = new Supervisor(ledger, runner, clock);
  const accepted = await supervisor.startHumanTurn("finish authentication and keep going until it is verified");
  while (ledger.turn(accepted.turnId)?.status === "in_progress") await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  assert.equal(ledger.turn(accepted.turnId)?.status, "completed");
  assert.equal(ledger.goal("human-goal")?.objective, "finish authentication");
  assert.equal(ledger.workRecord("human-goal")?.recordRevision, 1);
  assert.equal(ledger.workRecord("human-goal")?.updatedInTurn, accepted.turnId);
  assert.equal(ledger.turn(accepted.turnId)?.goalId, "human-goal");
  assert.equal((ledger.readStream(goalStream("human-goal")).find((event)=>event.type==="goal.changed")?.data as {sourceTurnId?:string}).sourceTurnId,accepted.turnId);
  assert.equal(ledger.turnItems(accepted.turnId).some((item) => item.type === "handoff"), true);
  ledger.close();
});

test("a direct Human Root resume binds the current Turn without queuing a duplicate Wake",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putGoal({id:"root",parentId:null,objective:"resume",observationMethod:"observe",verificationMethod:"verify",owner:"ceo",phase:"active",revision:0},"human");ledger.putGoal({...ledger.goal("root")!,phase:"paused",revision:1},"human");const supervisor=new Supervisor(ledger,fauxRunner([{rpc:{method:"goal.resume",params:{goalId:"root"}}},{rpc:{method:"work_record.update",params:{expectedRevision:0,content:"# Current State\n\nResumed.\n",reason:"resume",evidence:["$LATEST_SOURCE_SEQ"]}}},{handoff:{response:{content:"Goal work recorded."},handoff: { outcome:"blocked", evidence:[1]}}}]),clock);const accepted=await supervisor.startHumanTurn("resume");while(ledger.turn(accepted.turnId)?.status==="in_progress")await new Promise((resolve)=>setTimeout(resolve,1));assert.equal(ledger.turn(accepted.turnId)?.status,"completed");assert.equal(ledger.wakes().filter((wake)=>wake.status==="queued").length,0);ledger.close();});

test("current Root ignores completed Root history",()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const supervisor=new Supervisor(ledger,fauxRunner([]),clock);supervisor.createRootGoal("old","a");supervisor.confirmObservationMethod("a","observe");const evidence=ledger.appendEvent({...event("human","observed",{}),ts:clock.now().toISOString()});supervisor.completeGoal({goalId:"a",revision:1,reason:"done",evidence:[evidence.seq]},"human");supervisor.createRootGoal("current","z");assert.equal(supervisor.currentRoot()?.id,"z");ledger.close();});

test("a Human interaction interrupts active automatic CEO work", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const first = Promise.withResolvers<{ outcome: "abnormal"; reason: string }>();
  let prepared = 0;
  let terminated = false;
  const runner: Runner = {
    isolation: "process",
    prepare: () => {
      prepared += 1;
      if (prepared === 1) return { pid: null, begin: () => undefined, result: first.promise, terminate: async () => { terminated = true; first.resolve({ outcome: "abnormal", reason: "interrupted by Human" }); } };
      return { pid: null, begin: () => undefined, result: Promise.resolve({ outcome: "response" as const, response: { content: "你好" } }), terminate: async () => undefined };
    },
    terminateProcess: async () => undefined,
  };
  const supervisor = new Supervisor(ledger, runner, clock);
  supervisor.createRootGoal("background Goal", "root");
  supervisor.planWake("ceo", clock.now().toISOString(), "automatic review");
  const automatic = supervisor.tick();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const accepted = await supervisor.startHumanTurn("你好");
  assert.equal(terminated, true);
  const automaticWake=await automatic;assert.equal(automaticWake?.status,"consumed");assert.equal(ledger.turn(automaticWake!.turnId!)?.status,"interrupted");
  while (ledger.turn(accepted.turnId)?.status === "in_progress") await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  assert.equal(ledger.turn(accepted.turnId)?.status, "completed");
  ledger.close();
});

test("a Human Goal revision fences the active stale Turn before more RPC",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const pending=Promise.withResolvers<{outcome:"abnormal";reason:string}>();let request:RunRequest|undefined;const runner:Runner={isolation:"process",prepare:(value)=>{request=value;return{pid:null,begin:()=>undefined,result:pending.promise,terminate:async()=>pending.resolve({outcome:"abnormal",reason:"fenced"})}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);supervisor.createRootGoal("root","root");supervisor.planWake("ceo",clock.now().toISOString(),"work");const running=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));supervisor.updateGoal("root",{objective:"revised"},"human");assert.equal(ledger.turn(request!.execution.id)?.status,"interrupted");await assert.rejects(()=>request!.rpc!("ledger.search",{query:"root"}),/stale Turn RPC/);await running;ledger.close();});

test("a rejected Goal revision has no execution side effects",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:"observe",verificationMethod:"verify",owner:"ceo",phase:"active",revision:0},"human");ledger.putGoal({id:"child",parentId:"root",objective:"child",observationMethod:"observe",verificationMethod:"verify",owner:"worker",phase:"active",revision:0},"ceo");const pending=Promise.withResolvers<{outcome:"abnormal";reason:string}>();const runner:Runner={isolation:"process",prepare:()=>({pid:null,begin:()=>undefined,result:pending.promise,terminate:async()=>pending.resolve({outcome:"abnormal",reason:"cleanup"})}),terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{profiles:[{agent:"worker",role:"child"}]});supervisor.planWake("worker",clock.now().toISOString(),"work","supervisor",{goalId:"child"});const running=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));const turn=ledger.turns().find((candidate)=>candidate.status==="in_progress")!;assert.throws(()=>supervisor.updateGoal("child",{objective:"new",observationMethod:"",verificationMethod:""},"ceo"),/cannot be blank/);assert.equal(ledger.goal("child")?.revision,0);assert.equal(ledger.turn(turn.id)?.status,"in_progress");await supervisor.interruptTurn(turn.id);await running;ledger.close();});

test("a stale reassignment has no execution side effects",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:"observe",verificationMethod:"verify",owner:"ceo",phase:"active",revision:0},"human");ledger.putGoal({id:"child",parentId:"root",objective:"child",observationMethod:"observe",verificationMethod:"verify",owner:"worker",phase:"active",revision:0},"ceo");const evidence=ledger.appendEvent({...event("ceo","observed",{}),ts:clock.now().toISOString()});const pending=Promise.withResolvers<{outcome:"abnormal";reason:string}>();const runner:Runner={isolation:"process",prepare:()=>({pid:null,begin:()=>undefined,result:pending.promise,terminate:async()=>pending.resolve({outcome:"abnormal",reason:"cleanup"})}),terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{profiles:[{agent:"worker",role:"child"},{agent:"other",role:"child"}]});supervisor.planWake("worker",clock.now().toISOString(),"work","supervisor",{goalId:"child"});const running=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));const turn=ledger.turns().find((candidate)=>candidate.status==="in_progress")!;await assert.rejects(()=>supervisor.reassignGoal({id:"stale",goalId:"child",expectedGoalRevision:99,newOwner:"other",brief:{},reason:"move",evidence:[evidence.seq]},"ceo"),/stale/);assert.equal(ledger.goal("child")?.owner,"worker");assert.equal(ledger.turn(turn.id)?.status,"in_progress");await supervisor.interruptTurn(turn.id);await running;ledger.close();});

test("reassignment waits for the old owner's Runner to exit",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:"observe",verificationMethod:"verify",owner:"ceo",phase:"active",revision:0},"human");ledger.putGoal({id:"child",parentId:"root",objective:"child",observationMethod:"observe",verificationMethod:"verify",owner:"worker",phase:"active",revision:0},"ceo");const evidence=ledger.appendEvent({...event("ceo","observed",{}),ts:clock.now().toISOString()});const firstResult=Promise.withResolvers<{outcome:"abnormal";reason:string}>();const exit=Promise.withResolvers<void>();let prepared=0;let oldExited=false;let overlap=false;const runner:Runner={isolation:"process",prepare:()=>{prepared+=1;if(prepared===1)return{pid:null,begin:()=>undefined,result:firstResult.promise,terminate:async()=>{await exit.promise;oldExited=true;firstResult.resolve({outcome:"abnormal",reason:"reassigned"})}};if(!oldExited)overlap=true;return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"new owner observed"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{profiles:[{agent:"worker",role:"child"},{agent:"other",role:"child"}],turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});supervisor.planWake("worker",clock.now().toISOString(),"work","supervisor",{goalId:"child"});const oldRun=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));const reassignment=supervisor.reassignGoal({id:"move",goalId:"child",expectedGoalRevision:0,newOwner:"other",brief:{},reason:"move",evidence:[evidence.seq]},"ceo");await new Promise((resolve)=>setImmediate(resolve));const newRun=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));assert.equal(prepared,1);exit.resolve();await Promise.all([oldRun,reassignment,newRun]);assert.equal(prepared,2);assert.equal(overlap,false);ledger.close();});

test("Goal preemption waits for the old Runner to exit before starting the replacement Turn",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const firstResult=Promise.withResolvers<{outcome:"abnormal";reason:string}>();const termination=Promise.withResolvers<void>();let prepared=0;let firstExited=false;let overlapped=false;const runner:Runner={isolation:"process",prepare:()=>{prepared+=1;if(prepared===1)return{pid:null,begin:()=>undefined,result:firstResult.promise,terminate:async()=>{await termination.promise;firstExited=true;firstResult.resolve({outcome:"abnormal",reason:"preempted"})}};if(!firstExited)overlapped=true;return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"replacement observed"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:1}});supervisor.createRootGoal("root","root");supervisor.planWake("ceo",clock.now().toISOString(),"work");const first=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));supervisor.updateGoal("root",{objective:"revised"},"human");const replacement=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));assert.equal(prepared,1);termination.resolve();await Promise.all([first,replacement]);assert.equal(prepared,2);assert.equal(overlapped,false);ledger.close();});

test("a claimed Wake absorbs Goal revisions while waiting for the Runner exit barrier",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const firstResult=Promise.withResolvers<{outcome:"abnormal";reason:string}>();const termination=Promise.withResolvers<void>();let prepared=0;let replacementBinding:unknown;const runner:Runner={isolation:"process",prepare:(request)=>{prepared+=1;if(prepared===1)return{pid:null,begin:()=>undefined,result:firstResult.promise,terminate:async()=>{await termination.promise;firstResult.resolve({outcome:"abnormal",reason:"preempted"})}};replacementBinding=request.turn.goalBinding;return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"replacement observed"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});supervisor.createRootGoal("root","root");supervisor.planWake("ceo",clock.now().toISOString(),"work");const first=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));supervisor.updateGoal("root",{objective:"revision one"},"human");const replacement=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));supervisor.updateGoal("root",{objective:"revision two"},"human");assert.equal(ledger.wakes().filter((wake)=>wake.status==="claimed").length,1);assert.equal(ledger.wakes().filter((wake)=>wake.status==="queued").length,0);termination.resolve();await Promise.all([first,replacement]);assert.deepEqual(replacementBinding,{goalId:"root",goalRevision:2});ledger.close();});

test("Human admission wins over a claimed replacement after the termination barrier",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const firstResult=Promise.withResolvers<{outcome:"abnormal";reason:string}>();const firstExit=Promise.withResolvers<void>();let prepared=0;const runner:Runner={isolation:"process",prepare:()=>{prepared+=1;if(prepared===1)return{pid:null,begin:()=>undefined,result:firstResult.promise,terminate:async()=>{await firstExit.promise;firstResult.resolve({outcome:"abnormal",reason:"preempted"})}};return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"response" as const,response:{content:"accepted"}}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:1}});supervisor.createRootGoal("root","root");supervisor.planWake("ceo",clock.now().toISOString(),"first");const first=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));supervisor.updateGoal("root",{objective:"revised"},"human");const replacement=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));const human=supervisor.startHumanTurn("urgent correction");await new Promise((resolve)=>setImmediate(resolve));firstExit.resolve();const accepted=await human;const[,replacementWake]=await Promise.all([first,replacement]);assert.equal(ledger.turnItems(accepted.turnId).some((item)=>item.type==="user_message"&&(item.data as {text?:unknown}).text==="urgent correction"),true);assert.equal(prepared,2);assert.equal(replacementWake?.status,"queued");ledger.close();});

test("a queued Schedule binds the latest Goal revision only when its Turn starts",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});let binding:unknown;const runner:Runner={isolation:"process",prepare:(request)=>{binding=request.turn.goalBinding;return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"observed latest Goal"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:1}});supervisor.createRootGoal("root","root");supervisor.planWake("ceo",new Date(clock.now().getTime()+1_000).toISOString(),"future review");supervisor.updateGoal("root",{objective:"revised"},"human");assert.equal(ledger.schedules().find((schedule)=>schedule.reason==="future review")?.status,"pending");clock.advance(2_000);const wake=await supervisor.tick();assert.equal(wake?.status,"consumed");assert.deepEqual(binding,{goalId:"root",goalRevision:1});ledger.close();});

test("an active Human Turn blocks queued automatic Wakes",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const pending=Promise.withResolvers<{outcome:"response";response:{content:string}}>();const runner:Runner={isolation:"process",prepare:()=>({pid:null,begin:()=>undefined,result:pending.promise,terminate:async()=>pending.resolve({outcome:"response",response:{content:"stopped"}})}),terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);supervisor.createRootGoal("background","root");supervisor.planWake("ceo",clock.now().toISOString(),"automatic");const human=await supervisor.startHumanTurn("hello");assert.equal(await supervisor.tick(),null);assert.equal(ledger.wakes()[0]?.status,"queued");await supervisor.interruptTurn(human.turnId);ledger.close();});

test("concurrent Human submissions are serialized without losing either message",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const pending=Promise.withResolvers<{outcome:"abnormal";reason:string}>();let prepared=0;const runner:Runner={isolation:"process",prepare:()=>{prepared+=1;if(prepared===1)return{pid:null,begin:()=>undefined,result:pending.promise,terminate:async()=>pending.resolve({outcome:"abnormal",reason:"stopped"})};return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"response" as const,response:{content:"ok"}}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);supervisor.createRootGoal("background","root");supervisor.planWake("ceo",clock.now().toISOString(),"automatic");const automatic=supervisor.tick();await new Promise((resolve)=>setImmediate(resolve));const results=await Promise.all([supervisor.startHumanTurn("one"),supervisor.startHumanTurn("two")]);await automatic;assert.equal(results.length,2);assert.deepEqual(ledger.turns(supervisor.threadFor("ceo").id).flatMap((turn)=>ledger.turnItems(turn.id)).filter((item)=>item.type==="user_message").map((item)=>(item.data as {text:string}).text),["one","two"]);ledger.close();});

test("a Goal-targeted Wake binds the requested Goal when one Agent owns several",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});let binding:unknown;const runner:Runner={isolation:"process",prepare:(request:RunRequest)=>{binding=request.turn.goalBinding;return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal",reason:"observed"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:1}});ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");for(const id of ["a","z"])ledger.putGoal({id,parentId:"root",objective:id,observationMethod:"observe",verificationMethod:"verify",owner:"worker",phase:"active",revision:0},"ceo");ledger.enqueueWake(goalWake("wake-z","worker","z","goal:z"),"supervisor");await supervisor.tick();assert.deepEqual(binding,{goalId:"z",goalRevision:0});ledger.close();});

test("manual wake and stop target one Goal when an Agent owns several",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");for(const id of ["a","z"])ledger.putGoal({id,parentId:"root",objective:id,observationMethod:"o",verificationMethod:"v",owner:"worker",phase:"active",revision:0},"ceo");const supervisor=new Supervisor(ledger,fauxRunner([]),clock);assert.throws(()=>supervisor.planWake("worker",clock.now().toISOString(),"ambiguous"),/explicit Goal target/);supervisor.planWake("worker",clock.now().toISOString(),"a","worker",{goalId:"a"});supervisor.planWake("worker",clock.now().toISOString(),"z","worker",{goalId:"z"});await supervisor.stopAgentWake("worker","z");assert.equal(ledger.wakes().find((wake)=>wake.goalId==="z")?.status,"cancelled");assert.equal(ledger.wakes().find((wake)=>wake.goalId==="a")?.status,"queued");ledger.close();});

test("Goal Wake and stop bindings reject the wrong owner without breaking replay",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");assert.throws(()=>ledger.enqueueWake(goalWake("forged","worker","root"),"supervisor"),/owned by another Agent/);const valid=goalWake("valid","ceo","root");assert.equal(ledger.enqueueWake(valid,"supervisor").created,true);ledger.putGoal({...ledger.goal("root")!,phase:"paused",revision:1},"human");assert.equal(ledger.enqueueWake(valid,"supervisor").created,false);const supervisor=new Supervisor(ledger,fauxRunner([]),clock);await assert.rejects(()=>supervisor.stopAgentWake("worker","root"),/not owned/);assert.equal(ledger.wakes().length,1);ledger.close();});

test("an ordinary source-Wake response atomically acknowledges delivered Mail",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const runner:Runner={isolation:"process",prepare:()=>({pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"response" as const,response:{content:"reply"}}),terminate:async()=>undefined}),terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);const sent=supervisor.sendToCeo({message:"async hello"});const wake=await supervisor.tick();assert.equal(wake?.id,sent.wake.id);assert.equal(ledger.turn(wake!.turnId!)?.status,"completed");assert.equal(ledger.unreadMail("ceo").length,0);ledger.close();});

test("a follow-up steers the active Human turn and both messages commit together", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const response = Promise.withResolvers<{ outcome: "response"; response: { content: string } }>();
  let steered = "";
  const runner: Runner = {
    isolation: "process",
    prepare: () => ({
      pid: null,
      begin: () => undefined,
      result: response.promise,
      steer: async (message) => { steered = message; },
      terminate: async () => undefined,
    }),
    terminateProcess: async () => undefined,
  };
  const supervisor = new Supervisor(ledger, runner, clock);
  const original = await supervisor.startHumanTurn("first request");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const followUp = await supervisor.startHumanTurn("correct the budget");
  assert.equal(steered, "correct the budget");
  assert.equal(followUp.turnId, original.turnId);
  response.resolve({ outcome: "response", response: { content: "revised answer" } });
  while (ledger.turn(original.turnId)?.status === "in_progress") await new Promise((resolveWait) => setTimeout(resolveWait, 1));
  assert.equal(ledger.turn(original.turnId)?.status, "completed"); assert.equal(ledger.turnItems(original.turnId).filter((item) => item.type === "user_message").length, 2);
  ledger.close();
});

test("rejected steering starts a fresh Turn without duplicating a completed user message",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const firstResult=Promise.withResolvers<{outcome:"abnormal";reason:string}>();let prepared=0;const runner:Runner={isolation:"process",prepare:()=>{prepared+=1;if(prepared===1)return{pid:null,begin:()=>undefined,result:firstResult.promise,steer:async()=>{throw new Error("no longer accepting steering messages")},terminate:async()=>firstResult.resolve({outcome:"abnormal",reason:"superseded"})};return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"response" as const,response:{content:"fresh answer"}}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);const first=await supervisor.startHumanTurn("first");await new Promise((resolve)=>setImmediate(resolve));const second=await supervisor.startHumanTurn("second");assert.equal(second.steered,false);assert.notEqual(second.turnId,first.turnId);while(ledger.turn(second.turnId)?.status==="in_progress")await new Promise((resolve)=>setTimeout(resolve,1));assert.deepEqual(ledger.turnItems(first.turnId).filter((item)=>item.type==="user_message").map((item)=>item.status),["completed","failed"]);assert.deepEqual(ledger.turnItems(second.turnId).filter((item)=>item.type==="user_message").map((item)=>[item.status,item.data]),[["completed",{text:"second"}]]);ledger.close();});

test("steering that loses the Turn completion race starts a fresh Turn",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const firstResult=Promise.withResolvers<{outcome:"response";response:{content:string}}>();const steerResult=Promise.withResolvers<void>();let prepared=0;const runner:Runner={isolation:"process",prepare:()=>{prepared+=1;if(prepared===1)return{pid:null,begin:()=>undefined,result:firstResult.promise,steer:()=>steerResult.promise,terminate:async()=>undefined};return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"response" as const,response:{content:"fresh answer"}}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);const first=await supervisor.startHumanTurn("first");await new Promise((resolve)=>setImmediate(resolve));const follow=supervisor.startHumanTurn("second");firstResult.resolve({outcome:"response",response:{content:"stale answer"}});while(ledger.turn(first.turnId)?.status==="in_progress")await new Promise((resolve)=>setTimeout(resolve,1));steerResult.resolve();const second=await follow;assert.equal(second.steered,false);assert.notEqual(second.turnId,first.turnId);while(ledger.turn(second.turnId)?.status==="in_progress")await new Promise((resolve)=>setTimeout(resolve,1));assert.equal(ledger.turn(second.turnId)?.status,"completed");assert.deepEqual(ledger.turnItems(second.turnId).filter((item)=>item.type==="user_message").map((item)=>item.data),[{text:"second"}]);ledger.close();});

test("reasoning deltas become a durable reasoning Item",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const runner:Runner={isolation:"process",prepare:(request)=>({pid:null,begin:()=>{request.emit({type:"message.assistant.delta",data:{messageId:"m",delta:{type:"thinking_start"}}});request.emit({type:"message.assistant.delta",data:{messageId:"m",delta:{type:"thinking_delta",delta:"inspect state"}}});request.emit({type:"message.assistant.delta",data:{messageId:"m",delta:{type:"thinking_end"}}});},result:Promise.resolve({outcome:"response",response:{content:"done"}}),terminate:async()=>undefined}),terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);const accepted=await supervisor.startHumanTurn("test");while(ledger.turn(accepted.turnId)?.status==="in_progress")await new Promise((resolve)=>setTimeout(resolve,1));const reasoning=ledger.turnItems(accepted.turnId).find((item)=>item.type==="reasoning");assert.equal(reasoning?.status,"completed");assert.deepEqual(reasoning?.data,{text:"inspect state"});ledger.close();});

test("Runner cleanup failure is recorded without leaving the Turn active",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const runner:Runner={isolation:"process",prepare:()=>({pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"response" as const,response:{content:"ok"}}),terminate:async()=>{throw new Error("cleanup failed")}}),terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);const accepted=await supervisor.startHumanTurn("hello");while(ledger.turn(accepted.turnId)?.status==="in_progress")await new Promise((resolve)=>setTimeout(resolve,1));assert.equal(ledger.turn(accepted.turnId)?.status,"completed");assert.equal(ledger.readStream(`turn:${accepted.turnId}`).some((event)=>event.type==="runner.cleanup_failed"),true);ledger.close();});

test("interrupting a Human Turn terminates it without Mail or Wake", async () => {
  const clock = new SimulatedClock(); const ledger = createMemoryLedger({ clock }); const result = Promise.withResolvers<{ outcome: "abnormal"; reason: string }>();
  const runner: Runner = { isolation:"process",prepare:()=>({pid:null,begin:()=>undefined,result:result.promise,terminate:async()=>result.resolve({outcome:"abnormal",reason:"stopped"})}),terminateProcess:async()=>undefined };
  const supervisor = new Supervisor(ledger,runner,clock); const accepted = await supervisor.startHumanTurn("cancel me"); await new Promise((resolveWait)=>setImmediate(resolveWait)); assert.equal((await supervisor.interruptTurn(accepted.turnId)).status,"interrupted"); await new Promise((resolveWait)=>setImmediate(resolveWait)); assert.equal(ledger.wakes().length,0); assert.equal(ledger.mailbox().length,0); ledger.close();
});

test("a follow-up during Turn retry backoff joins the same Turn", async () => {
  const clock = new SimulatedClock(); const ledger = createMemoryLedger({ clock }); let attempt=0; let retryContext="";
  const runner: Runner = { isolation:"process",prepare:(request)=>{ attempt+=1; if(attempt>1) retryContext=String((request.context as {text?:string}).text??""); return {pid:null,begin:()=>undefined,result:Promise.resolve(attempt===1?{outcome:"abnormal" as const,reason:"temporary"}:{outcome:"response" as const,response:{content:"recovered"}}),terminate:async()=>undefined}; },terminateProcess:async()=>undefined };
  const supervisor = new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:2,baseDelayMs:25}}); const first=await supervisor.startHumanTurn("first"); while(!ledger.readStream(`turn:${first.turnId}`).some((event)=>event.type==="turn.retry_started")) await new Promise((resolveWait)=>setTimeout(resolveWait,1)); const follow=await supervisor.startHumanTurn("correction"); assert.equal(follow.turnId,first.turnId); while(ledger.turn(first.turnId)?.status==="in_progress") await new Promise((resolveWait)=>setTimeout(resolveWait,1)); assert.match(retryContext,/Human: correction/); assert.equal(ledger.turnItems(first.turnId).filter((item)=>item.type==="user_message").length,2); ledger.close();
});

test("a Human Turn that becomes Goal-bound rebuilds Goal context on Runner retry",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const seen:Array<{binding:unknown;execution:string;prompt:string;text:string}>=[];let attempt=0;const runner:Runner={isolation:"process",prepare:(request)=>{attempt+=1;const context=request.context as {systemPrompt?:unknown;text?:unknown};seen.push({binding:request.turn.goalBinding??null,execution:request.execution.bindingKind,prompt:String(context.systemPrompt??""),text:String(context.text??"")});let resolve!:(value:import("goah-ledger-contract").RunnerCandidateResult)=>void;const result=new Promise<import("goah-ledger-contract").RunnerCandidateResult>((done)=>{resolve=done;});return{pid:null,begin:()=>{if(attempt===1)void request.rpc!("goal.create",{id:"retry-goal",objective:"finish the durable goal"}).then(()=>resolve({outcome:"abnormal",reason:"retry after binding"}),error=>resolve({outcome:"abnormal",reason:String(error)}));else resolve({outcome:"abnormal",reason:"captured rebound context"});},result,terminate:async()=>undefined};},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:2,baseDelayMs:0}});const accepted=await supervisor.startHumanTurn("finish this goal");while(ledger.turn(accepted.turnId)?.status==="in_progress")await new Promise((resolve)=>setImmediate(resolve));assert.equal(seen[0]?.execution,"human");assert.equal(seen[1]?.execution,"goal");assert.deepEqual(seen[1]?.binding,{goalId:"retry-goal",goalRevision:0});assert.match(seen[1]?.prompt??"",/sole operating interface/);assert.match(seen[1]?.text??"",/# Shared Work Record Index[\s\S]*retry-goal/);ledger.close();});

test("accepted Handoff remains valid when the Agent updates its Work Record afterward",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});createWorkerGoal(ledger);const evidence=ledger.appendEvent({...event("worker","observed",{}),ts:clock.now().toISOString()});const runner:Runner={isolation:"process",prepare:(request)=>{let resolve!:(value:import("goah-ledger-contract").RunnerCandidateResult)=>void;const result=new Promise<import("goah-ledger-contract").RunnerCandidateResult>((done)=>{resolve=done;});return{pid:null,begin:()=>{void(async()=>{const initial=await request.rpc!("work_record.read",{goalId:"root"}) as unknown as {recordRevision:number};await request.rpc!("work_record.update",{expectedRevision:initial.recordRevision,content:"# Current State\n\nValidated before final refinement.\n",reason:"first update",evidence:[evidence.seq]});const validation=await request.rpc!("goal.handoff.validate",{handoff:{outcome:"progress",evidence:[evidence.seq]},candidateMessage:"Goal work completed."} as unknown as JsonValue) as unknown as import("goah-ledger-contract").HandoffValidationResult;if(!validation.accepted)throw new Error("validation failed");await request.rpc!("work_record.update",{expectedRevision:1,content:"# Current State\n\nRefined after Handoff validation.\n",reason:"final refinement",evidence:[evidence.seq]});request.emit({type:"message.assistant.completed",data:{message:{id:"final",role:"assistant",content:[{type:"text",text:"Goal work completed."}],stopReason:"toolUse"},completionIntent:"handoff",commitState:"provisional"}});resolve({outcome:"handoff",output:{validationAttemptId:validation.attemptId,validationToken:validation.token,handoff:{outcome:"progress",evidence:[evidence.seq]}}});})().catch((error)=>resolve({outcome:"abnormal",reason:String(error)}));},result,terminate:async()=>undefined};},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});supervisor.planWake("worker",clock.now().toISOString(),"validate before refinement");const wake=await supervisor.tick();assert.equal(ledger.turn(wake!.turnId!)?.status,"completed");assert.equal((ledger.lastEvent("worker","handoff.recorded")?.data as {recordRevision?:unknown}).recordRevision,2);ledger.close();});

test("a later rejected Handoff invalidates every older accepted token",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});createWorkerGoal(ledger);const evidence=ledger.appendEvent({...event("worker","observed",{}),ts:clock.now().toISOString()});let attempts:number[]=[];const runner:Runner={isolation:"process",prepare:(request)=>{let resolve!:(value:import("goah-ledger-contract").RunnerCandidateResult)=>void;const result=new Promise<import("goah-ledger-contract").RunnerCandidateResult>((done)=>{resolve=done;});return{pid:null,begin:()=>{void(async()=>{await request.rpc!("work_record.update",{expectedRevision:0,content:"# Current State\n\nready\n",reason:"ready",evidence:[evidence.seq]});const first=await request.rpc!("goal.handoff.validate",{handoff:{outcome:"progress",evidence:[evidence.seq]},candidateMessage:"first accepted"} as unknown as JsonValue) as unknown as import("goah-ledger-contract").HandoffValidationResult;const second=await request.rpc!("goal.handoff.validate",{handoff:{outcome:"progress",evidence:[999999]},candidateMessage:"second rejected"} as unknown as JsonValue) as unknown as import("goah-ledger-contract").HandoffValidationResult;attempts=[first.attemptId,second.attemptId];if(!first.accepted)throw new Error("first validation failed");request.emit({type:"message.assistant.completed",data:{message:{id:"first",role:"assistant",content:[{type:"text",text:"first accepted"}],stopReason:"toolUse"},completionIntent:"handoff",commitState:"provisional"}});resolve({outcome:"handoff",output:{validationAttemptId:first.attemptId,validationToken:first.token,handoff:{outcome:"progress",evidence:[evidence.seq]}}});})().catch((error)=>resolve({outcome:"abnormal",reason:String(error)}));},result,terminate:async()=>undefined};},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});supervisor.planWake("worker",clock.now().toISOString(),"invalidate old token");const wake=await supervisor.tick();assert.deepEqual(attempts,[1,2]);assert.equal(ledger.turn(wake!.turnId!)?.status,"failed");assert.equal(ledger.lastEvent("worker","handoff.recorded"),null);ledger.close();});

test("a nonrepairing Runner cannot hand off without updating its Work Record", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const runner: Runner = {
    isolation: "process",
    prepare: (request) => {let resolve!:(value:import("goah-ledger-contract").RunnerCandidateResult)=>void;const result=new Promise<import("goah-ledger-contract").RunnerCandidateResult>((done)=>{resolve=done;});return{pid:null,begin:()=>{void request.rpc!("goal.handoff.validate",{handoff:{outcome:"progress",evidence:[1]},candidateMessage:"Goal progress recorded."}).then((value)=>resolve({outcome:"abnormal",reason:JSON.stringify(value)}));},result,terminate:async()=>undefined};},
    terminateProcess: async () => undefined,
  };
  const supervisor = new Supervisor(ledger, runner, clock);
  createWorkerGoal(ledger);
  supervisor.planWake("worker", clock.now().toISOString(), "missing record update");
  const wake = await supervisor.tick();
  assert.equal(wake?.status, "consumed");
  assert.match(String((ledger.turn(wake!.turnId!)?.error as {reason?:string;message?:string})?.message), /Update this Goal's Work Record/);
  ledger.close();
});

test("an unbound Human Turn cannot mutate Goal organization", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const supervisor = new Supervisor(ledger, fauxRunner([{ rpc: { method: "goal.delegate", params: { id: "forbidden", parentGoalId: "root", childGoal: { id: "child", objective: "should not exist", observationMethod: "inspect", verificationMethod: "verify", owner: "worker" }, brief: {}, reason: "not bound", evidence: [] } } }]), clock);
  supervisor.createRootGoal("existing root", "root");
  assert.throws(() => supervisor.createRootGoal("second root", "second"), /unfinished Root Goal/);
  const accepted = await supervisor.startHumanTurn("hello"); while (ledger.turn(accepted.turnId)?.status === "in_progress") await new Promise((resolveWait)=>setTimeout(resolveWait,1));
  assert.equal(ledger.turn(accepted.turnId)?.status, "failed");
  assert.equal(ledger.goal("child"), null);
  assert.match(String((ledger.turn(accepted.turnId)?.error as { message?: string }).message), /requires a Goal-bound Turn/);
  ledger.close();
});

test("automatic Goal rounds advance from the Work Record timeline", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const supervisor = new Supervisor(ledger, fauxRunner([{ handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } }]), clock);
  createWorkerGoal(ledger);
  for (let round = 1; round <= 2; round += 1) {
    supervisor.planWake("worker", clock.now().toISOString(), `round-${round}`);
    assert.equal((await supervisor.tick())?.status, "consumed");
    clock.advance(1);
  }
  const rounds = ledger.eventsSince(0, ["run.admitted"]).map((event) => (event.data as { source: { kind: string; round?: number } }).source.round);
  assert.deepEqual(rounds, [1, 2]);
  ledger.close();
});

test("crashed wake keeps emergency mail and local partial work for recovery", async () => {
  const repo = repository();
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const crashing = fauxRunner([{ write: { path: "partial.txt", content: "keep\n" } }, { crash: "boom" }], undefined, repo);
  const first = new Supervisor(ledger, crashing, clock,{retryPolicy:{maxAttempts:2,baseDelayMs:60_000}});
  createWorkerGoal(ledger);
  ledger.putMail({ id: "urgent", to: "worker", from: "ceo", level: "emergency",...goalRoute("root"),body: { alert: true }, readAt: null }, "ceo");
  first.planWake("worker", clock.now().toISOString(), "crash");
  const abnormal = await first.tick();
  assert.equal(abnormal?.status, "consumed");assert.equal(ledger.turn(abnormal!.turnId!)?.status,"failed");
  assert.equal(ledger.unreadMail("worker").length, 1);
  assert.equal(readFileSync(join(repo, "partial.txt"), "utf8"), "keep\n");

  const recoveryContext = join(mkdtempSync(join(tmpdir(), "goah-context-")), "context.json");
  const recovering = fauxRunner([{ handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } }], recoveryContext, repo);
  ledger.enqueueWake(goalWake("recovery","worker","root",`recovery:${abnormal!.turnId}`),"supervisor");
  const second = new Supervisor(ledger, recovering, clock);
  assert.equal((await second.tick())?.status, "consumed");
  const context = JSON.parse(readFileSync(recoveryContext, "utf8")) as { text: string };
  assert.match(context.text, /# Incoming/);
  assert.match(context.text, /# Recovery/);
  assert.equal(ledger.unreadMail("worker").length, 0);
  assert.equal(ledger.events().some((event) => event.type.startsWith("workspace.")), false);
  ledger.close();
});

test("a coalesced recovery trigger preserves failure context and retry sequence",async()=>{
  const clock=new SimulatedClock();
  const ledger=createMemoryLedger({clock});
  createWorkerGoal(ledger);
  const failed=testTurn(ledger,"worker","failed",{goalId:"root",goalRevision:0});
  ledger.finishTurn(failed.id,"failed",{message:"original failure"},clock.now().toISOString(),"supervisor");
  ledger.enqueueWake(goalWake("coalesced","worker","root","manual:continue"),"supervisor");
  ledger.addWakeTrigger("coalesced","recovery:failed:2","supervisor");
  let request:RunRequest|undefined;
  const runner:Runner={isolation:"process",prepare:(value)=>{request=value;return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"failed again"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};
  const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0},retryPolicy:{maxAttempts:5,baseDelayMs:0}});
  const wake=await supervisor.tick();
  assert.match(JSON.stringify(request?.context),/original failure/);
  assert.deepEqual(request?.sourceWakeTriggers?.map((trigger)=>trigger.triggerRef),["manual:continue","recovery:failed:2"]);
  assert.equal(ledger.schedules().some((schedule)=>schedule.id===`recovery:${wake?.turnId}:3`),true);
  ledger.close();
});

test("nested Child retry exhaustion escalates to the direct parent Goal owner",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:"o",verificationMethod:"v",owner:"ceo",phase:"active",revision:0},"human");ledger.putGoal({id:"parent",parentId:"root",objective:"parent",observationMethod:"o",verificationMethod:"v",owner:"manager",phase:"active",revision:0},"ceo");ledger.putGoal({id:"leaf",parentId:"parent",objective:"leaf",observationMethod:"o",verificationMethod:"v",owner:"worker",phase:"active",revision:0},"manager");ledger.enqueueWake(goalWake("leaf-wake","worker","leaf"),"supervisor");const contexts:string[]=[];const runner:Runner={isolation:"process",prepare:(request)=>{contexts.push(JSON.stringify(request.context));return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"failed"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{profiles:[{agent:"manager",role:"child"},{agent:"worker",role:"child"}],turnRetryPolicy:{maxAttempts:1,baseDelayMs:0},retryPolicy:{maxAttempts:0,baseDelayMs:0}});const failed=await supervisor.tick();const escalation=ledger.wakes().find((wake)=>wake.status==="queued");assert.deepEqual(escalation&&{agent:escalation.agent,goalId:escalation.goalId},{agent:"manager",goalId:"parent"});assert.equal(deriveRecoveryViews(ledger).find((view)=>view.turnId===failed?.turnId)?.state,"escalated");await supervisor.tick();assert.match(contexts[1]??"",/# Recovery|transcript.interrupted/);ledger.close();});

test("Specialist failure recovery is visible in the canonical recovery view",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.enqueueWake(queuedWake("verify","verifier","verification:x"),"supervisor");const runner:Runner={isolation:"process",prepare:()=>({pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"failed"}),terminate:async()=>undefined}),terminateProcess:async()=>undefined};const failed=await new Supervisor(ledger,runner,clock,{profiles:[{agent:"verifier",role:"verifier"}],turnRetryPolicy:{maxAttempts:1,baseDelayMs:0},retryPolicy:{maxAttempts:2,baseDelayMs:1_000}}).tick();assert.equal(deriveRecoveryViews(ledger).find((view)=>view.turnId===failed?.turnId)?.state,"scheduled");ledger.close();});

test("Mail redelivery advances past coalesced terminal trigger aliases",async()=>{
  const clock=new SimulatedClock();
  const ledger=createMemoryLedger({clock});
  ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:"observe",verificationMethod:"verify",owner:"ceo",phase:"active",revision:0},"human");
  const terminal=(wakeId:string,primary:string,mailTrigger?:string)=>{ledger.enqueueWake(goalWake(wakeId,"ceo","root",primary),"supervisor");if(mailTrigger)ledger.addWakeTrigger(wakeId,mailTrigger,"supervisor");ledger.cancelWake(wakeId,clock.now().toISOString());};
  ledger.putMail({id:"decision",to:"ceo",from:"verifier",level:"decision",...goalRoute("root"),body:{},readAt:null},"verifier");
  terminal("base","mail:decision");
  terminal("alias-1","manual:1","mail:decision@redelivery:1");
  terminal("alias-2","manual:2","mail:decision@redelivery:2");
  let request:RunRequest|undefined;
  const runner:Runner={isolation:"process",prepare:(value)=>{request=value;return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"captured"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};
  const wake=await new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}}).tick();
  assert.equal(wake?.status,"consumed");
  assert.equal(ledger.unreadMail("ceo").length,1);
  assert.equal(request?.sourceWakeTriggers?.some((trigger)=>trigger.triggerRef==="mail:decision@redelivery:3"),true);
  ledger.close();
});

test("a queued Mail Wake adopts the latest Goal revision at admission",async()=>{
  const clock=new SimulatedClock();
  const ledger=createMemoryLedger({clock});
  ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active",revision:0},"human");
  ledger.putGoal({id:"child",parentId:"root",objective:"old",observationMethod:"observe",verificationMethod:"verify",owner:"worker",phase:"active",revision:0},"ceo");
  ledger.putMail({id:"decision",to:"worker",from:"ceo",level:"decision",...goalRoute("child"),body:{},readAt:null},"ceo");
  ledger.enqueueWake(goalWake("mail-wake","worker","child","mail:decision"),"supervisor");
  new Supervisor(ledger,fauxRunner([]),clock).updateGoal("child",{objective:"new",observationMethod:"observe new",verificationMethod:"verify new"},"ceo");
  let binding:unknown;
  const runner:Runner={isolation:"process",prepare:(request)=>{binding=request.turn.goalBinding;return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"observed latest revision"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};
  const wake=await new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}}).tick();
  assert.equal(wake?.status,"consumed");
  assert.deepEqual(binding,{goalId:"child",goalRevision:1});
  ledger.close();
});

test("recovery kills the recorded runner before another wake can use its local root", async () => {
  const repo = repository();
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const runner = new ProcessRunner({ command: process.execPath, args: [fauxRunnerWorkerPath()], cwd: repo, env: { GOAH_FAUX_STEPS: JSON.stringify([{ write: { path: "running.txt", content: "partial\n" }, hang: true }]) }, killGraceMs: 25 });
  const execution=testTurn(ledger,"worker","running-turn",{leaseUntil:new Date(clock.now().getTime()+100).toISOString(),leaseToken:"lease"});
  const handle = runner.prepare({ agent:"worker",execution, turn: { source: { kind: "system", reason: "test" } }, context: {}, now: () => clock.now().toISOString(), emit: () => undefined });
  ledger.attachTurnProcess(execution.id,"lease",handle.pid!);
  handle.begin();
  await waitFor(() => existsSync(join(repo, "running.txt")));
  clock.advance(200);
  await new Supervisor(ledger, runner, clock).recover();
  assert.equal(ledger.turn(execution.id)?.status, "failed");
  assert.throws(() => process.kill(handle.pid!, 0));
  assert.equal(readFileSync(join(repo, "running.txt"), "utf8"), "partial\n");
  ledger.close();
});

test("restart recovery requeues an orphaned Specialist Turn from its persisted binding",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const turn=testTurn(ledger,"quality","specialist-orphan",{specialistRole:"verifier"});const supervisor=new Supervisor(ledger,fauxRunner([]),clock,{profiles:[{agent:"quality",role:"verifier"}]});await supervisor.recover();assert.equal(ledger.turn(turn.id)?.status,"failed");const wake=ledger.queuedWakeForAgent("quality");assert.equal(wake?.bindingKind,"specialist");assert.equal(wake?.specialistRole,"verifier");assert.equal(wake?.triggerRef,`recovery:${turn.id}`);ledger.close();});

test("supervisor leaves Git history decisions to the runner", async () => {
  const repo = repository();
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const runner = fauxRunner([
    { write: { path: "README.md", content: "worker change\n" } },
    { handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } },
  ], undefined, repo);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const supervisor = new Supervisor(ledger, runner, clock);
  createWorkerGoal(ledger); supervisor.planWake("worker", clock.now().toISOString(), "local edit");
  assert.equal((await supervisor.tick())?.status, "consumed");
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "worker change\n");
  assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
  assert.match(git(repo, ["status", "--short"]), /README\.md/);
  ledger.close();
});

test("schedule and mail triggers are durable and coalesced", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const supervisor = new Supervisor(ledger, fauxRunner([{ handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } }]), clock);
  createWorkerGoal(ledger);
  ledger.putMail({ id: "decision", to: "worker", from: "ceo", level: "decision", ...goalRoute("root"),body: {}, readAt: null }, "ceo");
  supervisor.planWake("worker", clock.now().toISOString(), "scheduled");
  await supervisor.tick();
  assert.equal(ledger.wakes().filter((wake) => wake.agent === "worker").length, 1);
  assert.equal(ledger.events().some((event) => event.type === "wake_trigger.added"), true);
  ledger.close();
});

test("supervisor renews a live runner lease instead of treating duration as a task limit", async () => {
  const clock: Clock = { now: () => new Date() };
  const ledger = createMemoryLedger({ clock });
  const runner = fauxRunner([
    { delayMs: 120 },
    { handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } },
  ]);
  const supervisor = new Supervisor(ledger, runner, clock, { leaseMs: 60 });
  createWorkerGoal(ledger); supervisor.planWake("worker", clock.now().toISOString(), "renew lease");
  assert.equal((await supervisor.tick())?.status, "consumed");
  assert.equal(ledger.events().some((event) => event.type === "turn.in_progress"), true);
  ledger.close();
});

test("verification plane records findings and reports calibrated quality", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const supervisor = new Supervisor(ledger, fauxRunner([]), clock);
  createWorkerGoal(ledger);
  const evidence = ledger.appendEvent({ ...event("worker", "tool.fact", { value: 1 }, "w"), ts: clock.now().toISOString() });
  const verifyTurn=testTurn(ledger,"worker","w",{source:"goal",goalId:"root",goalRevision:0});ledger.finishTurn(verifyTurn.id,"failed",{message:"verification target"},clock.now().toISOString(),"supervisor");
  ledger.appendEvent({ ...event("worker", "handoff.recorded", {goalId:"root",goalRevision:0,recordRevision:1,outcome:"progress",evidence:[evidence.seq]}, "w"), ts: clock.now().toISOString() });
  let blindPayload = "";
  let verifiedTurn="";
  const model: VerifierModel = {
    verifyTurn: async (input) => {verifiedTurn=input.turnId;return{ findings: [{ id: "finding-a", body: { issue: "unsupported" }, evidence: [evidence.seq], riskWeight: 2 }], tokensUsed: 10 }},
    blindAudit: async (facts) => { blindPayload = JSON.stringify(facts); return { findings: [], tokensUsed: 5 }; },
  };
  const plane = new VerificationPlane(ledger, supervisor, model);
  await plane.verifyTurn("w");
  assert.equal(verifiedTurn,"w");
  assert.deepEqual(ledger.mailbox().filter((mail)=>mail.from==="verifier").map((mail)=>mail.to),["worker"]);
  await plane.auditGlobal();
  assert.match(blindPayload, /tool.fact/);
  assert.deepEqual(evaluateVerification([
    { id: "high", shouldFlag: true, riskWeight: 9 },
    { id: "low", shouldFlag: true, riskWeight: 1 },
    { id: "ok", shouldFlag: false, riskWeight: 1 },
  ], ["high", "ok"]), { precision: 0.5, riskWeightedRecall: 0.9 });
  assert.equal(calibrateVerificationThreshold([
    { id: "high", shouldFlag: true, riskWeight: 9 }, { id: "low", shouldFlag: true, riskWeight: 1 }, { id: "ok", shouldFlag: false, riskWeight: 1 },
  ], [{ id: "high", score: 0.9 }, { id: "low", score: 0.4 }, { id: "ok", score: 0.6 }], 0.9), 0.9);
  ledger.close();
});

test("verification refuses missing and in-progress Turns",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const supervisor=new Supervisor(ledger,fauxRunner([]),clock);const model:VerifierModel={verifyTurn:async()=>({findings:[],tokensUsed:0}),blindAudit:async()=>({findings:[],tokensUsed:0})};const plane=new VerificationPlane(ledger,supervisor,model);await assert.rejects(()=>plane.verifyTurn("missing"),/Turn not found/);const turn=testTurn(ledger,"worker","active-verify");await assert.rejects(()=>plane.verifyTurn(turn.id),/in-progress/);assert.deepEqual(ledger.readStream("turn:missing"),[]);ledger.close();});

test("verification validates the complete result before committing it",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const supervisor=new Supervisor(ledger,fauxRunner([]),clock);const evidence=ledger.appendEvent({...event("worker","fact"),ts:clock.now().toISOString()});const turn=testTurn(ledger,"worker","verify-atomic");ledger.finishTurn(turn.id,"completed",null,clock.now().toISOString(),"supervisor");const model:VerifierModel={verifyTurn:async()=>({findings:[{id:"valid",body:{},evidence:[evidence.seq],riskWeight:1},{id:"invalid",body:{},evidence:[999999],riskWeight:1}],tokensUsed:0}),blindAudit:async()=>({findings:[],tokensUsed:0})};await assert.rejects(()=>new VerificationPlane(ledger,supervisor,model).verifyTurn(turn.id),/existing evidence/);assert.equal(ledger.mailbox().some((mail)=>mail.from==="verifier"),false);ledger.close();});

test("verification routes a custom-named Specialist from the Turn binding, not the Agent name",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const supervisor=new Supervisor(ledger,fauxRunner([]),clock,{profiles:[{agent:"quality",role:"verifier"}]});const turn=testTurn(ledger,"quality","quality-turn",{specialistRole:"verifier"});ledger.finishTurn(turn.id,"completed",null,clock.now().toISOString(),"supervisor");const model:VerifierModel={verifyTurn:async()=>({findings:[],tokensUsed:1}),blindAudit:async()=>({findings:[],tokensUsed:0})};await new VerificationPlane(ledger,supervisor,model).verifyTurn(turn.id);const mail=ledger.unreadMail("quality")[0]!;assert.equal(mail.routeKind,"specialist_inbox");assert.equal(mail.specialistRole,"verifier");ledger.close();});

test("Verification Mail reaches the next Human Turn and is acknowledged on success",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const contexts:JsonValue[]=[];const runner:Runner={isolation:"process",prepare:(request)=>{contexts.push(request.context);return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"response" as const,response:{content:"ok"}}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);const first=await supervisor.startHumanTurn("first");while(ledger.turn(first.turnId)?.status==="in_progress")await new Promise((resolve)=>setImmediate(resolve));const evidence=ledger.readStream(`turn:${first.turnId}`)[0]!.seq;const model:VerifierModel={verifyTurn:async()=>({findings:[{id:"f",body:{issue:"must surface"},evidence:[evidence],riskWeight:1}],tokensUsed:1}),blindAudit:async()=>({findings:[],tokensUsed:0})};await new VerificationPlane(ledger,supervisor,model).verifyTurn(first.turnId);const mail=ledger.unreadMail("ceo")[0]!;const mailSeq=ledger.eventsSince(0,["mail.put"]).find((event)=>((event.data as {snapshot?:{id?:unknown}}).snapshot?.id===mail.id))!.seq;assert.equal(await supervisor.tick(),null);const second=await supervisor.startHumanTurn("second");while(ledger.turn(second.turnId)?.status==="in_progress")await new Promise((resolve)=>setImmediate(resolve));assert.match(JSON.stringify(contexts[1]),/must surface/);assert.equal(((contexts[1] as {sourceSeqs?:number[]}).sourceSeqs??[]).includes(mailSeq),true);assert.equal(ledger.unreadMail("ceo").length,0);ledger.close();});

test("Human context delivers Mail in bounded FIFO batches",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});let context:JsonValue=null;const runner:Runner={isolation:"process",prepare:(request)=>{context=request.context;return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"response" as const,response:{content:"ok"}}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock);for(let index=0;index<25;index+=1)ledger.putMail({id:`m${index}`,to:"ceo",from:"human",level:"fyi",...humanInboxRoute(),body:{message:`mail-${index}`},readAt:null},"human");const turn=await supervisor.startHumanTurn("review inbox");while(ledger.turn(turn.turnId)?.status==="in_progress")await new Promise((resolve)=>setImmediate(resolve));assert.match(JSON.stringify(context),/mail-0/);assert.doesNotMatch(JSON.stringify(context),/mail-24/);assert.equal(ledger.unreadMail("ceo").length,5);ledger.close();});

test("Wake triggers cannot mix Human and system execution bindings",()=>{const ledger=createMemoryLedger();ledger.putMail({id:"human-mail",to:"ceo",from:"human",level:"decision",...humanInboxRoute(),body:{},readAt:null},"human");ledger.putMail({id:"remaining",to:"ceo",from:"verifier",level:"decision",...humanInboxRoute(),body:{},readAt:null},"verifier");ledger.enqueueWake(queuedWake("mixed","ceo","mail:human-mail"),"supervisor");assert.throws(()=>ledger.addWakeTrigger("mixed","mail:remaining","supervisor"),/does not match/);assert.deepEqual(ledger.wakeTriggers("mixed").map((trigger)=>trigger.triggerRef),["mail:human-mail"]);ledger.close();});

test("two agents run concurrently while CEO context and dashboard see the organization", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const runner = fauxRunner([{ delayMs: 50 }, { handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } }]);
  const supervisor = new Supervisor(ledger, runner, clock, { profiles: [{ agent: "ceo", role: "ceo" }, { agent: "a", role: "child" }, { agent: "b", role: "child" }] });
  ledger.putGoal({ id: "root", parentId: null, objective: "organization", observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 0 }, "human");
  ledger.putGoal({ id: "a-goal", parentId: "root", objective: "a", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "a", phase: "active", revision: 0 }, "ceo");
  ledger.putGoal({ id: "b-goal", parentId: "root", objective: "b", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "b", phase: "active", revision: 0 }, "ceo");
  supervisor.planWake("a", clock.now().toISOString(), "a");
  supervisor.planWake("b", clock.now().toISOString(), "b");
  const completed = await supervisor.runAvailable(2);
  assert.deepEqual(completed.map((wake) => wake.agent).sort(), ["a", "b"]);
  assert.match(renderDashboard(ledger), /organization/);

  const ceoContext = join(mkdtempSync(join(tmpdir(), "goah-context-")), "context.json");
  const ceoSupervisor = new Supervisor(ledger, fauxRunner([{ handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } }], ceoContext), clock, { profiles: [{ agent: "ceo", role: "ceo" }] });
  ceoSupervisor.planWake("ceo", clock.now().toISOString(), "replan");
  await ceoSupervisor.tick();
  const ceoText = (JSON.parse(readFileSync(ceoContext, "utf8")) as { text: string }).text;
  for (const id of ["root", "a-goal", "b-goal"]) assert.match(ceoText, new RegExp(`\\[${id}\\]`));

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await runSupervisorDaemon(supervisor, { pollMs: 5, concurrency: 2, signal: controller.signal });
  ledger.close();
});

test("daemon polling does not accumulate AbortSignal listeners",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const supervisor=new Supervisor(ledger,fauxRunner([]),clock);const controller=new AbortController();const running=runSupervisorDaemon(supervisor,{pollMs:0,signal:controller.signal});await new Promise((resolve)=>setTimeout(resolve,30));assert.ok(getEventListeners(controller.signal,"abort").length<=1);controller.abort();await running;ledger.close();});

test("accelerated 30-day soak keeps wake context bounded and projections replayable", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const contextFile = join(mkdtempSync(join(tmpdir(), "goah-soak-")), "context.json");
  const supervisor = new Supervisor(ledger, fauxRunner([{ handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } }], contextFile), clock);
  createWorkerGoal(ledger);
  for (let day = 0; day < 30; day += 1) {
    supervisor.planWake("worker", clock.now().toISOString(), `day-${day}`);
    assert.equal((await supervisor.tick())?.status, "consumed");
    assert.ok(readFileSync(contextFile).byteLength < 20_000);
    clock.advance(86_400_000);
  }
  assert.equal(ledger.wakes().filter((wake) => wake.status === "consumed").length, 30);
  const before = JSON.stringify({ goals: ledger.goals(), wakes: ledger.wakes(), schedules: ledger.schedules() });
  ledger.rebuildProjections();
  assert.equal(JSON.stringify({ goals: ledger.goals(), wakes: ledger.wakes(), schedules: ledger.schedules() }), before);
  ledger.close();
});

test("official Pi agent core worker completes a structured handoff through the process boundary", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const runner = new ProcessRunner({ command: process.execPath, args: [piWorkerPath()], env: {
    GOAH_PI_PROVIDER: "faux",
    GOAH_PI_MODEL: "faux-goah",
    GOAH_PI_COMPACT_AT_TOKENS: "10",
    GOAH_PI_RETAIN_CONTEXT_TOKENS: "1",
    GOAH_PI_FAUX_HANDOFF: JSON.stringify({ outcome:"progress" }),
  } });
  const supervisor = new Supervisor(ledger, runner, clock);
  createWorkerGoal(ledger); supervisor.planWake("worker", clock.now().toISOString(), "pi integration");
  const completed=await supervisor.tick();assert.equal(completed?.status, "consumed");
  const started = ledger.events().find((event) => event.type === "transcript.started");
  assert.equal((started?.data as { formatVersion?: number }).formatVersion, 1);
  assert.equal(ledger.events().some((event) => event.type === "request.prepared"), true);
  const prepared = ledger.events().find((event) => event.type === "request.prepared")?.data as { tools?: Array<{ name?: string }> };
  assert.equal(prepared.tools?.some((tool) => tool.name === "delegate_goal"), false);
  assert.equal(prepared.tools?.some((tool) => tool.name === "team_list"), false);
  assert.equal(prepared.tools?.some((tool) => tool.name === "ledger_search"), true);
  for (const name of ["read", "write", "edit", "bash", "handoff", "work_record_update"]) assert.equal(prepared.tools?.some((tool) => tool.name === name), true, name);
  assert.equal(prepared.tools?.some((tool) => tool.name === "memory_append"), false);
  const handoff=ledger.lastEvent("worker","handoff.recorded")?.data as {goalId?:unknown;goalRevision?:unknown;recordRevision?:unknown;outcome?:unknown;evidence?:unknown[]};assert.deepEqual({goalId:handoff.goalId,goalRevision:handoff.goalRevision,recordRevision:handoff.recordRevision,outcome:handoff.outcome},{goalId:"root",goalRevision:0,recordRevision:1,outcome:"progress"});assert.equal((handoff.evidence??[]).length,1);
  assert.equal(ledger.turnItems(completed!.turnId!).filter((item)=>item.type==="assistant_message").length,1);assert.equal(ledger.readStream(`turn:${completed!.turnId}`).filter((event)=>event.type==="response.committed").length,1);
  ledger.close();
});

test("official Pi returns correctable Handoff issues to the live Agent and succeeds after repair",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});createWorkerGoal(ledger);const runner=new ProcessRunner({command:process.execPath,args:[piWorkerPath()],env:{GOAH_PI_PROVIDER:"faux",GOAH_PI_MODEL:"faux-goah",GOAH_PI_FAUX_HANDOFF_REPAIR:"1"}});const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});supervisor.planWake("worker",clock.now().toISOString(),"repair Handoff");const wake=await supervisor.tick();const turn=ledger.turn(wake!.turnId!)!;assert.equal(turn.status,"completed");const stream=ledger.readStream(`turn:${turn.id}`);assert.equal(stream.filter((event)=>event.type==="rpc.goal.handoff.validate").length,2);assert.equal(stream.filter((event)=>event.type==="tool.called"&&(event.data as {name?:unknown}).name==="handoff").length,2);assert.equal(stream.filter((event)=>event.type==="response.committed").length,1);assert.deepEqual(ledger.turnItems(turn.id).filter((item)=>item.type==="assistant_message").map((item)=>(item.data as {text:string}).text),["Premature completion attempt.","Goal work recorded with outcome progress."]);ledger.close();});

test("process faux Runner continues after correctable Handoff feedback",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});createWorkerGoal(ledger);const supervisor=new Supervisor(ledger,fauxRunner([{handoff:{response:{content:"bad evidence"},handoff:{outcome:"progress",evidence:[999999]}}},{handoff:{response:{content:"repaired evidence"},handoff:{outcome:"progress",evidence:[1]}}}]),clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});supervisor.planWake("worker",clock.now().toISOString(),"repair in adapter");const wake=await supervisor.tick();assert.equal(ledger.turn(wake!.turnId!)?.status,"completed");assert.equal(ledger.readStream(`turn:${wake!.turnId}`).filter((event)=>event.type==="runner.handoff_rejected").length,1);assert.equal((ledger.turnItems(wake!.turnId!).findLast((item)=>item.type==="assistant_message")?.data as {text?:unknown}).text,"repaired evidence");ledger.close();});

test("failed Runner execution ends the canonical transcript as interrupted",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const runner=new ProcessRunner({command:process.execPath,args:[piWorkerPath()],env:{GOAH_PI_PROVIDER:"faux",GOAH_PI_MODEL:"faux-goah",GOAH_PI_FAUX_ERROR:"provider failed"}});const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:1}});const accepted=await supervisor.startHumanTurn("hello");while(ledger.turn(accepted.turnId)?.status==="in_progress")await new Promise((resolve)=>setTimeout(resolve,5));const terminals=ledger.readStream(`turn:${accepted.turnId}`).filter((event)=>event.type==="transcript.completed"||event.type==="transcript.interrupted").map((event)=>event.type);assert.deepEqual(terminals,["transcript.interrupted"]);ledger.close();});

test("official Pi worker exposes organization tools only to the CEO profile", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const runner = new ProcessRunner({ command: process.execPath, args: [piWorkerPath()], env: {
    GOAH_PI_PROVIDER: "faux",
    GOAH_PI_MODEL: "faux-ceo",
    GOAH_PI_FAUX_HANDOFF: JSON.stringify({ outcome:"progress" }),
  } });
  const supervisor = new Supervisor(ledger, runner, clock);
  supervisor.startGoal("operate organization", "pi-ceo-root");
  assert.equal((await supervisor.tick())?.status, "consumed");
  const prepared = ledger.events().find((event) => event.type === "request.prepared")?.data as { tools?: Array<{ name?: string }> };
  assert.equal(prepared.tools?.some((tool) => tool.name === "delegate_goal"), true);
  assert.equal(prepared.tools?.some((tool) => tool.name === "team_list"), true);
  assert.equal(prepared.tools?.some((tool) => tool.name === "put_goal"), false);
  for (const name of ["read", "write", "edit", "bash", "handoff", "work_record_update"]) assert.equal(prepared.tools?.some((tool) => tool.name === name), true, name);
  assert.equal(prepared.tools?.some((tool) => tool.name === "memory_append"), false);
  ledger.close();
});

test("bidirectional runner RPC applies child capabilities and rejects parent-only goal writes", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const seed = ledger.appendEvent({ ...event("worker", "fact", { text: "rpcseed" }), ts: clock.now().toISOString() });
  const runner = fauxRunner([
    { rpc: { method: "ledger.search", params: { query: "rpcseed" } } },
    { rpc: { method: "mail.send", params: { to: "ceo", goalId:"parent", level: "fyi", body: { message: "working" } } } },
    { rpc: { method: "schedule.set", params: { at: "2026-08-20T00:00:00.000Z", reason: "continue" } } },
    { handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } },
  ]);
  const supervisor = new Supervisor(ledger, runner, clock, { profiles: [{ agent: "worker", role: "child" }] });
  createWorkerGoal(ledger); supervisor.planWake("worker", clock.now().toISOString(), "rpc");
  assert.equal((await supervisor.tick())?.status, "consumed");
  assert.equal(ledger.mailbox().some((mail) => mail.to === "ceo"), true);
  assert.equal(ledger.schedules().find((schedule)=>schedule.reason==="continue")?.nextWakeAt, "2026-08-20T00:00:00.000Z");
  assert.equal(ledger.events().filter((event) => event.type.startsWith("rpc.")).length, 6);

  const denied = new Supervisor(ledger, fauxRunner([{ rpc: { method: "goal.put", params: { goal: { ...goal(), revision: 1 } } } }]), clock, { profiles: [{ agent: "worker", role: "child" }] });
  clock.advance(1);
  denied.planWake("worker", clock.now().toISOString(), "denied");
  const deniedWake=await denied.tick();assert.equal(deniedWake?.status,"consumed");assert.equal(ledger.turn(deniedWake!.turnId!)?.status,"failed");
  assert.equal(ledger.goal("root")?.revision, 0);
  ledger.close();
});

test("legacy Goal memory remains readable while Goal Agents write Work Records instead", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const staleNote = `legacy survey: ${"x".repeat(500)}`;
  const supervisor = new Supervisor(ledger, fauxRunner([]), clock, { memoryTailChars: 200 });
  createWorkerGoal(ledger);
  ledger.appendEvent({ streamId: "memory:worker", ts: clock.now().toISOString(), actor: "worker", type: "memory.appended", data: { note: staleNote, turnId: "legacy-1" } });
  ledger.appendEvent({ streamId: "memory:worker", ts: clock.now().toISOString(), actor: "worker", type: "memory.appended", data: { note: "integration tests fake-fail when the clock is mocked; approach A rejected: metric freshness window", turnId: "legacy-2" } });
  const memoryEvents = ledger.readStream(`memory:worker`).filter((item) => item.type === "memory.appended");
  assert.equal(memoryEvents.length, 2);

  const secondContext = join(mkdtempSync(join(tmpdir(), "goah-memory-")), "context-2.json");
  supervisor.planWake("worker", clock.now().toISOString(), "memory-second");
  assert.equal((await new Supervisor(ledger, fauxRunner([{ handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } }], secondContext), clock, { memoryTailChars: 200 }).tick())?.status, "consumed");
  const context = JSON.parse(readFileSync(secondContext, "utf8")) as { text: string; sourceSeqs: number[] };
  assert.match(context.text, /# Working memory\n\n- integration tests fake-fail[^\n]*\[event:\d+\]/);
  assert.doesNotMatch(context.text, /legacy survey/);
  assert.equal(context.sourceSeqs.includes(memoryEvents[1]!.seq), true);
  assert.equal(context.sourceSeqs.includes(memoryEvents[0]!.seq), false);
  assert.equal(ledger.readStream(`memory:worker`).length, 2);
  ledger.close();
});

test("CEO role delegates atomically and receives its dedicated operating policy", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const root = { id: "ceo-root", parentId: null, objective: "build organization", observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 0 } as const;
  ledger.putGoal(root, "human");
  const evidence = ledger.appendEvent({ ...event("ceo", "organization.observed", { independent: true }), ts: clock.now().toISOString() });
  assert.throws(() => ledger.commitDelegation({ id: "self-delegation", parentGoalId: "ceo-root",expectedParentRevision:0, childGoal: { id: "self-child", objective: "vague", observationMethod: "none", verificationMethod: "none", owner: "ceo" }, brief: {}, reason: "self", evidence: [evidence.seq] }, "ceo"), /distinct worker agent/);
  const contextFile = join(mkdtempSync(join(tmpdir(), "goah-ceo-")), "context.json");
  const supervisor = new Supervisor(ledger, fauxRunner([
    { rpc: { method: "goal.delegate", params: { id: "delegation-1", parentGoalId: "ceo-root",expectedParentRevision:0, childGoal: { id: "child", objective: "own observation", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "worker" }, brief: { deliverable: "evidence" }, reason: "independent result", evidence: [evidence.seq] } } },
    { handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } },
  ], contextFile), clock, { profiles: [{ agent: "ceo", role: "ceo" }] });
  supervisor.planWake("ceo", clock.now().toISOString(), "replan");
  assert.equal((await supervisor.tick())?.status, "consumed");
  assert.equal(ledger.goal("child")?.owner, "worker");
  assert.equal(ledger.unreadMail("worker").length, 1);
  assert.equal(ledger.queuedWakeForAgent("worker")?.triggerRef, "delegation:delegation-1");
  const context = JSON.parse(readFileSync(contextFile, "utf8")) as { systemPrompt: string; text: string };
  assert.match(context.systemPrompt, /operationalize the goal/i);
  assert.match(context.text, /Observation methods[\s\S]*MISSING/);
  ledger.close();
});

test("human observation confirmation and root revision wake CEO without preserving a stale method", () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const supervisor = new Supervisor(ledger, fauxRunner([]), clock);
  const started = supervisor.startGoal("grow revenue", "revenue");
  assert.equal(ledger.goal("revenue")?.observationMethod, null);
  const confirmed = supervisor.confirmObservationMethod("revenue", "Run the net revenue report every six hours.");
  assert.equal(confirmed.revision, 1);
  assert.match(confirmed.observationMethod ?? "", /net revenue/);
  const revised = supervisor.updateGoal("revenue", { objective: "grow retained net revenue" }, "human");
  assert.equal(revised.observationMethod, null);
  assert.equal(revised.revision, 2);
  assert.equal(ledger.wake(started.wake.id)?.status, "queued");
  assert.equal(ledger.wakeTriggers(started.wake.id).length,3);
  ledger.close();
});

test("Supervisor accepts a valid declarative CEO Handoff without inventing organization motion", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const supervisor = new Supervisor(ledger, fauxRunner([{ handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } }]), clock, { retryPolicy: { maxAttempts: 2, baseDelayMs: 1 } });
  const started = supervisor.startGoal("operate without stalling", "root-motion");
  assert.equal(started.wake.agent, "ceo");
  const completed=await supervisor.tick();assert.equal(completed?.status,"consumed");assert.equal(ledger.turn(completed!.turnId!)?.status,"completed");
  assert.equal(ledger.events().some((item) => item.type === "ceo.motion_invalid"), false);
  ledger.close();
});

test("all Goal Handoff outcomes are declarative and have no implicit effects",async()=>{for(const outcome of ["progress","waiting","blocked","completion_proposed"] as const){const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const supervisor=new Supervisor(ledger,fauxRunner([{handoff:{response:{content:"Goal work recorded."},handoff:{outcome,evidence:[1]}}}]),clock);createWorkerGoal(ledger);supervisor.planWake("worker",clock.now().toISOString(),outcome);const wake=await supervisor.tick();assert.equal(ledger.turn(wake!.turnId!)?.status,"completed");assert.equal(ledger.goal("root")?.phase,"active");assert.equal(ledger.mailbox().length,0);assert.equal(ledger.schedules().filter((schedule)=>schedule.status==="pending").length,0);assert.equal(ledger.wakes().length,1);assert.equal(supervisor.teamList().find((member)=>member.agent==="worker")?.lastOutcome,outcome);ledger.close();}});

test("Agent Mail cannot masquerade as a Human or specialist inbox route",()=>{const ledger=createMemoryLedger();assert.throws(()=>ledger.putMail({id:"to-child",to:"worker",from:"ceo",level:"decision",...humanInboxRoute(),body:{},readAt:null},"ceo"),/Human inbox/);assert.throws(()=>ledger.putMail({id:"to-ceo",to:"ceo",from:"worker",level:"decision",...humanInboxRoute(),body:{},readAt:null},"worker"),/Human inbox/);ledger.close();});

test("a forged unbound Child Wake is cancelled before Runner admission",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});createWorkerGoal(ledger);ledger.enqueueWake(queuedWake("unbound-child","worker","manual:invalid"),"supervisor");let prepared=false;const runner:Runner={isolation:"process",prepare:()=>{prepared=true;throw new Error("must not run")},terminateProcess:async()=>undefined};const wake=await new Supervisor(ledger,runner,clock,{profiles:[{agent:"worker",role:"child"}]}).tick();assert.equal(wake?.status,"cancelled");assert.equal(prepared,false);assert.equal(ledger.turns().length,0);ledger.close();});

test("Verifier retains the explicit unbound specialist execution path",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.enqueueWake(queuedWake("verify","verifier","verification:turn"),"supervisor");let source="";const runner:Runner={isolation:"process",prepare:(request)=>{source=request.turn.source.kind;return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"response" as const,response:{content:"verified"}}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const wake=await new Supervisor(ledger,runner,clock,{profiles:[{agent:"verifier",role:"verifier"}]}).tick();assert.equal(wake?.status,"consumed");assert.equal(source,"system");assert.equal(ledger.turn(wake!.turnId!)?.goalId,null);ledger.close();});

test("Specialist inbox Mail opens only the matching Specialist Turn",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putMail({id:"verify-mail",to:"verifier",from:"supervisor",level:"decision",...specialistInboxRoute("verifier"),body:{request:"inspect"},readAt:null},"supervisor");let context="";const runner:Runner={isolation:"process",prepare:(request)=>{context=JSON.stringify(request.context);return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"response" as const,response:{content:"done"}}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const wake=await new Supervisor(ledger,runner,clock,{profiles:[{agent:"verifier",role:"verifier"}]}).tick();assert.equal(wake?.bindingKind,"specialist");assert.match(context,/inspect/);assert.equal(ledger.unreadMail("verifier").length,0);ledger.close();});

test("official Pi applies a custom Child prompt only inside its Goal Turn",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});createWorkerGoal(ledger);const runner=new ProcessRunner({command:process.execPath,args:[piWorkerPath()],env:{GOAH_PI_PROVIDER:"faux",GOAH_PI_MODEL:"faux-goah"}});const supervisor=new Supervisor(ledger,runner,clock,{profiles:[{agent:"worker",role:"child",systemPrompt:"Keep the configured worker identity."}],turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});supervisor.planWake("worker",clock.now().toISOString(),"inspect");const wake=await supervisor.tick();const prepared=ledger.readStream(`turn:${wake!.turnId}`).find((event)=>event.type==="request.prepared")?.data as {systemPrompt?:unknown};const prompt=String(prepared.systemPrompt??"");assert.match(prompt,/Keep the configured worker identity/);assert.match(prompt,/This Turn is Goal-bound/);assert.doesNotMatch(prompt,/starts without a Goal binding|has no Goal binding/);ledger.close();});

test("Child mail.send cannot bypass the CEO-only Human request path",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:"o",verificationMethod:"v",owner:"ceo",phase:"active",revision:0},"human");ledger.putGoal({id:"child",parentId:"root",objective:"child",observationMethod:"o",verificationMethod:"v",owner:"worker",phase:"active",revision:0},"ceo");const runner=fauxRunner([{rpc:{method:"mail.send",params:{to:"human",level:"decision",body:{message:"bypass"}}}},{handoff:{response:{content:"Goal work recorded."},handoff:{outcome:"progress",evidence:[1]}}}]);const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});ledger.enqueueWake(goalWake("child","worker","child"),"supervisor");const wake=await supervisor.tick();assert.equal(ledger.turn(wake!.turnId!)?.status,"failed");assert.equal(ledger.unreadMail("human").length,0);ledger.close();});

test("mail.send rejects an unknown Agent recipient before writing Mail",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});createWorkerGoal(ledger);const runner=fauxRunner([{rpc:{method:"mail.send",params:{to:"wroker",level:"decision",body:{message:"typo"}}}},{handoff:{response:{content:"Goal work recorded."},handoff:{outcome:"progress",evidence:[1]}}}]);const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});ledger.enqueueWake(goalWake("child","worker","root"),"supervisor");const wake=await supervisor.tick();assert.equal(ledger.turn(wake!.turnId!)?.status,"failed");assert.equal(ledger.mailbox().length,0);ledger.close();});

test("mail.send requires an explicit recipient Goal route",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});createWorkerGoal(ledger);const runner=fauxRunner([{rpc:{method:"mail.send",params:{to:"ceo",level:"decision",body:{message:"missing route"}}}},{handoff:{response:{content:"Goal work recorded."},handoff:{outcome:"progress",evidence:[1]}}}]);const supervisor=new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});ledger.enqueueWake(goalWake("child-mail","worker","root"),"supervisor");const wake=await supervisor.tick();assert.equal(ledger.turn(wake!.turnId!)?.status,"failed");assert.match(String((ledger.turn(wake!.turnId!)?.error as {message?:unknown})?.message),/requires a Goal route/);assert.equal(ledger.mailbox().length,0);ledger.close();});

test("a Goal Turn receives only Mail routed to that Goal",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putGoal({id:"parent",parentId:null,objective:"parent",observationMethod:"observe",verificationMethod:"verify",owner:"ceo",phase:"active",revision:0},"human");for(const id of ["a","z"])ledger.putGoal({id,parentId:"parent",objective:id,observationMethod:"observe",verificationMethod:"verify",owner:"worker",phase:"active",revision:0},"ceo");ledger.putMail({id:"mail-a",to:"worker",from:"ceo",level:"decision",...goalRoute("a"),body:{secret:"only-a"},readAt:null},"ceo");ledger.enqueueWake(goalWake("wake-z","worker","z","goal:z"),"supervisor");let context="";const runner:Runner={isolation:"process",prepare:(request)=>{context=JSON.stringify(request.context);return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"captured"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};await new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}}).tick();assert.doesNotMatch(context,/only-a/);assert.equal(ledger.unreadMail("worker").some((mail)=>mail.id==="mail-a"),true);ledger.close();});

test("pausing a Goal retires its future Schedule and clears Team motion",()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const supervisor=new Supervisor(ledger,fauxRunner([]),clock);createWorkerGoal(ledger);supervisor.planWake("worker",new Date(clock.now().getTime()+60_000).toISOString(),"later");supervisor.transitionGoal("root","paused","ceo");assert.equal(ledger.schedules()[0]?.status,"superseded");assert.equal(supervisor.teamList().find((member)=>member.agent==="worker")?.nextWakeAt,null);ledger.close();});

test("blocking a Goal cancels its queued Wake and clears Team motion",()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const supervisor=new Supervisor(ledger,fauxRunner([]),clock);createWorkerGoal(ledger);ledger.enqueueWake(goalWake("blocked-wake","worker","root"),"supervisor");supervisor.transitionGoal("root","blocked","ceo");assert.equal(ledger.wake("blocked-wake")?.status,"cancelled");assert.equal(supervisor.teamList().find((member)=>member.agent==="worker")?.motion,"idle");ledger.close();});

test("inactive reassignment stays dormant until resume creates the new owner's Goal Turn",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});createWorkerGoal(ledger);const evidence=ledger.appendEvent({streamId:"control:test",ts:clock.now().toISOString(),actor:"ceo",type:"observed",data:{}});const contexts:JsonValue[]=[];const bindings:unknown[]=[];const runner:Runner={isolation:"process",prepare:(request)=>{contexts.push(request.context);bindings.push(request.turn.goalBinding);return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"captured"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};const supervisor=new Supervisor(ledger,runner,clock,{profiles:[{agent:"new-worker",role:"child"}],turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}});supervisor.transitionGoal("root","paused","ceo");const moved=await supervisor.reassignGoal({id:"move-paused",goalId:"root",expectedGoalRevision:1,newOwner:"new-worker",brief:{},reason:"replace owner",evidence:[evidence.seq]},"ceo");assert.equal(moved.wake,null);assert.equal(await supervisor.tick(),null);supervisor.transitionGoal("root","active","ceo");const wake=await supervisor.tick();assert.equal(wake?.agent,"new-worker");assert.deepEqual(bindings[0],{goalId:"root",goalRevision:3});assert.match(JSON.stringify(contexts[0]),/move-paused/);ledger.close();});

test("Goal context scopes Last outcome to the bound Goal",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});ledger.putGoal({id:"root",parentId:null,objective:"root",observationMethod:"o",verificationMethod:"v",owner:"ceo",phase:"active",revision:0},"human");for(const id of ["a","z"])ledger.putGoal({id,parentId:"root",objective:id,observationMethod:"o",verificationMethod:"v",owner:"worker",phase:"active",revision:0},"ceo");ledger.appendEvent({streamId:"turn:old-a",ts:clock.now().toISOString(),actor:"worker",type:"handoff.recorded",data:{goalId:"a",goalRevision:0,recordRevision:1,outcome:"blocked",evidence:[1]}});ledger.enqueueWake(goalWake("wake-z","worker","z","goal:z"),"supervisor");let context="";const runner:Runner={isolation:"process",prepare:(request)=>{context=String((request.context as {text?:unknown}).text??"");return{pid:null,begin:()=>undefined,result:Promise.resolve({outcome:"abnormal" as const,reason:"captured"}),terminate:async()=>undefined}},terminateProcess:async()=>undefined};await new Supervisor(ledger,runner,clock,{turnRetryPolicy:{maxAttempts:1,baseDelayMs:0}}).tick();assert.doesNotMatch(context,/# Last outcome[\s\S]*blocked/);ledger.close();});

test("Mail and Schedule effects occur only when the Agent requests them explicitly",async()=>{const clock=new SimulatedClock();const ledger=createMemoryLedger({clock});const nextWakeAt=new Date(clock.now().getTime()+60_000).toISOString();const supervisor=new Supervisor(ledger,fauxRunner([{rpc:{method:"mail.send",params:{to:"ceo",goalId:"parent",level:"decision",body:{type:"explicit_notice"}}}},{rpc:{method:"schedule.set",params:{at:nextWakeAt,reason:"explicit follow-up"}}},{handoff:{response:{content:"Goal work recorded."},handoff:{outcome:"waiting",evidence:[1]}}}]),clock);createWorkerGoal(ledger);supervisor.planWake("worker",clock.now().toISOString(),"work");await supervisor.tick();assert.equal(ledger.unreadMail("ceo").some((mail)=>(mail.body as {type?:string}).type==="explicit_notice"&&mail.goalId==="parent"),true);assert.equal(ledger.schedules().some((schedule)=>schedule.status==="pending"&&schedule.nextWakeAt===nextWakeAt),true);ledger.close();});

test("one root goal forms a two-agent organization and returns completion control to the human", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const byTrigger = {
    "root:company:revised:1": [
      { rpc: { method: "team.list", params: {} } },
      { rpc: { method: "goal.delegate", params: { id: "d-research", parentGoalId: "company",expectedParentRevision:1, childGoal: { id: "market", objective: "validate demand", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "research" }, brief: { deliverable: "evidence" }, reason: "independent evidence boundary", evidence: [1] } } },
      { rpc: { method: "goal.delegate", params: { id: "d-operations", parentGoalId: "company",expectedParentRevision:1, childGoal: { id: "operations", objective: "design fulfillment", observationMethod: "Verify the objective through an evidence-backed handoff.", verificationMethod: "Verify the objective through an evidence-backed handoff.", owner: "operator" }, brief: { deliverable: "plan" }, reason: "independent operating boundary", evidence: [1] } } },
      { handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } },
    ],
    "ceo|mail:": [
      { rpc: { method: "goal.complete", params: { goalId: "market", revision: 0, reason: "material handoff satisfies the observation method", evidence: ["$LATEST_SOURCE_SEQ"] } } },
      { rpc: { method: "goal.complete", params: { goalId: "operations", revision: 0, reason: "material handoff satisfies the observation method", evidence: ["$LATEST_SOURCE_SEQ"] } } },
      { rpc: { method: "human.request", params: { type: "completion_recommendation", message: "review consolidated child results", evidence: [1] } } },
      { handoff: { response:{content:"Goal work recorded."},handoff: { outcome:"progress", evidence:[1] } } },
    ],
  };
  const byAgent = {
    research: [{rpc:{method:"mail.send",params:{to:"ceo",goalId:"company",level:"decision",body:{type:"completion_proposal",childGoalId:"market"}}}},{handoff: { response:{content:"Market research is ready for CEO review."},handoff: { outcome:"completion_proposed", evidence:[1] } }}],
    operator: [{rpc:{method:"mail.send",params:{to:"ceo",goalId:"company",level:"decision",body:{type:"completion_proposal",childGoalId:"operations"}}}},{handoff: { response:{content:"Operations work is ready for CEO review."},handoff: { outcome:"completion_proposed", evidence:[1] } }}],
  };
  const runner = new ProcessRunner({ command: process.execPath, args: [fauxRunnerWorkerPath()], env: { GOAH_FAUX_STEPS_BY_AGENT: JSON.stringify(byAgent), GOAH_FAUX_STEPS_BY_TRIGGER: JSON.stringify(byTrigger) }, killGraceMs: 25 });
  const supervisor = new Supervisor(ledger, runner, clock);
  supervisor.startGoal("launch a durable company", "company");
  supervisor.confirmObservationMethod("company", "Complete both child goals from material evidence and obtain human confirmation.");
  const completed = await supervisor.runAvailable(3, 10);
  assert.deepEqual([...new Set(completed.map((wake) => wake.agent))].sort(), ["ceo", "operator", "research"]);
  assert.equal(ledger.goals().filter((goal) => goal.parentId === "company").length, 2);
  assert.deepEqual(ledger.wakes().filter((wake) => wake.agent !== "ceo").map((wake) => wake.triggerRef).sort(), ["delegation:d-operations", "delegation:d-research"]);
  assert.deepEqual(supervisor.teamList().filter((member) => member.agent !== "ceo").map((member) => member.motion), ["retired", "retired"]);
  assert.equal(ledger.unreadMail("human").some((mail) => (mail.body as { type?: string }).type === "completion_recommendation"), true);
  const rosterBeforeReplay = JSON.stringify(supervisor.teamList());
  ledger.rebuildProjections();
  assert.equal(JSON.stringify(supervisor.teamList()), rosterBeforeReplay);
  const rootEvidence = ledger.eventsSince(0, ["handoff.recorded"]).filter((event) => event.actor === "ceo").at(-1)!;
  assert.equal(supervisor.completeGoal({ goalId: "company", revision: 1, reason: "CEO consolidated both observed child results", evidence: [rootEvidence.seq] }, "human").phase, "complete");
  assert.equal(ledger.goal("company")?.phase, "complete");
  ledger.close();
});

test("process verifier model runs on official Pi core and records findings", async () => {
  const clock = new SimulatedClock();
  const ledger = createMemoryLedger({ clock });
  const supervisor = new Supervisor(ledger, fauxRunner([]), clock);
  createWorkerGoal(ledger);
  const evidence = ledger.appendEvent({ ...event("worker", "fact", {}, "verify-wake"), ts: clock.now().toISOString() });
  const verifyTurn=testTurn(ledger,"worker","verify-wake",{source:"goal",goalId:"root",goalRevision:0});ledger.finishTurn(verifyTurn.id,"failed",{message:"verification target"},clock.now().toISOString(),"supervisor");
  const model = new ProcessVerifierModel({ command: process.execPath, args: [verificationWorkerPath()], env: { GOAH_PI_PROVIDER: "faux", GOAH_PI_MODEL: "faux-verifier", GOAH_VERIFIER_FAUX_FINDINGS: JSON.stringify([{ id: "verify-finding", body: { issue: "found" }, evidence: [evidence.seq], riskWeight: 3 }]) } });
  await new VerificationPlane(ledger, supervisor, model).verifyTurn("verify-wake");
  assert.equal(ledger.mailbox().some((mail)=>mail.from==="verifier"&&mail.to==="worker"),true);
  ledger.close();
});

test("process verifier output is bounded",async()=>{const model=new ProcessVerifierModel({command:process.execPath,args:["-e","process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(1100000)))"]});await assert.rejects(()=>model.blindAudit([]),/verifier output exceeded 1 MB/);});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("condition timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
function testTurn(ledger:ReturnType<typeof createMemoryLedger>,agent:string,id:string,patch:Partial<TurnSnapshot>={}):TurnSnapshot{const now=new Date().toISOString();let ceo=ledger.threads().find((candidate)=>candidate.agent==="ceo");if(agent!=="ceo"&&!ceo){ceo={id:"thread:ceo",agent:"ceo",parentThreadId:null,createdAt:now,updatedAt:now};ledger.putThread(ceo,"supervisor");}let thread=ledger.threads().find((candidate)=>candidate.agent===agent);if(!thread){thread={id:`thread:${agent}`,agent,parentThreadId:agent==="ceo"?null:ceo!.id,createdAt:now,updatedAt:now};ledger.putThread(thread,"supervisor");}const requested=patch as {source?:TurnSnapshot["source"];goalId?:string|null;goalRevision?:number|null;specialistRole?:"verifier"|"audit"|null};const source=requested.source??(requested.goalId?"goal":"system");const binding=requested.goalId?goalExecutionBinding(agent,requested.goalId):specialistBinding(agent,requested.specialistRole??"verifier");const wakeId=`test-wake:${id}`;ledger.enqueueWake({id:wakeId,...binding,triggerRef:`test:${id}`,status:"queued",attempt:0,enqueuedSeq:0,claimedAt:null,consumedAt:null,turnId:null},"supervisor");const claimed=ledger.claimNextWake(now);if(claimed?.id!==wakeId)throw new Error("test failed to claim Turn Wake");const turnBinding=requested.goalId?{bindingKind:"goal" as const,goalId:requested.goalId,goalRevision:requested.goalRevision??ledger.goal(requested.goalId)!.revision,specialistRole:null}:{bindingKind:"specialist" as const,goalId:null,goalRevision:null,specialistRole:requested.specialistRole??"verifier"};const turn={id,threadId:thread.id,source,status:"in_progress" as const,attempt:1,error:null,startedAt:now,endedAt:null,leaseUntil:new Date(Date.now()+60_000).toISOString(),leaseToken:"test-lease",runnerPid:null,...patch,...turnBinding} as TurnSnapshot;ledger.startTurnFromWake(wakeId,turn,now);return turn;}
function fauxRunner(steps: unknown[], contextFile?: string, cwd?: string): ProcessRunner {
  return new ProcessRunner({ command: process.execPath, args: [fauxRunnerWorkerPath()], ...(cwd ? { cwd } : {}), env: { GOAH_FAUX_STEPS: JSON.stringify(steps), ...(contextFile ? { GOAH_FAUX_CONTEXT_FILE: contextFile } : {}) }, killGraceMs: 25 });
}
function git(cwd: string, args: string[]): string { const result = spawnSync("git", args, { cwd, encoding: "utf8" }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
