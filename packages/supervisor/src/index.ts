import { randomUUID } from "node:crypto";
import {
  assertAgentHandoff,
  assertHandoff,
  assertTurnOutput,
  goalStream,
  goalRoute,
  goalExecutionBinding,
  goalTurnBinding,
  humanInboxRoute,
  humanRequestRoute,
  humanBinding,
  humanTurnBinding,
  specialistBinding,
  specialistTurnBinding,
  type AgentCapability,
  type AgentHandoff,
  type AgentProfile,
  type AgentRole,
  type Clock,
  type CommittedTurnOutput,
  type DelegationRequest,
  type DelegationResult,
  type ExecutionBinding,
  type GoalSnapshot,
  type HandoffValidationRequest,
  type HandoffValidationResult,
  type GoalCompletionRequest,
  type GoalHandoff,
  type GoalPhase,
  type JsonValue,
  type Ledger,
  type MailSnapshot,
  memoryStream,
  type ReassignmentRequest,
  type ReassignmentResult,
  type Runner,
  type RunnerHandle,
  type RunnerProfile,
  type RunnerRpcMethod,
  type ScheduleSnapshot,
  type TeamMemberView,
  type TurnContext,
  type TurnSnapshot,
  type TurnItemSnapshot,
  type TurnOutput,
  type WakeSnapshot,
  type WakeTriggerSnapshot,
  wakeStream,
} from "goah-ledger-contract";
import { composeActiveContext, selectRecoveryEvents, selectWorkingMemory } from "./context-view.js";
import { defaultTurnPrompt } from "./roles.js";

export { composeActiveContext, selectRecoveryEvents, type ActiveContextInput, type ActiveContextView } from "./context-view.js";

/** Dispatches each wake to the runner selected by its opaque Runner Profile. */
export class RunnerRouter implements Runner {
  readonly isolation = "process" as const;
  readonly #byPid = new Map<number, Runner>();
  constructor(readonly runners: ReadonlyMap<string, Runner>, readonly fallback = "default") {}
  prepare(request: Parameters<Runner["prepare"]>[0]): RunnerHandle {
    const context = request.context && typeof request.context === "object" && !Array.isArray(request.context) ? request.context as Record<string, unknown> : {};
    const profile = context.runnerProfile && typeof context.runnerProfile === "object" && !Array.isArray(context.runnerProfile) ? context.runnerProfile as Record<string, unknown> : {};
    const id = typeof profile.id === "string" ? profile.id : this.fallback;
    const runner = this.runners.get(id);
    if (!runner) throw new Error(`runner profile is not configured: ${id}`);
    const handle = runner.prepare(request);
    if (handle.pid) this.#byPid.set(handle.pid, runner);
    void handle.result.then(()=>{if(handle.pid)this.#byPid.delete(handle.pid);},()=>{if(handle.pid)this.#byPid.delete(handle.pid);});
    return handle;
  }
  async terminateProcess(pid: number, runnerProfileId?: string): Promise<void> {
    const runner = this.#byPid.get(pid)??this.runners.get(runnerProfileId??this.fallback);
    if (!runner) return;
    await runner.terminateProcess(pid);
  }
}

export interface SupervisorOptions {
  leaseMs?: number;
  memoryTailChars?: number;
  retryPolicy?: { maxAttempts: number; baseDelayMs: number };
  turnRetryPolicy?: { maxAttempts: number; baseDelayMs: number };
  profiles?: AgentProfile[];
  runnerProfiles?: RunnerProfile[];
}

export class Supervisor {
  readonly #leaseMs: number;
  readonly #memoryTailChars: number;
  #claimTail: Promise<void> = Promise.resolve();
  #humanTail:Promise<void>=Promise.resolve();
  readonly #retryPolicy: NonNullable<SupervisorOptions["retryPolicy"]>;
  readonly #turnRetryPolicy: NonNullable<SupervisorOptions["turnRetryPolicy"]>;
  readonly #profiles: Map<string, AgentProfile>;
  readonly #runnerProfiles: Map<string, RunnerProfile>;
  readonly #handles = new Map<string, RunnerHandle>();
  readonly #executions=new Map<string,Promise<void>>();
  readonly #agentExecutions=new Map<string,Promise<void>>();
  readonly #handoffValidations=new Map<string,{turnId:string;attemptId:number;agent:string;attempt:number;leaseToken:string;goalId:string;goalRevision:number;message:string;handoff:AgentHandoff}>();
  readonly #handoffAttemptSeq=new Map<string,number>();

  #runner: Runner;
  constructor(readonly ledger: Ledger, runner: Runner, readonly clock: Clock, options: SupervisorOptions = {}) {
    this.#runner = runner;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#memoryTailChars = options.memoryTailChars ?? 12_000;
    this.#retryPolicy = options.retryPolicy ?? { maxAttempts: 0, baseDelayMs: 1_000 };
    this.#turnRetryPolicy = options.turnRetryPolicy ?? { maxAttempts: 3, baseDelayMs: 1_000 };
    for(const profile of options.profiles??[]){if(profile.agent==="ceo"&&profile.role!=="ceo"||profile.agent!=="ceo"&&profile.role==="ceo")throw new Error("exactly the ceo Agent must use the ceo role");}
    this.#profiles = new Map([["ceo", { agent: "ceo", role: "ceo" } satisfies AgentProfile], ...(options.profiles ?? []).map((profile) => [profile.agent, profile] as const)]);
    this.#runnerProfiles = new Map((options.runnerProfiles ?? []).map((profile) => [profile.id, profile] as const));
  }

  /**
   * Hot-swap the runner after a config reload. Refused while a Turn is active:
   * a live child must never observe its runner vanish mid-flight.
   * The next Turn uses the new runner, and spawn-time env
   * resolution applies the new credentials to the next spawn.
   */
  swapRunner(runner: Runner, profiles?: RunnerProfile[]): void {
    const active = this.ledger.turns().filter((turn) => turn.status === "in_progress");
    if (active.length > 0) throw new Error("cannot swap runner while a Turn is in progress");
    this.#runner = runner;
    if (profiles) { this.#runnerProfiles.clear(); for (const profile of profiles) this.#runnerProfiles.set(profile.id, profile); }
  }
  get runner(): Runner { return this.#runner; }
  createGoal(goal: GoalSnapshot, actor = "human"): void { if(!this.#validGoalOwner(goal.owner,goal))throw new Error("Goal owner role does not match Root/Child position");if(goal.parentId===null&&this.ledger.goals().some((candidate)=>candidate.id!==goal.id&&candidate.parentId===null&&candidate.phase!=="complete"))throw new Error("CEO already has an unfinished Root Goal");this.ledger.putGoal(goal, actor); }
  createRootGoal(objective: string, id: string = randomUUID(),sourceTurnId?:string): GoalSnapshot {
    if (!objective.trim()) throw new Error("root objective is required");
    if (this.ledger.goals().some((goal) => goal.parentId === null && goal.owner === "ceo" && goal.phase !== "complete")) throw new Error("CEO already has an unfinished Root Goal; use work_on_goal");
    const goal: GoalSnapshot = { id, parentId: null, objective, observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 0 };
    this.ledger.putGoal(goal,"human",undefined,{operation:"create",reason:"Human established a durable Root Goal",evidence:[],authority:{kind:"human"},...(sourceTurnId?{sourceTurnId}:{})});
    return this.#goal(id);
  }
  startGoal(objective: string, id: string = randomUUID()): { goal: GoalSnapshot; wake: WakeSnapshot } {
    const goal = this.createRootGoal(objective, id);
    const wake = this.#enqueueTrigger("ceo", `root:${id}:created`,{goalId:goal.id});
    if (!wake) throw new Error("CEO wake was not admitted for an active root goal");
    return { goal, wake };
  }

  threadFor(agent = "ceo"): import("goah-ledger-contract").ThreadSnapshot {
    const parentThreadId = agent === "ceo" ? null : this.threadFor("ceo").id;
    const existing = this.ledger.threads().find((thread) => thread.agent === agent && thread.parentThreadId === parentThreadId);
    if (existing) return existing;
    const now = this.#now(); const thread = { id: randomUUID(), agent, parentThreadId, createdAt: now, updatedAt: now };
    this.ledger.putThread(thread, "supervisor"); return thread;
  }

  async startHumanTurn(message: string): Promise<{ threadId: string; turnId: string; steered: boolean }> {
    const previous=this.#humanTail;let release!:()=>void;this.#humanTail=new Promise<void>((resolve)=>{release=resolve;});await previous;try{return await this.#startHumanTurn(message);}finally{release();}
  }
  async #startHumanTurn(message:string):Promise<{threadId:string;turnId:string;steered:boolean}>{
    if (!message.trim()) throw new Error("message is required");
    const thread = this.threadFor("ceo"); const active = this.ledger.activeTurn(thread.id);
    if (active) {
      if (active.source !== "human") { const goalId = active.goalId; await this.interruptTurn(active.id); if (goalId){const goal=this.ledger.goal(goalId);if(goal?.phase==="active")this.#enqueueTrigger(goal.owner,`human-interrupted:${active.id}`,{goalId:goal.id});} }
      else { const handle=this.#handles.get(active.id);if(handle&&!handle.steer)await this.interruptTurn(active.id);else if(handle?.steer){const item=this.#appendTurnItem(active.id,"user_message",{text:message},"human",randomUUID(),"in_progress");try{await handle.steer(message);const stored=this.ledger.turnItems(active.id).find((candidate)=>candidate.id===item.id);if(this.ledger.turn(active.id)?.status==="in_progress"&&stored?.status==="in_progress"){this.ledger.putTurnItem({...stored,status:"completed",completedAt:this.#now()},"human");return{threadId:thread.id,turnId:active.id,steered:true};}}catch{const stored=this.ledger.turnItems(active.id).find((candidate)=>candidate.id===item.id);if(this.ledger.turn(active.id)?.status==="in_progress"&&stored?.status==="in_progress")this.ledger.putTurnItem({...stored,status:"failed",completedAt:this.#now()},"human");if(this.ledger.turn(active.id)?.status==="in_progress")await this.interruptTurn(active.id);}}else{this.#appendTurnItem(active.id,"user_message",{text:message},"human");return{threadId:thread.id,turnId:active.id,steered:true};} }
    }
    await this.#awaitAgentExecution("ceo");
    if(this.ledger.activeTurn(thread.id))return this.#startHumanTurn(message);
    const now = this.#now(); this.ledger.putThread({ ...thread,updatedAt:now },"supervisor"); const leaseToken = randomUUID();
    const turn: TurnSnapshot = { id: randomUUID(), threadId: thread.id, source: "human", ...humanTurnBinding(), status: "in_progress", attempt: 1, error: null, startedAt: now, endedAt: null, leaseUntil: new Date(this.clock.now().getTime() + this.#leaseMs).toISOString(), leaseToken, runnerPid: null,runnerProfileId:this.#runnerProfileId("ceo") };
    this.ledger.putTurn(turn, "human"); this.#appendTurnItem(turn.id, "user_message", { text: message }, "human");
    const context: TurnContext = { source: { kind: "human" } };const deliveredMail=this.#contextMail(humanBinding());
    void this.#trackExecution(turn,"ceo",context,()=>this.#humanContext(turn.id,"ceo",deliveredMail),null,deliveredMail.map((mail)=>mail.id)); return { threadId: thread.id, turnId: turn.id, steered: false };
  }

  async interruptTurn(turnId: string): Promise<TurnSnapshot> {
    const turn = this.ledger.turn(turnId); if (!turn || turn.status !== "in_progress") throw new Error("active Turn not found");
    this.#clearHandoffState(turn.id);this.ledger.finishTurn(turn.id,"interrupted",{message:"interrupted by Human"},this.#now(),"human");const handle=this.#handles.get(turn.id);try{await handle?.terminate();}catch(error){this.#recordCleanupFailure(turn.id,error);}finally{this.#handles.delete(turn.id);}await this.#executions.get(turn.id);
    return this.ledger.turn(turn.id)!;
  }

  async #executeTurn(initial: TurnSnapshot, agent: string, turnContext: TurnContext, contextFactory: () => JsonValue, sourceWake: WakeSnapshot | null = null, deliveredMailIds: string[] = [], recordRevisionAtStart = -1, sourceWakeTriggers: WakeTriggerSnapshot[] = []): Promise<void> {
    while (this.ledger.turn(initial.id)?.status === "in_progress") {
      const execution = this.ledger.turn(initial.id)!; const leaseToken = execution.leaseToken!; let handle: RunnerHandle | null = null; let renewal: NodeJS.Timeout | null = null;
      try {
        handle = this.runner.prepare({ agent,execution, ...(sourceWake ? { sourceWake, sourceWakeTriggers } : {}),turn:turnContext,context:contextFactory(),now:()=>this.#now(),emit:(trace)=>this.#recordTurnTrace(initial.id,leaseToken,trace.type,trace.data,agent),rpc:(method,params)=>this.#agentRpcForTurn(initial.id,agent,turnContext,method,params,sourceWake?.id) });
        this.#handles.set(initial.id,handle); if(handle.pid) this.ledger.attachTurnProcess(initial.id,leaseToken,handle.pid); renewal=setInterval(()=>{try{this.ledger.renewTurnLease(initial.id,leaseToken,new Date(this.clock.now().getTime()+this.#leaseMs).toISOString(),this.#now());}catch{void this.#terminateHandle(initial.id,handle!);}},Math.max(25,Math.floor(this.#leaseMs/3))); renewal.unref(); handle.begin(); const result=await handle.result; if(renewal)clearInterval(renewal); renewal=null;await this.#terminateHandle(initial.id,handle);this.#handles.delete(initial.id);
        const current=this.ledger.turn(initial.id); if(!current||current.status!=="in_progress")return;if(current.attempt>1)this.ledger.appendEvent({streamId:`turn:${current.id}`,ts:this.#now(),actor:"supervisor",type:"turn.retry_finished",data:{attempt:current.attempt,outcome:result.outcome},ignorable:true});if(result.outcome!=="abnormal")this.#closeStreamingItems(current.id);
        if(result.outcome==="abnormal"){
          if(current.attempt<this.#turnRetryPolicy.maxAttempts){this.ledger.repairTurnAttempt(current.id,result.reason,this.#now(),"supervisor");this.ledger.appendEvent({streamId:`turn:${current.id}`,ts:this.#now(),actor:"supervisor",type:"turn.retry_started",data:{attempt:current.attempt+1,reason:result.reason},ignorable:true});this.ledger.putTurn({...current,attempt:current.attempt+1,leaseUntil:new Date(this.clock.now().getTime()+this.#leaseMs).toISOString(),runnerPid:null},"supervisor");await new Promise((resolve)=>setTimeout(resolve,this.#turnRetryPolicy.baseDelayMs*2**(current.attempt-1)));continue;}
          this.#failTurn(current.id,result.reason);this.#scheduleTurnRecovery(sourceWake,sourceWakeTriggers,current.id,agent); return;
        }
        if(turnContext.goalBinding){if(result.outcome!=="handoff")throw new Error("Goal-bound Turn requires Handoff");this.#commitGoalTurn(current.id,agent,turnContext,result.output,sourceWake?.id??null,deliveredMailIds,recordRevisionAtStart);return;}
        if(result.outcome!=="response")throw new Error("ordinary Turn cannot finish with Handoff");if(!this.ledger.turnItems(current.id).some((item)=>item.type==="assistant_message"&&(item.data as {text?:unknown}).text===result.response.content))this.#appendTurnItem(current.id,"assistant_message",{text:result.response.content},agent);this.ledger.finishTurn(current.id,"completed",null,this.#now(),"supervisor",deliveredMailIds);return;
      } catch(error){if(renewal)clearInterval(renewal);if(handle)await this.#terminateHandle(initial.id,handle);this.#handles.delete(initial.id);const current=this.ledger.turn(initial.id);if(current?.status==="in_progress"){this.#failTurn(current.id,error instanceof Error?error.message:String(error));this.#scheduleTurnRecovery(sourceWake,sourceWakeTriggers,current.id,agent);}return;}
    }
  }
  #trackExecution(initial:TurnSnapshot,agent:string,turnContext:TurnContext,contextFactory:()=>JsonValue,sourceWake:WakeSnapshot|null=null,deliveredMailIds:string[]=[],recordRevisionAtStart=-1,sourceWakeTriggers:WakeTriggerSnapshot[]=[]):Promise<void>{const running=this.#executeTurn(initial,agent,turnContext,contextFactory,sourceWake,deliveredMailIds,recordRevisionAtStart,sourceWakeTriggers);this.#executions.set(initial.id,running);this.#agentExecutions.set(agent,running);void running.finally(()=>{if(this.#executions.get(initial.id)===running)this.#executions.delete(initial.id);if(this.#agentExecutions.get(agent)===running)this.#agentExecutions.delete(agent);});return running;}
  async #awaitAgentExecution(agent:string):Promise<void>{const running=this.#agentExecutions.get(agent);if(running)await running;}

  #humanContext(turnId: string, agent: string,mail:MailSnapshot[]): JsonValue {
    const turn=this.ledger.turn(turnId)!;
    const current=this.#turnHistory(turn.id);
    const turnSourceSeqs=this.ledger.readStream(`turn:${turn.id}`).filter((event)=>event.type==="item.user_message.started").map((event)=>event.seq);
    if(turn.bindingKind==="goal"){
      const context:TurnContext={source:{kind:"human"},goalBinding:{goalId:turn.goalId,goalRevision:turn.goalRevision}};
      const base=this.#loadContext({...goalExecutionBinding(agent,turn.goalId),attempt:turn.attempt},context,mail,[]) as Record<string,JsonValue>;
      const sourceSeqs=Array.isArray(base.sourceSeqs)?base.sourceSeqs.filter((value):value is number=>typeof value==="number"):[];
      return{...base,text:`${String(base.text??"")}\n\n# Current Turn\n\n${current}`,sourceSeqs:[...new Set([...sourceSeqs,...turnSourceSeqs])].sort((a,b)=>a-b)} as unknown as JsonValue;
    }
    const profile=this.#profiles.get(agent)??{agent,role:"ceo" as const};
    const runnerProfile=this.#runnerProfiles.get(profile.runnerProfile??"default");
    const recent=this.ledger.turns(turn.threadId).filter((candidate)=>candidate.id!==turn.id&&candidate.status==="completed").slice(-8).flatMap((candidate)=>this.ledger.turnItems(candidate.id).filter((item)=>item.type==="user_message"||item.type==="assistant_message").map((item)=>`${item.type==="user_message"?"Human":"Assistant"}: ${String((item.data as {text?:unknown}).text??"")}`));
    const sourceSeqs=[...turnSourceSeqs,...this.#mailSourceSeqs(mail)];
    const incoming=mail.map((item)=>`- [${item.level}] ${item.id} from ${item.from}: ${boundedJson(item.body)}`);
    const context:TurnContext={source:{kind:"human"}};
    return {text:[...(recent.length?[`# Recent conversation\n\n${recent.join("\n")}`]:[]),...(incoming.length?[`# Incoming\n\n${incoming.join("\n")}`]:[]),`# Current Turn\n\n${current}`].join("\n\n"),sourceSeqs,capabilities:profile.capabilities??defaultCapabilities(profile.role),systemPrompt:profile.systemPrompt??defaultTurnPrompt(profile.role,agent,context),...(runnerProfile?{runnerProfile}:{})} as unknown as JsonValue;
  }

  #goalContext(wake:WakeSnapshot,turn:TurnContext,turnId:string,mail:MailSnapshot[],wakeTriggers:WakeTriggerSnapshot[]):JsonValue{const base=this.#loadContext(wake,turn,mail,wakeTriggers);if(!base||typeof base!=="object"||Array.isArray(base))return base;const value=base as Record<string,JsonValue>;const history=this.#turnHistory(turnId);return {...value,...(history?{text:`${String(value.text??"")}\n\n# Current Turn retry history\n\n${history}`}:{})};}

  #threadAgent(threadId:string):string{const thread=this.ledger.thread(threadId);if(!thread)throw new Error("Turn Thread not found");return thread.agent;}

  #turnHistory(turnId: string): string { const items=this.ledger.turnItems(turnId).map((item)=>{const data=item.data as {text?:unknown;tool?:unknown;result?:unknown};if(item.type==="user_message")return `Human: ${String(data.text??"")}`;if(item.type==="assistant_message")return `Assistant: ${String(data.text??"")}`;if(item.type==="tool_call")return `Tool call: ${String(data.tool??"")} ${JSON.stringify(item.data)}`;if(item.type==="tool_result")return `Tool result: ${JSON.stringify(data.result??item.data)}`;return `${item.type}: ${JSON.stringify(item.data)}`;});const facts=this.ledger.readStream(`turn:${turnId}`).filter((event)=>event.type==="turn.retry_started").map((event)=>`${event.type}: ${JSON.stringify(event.data)}`);return [...items,...facts].join("\n"); }

  #failTurn(turnId: string, reason: string): void { const current=this.ledger.turn(turnId);if(!current||current.status!=="in_progress")return;this.#clearHandoffState(turnId);this.ledger.finishTurn(turnId,"failed",{message:reason},this.#now(),"supervisor"); }
  #preemptGoalTurn(goalId:string,reason:string):void{const turn=this.ledger.turns().find((candidate)=>candidate.status==="in_progress"&&candidate.bindingKind==="goal"&&candidate.goalId===goalId);if(!turn)return;this.#clearHandoffState(turn.id);this.ledger.finishTurn(turn.id,"interrupted",{message:reason},this.#now(),"supervisor");const handle=this.#handles.get(turn.id);if(handle)void this.#terminateHandle(turn.id,handle).finally(()=>this.#handles.delete(turn.id));}
  async #terminateHandle(turnId:string,handle:RunnerHandle):Promise<void>{try{await handle.terminate();}catch(error){this.#recordCleanupFailure(turnId,error);}}
  #recordCleanupFailure(turnId:string,error:unknown):void{this.ledger.appendEvent({streamId:`turn:${turnId}`,ts:this.#now(),actor:"supervisor",type:"runner.cleanup_failed",data:{message:error instanceof Error?error.message:String(error)},ignorable:true});}

  #scheduleTurnRecovery(sourceWake:WakeSnapshot|null,triggers:WakeTriggerSnapshot[],turnId:string,agent:string):void{if(!sourceWake)return;const turn=this.ledger.turn(turnId);if(!turn)return;const role=this.#role(agent);const goal=turn.bindingKind==="goal"?this.ledger.goal(turn.goalId):null;if(turn.bindingKind==="human"||turn.bindingKind==="goal"&&(!goal||goal.phase!=="active"||goal.owner!==agent)||turn.bindingKind==="specialist"&&role!==turn.specialistRole)return;const prior=Math.max(0,...triggers.map((trigger)=>parseRecoveryTrigger(trigger.triggerRef)?.attempt??0));const next=prior+1;if(next<this.#retryPolicy.maxAttempts){const delay=this.#retryPolicy.baseDelayMs*2**prior;const binding=turn.bindingKind==="goal"?goalExecutionBinding(agent,turn.goalId):specialistBinding(agent,turn.specialistRole);this.ledger.putSchedule({id:recoveryScheduleId(turnId,next),...binding,nextWakeAt:new Date(this.clock.now().getTime()+delay).toISOString(),reason:recoveryRef(turnId),setBy:"supervisor",status:"pending",resolvedAt:null},"supervisor",sourceWake.id);}else if(role==="child"&&goal?.parentId){const parent=this.ledger.goal(goal.parentId);if(parent?.phase==="active")this.#enqueueTrigger(parent.owner,childRetryExhaustedRef(turnId),{goalId:parent.id});}}

  #closeStreamingItems(turnId:string):void{const open=this.ledger.turnItems(turnId).filter((item)=>item.status==="in_progress");if(open.some((item)=>item.type==="tool_call"||item.type==="user_message"))throw new Error("Runner returned while an input or tool call was still open");for(const item of open)this.ledger.putTurnItem({...item,status:"completed",completedAt:this.#now()},"supervisor");}

  #appendTurnItem(turnId: string, type: TurnItemSnapshot["type"], data: JsonValue, actor: string, id: string = randomUUID(), status: TurnItemSnapshot["status"] = "completed"): TurnItemSnapshot {
    const now = this.#now(); const item: TurnItemSnapshot = { id, turnId, ordinal: this.ledger.turnItems(turnId).length + 1, type, status, data, createdAt: now, completedAt: status === "in_progress" ? null : now }; this.ledger.putTurnItem(item, actor); return item;
  }

  #recordTurnTrace(turnId: string, leaseToken: string, type: string, data: JsonValue, actor = "ceo"): void {
    if(type==="transcript.completed"||type==="transcript.interrupted")return;
    if(type==="transcript.started"&&this.ledger.readStream(`turn:${turnId}`).some((event)=>event.type==="transcript.started"))return;
    this.ledger.appendTurnEvent({ streamId: `turn:${turnId}`, ts: this.#now(), actor, type, data },leaseToken);
    if (type === "message.assistant.completed") {const value=data&&typeof data==="object"&&!Array.isArray(data)?data as {message?:{content?:unknown};completionIntent?:unknown;commitState?:unknown}:{};if(!["ordinary","handoff"].includes(String(value.completionIntent))||value.commitState!==(value.completionIntent==="handoff"?"provisional":"committed"))throw new Error("Runner assistant completion is missing normalized intent/state");const text=messageTextContent(value.message?.content);if(text)this.#appendTurnItem(turnId,"assistant_message",{text},actor);}
    else if(type==="plan.updated")this.#appendTurnItem(turnId,"plan",data,actor);
    else if(type==="message.assistant.delta"){const input=data as {messageId?:unknown;delta?:{type?:unknown;delta?:unknown;content?:unknown}};const delta=input.delta;if(delta?.type==="thinking_start"||delta?.type==="thinking_delta"||delta?.type==="thinking_end"){const turn=this.ledger.turn(turnId)!;const id=`${turnId}:attempt:${turn.attempt}:reasoning:${String(input.messageId??"message")}`;const existing=this.ledger.turnItems(turnId).find((item)=>item.id===id);const text=`${String((existing?.data as {text?:unknown}|undefined)?.text??"")}${delta.type==="thinking_delta"?String(delta.delta??""):""}`;if(!existing)this.#appendTurnItem(turnId,"reasoning",{text},actor,id,delta.type==="thinking_end"?"completed":"in_progress");else this.ledger.putTurnItem({...existing,data:{text},status:delta.type==="thinking_end"?"completed":"in_progress",completedAt:delta.type==="thinking_end"?this.#now():null},actor);}}
    else if (type === "tool.called") { const input = data as { callId?: unknown; name?: unknown; arguments?: JsonValue };const turn=this.ledger.turn(turnId)!;const id=`${turnId}:attempt:${turn.attempt}:tool:${String(input.callId)}`;if(this.ledger.turnItems(turnId).some((item)=>item.id===id))throw new Error("duplicate tool call id in Turn attempt");this.#appendTurnItem(turnId, "tool_call", { callId:String(input.callId),tool: String(input.name), arguments: input.arguments ?? null }, actor,id,"in_progress"); }
    else if (type === "tool.completed") { const input = data as { callId?: unknown; result?: JsonValue; isError?: unknown };const turn=this.ledger.turn(turnId)!;const id=`${turnId}:attempt:${turn.attempt}:tool:${String(input.callId)}`; const existing = this.ledger.turnItems(turnId).find((item) => item.id === id);if(!existing)throw new Error("tool result has no matching call in Turn attempt");this.ledger.putTurnItem({ ...existing, status: input.isError ? "failed" : "completed", completedAt: this.#now() }, actor); this.#appendTurnItem(turnId, "tool_result", { callId: String(input.callId), result: input.result ?? null }, actor); }
  }
  sendToCeo(body: JsonValue, level: "fyi" | "decision" | "emergency" = "decision"): { mail: MailSnapshot; wake: WakeSnapshot } {
    const mail:MailSnapshot = { id: randomUUID(), to: "ceo", from: "human", level, ...humanInboxRoute(), body, readAt: null };
    this.ledger.putMail(mail, "human");
    const wake = this.#enqueueTrigger("ceo", `mail:${mail.id}`);
    if (!wake) throw new Error("CEO wake was not admitted");
    return { mail, wake };
  }
  delegate(request: DelegationRequest, actor = "ceo", wakeId?: string): DelegationResult {const candidate:GoalSnapshot={...request.childGoal,parentId:request.parentGoalId,phase:"active",revision:0};if(!this.#validGoalOwner(candidate.owner,candidate))throw new Error("Child Goal owner must use a Child Agent profile");return this.ledger.commitDelegation(request, actor, wakeId); }
  async reassignGoal(request: ReassignmentRequest, actor = "ceo", wakeId?: string): Promise<ReassignmentResult> {const goal=this.#goal(request.goalId);if(!this.#validGoalOwner(request.newOwner,{...goal,owner:request.newOwner}))throw new Error("Child Goal owner must use a Child Agent profile");const thread=this.ledger.threads().find((candidate)=>candidate.agent===goal.owner);const active=thread?this.ledger.activeTurn(thread.id):null;if(active?.bindingKind==="goal"&&active.goalId===goal.id)await this.interruptTurn(active.id);return this.ledger.commitReassignment(request, actor, wakeId); }
  teamList(now = this.#now()): TeamMemberView[] { return deriveTeam(this.ledger, now); }
  agentRole(agent:string):AgentRole{return this.#role(agent);}
  updateGoal(id: string, patch: Partial<Pick<GoalSnapshot, "objective" | "observationMethod" | "verificationMethod">>, actor = "human",change?:{reason:string;evidence:number[];sourceTurnId?:string;sourceWakeId?:string}): GoalSnapshot {
    if (patch.objective === undefined && patch.observationMethod === undefined && patch.verificationMethod === undefined) throw new Error("goal update requires objective, observation method, or verification method");
    const current = this.#goal(id);
    this.#assertGoalMutationAuthority(current,actor);
    if (patch.objective !== undefined && patch.objective !== current.objective && current.parentId !== null && (patch.observationMethod === undefined || patch.verificationMethod === undefined)) throw new Error("child objective revision requires replacement observation and verification methods");
    const next = {
      ...current,
      ...patch,
      ...(patch.objective !== undefined && patch.objective !== current.objective && current.parentId === null && patch.observationMethod === undefined ? { observationMethod: null } : {}),
      ...(patch.objective !== undefined && patch.objective !== current.objective && current.parentId === null && patch.verificationMethod === undefined ? { verificationMethod: null } : {}),
      revision: current.revision + 1,
    };
    this.#preemptGoalTurn(current.id,"Goal definition changed");this.ledger.putGoal(next,actor,change?.sourceWakeId,{operation:"revise",reason:change?.reason??"Goal definition revised",evidence:change?.evidence??[],...(change?.sourceTurnId?{sourceTurnId:change.sourceTurnId}:{}),...(change?.sourceWakeId?{sourceWakeId:change.sourceWakeId}:{})});
    if (next.parentId === null && next.owner === "ceo" && actor === "human") this.#enqueueTrigger("ceo", `root:${id}:revised:${next.revision}`,{goalId:next.id});
    return next;
  }
  confirmObservationMethod(id: string, observationMethod: string): GoalSnapshot {
    const current = this.#goal(id);
    if (current.parentId !== null) throw new Error("human confirmation applies only to a root goal");
    return this.updateGoal(id, { observationMethod, verificationMethod: observationMethod }, "human",{reason:"Human confirmed the Root observation and verification method",evidence:[]});
  }
  reviseChildGoal(id: string, objective: string, observationMethod: string, verificationMethod: string, actor: string, reason: string, evidence: number[], wakeId?: string,sourceTurnId?:string): GoalSnapshot {
    const current = this.#goal(id);
    if (current.parentId === null) throw new Error("CEO cannot revise a root goal");
    if (!reason.trim()) throw new Error("goal revision reason is required");
    for (const seq of evidence) if (!this.ledger.eventsSince(seq - 1).some((event) => event.seq === seq)) throw new Error(`evidence event does not exist: ${seq}`);
    this.ledger.appendEvent({ streamId: wakeId ? wakeStream(wakeId) : goalStream(id), ts: this.#now(), actor, type: "goal.revision_requested", data: { goalId: id, fromRevision: current.revision, objective, observationMethod, verificationMethod, reason, evidence } });
    return this.updateGoal(id, { objective, observationMethod, verificationMethod }, actor,{reason,evidence,...(wakeId?{sourceWakeId:wakeId}:{}),...(sourceTurnId?{sourceTurnId}:{})});
  }
  completeGoal(request: GoalCompletionRequest, actor = "human", wakeId?: string): GoalSnapshot {
    const goal = this.ledger.completeGoal(request, actor, wakeId);
    this.#preemptGoalTurn(goal.id,"Goal completed");
    return goal;
  }
  transitionGoal(id: string, phase: GoalPhase, actor = "human",scheduleMotion=true,sourceTurnId?:string): GoalSnapshot {
    const current = this.#goal(id);
    this.#assertGoalMutationAuthority(current,actor);
    if (current.phase === phase) return current;
    if (phase === "complete") throw new Error("goal completion requires reason and evidence");
    const next = { ...current, phase, revision: current.revision + 1 };
    const operation=phase==="paused"?"pause":phase==="blocked"?"block":"resume";this.#preemptGoalTurn(current.id,`Goal ${operation}`);this.ledger.putGoal(next,actor,undefined,{operation,reason:`Goal ${operation} requested by ${actor}`,evidence:[],...(sourceTurnId?{sourceTurnId}:{})});
    if (phase === "active"&&scheduleMotion) this.#enqueueTrigger(next.owner, `${next.parentId ? "goal" : "root"}:${id}:resumed:${next.revision}`,{goalId:next.id});
    return next;
  }

  planWake(agent: string, at: string, reason: string, setBy = agent,target?:{goalId:string}): WakeSnapshot | null {
    const parsed=Date.parse(at);if(!Number.isFinite(parsed))throw new Error("schedule time is invalid");const nextWakeAt=new Date(parsed).toISOString();const binding=target??this.#singleActiveGoalTarget(agent);const role=this.#role(agent);if(!binding&&role!=="verifier"&&role!=="audit")throw new Error("Goal-owning Agent schedules require an active Goal target");if(binding){const goal=this.ledger.goal(binding.goalId);if(!goal||goal.phase!=="active"||!this.#validGoalOwner(agent,goal))throw new Error("schedule target is not an active Goal owned by this Agent");}
    const executionTarget=binding?goalExecutionBinding(agent,binding.goalId):specialistBinding(agent,role as "verifier"|"audit");const schedule: ScheduleSnapshot = { id: `schedule:${agent}${binding?`:${binding.goalId}`:""}:${randomUUID()}`, ...executionTarget, nextWakeAt, reason, setBy,status:"pending",resolvedAt:null };
    this.ledger.putSchedule(schedule, setBy);
    return nextWakeAt <= this.#now() ? this.#enqueueSchedule(schedule) : null;
  }

  async stopAgentWake(agent:string,goalId?:string):Promise<WakeSnapshot|null>{const role=this.#role(agent);if(goalId){const goal=this.#goal(goalId);if(!this.#validGoalOwner(agent,goal))throw new Error("Goal stop target is not owned by the Agent");}const binding=role==="verifier"||role==="audit"?null:goalId?{goalId}:this.#singleActiveGoalTarget(agent);if(role!=="verifier"&&role!=="audit"&&!binding)throw new Error("Goal stop requires an explicit Goal target");const wake=this.ledger.wakes().find((item)=>item.agent===agent&&(item.status==="queued"||item.status==="claimed")&&(binding?item.bindingKind==="goal"&&item.goalId===binding.goalId:item.bindingKind==="specialist"));if(wake)this.ledger.cancelWake(wake.id,this.#now());const thread=this.ledger.threads().find((item)=>item.agent===agent);const turn=thread?this.ledger.activeTurn(thread.id):null;if(turn&&(binding?turn.bindingKind==="goal"&&turn.goalId===binding.goalId:turn.bindingKind==="specialist"))await this.interruptTurn(turn.id);return wake?this.#wake(wake.id):null;}

  async recover(): Promise<void> {
    for(const wake of this.ledger.wakes().filter((candidate)=>candidate.status==="claimed"))this.ledger.releaseWake(wake.id,this.#now());
    for (const turn of this.ledger.turns().filter((candidate) => candidate.status === "in_progress"&&!this.#handles.has(candidate.id))) { if (turn.runnerPid) await this.runner.terminateProcess(turn.runnerPid,turn.runnerProfileId); this.#failTurn(turn.id,"orphaned Runner ownership recovered after Supervisor restart"); const thread=this.ledger.thread(turn.threadId);if(!thread)continue;if(turn.bindingKind==="goal"){const goal=this.ledger.goal(turn.goalId);if(goal?.phase==="active"&&goal.owner===thread.agent)this.#enqueueTrigger(thread.agent,recoveryRef(turn.id),{goalId:goal.id});}else if(turn.bindingKind==="specialist"&&this.#role(thread.agent)===turn.specialistRole)this.#enqueueTrigger(thread.agent,recoveryRef(turn.id)); }
  }
  async tick(): Promise<WakeSnapshot | null> {
    const wake = await this.#claimNextWake();
    if (!wake) return null;
    let createdTurnId:string|null=null;
    try {
      await this.#awaitAgentExecution(wake.agent);const currentWake=this.#wake(wake.id);if(currentWake.status!=="claimed")return currentWake;if(currentWake.bindingKind==="goal"){const goal=this.ledger.goal(currentWake.goalId);if(!goal||goal.owner!==currentWake.agent||goal.phase!=="active"||!this.#validGoalOwner(currentWake.agent,goal)){this.ledger.cancelWake(currentWake.id,this.#now());return this.#wake(currentWake.id);}}const wakeTriggers=this.ledger.wakeTriggers(currentWake.id).filter((trigger)=>trigger.status==="pending");const turnContext = this.#turnContext(currentWake,wakeTriggers);if(!this.#validExecution(currentWake.agent,turnContext)){this.ledger.cancelWake(currentWake.id,this.#now());return this.#wake(currentWake.id);}const thread=this.threadFor(currentWake.agent);const now=this.#now();const leaseToken=randomUUID();const turnBinding=currentWake.bindingKind==="goal"?goalTurnBinding(currentWake.goalId,turnContext.goalBinding!.goalRevision):currentWake.bindingKind==="human"?humanTurnBinding():specialistTurnBinding(currentWake.specialistRole);const execution:TurnSnapshot={id:randomUUID(),threadId:thread.id,source:turnContext.source.kind,...turnBinding,status:"in_progress",attempt:1,error:null,startedAt:now,endedAt:null,leaseUntil:new Date(this.clock.now().getTime()+this.#leaseMs).toISOString(),leaseToken,runnerPid:null,runnerProfileId:this.#runnerProfileId(currentWake.agent)};
      this.ledger.putThread({ ...thread,updatedAt:this.#now() },"supervisor");
      this.ledger.startTurnFromWake(currentWake.id,execution,now);createdTurnId=execution.id;const deliveredMail=this.#contextMail(currentWake);const deliveredMailIds=deliveredMail.map((mail)=>mail.id);this.ledger.appendEvent({streamId:`turn:${execution.id}`,ts:now,actor:"supervisor",type:"run.admitted",data:{...turnContext,wakeTriggers} as unknown as JsonValue,ignorable:true});const revision=turnContext.goalBinding?this.ledger.workRecord(turnContext.goalBinding.goalId)?.recordRevision??-1:-1;await this.#trackExecution(execution,currentWake.agent,turnContext,()=>this.#goalContext(currentWake,turnContext,execution.id,deliveredMail,wakeTriggers),currentWake,deliveredMailIds,revision,wakeTriggers);
      return this.#wake(wake.id);
    } catch (error) {
      if(createdTurnId&&this.ledger.turn(createdTurnId)?.status==="in_progress")this.#failTurn(createdTurnId,error instanceof Error?error.message:String(error));const current=this.ledger.wake(wake.id);if(current?.status==="claimed")this.ledger.releaseWake(wake.id,this.#now());return this.#wake(wake.id);
    }
  }

  async #claimNextWake(): Promise<WakeSnapshot | null> {
    const previous = this.#claimTail;
    let release!: () => void;
    this.#claimTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      for (const schedule of this.ledger.dueSchedules(this.#now())) this.#enqueueSchedule(schedule);
      for (const mail of this.ledger.triggeringMail()) {
        const thread=this.ledger.threads().find((candidate)=>candidate.agent===mail.to);if(thread&&this.ledger.activeTurn(thread.id))continue;
        const goal=mail.routeKind==="goal"?this.ledger.goal(mail.goalId):null;const target=goal&&goal.owner===mail.to&&goal.phase==="active"&&this.#validGoalOwner(mail.to,goal)?{goalId:goal.id}:undefined;const humanInteraction=mail.routeKind==="human_inbox"&&mail.to==="ceo"&&mail.from==="human";const specialistInteraction=mail.routeKind==="specialist_inbox"&&this.#role(mail.to)===mail.specialistRole;if(!target&&!humanInteraction&&!specialistInteraction)continue;const base=`mail:${mail.id}`;const related=this.ledger.wakeTriggersForAgent(mail.to).map((trigger)=>({trigger,attempt:mailDeliveryAttempt(trigger.triggerRef,base)})).filter((entry):entry is {trigger:WakeTriggerSnapshot;attempt:number}=>entry.attempt!==null);const pending=related.filter((entry)=>entry.trigger.status==="pending").sort((a,b)=>b.attempt-a.attempt)[0];const next=related.reduce((highest,entry)=>Math.max(highest,entry.attempt),-1)+1;const trigger=pending?.trigger.triggerRef??(next===0?base:`${base}@redelivery:${next}`);this.#enqueueTrigger(mail.to,trigger,target);
      }
      return this.ledger.claimNextWake(this.#now());
    } finally {
      release();
    }
  }

  async runAvailable(concurrency = 4, maxWakes = 100): Promise<WakeSnapshot[]> {
    const completed: WakeSnapshot[] = [];
    while (true) {
      const batch = await Promise.all(Array.from({ length: concurrency }, () => this.tick()));
      const wakes = batch.filter((wake): wake is WakeSnapshot => wake !== null);
      completed.push(...wakes);
      if (wakes.length === 0 || completed.length >= maxWakes) return completed;
    }
  }

  #enqueueSchedule(schedule: ScheduleSnapshot): WakeSnapshot | null {
    if(schedule.status!=="pending")return null;
    if(schedule.bindingKind==="goal"){const goal=this.ledger.goal(schedule.goalId);if(!goal||goal.owner!==schedule.agent||goal.phase!=="active"||!this.#validGoalOwner(schedule.agent,goal)){this.ledger.supersedeSchedule(schedule.id,this.#now());return null;}}
    else if(!["verifier","audit"].includes(this.#role(schedule.agent))){this.ledger.cancelSchedule(schedule.id,this.#now());return null;}
    const wake:WakeSnapshot={id:`wake:${schedule.id}`,...(schedule.bindingKind==="goal"?goalExecutionBinding(schedule.agent,schedule.goalId):specialistBinding(schedule.agent,schedule.specialistRole)),triggerRef:`${schedule.id}@${schedule.nextWakeAt}`,status:"queued",attempt:0,enqueuedSeq:0,claimedAt:null,consumedAt:null,turnId:null};
    return this.ledger.consumeSchedule(schedule.id,wake,this.#now()).wake;
  }

  #enqueueTrigger(agent: string, triggerRef: string,target?:{goalId:string}): WakeSnapshot | null {
    let binding:ExecutionBinding;
    if(target){const goal=this.ledger.goal(target.goalId);if(!goal||goal.owner!==agent||goal.phase!=="active"||!this.#validGoalOwner(agent,goal))return null;binding=goalExecutionBinding(agent,target.goalId);}
    else {const mailId=mailIdFromTriggerRef(triggerRef);const mail=mailId?this.ledger.mailbox().find((candidate)=>candidate.id===mailId):null;const role=this.#role(agent);if(agent==="ceo"&&role==="ceo"&&mail?.routeKind==="human_inbox"&&mail.from==="human")binding=humanBinding();else if(role==="verifier"||role==="audit")binding=specialistBinding(agent,role);else return null;}
    const sameBinding=(wake:WakeSnapshot)=>wake.bindingKind===binding.bindingKind&&wake.goalId===binding.goalId&&wake.specialistRole===binding.specialistRole;
    const exact = this.ledger.wakeByTrigger(agent, triggerRef);
    if (exact) {if(!sameBinding(exact))throw new Error("Wake trigger was reused with a different execution binding");return exact;}
    const pending = this.ledger.wakes().find((wake)=>wake.agent===agent&&wake.status==="claimed"&&sameBinding(wake))??this.ledger.wakes().find((wake)=>wake.agent===agent&&wake.status==="queued"&&sameBinding(wake));
    if (pending) {
      this.ledger.addWakeTrigger(pending.id,triggerRef,"supervisor");
      return pending;
    }
    const wake: WakeSnapshot = { id: randomUUID(), ...binding, triggerRef, status: "queued", attempt: 0, enqueuedSeq: 0, claimedAt:null,consumedAt:null,turnId:null };
    const result = this.ledger.enqueueWake(wake, "supervisor");
    if (result.created) return this.#wake(wake.id);
    const existing = this.ledger.wakeByTrigger(agent, triggerRef);
    if (!existing) throw new Error("deduplicated wake is missing");
    return existing;
  }

  #hasActiveRoot(): boolean { return this.ledger.goals().some((goal) => goal.parentId === null && goal.owner === "ceo" && goal.phase === "active"); }
  #activeRoot():GoalSnapshot|null{return this.ledger.goals().find((goal)=>goal.parentId===null&&goal.owner==="ceo"&&goal.phase==="active")??null;}
  #singleActiveGoalTarget(agent:string):{goalId:string}|undefined{const goals=this.ledger.goalsForOwner(agent).filter((goal)=>goal.phase==="active"&&this.#validGoalOwner(agent,goal));if(goals.length>1)throw new Error("Wake requires an explicit Goal target when an Agent owns multiple active Goals");return goals.length===1?{goalId:goals[0]!.id}:undefined;}
  #knownAgent(agent:string):boolean{return this.#profiles.has(agent)||this.ledger.threads().some((thread)=>thread.agent===agent)||this.ledger.goals().some((goal)=>goal.owner===agent);}
  #role(agent:string):AgentRole{return this.#profiles.get(agent)?.role??(agent==="ceo"?"ceo":"child");}
  #validGoalOwner(agent:string,goal:GoalSnapshot):boolean{const role=this.#role(agent);return goal.owner===agent&&(role==="ceo"?agent==="ceo"&&goal.parentId===null:role==="child"&&goal.parentId!==null);}
  #validExecution(agent:string,turn:TurnContext):boolean{const role=this.#role(agent);if(turn.goalBinding){const goal=this.ledger.goal(turn.goalBinding.goalId);return Boolean(goal&&this.#validGoalOwner(agent,goal));}if(turn.source.kind==="human")return agent==="ceo"&&role==="ceo";return role==="verifier"||role==="audit";}
  #commitGoalTurn(turnId:string,agent:string,turn:TurnContext,raw:TurnOutput,sourceWakeId:string|null,mailIds:string[],revisionAtStart:number):void{const binding=turn.goalBinding!;const goal=this.#goal(binding.goalId);if(goal.revision!==binding.goalRevision)throw new Error("Goal revision changed during the Turn");const record=this.ledger.workRecord(goal.id);if(!record||record.recordRevision<=revisionAtStart||record.updatedInTurn!==turnId||record.goalRevision!==goal.revision)throw new Error("Goal-bound Turn must update its Work Record before handoff");assertTurnOutput(raw);const validation=this.#handoffValidations.get(raw.validationToken);const execution=this.ledger.turn(turnId);if(!validation||!execution||validation.turnId!==turnId||validation.attemptId!==raw.validationAttemptId||this.#handoffAttemptSeq.get(turnId)!==raw.validationAttemptId||validation.agent!==agent||validation.attempt!==execution.attempt||validation.leaseToken!==execution.leaseToken||validation.goalId!==goal.id||validation.goalRevision!==goal.revision||validation.handoff.outcome!==raw.handoff.outcome||!isSameNumbers(validation.handoff.evidence,raw.handoff.evidence))throw new Error("Handoff validation token is stale or does not match this Turn");const responseItem=[...this.ledger.turnItems(turnId)].reverse().find((item)=>item.type==="assistant_message"&&item.status==="completed"&&(item.data as {text?:unknown}).text===validation.message);if(!responseItem)throw new Error("accepted Handoff response was not recorded in the Turn");const output=this.#goalTurnOutput(raw,binding);assertHandoff(output.handoff);const now=this.#now();const item:TurnItemSnapshot={id:randomUUID(),turnId,ordinal:this.ledger.turnItems(turnId).length+1,type:"handoff",status:"completed",data:output.handoff as unknown as JsonValue,createdAt:now,completedAt:now};this.ledger.commitHandoff({agent,turnId,sourceWakeId,mailIds,ts:now,output,responseItemId:responseItem.id,item});this.#clearHandoffState(turnId);}

  #goalTurnOutput(output: TurnOutput, binding: NonNullable<TurnContext["goalBinding"]>): CommittedTurnOutput {
    const record = this.ledger.workRecord(binding.goalId);
    if (!record) throw new Error("Goal Work Record is missing");
    const handoff: GoalHandoff = {
      goalId: binding.goalId,
      goalRevision: binding.goalRevision,
      recordRevision: record.recordRevision,
      outcome: output.handoff.outcome,
      evidence: output.handoff.evidence,
    };
    return { handoff };
  }

  #turnContext(wake:WakeSnapshot,triggers=this.ledger.wakeTriggers(wake.id).filter((trigger)=>trigger.status==="pending")):TurnContext{
    if(wake.bindingKind==="human")return{source:{kind:"human"}};
    if(wake.bindingKind==="specialist")return{source:{kind:"system",reason:triggers.map((trigger)=>trigger.triggerRef).join(", ")}};
    const goal=this.#goal(wake.goalId);return{source:{kind:"goal",round:(this.ledger.workRecord(goal.id)?.recordRevision??0)+1},goalBinding:{goalId:goal.id,goalRevision:goal.revision}};
  }

  #loadContext(wake: ExecutionBinding&{attempt:number}, turn: TurnContext,mail:MailSnapshot[],wakeTriggers:WakeTriggerSnapshot[]): JsonValue {
    const profile = this.#profiles.get(wake.agent) ?? { agent: wake.agent, role: "child" as const };
    const role = profile.role;
    const capabilities = profile.capabilities ?? defaultCapabilities(role);
    const runnerProfile = this.#runnerProfiles.get(profile.runnerProfile ?? "default");
    const goals = role === "ceo" ? this.ledger.goals() : this.ledger.goalsForOwner(wake.agent);
    const handoff = turn.goalBinding?this.ledger.lastGoalHandoff(turn.goalBinding.goalId):null;
    const recoveryIds=[...new Set(wakeTriggers.flatMap((trigger)=>{const parsed=parseRecoveryTrigger(trigger.triggerRef);const exhausted=childRetryExhaustedTurnId(trigger.triggerRef);return parsed?[parsed.turnId]:exhausted?[exhausted]:[]}))];
    const recoveryEvents = recoveryIds.flatMap((recoveryId)=>selectRecoveryEvents(this.ledger.turn(recoveryId)?this.ledger.readStream(`turn:${recoveryId}`):this.ledger.eventsForWake(recoveryId)));
    const teamHandoffs = role === "ceo"
      ? [...this.ledger.eventsSince(0, ["handoff.recorded"])].reverse().filter((event, index, all) => all.findIndex((candidate) => candidate.actor === event.actor) === index)
      : [];
    const workingMemory = selectWorkingMemory(this.ledger.readStream(memoryStream(wake.agent)), this.#memoryTailChars);
    const active = composeActiveContext({ role, capabilities, systemPrompt: profile.systemPrompt ?? defaultTurnPrompt(role,wake.agent,turn), wake,wakeTriggers, goals, mail, lastHandoff: handoff, teamHandoffs, team: role === "ceo" ? this.teamList() : [], recoveryEvents, workingMemory });
    const records = this.ledger.workRecords();
    const currentRecord = turn.goalBinding ? this.ledger.workRecord(turn.goalBinding.goalId) : null;
    const currentGoal = turn.goalBinding ? this.ledger.goal(turn.goalBinding.goalId) : null;
    const parentRecord = currentGoal?.parentId ? this.ledger.workRecord(currentGoal.parentId) : null;
    const recordIndex = records.map((record) => `- /goals/${record.goalId}.md · r${record.recordRevision} · ${this.ledger.goal(record.goalId)?.owner ?? "unknown"} · ${this.ledger.goal(record.goalId)?.phase ?? "unknown"}`);
    const workText = [`# Shared Work Record Index\n\n${recordIndex.join("\n")}`, ...(currentRecord ? [`# Your Work Record\n\n${currentRecord.content}`] : []), ...(parentRecord ? [`# Parent Work Record\n\n${parentRecord.content}`] : [])].join("\n\n");
    return { ...active, text: `${active.text}\n\n${workText}`, sourceSeqs: [...new Set([...active.sourceSeqs,...this.#mailSourceSeqs(mail), ...records.map((record) => record.lastEventSeq)])].sort((a, b) => a - b), workRecord: currentRecord, sharedWorkRecords: records, ...(runnerProfile ? { runnerProfile } : {}) } as unknown as JsonValue;
  }

  #wake(id: string): WakeSnapshot { const value = this.ledger.wake(id); if (!value) throw new Error(`wake not found: ${id}`); return value; }
  #goal(id: string): GoalSnapshot { const value = this.ledger.goal(id); if (!value) throw new Error(`goal not found: ${id}`); return value; }
  #assertGoalMutationAuthority(goal:GoalSnapshot,actor:string):void{if(goal.parentId===null){if(actor!=="human")throw new Error("only human may modify a root goal");return;}const parent=this.ledger.goal(goal.parentId);if(parent?.owner!==actor)throw new Error("only the parent goal owner may modify a child goal");}
  #now(): string { return this.clock.now().toISOString(); }
  #futureTime(value:string,after:string):string{const parsed=Date.parse(value);if(!Number.isFinite(parsed)||parsed<=Date.parse(after))throw new Error("nextWakeAt must be later than the Turn start");return new Date(parsed).toISOString();}
  #runnerProfileId(agent:string):string{return this.#profiles.get(agent)?.runnerProfile??"default";}
  #contextMail(target:ExecutionBinding):MailSnapshot[]{const selected:MailSnapshot[]=[];let used=0;const matches=(mail:MailSnapshot)=>target.bindingKind==="goal"?mail.routeKind==="goal"&&mail.goalId===target.goalId:target.bindingKind==="human"?mail.routeKind==="human_inbox":mail.routeKind==="specialist_inbox"&&mail.specialistRole===target.specialistRole;for(const mail of this.ledger.unreadMail(target.agent).filter(matches)){const cost=Math.min(JSON.stringify(mail.body).length,2_000)+128;if(selected.length>=20||selected.length>0&&used+cost>this.#memoryTailChars)break;selected.push(mail);used+=cost;}return selected;}
  #mailSourceSeqs(mail:MailSnapshot[]):number[]{const ids=new Set(mail.map((item)=>item.id));if(!ids.size)return[];return this.ledger.eventsSince(0,["mail.put"]).filter((event)=>{const data=event.data&&typeof event.data==="object"&&!Array.isArray(event.data)?event.data as {snapshot?:{id?:unknown}}:{};return typeof data.snapshot?.id==="string"&&ids.has(data.snapshot.id);}).map((event)=>event.seq);}

  async #agentRpcForTurn(turnId: string, agent: string, context: TurnContext, method: RunnerRpcMethod, params: JsonValue, sourceWakeId?:string): Promise<JsonValue> {
    const handoffAttemptId=method==="goal.handoff.validate"?this.#beginHandoffAttempt(turnId):null;
    const execution = this.ledger.turn(turnId); if (!execution || execution.status !== "in_progress" || !execution.leaseToken || !execution.leaseUntil || execution.leaseUntil < this.#now()) throw new Error("stale Turn RPC rejected");
    if(context.goalBinding){const goal=this.ledger.goal(context.goalBinding.goalId);const thread=this.ledger.thread(execution.threadId);if(!goal||goal.phase!=="active"||goal.revision!==context.goalBinding.goalRevision||goal.owner!==agent||execution.bindingKind!=="goal"||execution.goalId!==goal.id||execution.goalRevision!==goal.revision||thread?.agent!==agent)throw new Error("stale Goal-bound Turn RPC rejected");}
    const input = asRecord(params);
    if(method==="goal.handoff.validate"){const candidate=String(input.candidateMessage??"");this.ledger.appendEvent({streamId:`turn:${turnId}`,ts:this.#now(),actor:agent,type:"rpc.goal.handoff.validate",data:{attemptId:handoffAttemptId!,handoff:input.handoff??null,candidateMessagePresent:Boolean(candidate.trim()),candidateMessageChars:candidate.length},ignorable:true});return this.#validateHandoffDraft(turnId,handoffAttemptId!,agent,execution,context,input) as unknown as JsonValue;}
    const profile = this.#profiles.get(agent) ?? { agent, role: "child" as const }; const allowed = new Set(profile.capabilities ?? defaultCapabilities(profile.role)); if (!allowed.has(method)) throw new Error(`${profile.role} agent is not allowed to call ${method}`);
    if (!context.goalBinding && goalBoundCapability(method)) throw new Error(`${method} requires a Goal-bound Turn`);
    this.ledger.appendEvent({ streamId: `turn:${turnId}`, ts: this.#now(), actor: agent, type: `rpc.${method}`, data: params, ignorable:true });
    if (method === "ledger.search") return this.ledger.searchEvents(String(input.query), Number(input.limit ?? 20)) as unknown as JsonValue;
    if (method === "team.list") return this.teamList() as unknown as JsonValue;
    if (method === "goal.get") return (context.goalBinding ? this.ledger.goal(context.goalBinding.goalId) : null) as unknown as JsonValue;
    if (method === "goal.create") {
      if (context.source.kind !== "human" || context.goalBinding || agent !== "ceo") throw new Error("Root Goal creation requires an unbound CEO Human Turn"); const goal = this.createRootGoal(String(input.objective), typeof input.id === "string" ? input.id : undefined,turnId); context.goalBinding = { goalId: goal.id, goalRevision: goal.revision }; this.ledger.putTurn({ ...this.ledger.turn(turnId)!, ...goalTurnBinding(goal.id,goal.revision) }, "supervisor"); return { goal, goalBinding: context.goalBinding } as unknown as JsonValue;
    }
    if (method === "goal.work") { if(context.source.kind!=="human"||context.goalBinding)throw new Error("work_on_goal requires an unbound Human Turn");const goal = this.#goal(String(input.goalId)); if (goal.phase !== "active" || !this.#validGoalOwner(agent,goal)) throw new Error("work_on_goal requires the active owned Root Goal"); context.goalBinding = { goalId: goal.id, goalRevision: goal.revision }; this.ledger.putTurn({ ...this.ledger.turn(turnId)!, ...goalTurnBinding(goal.id,goal.revision) }, "supervisor"); return { goal, goalBinding: context.goalBinding } as unknown as JsonValue; }
    if (method === "work_record.list") return this.ledger.workRecords() as unknown as JsonValue;
    if (method === "work_record.read") return this.ledger.workRecord(String(input.goalId ?? context.goalBinding?.goalId ?? "")) as unknown as JsonValue;
    if (method === "work_record.history") return this.ledger.workRecordHistory(String(input.goalId ?? context.goalBinding?.goalId ?? "")) as unknown as JsonValue;
    if (method === "work_record.diff") return this.ledger.workRecordDiff(String(input.goalId ?? context.goalBinding?.goalId ?? ""), Number(input.fromRevision), Number(input.toRevision)) as unknown as JsonValue;
    if (method === "work_record.search") return this.ledger.searchWorkRecords(String(input.query), Number(input.limit ?? 20)) as unknown as JsonValue;
    if (method === "work_record.update") { const binding = context.goalBinding!; return this.ledger.updateWorkRecord({ goalId: binding.goalId, goalRevision: binding.goalRevision, expectedRevision: Number(input.expectedRevision), content: String(input.content), reason: String(input.reason), evidence: numberArray(input.evidence), turnId, ...(sourceWakeId?{sourceWakeId}:{}) }, agent) as unknown as JsonValue; }
    if (method === "goal.delegate") {const binding=context.goalBinding!;if(String(input.parentGoalId)!==binding.goalId)throw new Error("delegation parent must be the Goal bound to this Turn");return this.delegate({ id:String(input.id),parentGoalId:binding.goalId,expectedParentRevision:Number(input.expectedParentRevision),childGoal:asChildGoal(input.childGoal),brief:(input.brief??null) as JsonValue,reason:String(input.reason),evidence:numberArray(input.evidence),sourceTurnId:turnId },agent,sourceWakeId) as unknown as JsonValue;}
    if (method === "goal.reassign") {const goal=this.#goal(String(input.goalId));if(goal.parentId!==context.goalBinding!.goalId)throw new Error("reassignment target must be a child of the Goal bound to this Turn");return await this.reassignGoal({ id:String(input.id),goalId:goal.id,expectedGoalRevision:Number(input.expectedGoalRevision),newOwner:String(input.newOwner),brief:(input.brief??null) as JsonValue,reason:String(input.reason),evidence:numberArray(input.evidence),sourceTurnId:turnId },agent,sourceWakeId) as unknown as JsonValue;}
    if (method === "goal.revise") return this.reviseChildGoal(String(input.goalId),String(input.objective),String(input.observationMethod),String(input.verificationMethod),agent,String(input.reason),numberArray(input.evidence),sourceWakeId,turnId) as unknown as JsonValue;
    if (method === "goal.pause" || method === "goal.resume") { const goal=this.#goal(String(input.goalId)); const directRoot=!context.goalBinding&&context.source.kind==="human"&&goal.parentId===null; if(!context.goalBinding&&!directRoot) throw new Error(`${method} requires a Goal-bound Turn`); const next=this.transitionGoal(goal.id,method==="goal.pause"?"paused":"active",directRoot?"human":agent,!directRoot,turnId); if(method==="goal.resume"&&directRoot){context.goalBinding={goalId:next.id,goalRevision:next.revision};this.ledger.putTurn({...this.ledger.turn(turnId)!,...goalTurnBinding(next.id,next.revision)},"supervisor");return {goal:next,goalBinding:context.goalBinding} as unknown as JsonValue;} return next as unknown as JsonValue; }
    if (method === "goal.complete") { const goal=this.#goal(String(input.goalId)); const directRoot=!context.goalBinding&&context.source.kind==="human"&&goal.parentId===null; if(!context.goalBinding&&!directRoot) throw new Error("goal.complete requires a Goal-bound Turn"); return this.completeGoal({goalId:goal.id,revision:Number(input.revision),reason:String(input.reason),evidence:numberArray(input.evidence),sourceTurnId:turnId},directRoot?"human":agent,sourceWakeId) as unknown as JsonValue; }
    if (method === "mail.send") {const to=String(input.to);if(to==="human")throw new Error("Human communication requires human.request");if(!this.#knownAgent(to))throw new Error(`unknown Agent recipient: ${to}`);const goalId=String(input.goalId??"").trim();if(!goalId)throw new Error("Agent Mail requires a Goal route");const goal=this.#goal(goalId);if(!this.#validGoalOwner(to,goal))throw new Error("Agent Mail Goal route does not match the recipient role and ownership");const mail: MailSnapshot = { id:randomUUID(),to,from:agent,level:String(input.level) as MailSnapshot["level"],...goalRoute(goalId),body:(input.body??null) as JsonValue,readAt:null }; this.ledger.putMail(mail,agent,sourceWakeId); return mail as unknown as JsonValue; }
    if (method === "human.request") {if(agent!=="ceo")throw new Error("only CEO may request Human input");const evidence=numberArray(input.evidence);if(!evidence.length)throw new Error("evidence is required");for(const seq of evidence)if(!this.ledger.eventsSince(seq-1).some((event)=>event.seq===seq))throw new Error(`evidence event does not exist: ${seq}`);const mail: MailSnapshot = { id:randomUUID(),to:"human",from:agent,level:"decision",...humanRequestRoute(),body:{ type:String(input.type),message:input.message??null,evidence },readAt:null }; this.ledger.putMail(mail,agent,sourceWakeId); return mail as unknown as JsonValue; }
    if (method === "schedule.set") return (this.planWake(agent,String(input.at),String(input.reason),agent,context.goalBinding)??{scheduled:true}) as unknown as JsonValue;
    if (method === "goal.put") {const next=input.goal as unknown as GoalSnapshot;if(!this.#validGoalOwner(next.owner,next))throw new Error("Goal owner role does not match Root/Child position");const current=this.ledger.goal(next.id);const operation=!current?"create":current.phase!==next.phase?(next.phase==="paused"?"pause":next.phase==="active"?"resume":next.phase==="blocked"?"block":"complete"):current.owner!==next.owner?"reassign":"revise";this.ledger.putGoal(next,agent,sourceWakeId,{operation,reason:String(input.reason??"Advanced Goal mutation"),evidence:numberArray(input.evidence??[]),sourceTurnId:turnId,...(sourceWakeId?{sourceWakeId}:{})}); return input.goal as JsonValue; }
    if (method === "memory.append") { const note=String(input.note??"").trim(); if(!note) throw new Error("memory note cannot be empty"); const event=this.ledger.appendEvent({streamId:memoryStream(agent),ts:this.#now(),actor:agent,type:"memory.appended",data:{note,turnId}}); return {seq:event.seq} as unknown as JsonValue; }
    throw new Error(`unsupported Agent capability: ${method}`);
  }

  #validateHandoffDraft(turnId:string,attemptId:number,agent:string,execution:TurnSnapshot,context:TurnContext,input:Record<string,JsonValue>):HandoffValidationResult{
    if(!context.goalBinding||execution.bindingKind!=="goal")return{accepted:false,fatal:true,attemptId,issues:[{code:"turn_not_goal_bound",message:"This Turn is no longer Goal-bound."}]};
    const request: HandoffValidationRequest={handoff:(input.handoff??null) as unknown as HandoffValidationRequest["handoff"],candidateMessage:String(input.candidateMessage??"")};
    const issues:import("goah-ledger-contract").HandoffValidationIssue[]=[];
    try{assertAgentHandoff(request.handoff);}catch{issues.push({code:"handoff_invalid",message:"Handoff requires a valid outcome and at least one evidence event."});}
    const existingMessage=[...this.ledger.turnItems(turnId)].reverse().find((item)=>item.type==="assistant_message"&&item.status==="completed"&&typeof (item.data as {text?:unknown}).text==="string"&&Boolean((item.data as {text:string}).text.trim()));
    const message=request.candidateMessage.trim()||String((existingMessage?.data as {text?:unknown}|undefined)?.text??"").trim();
    if(!message)issues.push({code:"message_missing",message:"This Goal Turn needs a readable assistant message before it can finish."});
    const goal=this.ledger.goal(context.goalBinding.goalId);if(!goal||goal.phase!=="active"||goal.owner!==agent||goal.revision!==context.goalBinding.goalRevision)return{accepted:false,fatal:true,attemptId,issues:[{code:"goal_fence_changed",message:"Goal ownership, phase, or revision changed; this Turn can no longer finish against the old binding."}]};
    const record=this.ledger.workRecord(goal.id);if(!record||record.updatedInTurn!==turnId||record.goalRevision!==goal.revision)issues.push({code:"work_record_not_updated",message:"Update this Goal's Work Record in the current Turn before Handoff.",details:{goalId:goal.id,recordRevision:record?.recordRevision??null}});
    const evidence=Array.isArray(request.handoff?.evidence)?request.handoff.evidence:[];for(const seq of evidence)if(!Number.isInteger(seq)||!this.ledger.eventsSince(seq-1).some((event)=>event.seq===seq))issues.push({code:"evidence_not_found",message:`Evidence event ${String(seq)} does not exist in the Ledger.`,details:{seq}});
    if(issues.length)return{accepted:false,fatal:false,attemptId,issues};
    const token=randomUUID();this.#handoffValidations.set(token,{turnId,attemptId,agent,attempt:execution.attempt,leaseToken:execution.leaseToken!,goalId:goal.id,goalRevision:goal.revision,message,handoff:{outcome:request.handoff.outcome,evidence:[...request.handoff.evidence]}});return{accepted:true,fatal:false,attemptId,token,goalId:goal.id,goalRevision:goal.revision};
  }
  #beginHandoffAttempt(turnId:string):number{this.#invalidateHandoffTokens(turnId);const attemptId=(this.#handoffAttemptSeq.get(turnId)??0)+1;this.#handoffAttemptSeq.set(turnId,attemptId);return attemptId;}
  #invalidateHandoffTokens(turnId:string):void{for(const[token,value]of this.#handoffValidations)if(value.turnId===turnId)this.#handoffValidations.delete(token);}
  #clearHandoffState(turnId:string):void{this.#invalidateHandoffTokens(turnId);this.#handoffAttemptSeq.delete(turnId);}

}

export async function runSupervisorDaemon(supervisor: Supervisor, options: { pollMs?: number; concurrency?: number; signal?: AbortSignal; onError?: (error: unknown) => void } = {}): Promise<void> {
  const pollMs = options.pollMs ?? 1_000;
  await supervisor.recover();
  while (!options.signal?.aborted) {
    try { await supervisor.runAvailable(options.concurrency ?? 4); }
    catch (error) { options.onError?.(error); }
    await new Promise<void>((resolve) => {
      if(options.signal?.aborted){resolve();return;}const onAbort=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{options.signal?.removeEventListener("abort",onAbort);resolve();},pollMs);options.signal?.addEventListener("abort",onAbort,{once:true});if(options.signal?.aborted)onAbort();
    });
  }
}

export function deriveTeam(ledger: Ledger, now = new Date().toISOString()): TeamMemberView[] {
  const goals = ledger.goals();
  const wakes = ledger.wakes();
  const schedules = ledger.schedules();
  const threads=ledger.threads();const turns=ledger.turns();
  const handoffs = ledger.eventsSince(0, ["handoff.recorded"]);
  const owners = [...new Set(goals.map((goal) => goal.owner))].sort();
  return owners.map((agent) => {
    const owned = goals.filter((goal) => goal.owner === agent);
    const live = owned.filter((goal) => goal.phase !== "complete");
    const agentWakes = wakes.filter((wake) => wake.agent === agent).sort((a, b) => b.enqueuedSeq - a.enqueuedSeq);
    const activeWake = agentWakes.find((wake) => {if(wake.status!=="claimed"&&wake.status!=="queued")return false;if(!wake.goalId)return true;const goal=ledger.goal(wake.goalId);return goal?.phase==="active"&&goal.owner===agent;});
    const threadIds=new Set(threads.filter((thread)=>thread.agent===agent).map((thread)=>thread.id));const activeTurn=turns.find((turn)=>threadIds.has(turn.threadId)&&turn.status==="in_progress");
    const nextWakeAt = schedules.filter((schedule) => {if(schedule.agent!==agent||schedule.status!=="pending"||schedule.nextWakeAt<=now)return false;if(!schedule.goalId)return true;const goal=ledger.goal(schedule.goalId);return goal?.phase==="active"&&goal.owner===agent;}).map((schedule) => schedule.nextWakeAt).sort()[0] ?? null;
    const lastHandoff = [...handoffs].reverse().find((event) => event.actor === agent) ?? null;
    const value=lastHandoff?.data as {outcome?:unknown}|undefined;const lastOutcome=typeof value?.outcome==="string"?value.outcome as TeamMemberView["lastOutcome"]:null;
    let motion: TeamMemberView["motion"];
    if (live.length === 0) motion = "retired";
    else if (activeTurn) motion = "running";
    else if (activeWake) motion = "queued";
    else if (nextWakeAt) motion = "scheduled";
    else motion = "idle";
    return { agent, goalIds: owned.map((goal) => goal.id), motion,lastOutcome, lastHandoffSeq: lastHandoff?.seq ?? null, lastWakeStatus: agentWakes[0]?.status ?? null, nextWakeAt };
  });
}

export interface RecoveryView { turnId: string; agent: string; state: "scheduled" | "queued" | "running" | "recovered" | "escalated" | "superseded" | "needed"; actionable: boolean }

export function deriveRecoveryViews(ledger: Ledger): RecoveryView[] {
  const views: RecoveryView[] = [];
  const wakes = ledger.wakes();
  const schedules = ledger.schedules();
  const triggers = wakes.flatMap((wake) => ledger.wakeTriggers(wake.id));
  for (const turn of ledger.turns()) {
    if (turn.status !== "failed") continue;
    const sourceWake = wakes.find((wake) => wake.turnId === turn.id);
    const thread = ledger.thread(turn.threadId);
    const goal = turn.bindingKind==="goal" ? ledger.goal(turn.goalId) : null;
    const goalFailure=Boolean(turn.bindingKind==="goal"&&thread&&goal&&goal.phase==="active"&&goal.owner===thread.agent);
    const specialistFailure=Boolean(turn.bindingKind==="specialist"&&thread&&sourceWake?.agent===thread.agent);
    if (!sourceWake || !thread || !goalFailure&&!specialistFailure) continue;
    const base = { turnId: turn.id, agent: thread.agent };
    const scheduled = schedules.some((schedule) => {
      const recovery = parseRecoveryTrigger(schedule.id);
      const sameTarget=goalFailure?schedule.bindingKind==="goal"&&schedule.goalId===goal!.id:schedule.bindingKind==="specialist"&&turn.bindingKind==="specialist"&&schedule.specialistRole===turn.specialistRole;
      return schedule.status === "pending" && schedule.setBy === "supervisor" && schedule.agent === thread.agent && sameTarget && schedule.reason === recoveryRef(turn.id) && recovery?.turnId === turn.id && recovery.attempt > 0;
    });
    if (scheduled) { views.push({ ...base, state: "scheduled", actionable: false }); continue; }
    const recoveryWake = triggers.flatMap((trigger) => {
      const recovery = parseRecoveryTrigger(trigger.triggerRef);
      const wake = recovery?.turnId === turn.id ? wakes.find((candidate) => candidate.id === trigger.wakeId) : null;
      const sameTarget=goalFailure?wake?.bindingKind==="goal"&&wake.goalId===goal!.id:wake?.bindingKind==="specialist"&&turn.bindingKind==="specialist"&&wake.specialistRole===turn.specialistRole;
      return wake?.agent === thread.agent && sameTarget ? [wake] : [];
    }).sort((left, right) => right.enqueuedSeq - left.enqueuedSeq)[0];
    if (recoveryWake?.status === "queued" || recoveryWake?.status === "claimed") { views.push({ ...base, state: "queued", actionable: false }); continue; }
    if (recoveryWake?.status === "consumed" && recoveryWake.turnId) {
      const retry = ledger.turn(recoveryWake.turnId);
      const state: RecoveryView["state"] = retry?.status === "in_progress" ? "running" : retry?.status === "completed" ? "recovered" : "superseded";
      views.push({ ...base, state, actionable: false });
      continue;
    }
    const parent=goalFailure&&goal!.parentId?ledger.goal(goal!.parentId):null;
    const escalation = triggers.flatMap((trigger) => {
      const wake = trigger.triggerRef === childRetryExhaustedRef(turn.id) ? wakes.find((candidate) => candidate.id === trigger.wakeId) : null;
      return wake?.bindingKind==="goal"&&parent&&wake.agent===parent.owner&&wake.goalId===parent.id&&parent.phase==="active"?[wake]:[];
    }).find((wake) => wake.status === "queued" || wake.status === "claimed" || wake.status === "consumed");
    if (escalation) { views.push({ ...base, state: "escalated", actionable: false }); continue; }
    views.push({ ...base, state: "needed", actionable: true });
  }
  return views;
}

export function renderDashboard(ledger: Ledger): string {
  const rows = (values: unknown[]) => values.map((value) => `<tr><td><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>goah status</title><style>body{font:14px ui-monospace;margin:32px;background:#101418;color:#dce3e4}section{margin:32px 0}pre{white-space:pre-wrap;border:1px solid #334;padding:12px}</style></head><body><h1>goah</h1><p>seq ${ledger.events().at(-1)?.seq ?? 0}</p><section><h2>Team</h2><table>${rows(deriveTeam(ledger))}</table></section><section><h2>Goals</h2><table>${rows(ledger.goals())}</table></section><section><h2>Wakes</h2><table>${rows(ledger.wakes())}</table></section><section><h2>Mailbox</h2><table>${rows(ledger.mailbox())}</table></section></body></html>`;
}

function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function messageTextContent(content: unknown): string { if (typeof content === "string") return content; if (!Array.isArray(content)) return ""; return content.map((part) => part && typeof part === "object" && !Array.isArray(part) && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "").filter(Boolean).join("\n"); }
function goalBoundCapability(method: AgentCapability): boolean { return ["goal.delegate", "goal.reassign", "goal.revise", "goal.put", "work_record.update", "schedule.set", "human.request"].includes(method); }
function asRecord(value: JsonValue): Record<string, JsonValue> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("RPC params must be an object"); return value; }
function boundedJson(value:JsonValue,maxChars=2_000):string{const text=typeof value==="string"?value:JSON.stringify(value);return text.length<=maxChars?text:`${text.slice(0,maxChars)}…`;}
function recoveryRef(turnId:string):string{return `recovery:${turnId}`;}
function recoveryScheduleId(turnId:string,attempt:number):string{return `${recoveryRef(turnId)}:${attempt}`;}
function childRetryExhaustedRef(turnId:string):string{return `child-retry-exhausted:${turnId}`;}
function childRetryExhaustedTurnId(triggerRef:string):string|null{return triggerRef.startsWith("child-retry-exhausted:")?triggerRef.slice("child-retry-exhausted:".length)||null:null;}
function parseRecoveryTrigger(triggerRef:string):{turnId:string;attempt:number}|null{if(!triggerRef.startsWith("recovery:"))return null;const [turnId,rawAttempt]=triggerRef.slice("recovery:".length).split("@")[0]!.split(":");if(!turnId)return null;const attempt=rawAttempt===undefined?0:Number(rawAttempt);return Number.isInteger(attempt)&&attempt>=0?{turnId,attempt}:null;}
function mailIdFromTriggerRef(triggerRef:string):string|null{if(!triggerRef.startsWith("mail:"))return null;return triggerRef.slice("mail:".length).split("@redelivery:")[0]||null;}
function mailDeliveryAttempt(triggerRef:string,base:string):number|null{if(triggerRef===base)return 0;const prefix=`${base}@redelivery:`;if(!triggerRef.startsWith(prefix))return null;const attempt=Number(triggerRef.slice(prefix.length));return Number.isInteger(attempt)&&attempt>0?attempt:null;}
function numberArray(value: JsonValue | undefined): number[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) throw new Error("RPC evidence must be a number array"); return value as number[]; }
function isSameNumbers(left:number[],right:number[]):boolean{return left.length===right.length&&left.every((value,index)=>value===right[index]);}
function asChildGoal(value: JsonValue | undefined): { id: string; objective: string; observationMethod: string; verificationMethod: string; owner: string } {
  const input = asRecord(value ?? null);
  return { id: String(input.id), objective: String(input.objective), observationMethod: String(input.observationMethod), verificationMethod: String(input.verificationMethod), owner: String(input.owner) };
}
function defaultCapabilities(role: AgentRole): AgentCapability[] {
  if (role === "ceo") return ["ledger.search", "mail.send", "schedule.set", "team.list", "goal.get", "goal.create", "goal.work", "goal.delegate", "goal.reassign", "goal.revise", "goal.pause", "goal.resume", "goal.complete", "human.request", "work_record.list", "work_record.read", "work_record.history", "work_record.diff", "work_record.search", "work_record.update"];
  if (role === "verifier" || role === "audit") return ["ledger.search", "mail.send", "memory.append"];
  return ["ledger.search", "mail.send", "schedule.set", "goal.get", "work_record.list", "work_record.read", "work_record.history", "work_record.diff", "work_record.search", "work_record.update"];
}

export * from "./verification.js";
export * from "./roles.js";
