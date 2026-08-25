import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  assertHandoff,
  capabilityFor,
  controlStream,
  evaluateMetric,
  goalStream,
  type ActionSnapshot,
  type AgentCapability,
  type AgentProfile,
  type AgentRole,
  type AuditAdvice,
  type Clock,
  type ConnectorDispatchResult,
  type ConnectorProcessSpec,
  type ConnectorQueryResult,
  type DelegationRequest,
  type DelegationResult,
  type GoalSnapshot,
  type GoalCompletionRequest,
  type GoalHandoff,
  type GoalPhase,
  type JsonValue,
  type Handoff,
  type Ledger,
  type MailSnapshot,
  memoryStream,
  type MetricEvaluation,
  type MetricContract,
  type MetricProcessSpec,
  type MetricSample,
  type ReassignmentRequest,
  type ReassignmentResult,
  type Runner,
  type RunnerHandle,
  type RunnerProfile,
  type ScheduleSnapshot,
  type TeamMemberView,
  type TurnContext,
  type TurnSnapshot,
  type TurnItemSnapshot,
  type TurnOutput,
  type WakeSnapshot,
  wakeStream,
} from "goah-ledger-contract";
import { composeActiveContext, selectRecoveryEvents, selectWorkingMemory } from "./context-view.js";
import { defaultRolePrompt } from "./roles.js";

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
  allowExternalActions?: boolean;
  approvers?: string[];
  auditWriters?: string[];
  silence?: { maxSilentMs?: number; notify?: string } | null;
  retryPolicy?: { maxAttempts: number; baseDelayMs: number };
  turnRetryPolicy?: { maxAttempts: number; baseDelayMs: number };
  profiles?: AgentProfile[];
  runnerProfiles?: RunnerProfile[];
  verifyMetricsAfterWake?: boolean;
}

interface MetricCollectorRegistration { goalId: string; contract: MetricContract; spec: MetricProcessSpec; intervalMs: number; nextAt: number }

export class Supervisor {
  readonly #leaseMs: number;
  readonly #memoryTailChars: number;
  readonly #allowExternalActions: boolean;
  readonly #approvers: Set<string>;
  readonly #auditWriters: Set<string>;
  #claimTail: Promise<void> = Promise.resolve();
  #humanTail:Promise<void>=Promise.resolve();
  readonly #connectors = new Map<string, ConnectorProcessSpec>();
  readonly #metricCollectors = new Map<string, MetricCollectorRegistration>();
  readonly #metricContracts = new Map<string, MetricContract>();
  readonly #silence: { maxSilentMs: number; notify: string } | null;
  readonly #retryPolicy: NonNullable<SupervisorOptions["retryPolicy"]>;
  readonly #turnRetryPolicy: NonNullable<SupervisorOptions["turnRetryPolicy"]>;
  readonly #profiles: Map<string, AgentProfile>;
  readonly #runnerProfiles: Map<string, RunnerProfile>;
  readonly #handles = new Map<string, RunnerHandle>();
  readonly #executions=new Map<string,Promise<void>>();
  readonly #verifyMetricsAfterWake: boolean;

  #runner: Runner;
  constructor(readonly ledger: Ledger, runner: Runner, readonly clock: Clock, options: SupervisorOptions = {}) {
    this.#runner = runner;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#memoryTailChars = options.memoryTailChars ?? 12_000;
    this.#allowExternalActions = options.allowExternalActions ?? false;
    this.#approvers = new Set(options.approvers ?? ["human", "ceo"]);
    this.#auditWriters = new Set(options.auditWriters ?? ["verifier", "audit"]);
    this.#silence = options.silence === null ? null : { maxSilentMs: options.silence?.maxSilentMs ?? 12 * 3_600_000, notify: options.silence?.notify ?? "ceo" };
    this.#retryPolicy = options.retryPolicy ?? { maxAttempts: 0, baseDelayMs: 1_000 };
    this.#turnRetryPolicy = options.turnRetryPolicy ?? { maxAttempts: 3, baseDelayMs: 1_000 };
    this.#profiles = new Map([["ceo", { agent: "ceo", role: "ceo" } satisfies AgentProfile], ...(options.profiles ?? []).map((profile) => [profile.agent, profile] as const)]);
    this.#runnerProfiles = new Map((options.runnerProfiles ?? []).map((profile) => [profile.id, profile] as const));
    this.#verifyMetricsAfterWake = options.verifyMetricsAfterWake ?? false;
  }

  registerConnector(connector: ConnectorProcessSpec): void { this.#connectors.set(connector.manifest.connector, connector); }
  registerMetricContract(goalId: string, contract: MetricContract): void { this.#metricContracts.set(goalId, contract); }
  registerMetricCollector(goalId: string, contract: MetricContract, spec: MetricProcessSpec, intervalMs = 60_000): void {
    this.registerMetricContract(goalId, contract);
    this.#metricCollectors.set(goalId, { goalId, contract, spec, intervalMs, nextAt: 0 });
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
  createGoal(goal: GoalSnapshot, actor = "human"): void { this.ledger.putGoal(goal, actor); }
  createRootGoal(objective: string, id: string = randomUUID(),sourceTurnId?:string): GoalSnapshot {
    if (!objective.trim()) throw new Error("root objective is required");
    if (this.ledger.goals().some((goal) => goal.parentId === null && goal.owner === "ceo" && goal.phase !== "complete")) throw new Error("CEO already has an unfinished Root Goal; use work_on_goal");
    const goal: GoalSnapshot = { id, parentId: null, objective, observationMethod: null, verificationMethod: null, owner: "ceo", phase: "active", revision: 0 };
    this.ledger.putGoal(goal,"human",undefined,{operation:"create",reason:"Human established a durable Root Goal",evidence:[],authority:{kind:"human"},...(sourceTurnId?{sourceTurnId}:{})});
    return this.#goal(id);
  }
  startGoal(objective: string, id: string = randomUUID()): { goal: GoalSnapshot; wake: WakeSnapshot } {
    const goal = this.createRootGoal(objective, id);
    const wake = this.#enqueueTrigger("ceo", `root:${id}:created`,{goalId:goal.id,goalRevision:goal.revision});
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
      if (active.source !== "human") { const goalId = active.goalId; await this.interruptTurn(active.id); if (goalId){const goal=this.ledger.goal(goalId);if(goal?.phase==="active")this.#enqueueTrigger(goal.owner,`human-interrupted:${active.id}`,{goalId:goal.id,goalRevision:goal.revision});} }
      else { const handle=this.#handles.get(active.id);if(handle&&!handle.steer)await this.interruptTurn(active.id);else if(handle?.steer){const item=this.#appendTurnItem(active.id,"user_message",{text:message},"human",randomUUID(),"in_progress");try{await handle.steer(message);const stored=this.ledger.turnItems(active.id).find((candidate)=>candidate.id===item.id);if(this.ledger.turn(active.id)?.status==="in_progress"&&stored?.status==="in_progress"){this.ledger.putTurnItem({...stored,status:"completed",completedAt:this.#now()},"human");return{threadId:thread.id,turnId:active.id,steered:true};}}catch{const stored=this.ledger.turnItems(active.id).find((candidate)=>candidate.id===item.id);if(this.ledger.turn(active.id)?.status==="in_progress"&&stored?.status==="in_progress")this.ledger.putTurnItem({...stored,status:"failed",completedAt:this.#now()},"human");if(this.ledger.turn(active.id)?.status==="in_progress")await this.interruptTurn(active.id);}}else{this.#appendTurnItem(active.id,"user_message",{text:message},"human");return{threadId:thread.id,turnId:active.id,steered:true};} }
    }
    const now = this.#now(); this.ledger.putThread({ ...thread,updatedAt:now },"supervisor"); const leaseToken = randomUUID();
    const turn: TurnSnapshot = { id: randomUUID(), threadId: thread.id, source: "human", goalId: null, goalRevision: null, status: "in_progress", attempt: 1, error: null, startedAt: now, endedAt: null, leaseUntil: new Date(this.clock.now().getTime() + this.#leaseMs).toISOString(), leaseToken, runnerPid: null,runnerProfileId:this.#runnerProfileId("ceo") };
    this.ledger.putTurn(turn, "human"); this.#appendTurnItem(turn.id, "user_message", { text: message }, "human");
    const context: TurnContext = { source: { kind: "human" } };
    void this.#trackExecution(turn,"ceo",context,()=>this.#humanContext(turn.id,"ceo")); return { threadId: thread.id, turnId: turn.id, steered: false };
  }

  async interruptTurn(turnId: string): Promise<TurnSnapshot> {
    const turn = this.ledger.turn(turnId); if (!turn || turn.status !== "in_progress") throw new Error("active Turn not found");
    this.ledger.finishTurn(turn.id,"interrupted",{message:"interrupted by Human"},this.#now(),"human");const handle=this.#handles.get(turn.id);try{await handle?.terminate();}catch(error){this.#recordCleanupFailure(turn.id,error);}finally{this.#handles.delete(turn.id);}await this.#executions.get(turn.id);
    return this.ledger.turn(turn.id)!;
  }

  async #executeTurn(initial: TurnSnapshot, agent: string, turnContext: TurnContext, contextFactory: () => JsonValue, sourceWake: WakeSnapshot | null = null, deliveredMailIds: string[] = [], recordRevisionAtStart = -1): Promise<void> {
    while (this.ledger.turn(initial.id)?.status === "in_progress") {
      const execution = this.ledger.turn(initial.id)!; const leaseToken = execution.leaseToken!; let handle: RunnerHandle | null = null; let renewal: NodeJS.Timeout | null = null;
      try {
        handle = this.runner.prepare({ agent,execution, ...(sourceWake ? { sourceWake } : {}),turn:turnContext,context:contextFactory(),now:()=>this.#now(),emit:(trace)=>this.#recordTurnTrace(initial.id,leaseToken,trace.type,trace.data,agent),rpc:(method,params)=>this.#agentRpcForTurn(initial.id,agent,turnContext,method,params,sourceWake?.id) });
        this.#handles.set(initial.id,handle); if(handle.pid) this.ledger.attachTurnProcess(initial.id,leaseToken,handle.pid); renewal=setInterval(()=>{try{this.ledger.renewTurnLease(initial.id,leaseToken,new Date(this.clock.now().getTime()+this.#leaseMs).toISOString(),this.#now());}catch{void this.#terminateHandle(initial.id,handle!);}},Math.max(25,Math.floor(this.#leaseMs/3))); renewal.unref(); handle.begin(); const result=await handle.result; if(renewal)clearInterval(renewal); renewal=null;await this.#terminateHandle(initial.id,handle);this.#handles.delete(initial.id);
        const current=this.ledger.turn(initial.id); if(!current||current.status!=="in_progress")return;if(current.attempt>1)this.ledger.appendEvent({streamId:`turn:${current.id}`,ts:this.#now(),actor:"supervisor",type:"turn.retry_finished",data:{attempt:current.attempt,outcome:result.outcome},ignorable:true});if(result.outcome!=="abnormal")this.#closeStreamingItems(current.id);
        if(result.outcome==="abnormal"){
          if(current.attempt<this.#turnRetryPolicy.maxAttempts){this.ledger.repairTurnAttempt(current.id,result.reason,this.#now(),"supervisor");this.ledger.appendEvent({streamId:`turn:${current.id}`,ts:this.#now(),actor:"supervisor",type:"turn.retry_started",data:{attempt:current.attempt+1,reason:result.reason},ignorable:true});this.ledger.putTurn({...current,attempt:current.attempt+1,leaseUntil:new Date(this.clock.now().getTime()+this.#leaseMs).toISOString(),runnerPid:null},"supervisor");await new Promise((resolve)=>setTimeout(resolve,this.#turnRetryPolicy.baseDelayMs*2**(current.attempt-1)));continue;}
          this.#failTurn(current.id,result.reason);this.#scheduleTurnRecovery(sourceWake,current.id,agent); return;
        }
        if(turnContext.goalBinding){if(result.outcome!=="handoff")throw new Error("Goal-bound Turn requires Handoff");this.#commitGoalTurn(current.id,agent,turnContext,result.output,sourceWake?.id??null,deliveredMailIds,recordRevisionAtStart);return;}
        if(result.outcome!=="response")throw new Error("ordinary Turn cannot finish with Handoff");if(!this.ledger.turnItems(current.id).some((item)=>item.type==="assistant_message"&&(item.data as {text?:unknown}).text===result.response.content))this.#appendTurnItem(current.id,"assistant_message",{text:result.response.content},agent);this.ledger.finishTurn(current.id,"completed",null,this.#now(),"supervisor",deliveredMailIds);return;
      } catch(error){if(renewal)clearInterval(renewal);if(handle)await this.#terminateHandle(initial.id,handle);this.#handles.delete(initial.id);const current=this.ledger.turn(initial.id);if(current?.status==="in_progress"){this.#failTurn(current.id,error instanceof Error?error.message:String(error));this.#scheduleTurnRecovery(sourceWake,current.id,agent);}return;}
    }
  }
  #trackExecution(initial:TurnSnapshot,agent:string,turnContext:TurnContext,contextFactory:()=>JsonValue,sourceWake:WakeSnapshot|null=null,deliveredMailIds:string[]=[],recordRevisionAtStart=-1):Promise<void>{const running=this.#executeTurn(initial,agent,turnContext,contextFactory,sourceWake,deliveredMailIds,recordRevisionAtStart);this.#executions.set(initial.id,running);void running.finally(()=>{if(this.#executions.get(initial.id)===running)this.#executions.delete(initial.id);});return running;}

  #humanContext(turnId: string, agent: string): JsonValue {
    const turn=this.ledger.turn(turnId)!;const profile=this.#profiles.get(agent)??{agent,role:"ceo" as const};const runnerProfile=this.#runnerProfiles.get(profile.runnerProfile??"default");const recent=this.ledger.turns(turn.threadId).filter((candidate)=>candidate.id!==turn.id&&candidate.status==="completed").slice(-8).flatMap((candidate)=>this.ledger.turnItems(candidate.id).filter((item)=>item.type==="user_message"||item.type==="assistant_message").map((item)=>`${item.type==="user_message"?"Human":"Assistant"}: ${String((item.data as {text?:unknown}).text??"")}`));const current=this.#turnHistory(turn.id);const sourceSeqs=this.ledger.readStream(`turn:${turn.id}`).filter((event)=>event.type==="item.user_message.started").map((event)=>event.seq);return {text:[...(recent.length?[`# Recent conversation\n\n${recent.join("\n")}`]:[]),`# Current Turn\n\n${current}`].join("\n\n"),sourceSeqs,capabilities:profile.capabilities??defaultCapabilities(profile.role),systemPrompt:profile.systemPrompt??"You are Goah's primary Agent. Respond naturally and use tools when useful.",...(runnerProfile?{runnerProfile}:{})} as unknown as JsonValue;
  }

  #goalContext(wake:WakeSnapshot,turn:TurnContext,turnId:string):JsonValue{const base=this.#loadContext(wake,turn);if(!base||typeof base!=="object"||Array.isArray(base))return base;const value=base as Record<string,JsonValue>;const history=this.#turnHistory(turnId);return {...value,...(history?{text:`${String(value.text??"")}\n\n# Current Turn retry history\n\n${history}`}:{})};}

  #threadAgent(threadId:string):string{const thread=this.ledger.thread(threadId);if(!thread)throw new Error("Turn Thread not found");return thread.agent;}

  #turnHistory(turnId: string): string { const items=this.ledger.turnItems(turnId).map((item)=>{const data=item.data as {text?:unknown;tool?:unknown;result?:unknown};if(item.type==="user_message")return `Human: ${String(data.text??"")}`;if(item.type==="assistant_message")return `Assistant: ${String(data.text??"")}`;if(item.type==="tool_call")return `Tool call: ${String(data.tool??"")} ${JSON.stringify(item.data)}`;if(item.type==="tool_result")return `Tool result: ${JSON.stringify(data.result??item.data)}`;return `${item.type}: ${JSON.stringify(item.data)}`;});const facts=this.ledger.readStream(`turn:${turnId}`).filter((event)=>event.type==="ceo.motion_invalid"||event.type==="turn.retry_started").map((event)=>`${event.type}: ${JSON.stringify(event.data)}`);return [...items,...facts].join("\n"); }

  #failTurn(turnId: string, reason: string): void { const current=this.ledger.turn(turnId);if(!current||current.status!=="in_progress")return;this.ledger.finishTurn(turnId,"failed",{message:reason},this.#now(),"supervisor"); }
  async #terminateHandle(turnId:string,handle:RunnerHandle):Promise<void>{try{await handle.terminate();}catch(error){this.#recordCleanupFailure(turnId,error);}}
  #recordCleanupFailure(turnId:string,error:unknown):void{this.ledger.appendEvent({streamId:`turn:${turnId}`,ts:this.#now(),actor:"supervisor",type:"runner.cleanup_failed",data:{message:error instanceof Error?error.message:String(error)},ignorable:true});}

  #scheduleTurnRecovery(sourceWake:WakeSnapshot|null,turnId:string,agent:string):void{if(!sourceWake)return;const prior=sourceWake.triggerRef.startsWith("recovery:")?Number(sourceWake.triggerRef.slice("recovery:".length).split(":")[1]?.split("@")[0]??0):0;const next=prior+1;const goal=sourceWake.goalId?this.ledger.goal(sourceWake.goalId):null;if(next<this.#retryPolicy.maxAttempts){const delay=this.#retryPolicy.baseDelayMs*2**prior;this.ledger.putSchedule({id:`recovery:${turnId}:${next}`,agent:goal?.owner??agent,nextWakeAt:new Date(this.clock.now().getTime()+delay).toISOString(),reason:`recovery:${turnId}`,setBy:"supervisor",...(goal&&goal.phase==="active"?{goalId:goal.id,goalRevision:goal.revision}:{})},"supervisor",sourceWake.id);}else if(agent!=="ceo"&&this.#hasActiveRoot()){const root=this.#activeRoot();if(root)this.#enqueueTrigger("ceo",`child-retry-exhausted:${turnId}`,{goalId:root.id,goalRevision:root.revision});}}

  #closeStreamingItems(turnId:string):void{const open=this.ledger.turnItems(turnId).filter((item)=>item.status==="in_progress");if(open.some((item)=>item.type==="tool_call"||item.type==="user_message"))throw new Error("Runner returned while an input or tool call was still open");for(const item of open)this.ledger.putTurnItem({...item,status:"completed",completedAt:this.#now()},"supervisor");}

  #appendTurnItem(turnId: string, type: TurnItemSnapshot["type"], data: JsonValue, actor: string, id: string = randomUUID(), status: TurnItemSnapshot["status"] = "completed"): TurnItemSnapshot {
    const now = this.#now(); const item: TurnItemSnapshot = { id, turnId, ordinal: this.ledger.turnItems(turnId).length + 1, type, status, data, createdAt: now, completedAt: status === "in_progress" ? null : now }; this.ledger.putTurnItem(item, actor); return item;
  }

  #recordTurnTrace(turnId: string, leaseToken: string, type: string, data: JsonValue, actor = "ceo"): void {
    if(type==="transcript.completed"||type==="transcript.interrupted")return;
    if(type==="transcript.started"&&this.ledger.readStream(`turn:${turnId}`).some((event)=>event.type==="transcript.started"))return;
    this.ledger.appendTurnEvent({ streamId: `turn:${turnId}`, ts: this.#now(), actor, type, data },leaseToken);
    if (type === "message.assistant.completed") { const message = data && typeof data === "object" && !Array.isArray(data) ? (data as { message?: { content?: unknown } }).message : undefined; const text = messageTextContent(message?.content); if (text) this.#appendTurnItem(turnId, "assistant_message", { text }, actor); }
    else if(type==="plan.updated")this.#appendTurnItem(turnId,"plan",data,actor);
    else if(type==="message.assistant.delta"){const input=data as {messageId?:unknown;delta?:{type?:unknown;delta?:unknown;content?:unknown}};const delta=input.delta;if(delta?.type==="thinking_start"||delta?.type==="thinking_delta"||delta?.type==="thinking_end"){const turn=this.ledger.turn(turnId)!;const id=`${turnId}:attempt:${turn.attempt}:reasoning:${String(input.messageId??"message")}`;const existing=this.ledger.turnItems(turnId).find((item)=>item.id===id);const text=`${String((existing?.data as {text?:unknown}|undefined)?.text??"")}${delta.type==="thinking_delta"?String(delta.delta??""):""}`;if(!existing)this.#appendTurnItem(turnId,"reasoning",{text},actor,id,delta.type==="thinking_end"?"completed":"in_progress");else this.ledger.putTurnItem({...existing,data:{text},status:delta.type==="thinking_end"?"completed":"in_progress",completedAt:delta.type==="thinking_end"?this.#now():null},actor);}}
    else if (type === "tool.called") { const input = data as { callId?: unknown; name?: unknown; arguments?: JsonValue };const turn=this.ledger.turn(turnId)!;const id=`${turnId}:attempt:${turn.attempt}:tool:${String(input.callId)}`;if(this.ledger.turnItems(turnId).some((item)=>item.id===id))throw new Error("duplicate tool call id in Turn attempt");this.#appendTurnItem(turnId, "tool_call", { callId:String(input.callId),tool: String(input.name), arguments: input.arguments ?? null }, actor,id,"in_progress"); }
    else if (type === "tool.completed") { const input = data as { callId?: unknown; result?: JsonValue; isError?: unknown };const turn=this.ledger.turn(turnId)!;const id=`${turnId}:attempt:${turn.attempt}:tool:${String(input.callId)}`; const existing = this.ledger.turnItems(turnId).find((item) => item.id === id);if(!existing)throw new Error("tool result has no matching call in Turn attempt");this.ledger.putTurnItem({ ...existing, status: input.isError ? "failed" : "completed", completedAt: this.#now() }, actor); this.#appendTurnItem(turnId, "tool_result", { callId: String(input.callId), result: input.result ?? null }, actor); }
  }
  sendToCeo(body: JsonValue, level: "fyi" | "decision" | "emergency" = "decision"): { mail: MailSnapshot; wake: WakeSnapshot } {
    const mail = { id: randomUUID(), to: "ceo", from: "human", level, body, readAt: null };
    this.ledger.putMail(mail, "human");
    const wake = this.#enqueueTrigger("ceo", `mail:${mail.id}`);
    if (!wake) throw new Error("CEO wake was not admitted");
    return { mail, wake };
  }
  delegate(request: DelegationRequest, actor = "ceo", wakeId?: string): DelegationResult { return this.ledger.commitDelegation(request, actor, wakeId); }
  async reassignGoal(request: ReassignmentRequest, actor = "ceo", wakeId?: string): Promise<ReassignmentResult> {const goal=this.#goal(request.goalId);const thread=this.ledger.threads().find((candidate)=>candidate.agent===goal.owner);const active=thread?this.ledger.activeTurn(thread.id):null;if(active?.goalId===goal.id)await this.interruptTurn(active.id);return this.ledger.commitReassignment(request, actor, wakeId); }
  teamList(now = this.#now()): TeamMemberView[] { return deriveTeam(this.ledger, now); }
  updateGoal(id: string, patch: Partial<Pick<GoalSnapshot, "objective" | "observationMethod" | "verificationMethod" | "owner">>, actor = "human",change?:{reason:string;evidence:number[];sourceTurnId?:string;sourceWakeId?:string}): GoalSnapshot {
    if (patch.objective === undefined && patch.observationMethod === undefined && patch.verificationMethod === undefined && patch.owner === undefined) throw new Error("goal update requires objective, observation method, verification method, or owner");
    const current = this.#goal(id);
    if (patch.objective !== undefined && patch.objective !== current.objective && current.parentId !== null && (patch.observationMethod === undefined || patch.verificationMethod === undefined)) throw new Error("child objective revision requires replacement observation and verification methods");
    const next = {
      ...current,
      ...patch,
      ...(patch.objective !== undefined && patch.objective !== current.objective && current.parentId === null && patch.observationMethod === undefined ? { observationMethod: null } : {}),
      ...(patch.objective !== undefined && patch.objective !== current.objective && current.parentId === null && patch.verificationMethod === undefined ? { verificationMethod: null } : {}),
      revision: current.revision + 1,
    };
    this.ledger.putGoal(next,actor,change?.sourceWakeId,{operation:"revise",reason:change?.reason??"Goal definition revised",evidence:change?.evidence??[],...(change?.sourceTurnId?{sourceTurnId:change.sourceTurnId}:{}),...(change?.sourceWakeId?{sourceWakeId:change.sourceWakeId}:{})});
    if (next.parentId === null && next.owner === "ceo" && actor === "human") this.#enqueueTrigger("ceo", `root:${id}:revised:${next.revision}`,{goalId:next.id,goalRevision:next.revision});
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
    this.#suppressQueuedWake(goal.owner, `goal:${goal.id}:complete`,goal.id);
    if (goal.parentId && actor !== "ceo") {const root=this.#activeRoot();if(root)this.#enqueueTrigger("ceo", `goal:${goal.id}:complete:${goal.revision}`,{goalId:root.id,goalRevision:root.revision});}
    return goal;
  }
  transitionGoal(id: string, phase: GoalPhase, actor = "human",scheduleMotion=true,sourceTurnId?:string): GoalSnapshot {
    const current = this.#goal(id);
    if (current.phase === phase) return current;
    if (phase === "complete") throw new Error("goal completion requires reason and evidence");
    const next = { ...current, phase, revision: current.revision + 1 };
    const operation=phase==="paused"?"pause":phase==="blocked"?"block":"resume";this.ledger.putGoal(next,actor,undefined,{operation,reason:`Goal ${operation} requested by ${actor}`,evidence:[],...(sourceTurnId?{sourceTurnId}:{})});
    if (phase === "paused") this.#suppressQueuedWake(next.owner, `goal:${id}:${phase}`,next.id);
    if (phase === "active"&&scheduleMotion) this.#enqueueTrigger(next.owner, `${next.parentId ? "goal" : "root"}:${id}:resumed:${next.revision}`,{goalId:next.id,goalRevision:next.revision});
    if (next.parentId && actor !== "ceo" && phase === "blocked") {const root=this.#activeRoot();if(root)this.#enqueueTrigger("ceo", `goal:${id}:${phase}:${next.revision}`,{goalId:root.id,goalRevision:root.revision});}
    return next;
  }

  planWake(agent: string, at: string, reason: string, setBy = agent,target?:{goalId:string;goalRevision:number}): WakeSnapshot | null {
    const parsed=Date.parse(at);if(!Number.isFinite(parsed))throw new Error("schedule time is invalid");const nextWakeAt=new Date(parsed).toISOString();const binding=target??this.#singleActiveGoalTarget(agent);
    const schedule: ScheduleSnapshot = { id: `schedule:${agent}${binding?`:${binding.goalId}`:""}`, agent, nextWakeAt, reason, setBy,...(binding??{}) };
    this.ledger.putSchedule(schedule, setBy);
    return nextWakeAt <= this.#now() ? this.#enqueueSchedule(schedule) : null;
  }

  async stopAgentWake(agent: string): Promise<WakeSnapshot | null> {
    const wake=this.ledger.wakes().find((item)=>item.agent===agent&&(item.status==="queued"||item.status==="claimed"));if(wake)this.ledger.cancelWake(wake.id,this.#now());const thread=this.ledger.threads().find((item)=>item.agent===agent);const turn=thread?this.ledger.activeTurn(thread.id):null;if(turn)await this.interruptTurn(turn.id);return wake?this.#wake(wake.id):null;
  }

  async recover(): Promise<void> {
    this.ledger.recoverDispatchingActions();
    for(const wake of this.ledger.wakes().filter((candidate)=>candidate.status==="claimed"))this.ledger.releaseWake(wake.id,this.#now());
    for (const turn of this.ledger.turns().filter((candidate) => candidate.status === "in_progress"&&!this.#handles.has(candidate.id))) { if (turn.runnerPid) await this.runner.terminateProcess(turn.runnerPid,turn.runnerProfileId); this.#failTurn(turn.id,"orphaned Runner ownership recovered after Supervisor restart"); if(turn.goalId){const goal=this.ledger.goal(turn.goalId);if(goal&&goal.phase==="active")this.#enqueueTrigger(goal.owner,`recovery:${turn.id}`,{goalId:goal.id,goalRevision:goal.revision});} }
  }
  async tick(): Promise<WakeSnapshot | null> {
    const wake = await this.#claimNextWake();
    if (!wake) return null;
    if(wake.goalId){const goal=this.ledger.goal(wake.goalId);if(!goal||goal.owner!==wake.agent||goal.phase!=="active"||goal.revision!==wake.goalRevision){this.ledger.cancelWake(wake.id,this.#now());return this.#wake(wake.id);}}
    let createdTurnId:string|null=null;
    try {
      const turnContext = this.#turnContext(wake);const thread=this.threadFor(wake.agent);const now=this.#now();const leaseToken=randomUUID();const execution:TurnSnapshot={id:randomUUID(),threadId:thread.id,source:turnContext.source.kind,goalId:turnContext.goalBinding?.goalId??null,goalRevision:turnContext.goalBinding?.goalRevision??null,status:"in_progress",attempt:1,error:null,startedAt:now,endedAt:null,leaseUntil:new Date(this.clock.now().getTime()+this.#leaseMs).toISOString(),leaseToken,runnerPid:null,runnerProfileId:this.#runnerProfileId(wake.agent)};
      this.ledger.putThread({ ...thread,updatedAt:this.#now() },"supervisor");
      this.ledger.startTurnFromWake(wake.id,execution,now);createdTurnId=execution.id;const deliveredMailIds=this.ledger.unreadMail(wake.agent).map((mail)=>mail.id);this.ledger.appendEvent({streamId:`turn:${execution.id}`,ts:now,actor:"supervisor",type:"run.admitted",data:turnContext as unknown as JsonValue,ignorable:true});const revision=turnContext.goalBinding?this.ledger.workRecord(turnContext.goalBinding.goalId)?.recordRevision??-1:-1;await this.#trackExecution(execution,wake.agent,turnContext,()=>this.#goalContext(wake,turnContext,execution.id),wake,deliveredMailIds,revision);
      if (this.#verifyMetricsAfterWake) {
        for (const goal of this.ledger.goalsForOwner(wake.agent)) if (this.#metricCollectors.has(goal.id)) await this.collectMetricNow(goal.id);
      }
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
      await this.#collectMetrics();
      this.#scheduleMetricAlerts();
      this.#checkSystemSilence();
      for (const mail of this.ledger.triggeringMail()) {
        const thread=this.ledger.threads().find((candidate)=>candidate.agent===mail.to);if(thread&&this.ledger.activeTurn(thread.id))continue;
        const body=mail.body&&typeof mail.body==="object"&&!Array.isArray(mail.body)?mail.body as Record<string,JsonValue>:{};const goalId=typeof body.goalId==="string"?body.goalId:null;const goal=goalId?this.ledger.goal(goalId):null;const base=`mail:${mail.id}`;const related=this.ledger.wakes().filter((wake)=>wake.agent===mail.to&&(wake.triggerRef===base||wake.triggerRef.startsWith(`${base}@redelivery:`))).sort((a,b)=>a.enqueuedSeq-b.enqueuedSeq);const last=related.at(-1)??this.ledger.wakeByTrigger(mail.to,base);const trigger=last&&(last.status==="consumed"||last.status==="cancelled")?`${base}@redelivery:${related.length+1}`:last?.triggerRef??base;this.#enqueueTrigger(mail.to,trigger,goal&&goal.owner===mail.to&&goal.phase==="active"?{goalId:goal.id,goalRevision:goal.revision}:undefined);
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

  async submitAction(action: Omit<ActionSnapshot, "connector" | "gated" | "status" | "reconciledAt" | "externalRef">, connectorName: string, wakeId?: string): Promise<ActionSnapshot> {
    const connector = this.#connectors.get(connectorName);
    const capability = connector ? capabilityFor(connector.manifest, action.kind) : null;
    const gated = !connector || !capability || capability.risk !== "reversible"
      || (!connector.manifest.dryRun && !this.#allowExternalActions);
    if (gated && action.agent !== "ceo") this.#assertAgentGoalsCurrent(action.agent);
    const requested: ActionSnapshot = { ...action, connector: connectorName, gated, status: "requested", reconciledAt: null, externalRef: null };
    this.ledger.requestAction(requested, action.agent, wakeId);
    if (gated || !connector) return this.#action(action.id);
    this.ledger.approveAction(action.id, "supervisor", "declared reversible dry-run capability", action.evidence);
    return this.#dispatch(action.id);
  }

  async approveAction(id: string, approver: string, reason: string, evidence: number[]): Promise<ActionSnapshot> {
    if (!this.#approvers.has(approver)) throw new Error("actor is not authorized to approve actions");
    this.#requiredConnector(this.#action(id).connector);
    this.ledger.approveAction(id, approver, reason, evidence);
    return this.#dispatch(id);
  }

  rejectAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot {
    if (!this.#approvers.has(approver)) throw new Error("actor is not authorized to reject actions");
    return this.ledger.rejectAction(id, approver, reason, evidence);
  }

  putAuditAdvice(id: string, advice: Omit<AuditAdvice, "at">, wakeId?: string): ActionSnapshot {
    const role = this.#profiles.get(advice.by)?.role;
    if (!this.#auditWriters.has(advice.by) && role !== "verifier" && role !== "audit") throw new Error("actor is not authorized to write audit advice");
    return this.ledger.putAuditAdvice(id, advice, wakeId);
  }

  ackAuditAdvice(id: string, agent: string): ActionSnapshot { return this.ledger.ackAuditAdvice(id, agent); }

  recordMetric(sample: MetricSample): MetricEvaluation {
    const goal = this.ledger.goal(sample.goalId);
    if (!goal) throw new Error(`metric goal not found: ${sample.goalId}`);
    const contract = this.#metricContracts.get(goal.id);
    if (!contract) throw new Error(`metric contract is not registered: ${goal.id}`);
    if (contract.source !== sample.source) throw new Error("metric source does not match registered contract");
    this.ledger.appendEvent({ streamId: `metric:${goal.id}`, ts: this.#now(), actor: "supervisor", type: "metric.sampled", data: sample as unknown as JsonValue });
    const evaluation = evaluateMetric(contract, this.ledger.metricSamples(goal.id), this.#now());
    this.ledger.appendEvent({ streamId: `metric:${goal.id}`, ts: this.#now(), actor: "supervisor", type: "metric.evaluated", data: evaluation as unknown as JsonValue });
    if (evaluation.shouldWakeOwner) this.#enqueueTrigger(goal.owner, `metric:${goal.id}:${sample.observedAt}`,{goalId:goal.id,goalRevision:goal.revision});
    return evaluation;
  }

  async collectMetricNow(goalId: string): Promise<MetricEvaluation> {
    const registration = this.#metricCollectors.get(goalId);
    if (!registration) throw new Error(`metric collector is not registered: ${goalId}`);
    registration.nextAt = this.clock.now().getTime() + registration.intervalMs;
    const sample = await runJsonProcess<MetricSample>(registration.spec, { goalId });
    return this.recordMetric({ ...sample, goalId });
  }

  async reconcileAction(id: string): Promise<ActionSnapshot> {
    const action = this.#action(id);
    if (action.status !== "unknown") throw new Error("only unknown actions may be reconciled");
    const connector = this.#requiredConnector(action.connector);
    const capability = capabilityFor(connector.manifest, action.kind);
    if (!capability || capability.query === "none") throw new Error("connector cannot reconcile this action");
    const result = await runConnector<ConnectorQueryResult>(connector, "query", action);
    if (result.status === "pending") return action;
    return this.ledger.transitionAction(id, result.status, { reconciledAt: this.#now(), ...(result.externalRef ? { externalRef: result.externalRef } : {}) });
  }

  async retryUnknownAction(id: string): Promise<ActionSnapshot> {
    const action = this.#action(id);
    if (action.status !== "unknown") throw new Error("only unknown actions may be retried");
    const connector = this.#requiredConnector(action.connector);
    const capability = capabilityFor(connector.manifest, action.kind);
    if (!capability?.nativeIdempotency || !capability.automaticRetry) throw new Error("connector manifest forbids automatic retry");
    return this.#dispatch(id);
  }

  async #dispatch(id: string): Promise<ActionSnapshot> {
    const current = this.#action(id);
    const connector = this.#requiredConnector(current.connector);
    const dispatching = this.ledger.transitionAction(id, "dispatching");
    try{const result = await runConnector<ConnectorDispatchResult>(connector, "dispatch", dispatching);return this.ledger.transitionAction(id, result.status, result.externalRef ? { externalRef: result.externalRef } : {});}catch(error){this.ledger.transitionAction(id,"unknown");throw error;}
  }

  #enqueueSchedule(schedule: ScheduleSnapshot): WakeSnapshot | null {
    return this.#enqueueTrigger(schedule.agent, `${schedule.id}@${schedule.nextWakeAt}`,schedule.goalId?{goalId:schedule.goalId,goalRevision:schedule.goalRevision!}:undefined);
  }

  #enqueueTrigger(agent: string, triggerRef: string,target?:{goalId:string;goalRevision:number}): WakeSnapshot | null {
    if(target){const goal=this.ledger.goal(target.goalId);if(!goal||goal.owner!==agent||goal.phase!=="active"||goal.revision!==target.goalRevision)throw new Error("Wake Goal target is stale or owned by another Agent");}
    const exact = this.ledger.wakeByTrigger(agent, triggerRef);
    if (exact) {if((exact.goalId??null)!==(target?.goalId??null)||(exact.goalRevision??null)!==(target?.goalRevision??null))throw new Error("Wake trigger was reused with a different Goal target");return exact;}
    const ownsLiveGoal = this.ledger.goalsForOwner(agent).some((goal) => goal.phase === "active" || goal.phase === "blocked");
    const ceoInterrupt = agent === "ceo" && (triggerRef.startsWith("mail:") || triggerRef.startsWith("child-"));
    if (!ownsLiveGoal && !ceoInterrupt) return null;
    let queued = this.ledger.wakes().find((wake)=>wake.agent===agent&&wake.status==="queued"&&(wake.goalId??null)===(target?.goalId??null));
    if(queued&&queued.goalRevision!==target?.goalRevision){this.ledger.cancelWake(queued.id,this.#now());queued=undefined;}
    if (queued) {
      this.ledger.appendEvent({ streamId: wakeStream(queued.id), ts: this.#now(), actor: "supervisor", type: "wake.trigger_coalesced", data: { wakeId: queued.id, triggerRef } });
      return queued;
    }
    const wake: WakeSnapshot = { id: randomUUID(), agent, triggerRef, status: "queued", attempt: 0, enqueuedSeq: 0, claimedAt:null,consumedAt:null,turnId:null,...(target??{}) };
    const result = this.ledger.enqueueWake(wake, "supervisor");
    if (result.created) return this.#wake(wake.id);
    const existing = this.ledger.wakeByTrigger(agent, triggerRef);
    if (!existing) throw new Error("deduplicated wake is missing");
    return existing;
  }

  #suppressQueuedWake(agent: string, reason: string,goalId?:string): void {
    for(const wake of this.ledger.wakes().filter((candidate)=>candidate.agent===agent&&(candidate.status==="queued"||candidate.status==="claimed")&&(goalId===undefined||candidate.goalId===goalId))){this.ledger.appendEvent({ streamId: wakeStream(wake.id), ts: this.#now(), actor: "supervisor", type: "wake.suppressed", data: { reason } });this.ledger.cancelWake(wake.id,this.#now());}
  }

  #hasActiveRoot(): boolean { return this.ledger.goals().some((goal) => goal.parentId === null && goal.owner === "ceo" && goal.phase === "active"); }
  #activeRoot():GoalSnapshot|null{return this.ledger.goals().find((goal)=>goal.parentId===null&&goal.owner==="ceo"&&goal.phase==="active")??null;}
  #singleActiveGoalTarget(agent:string):{goalId:string;goalRevision:number}|undefined{const goals=this.ledger.goalsForOwner(agent).filter((goal)=>goal.phase==="active");if(goals.length>1)throw new Error("Wake requires an explicit Goal target when an Agent owns multiple active Goals");return goals.length===1?{goalId:goals[0]!.id,goalRevision:goals[0]!.revision}:undefined;}
  #role(agent: string): AgentRole { return this.#profiles.get(agent)?.role ?? "child"; }

  #commitGoalTurn(turnId:string,agent:string,turn:TurnContext,raw:TurnOutput,sourceWakeId:string|null,mailIds:string[],revisionAtStart:number):void{const binding=turn.goalBinding!;const goal=this.#goal(binding.goalId);if(goal.revision!==binding.goalRevision)throw new Error("Goal revision changed during the Turn");const record=this.ledger.workRecord(goal.id);if(!record||record.recordRevision<=revisionAtStart||record.updatedInTurn!==turnId||record.goalRevision!==goal.revision)throw new Error("Goal-bound Turn must update its Work Record before handoff");const output=this.#goalTurnOutput(raw,binding);assertHandoff(output.handoff);this.#validateCeoHandoff(agent,turnId,output);const outgoingMail=output.mail.map((draft)=>({id:randomUUID(),to:draft.to,from:agent,level:draft.level,body:draft.body,readAt:null}));const next=output.nextWakeAt?this.#futureTime(output.nextWakeAt,this.ledger.turn(turnId)!.startedAt):null;const schedule=next?{id:`schedule:${agent}:${goal.id}`,agent,nextWakeAt:next,reason:"handoff.next_steps",setBy:agent,goalId:goal.id,goalRevision:goal.revision}:null;const now=this.#now();const item:TurnItemSnapshot={id:randomUUID(),turnId,ordinal:this.ledger.turnItems(turnId).length+1,type:"handoff",status:"completed",data:output.handoff as unknown as JsonValue,createdAt:now,completedAt:now};const handoffEvent=this.ledger.commitHandoff({agent,turnId,sourceWakeId,mailIds,ts:now,output:{...output,nextWakeAt:next},outgoingMail,schedule,item});if(this.#role(agent)!=="ceo"&&handoffTriggersCeo(output.handoff)){const root=this.#activeRoot();if(root)this.#enqueueTrigger("ceo",`child-handoff:${handoffEvent.seq}`,{goalId:root.id,goalRevision:root.revision});}}

  #validateCeoHandoff(agent:string, turnId:string, output: TurnOutput): void {
    if (this.#role(agent) !== "ceo") return;
    const idle = this.teamList().filter((member) => member.agent !== "ceo" && member.status === "idle_unplanned");
    const missingObservationGoalIds = this.ledger.goals().filter((goal) => goal.parentId !== null && goal.phase !== "complete" && goal.observationMethod === null).map((goal) => goal.id);
    const activeRoot = this.#hasActiveRoot();
    const hasChildMotion = this.teamList().some((member) => member.agent !== "ceo" && !["idle_unplanned", "retired"].includes(member.status));
    const hasReview = Boolean(output.nextWakeAt);
    const hasBlocker = handoffBlocked(output.handoff);
    const asksHuman = output.mail.some((mail) => mail.to === "human" && (mail.level === "decision" || mail.level === "emergency"))
      || this.ledger.unreadMail("human").some((mail) => mail.from === "ceo" && (mail.level === "decision" || mail.level === "emergency"));
    if (idle.length === 0 && missingObservationGoalIds.length === 0 && (!activeRoot || hasChildMotion || hasReview || hasBlocker || asksHuman)) return;
    const violation = {
      idleAgents: idle.map((member) => member.agent),
      missingObservationGoalIds,
      reason: missingObservationGoalIds.length ? "active child goal has no observation method" : idle.length ? "active child goal has no liveness route" : "active root has no motion, review, wait, blocker, or human request",
    };
    this.ledger.appendEvent({ streamId: `turn:${turnId}`, ts: this.#now(), actor: "supervisor", type: "ceo.motion_invalid", data: violation, ignorable:true });
    throw new Error(`CEO motion invalid: ${violation.reason}${violation.idleAgents.length ? ` (${violation.idleAgents.join(", ")})` : ""}`);
  }

  #goalTurnOutput(output: TurnOutput, binding: NonNullable<TurnContext["goalBinding"]>): TurnOutput {
    const record = this.ledger.workRecord(binding.goalId);
    if (!record) throw new Error("Goal Work Record is missing");
    const legacy = "goalId" in output.handoff ? null : output.handoff;
    const handoff: GoalHandoff = {
      goalId: binding.goalId,
      goalRevision: binding.goalRevision,
      recordRevision: record.recordRevision,
      outcome: "goalId" in output.handoff ? output.handoff.outcome : legacy?.blocker ? "blocked" : legacy?.material ? "completion_proposed" : "progress",
      evidence: "goalId" in output.handoff && output.handoff.evidence.length ? output.handoff.evidence : record.evidence,
    };
    return { ...output, handoff };
  }

  #turnContext(wake: WakeSnapshot): TurnContext {
    const mailId=wake.triggerRef.startsWith("mail:")?wake.triggerRef.slice(5).split("@redelivery:")[0]:null;const humanMail = mailId!==null&&this.ledger.mailbox().some((mail) => mail.id === mailId && mail.from === "human");
    const goal=wake.goalId?this.#goal(wake.goalId):null;
    return { source: humanMail ? { kind: "human" } : goal?{kind:"goal",round:(this.ledger.workRecord(goal.id)?.recordRevision??0)+1}:{kind:"system",reason:wake.triggerRef}, ...(goal?{goalBinding:{goalId:goal.id,goalRevision:goal.revision}}:{}) };
  }

  #loadContext(wake: WakeSnapshot, turn: TurnContext): JsonValue {
    const profile = this.#profiles.get(wake.agent) ?? { agent: wake.agent, role: "child" as const };
    const role = profile.role;
    const capabilities = profile.capabilities ?? defaultCapabilities(role);
    const runnerProfile = this.#runnerProfiles.get(profile.runnerProfile ?? "default");
    const goals = role === "ceo" ? this.ledger.goals() : this.ledger.goalsForOwner(wake.agent);
    const mail = this.ledger.unreadMail(wake.agent);
    const handoff = this.ledger.lastEvent(wake.agent, "handoff.recorded");
    const recoveryId = wake.triggerRef.startsWith("recovery:")
      ? wake.triggerRef.slice("recovery:".length).split(":")[0]
      : wake.triggerRef.startsWith("retry:") ? wake.triggerRef.slice("retry:".length).split("@")[0] : null;
    const recoveryEvents = recoveryId ? selectRecoveryEvents(this.ledger.turn(recoveryId)?this.ledger.readStream(`turn:${recoveryId}`):this.ledger.eventsForWake(recoveryId)) : [];
    const teamHandoffs = role === "ceo"
      ? [...this.ledger.eventsSince(0, ["handoff.recorded"])].reverse().filter((event, index, all) => all.findIndex((candidate) => candidate.actor === event.actor) === index)
      : [];
    const actions = this.ledger.actions().filter((action) => action.agent === wake.agent && (action.status === "unknown" || Boolean(action.auditAdvice && !action.adviceAcked)));
    const revisionWarnings = goals.flatMap((goal) => this.#goalRevisionWarning(goal));
    const workingMemory = selectWorkingMemory(this.ledger.readStream(memoryStream(wake.agent)), this.#memoryTailChars);
    const active = composeActiveContext({ role, capabilities, systemPrompt: profile.systemPrompt ?? defaultRolePrompt(role), wake, goals, mail, actions, lastHandoff: handoff, teamHandoffs, team: role === "ceo" ? this.teamList() : [], revisionWarnings, recoveryEvents, workingMemory });
    const records = this.ledger.workRecords();
    const currentRecord = turn.goalBinding ? this.ledger.workRecord(turn.goalBinding.goalId) : null;
    const currentGoal = turn.goalBinding ? this.ledger.goal(turn.goalBinding.goalId) : null;
    const parentRecord = currentGoal?.parentId ? this.ledger.workRecord(currentGoal.parentId) : null;
    const recordIndex = records.map((record) => `- /goals/${record.goalId}.md · r${record.recordRevision} · ${this.ledger.goal(record.goalId)?.owner ?? "unknown"} · ${this.ledger.goal(record.goalId)?.phase ?? "unknown"}`);
    const workText = [`# Shared Work Record Index\n\n${recordIndex.join("\n")}`, ...(currentRecord ? [`# Your Work Record\n\n${currentRecord.content}`] : []), ...(parentRecord ? [`# Parent Work Record\n\n${parentRecord.content}`] : [])].join("\n\n");
    return { ...active, text: `${active.text}\n\n${workText}`, sourceSeqs: [...new Set([...active.sourceSeqs, ...records.map((record) => record.lastEventSeq)])].sort((a, b) => a - b), workRecord: currentRecord, sharedWorkRecords: records, ...(runnerProfile ? { runnerProfile } : {}) } as unknown as JsonValue;
  }

  #requiredConnector(name: string): ConnectorProcessSpec { const value = this.#connectors.get(name); if (!value) throw new Error(`connector not registered: ${name}`); return value; }
  #wake(id: string): WakeSnapshot { const value = this.ledger.wake(id); if (!value) throw new Error(`wake not found: ${id}`); return value; }
  #action(id: string): ActionSnapshot { const value = this.ledger.action(id); if (!value) throw new Error(`action not found: ${id}`); return value; }
  #goal(id: string): GoalSnapshot { const value = this.ledger.goal(id); if (!value) throw new Error(`goal not found: ${id}`); return value; }
  #goalRevisionWarning(goal: GoalSnapshot): string[] {
    if (goal.parentId === null || goal.phase === "complete") return [];
    let root = this.#goal(goal.parentId);
    while (root.parentId !== null) root = this.#goal(root.parentId);
    const rootSeq = this.ledger.readStream(goalStream(root.id)).filter((event) => event.type === "goal.changed").at(-1)?.seq ?? 0;
    const goalSeq = this.ledger.readStream(goalStream(goal.id)).filter((event) => event.type === "goal.changed").at(-1)?.seq ?? 0;
    return rootSeq > goalSeq ? [`Goal ${goal.id} predates root revision ${root.revision}; CEO must revise its objective/observation method before new gated actions.`] : [];
  }
  #assertAgentGoalsCurrent(agent: string): void {
    const warnings = this.ledger.goalsForOwner(agent).flatMap((goal) => this.#goalRevisionWarning(goal));
    if (warnings.length) throw new Error(warnings.join(" "));
  }
  #now(): string { return this.clock.now().toISOString(); }
  #futureTime(value:string,after:string):string{const parsed=Date.parse(value);if(!Number.isFinite(parsed)||parsed<=Date.parse(after))throw new Error("nextWakeAt must be later than the Turn start");return new Date(parsed).toISOString();}
  #runnerProfileId(agent:string):string{return this.#profiles.get(agent)?.runnerProfile??"default";}

  async #agentRpcForTurn(turnId: string, agent: string, context: TurnContext, method: AgentCapability, params: JsonValue, sourceWakeId?:string): Promise<JsonValue> {
    const execution = this.ledger.turn(turnId); if (!execution || execution.status !== "in_progress" || !execution.leaseToken || !execution.leaseUntil || execution.leaseUntil < this.#now()) throw new Error("stale Turn RPC rejected");
    const profile = this.#profiles.get(agent) ?? { agent, role: "child" as const }; const allowed = new Set(profile.capabilities ?? defaultCapabilities(profile.role)); if (!allowed.has(method)) throw new Error(`${profile.role} agent is not allowed to call ${method}`);
    if (!context.goalBinding && goalBoundCapability(method)) throw new Error(`${method} requires a Goal-bound Turn`);
    this.ledger.appendEvent({ streamId: `turn:${turnId}`, ts: this.#now(), actor: agent, type: `rpc.${method}`, data: params, ignorable:true }); const input = asRecord(params);
    if (method === "ledger.search") return this.ledger.searchEvents(String(input.query), Number(input.limit ?? 20)) as unknown as JsonValue;
    if (method === "team.list") return this.teamList() as unknown as JsonValue;
    if (method === "goal.get") return (context.goalBinding ? this.ledger.goal(context.goalBinding.goalId) : null) as unknown as JsonValue;
    if (method === "goal.create") {
      if (context.source.kind !== "human" || context.goalBinding || agent !== "ceo") throw new Error("Root Goal creation requires an unbound CEO Human Turn"); const goal = this.createRootGoal(String(input.objective), typeof input.id === "string" ? input.id : undefined,turnId); context.goalBinding = { goalId: goal.id, goalRevision: goal.revision }; this.ledger.putTurn({ ...this.ledger.turn(turnId)!, goalId: goal.id, goalRevision: goal.revision }, "supervisor"); return { goal, goalBinding: context.goalBinding } as unknown as JsonValue;
    }
    if (method === "goal.work") { if(context.source.kind!=="human"||context.goalBinding)throw new Error("work_on_goal requires an unbound Human Turn");const goal = this.#goal(String(input.goalId)); if (goal.owner !== agent || goal.phase !== "active") throw new Error("work_on_goal requires an active owned Goal"); context.goalBinding = { goalId: goal.id, goalRevision: goal.revision }; this.ledger.putTurn({ ...this.ledger.turn(turnId)!, goalId: goal.id, goalRevision: goal.revision }, "supervisor"); return { goal, goalBinding: context.goalBinding } as unknown as JsonValue; }
    if (method === "work_record.list") return this.ledger.workRecords() as unknown as JsonValue;
    if (method === "work_record.read") return this.ledger.workRecord(String(input.goalId ?? context.goalBinding?.goalId ?? "")) as unknown as JsonValue;
    if (method === "work_record.history") return this.ledger.workRecordHistory(String(input.goalId ?? context.goalBinding?.goalId ?? "")) as unknown as JsonValue;
    if (method === "work_record.diff") return this.ledger.workRecordDiff(String(input.goalId ?? context.goalBinding?.goalId ?? ""), Number(input.fromRevision), Number(input.toRevision)) as unknown as JsonValue;
    if (method === "work_record.search") return this.ledger.searchWorkRecords(String(input.query), Number(input.limit ?? 20)) as unknown as JsonValue;
    if (method === "work_record.update") { const binding = context.goalBinding!; return this.ledger.updateWorkRecord({ goalId: binding.goalId, goalRevision: binding.goalRevision, expectedRevision: Number(input.expectedRevision), content: String(input.content), reason: String(input.reason), evidence: numberArray(input.evidence), turnId, ...(sourceWakeId?{sourceWakeId}:{}) }, agent) as unknown as JsonValue; }
    if (method === "goal.delegate") {const binding=context.goalBinding!;if(String(input.parentGoalId)!==binding.goalId)throw new Error("delegation parent must be the Goal bound to this Turn");return this.delegate({ id:String(input.id),parentGoalId:binding.goalId,expectedParentRevision:Number(input.expectedParentRevision),childGoal:asChildGoal(input.childGoal),brief:(input.brief??null) as JsonValue,reason:String(input.reason),evidence:numberArray(input.evidence),sourceTurnId:turnId },agent,sourceWakeId) as unknown as JsonValue;}
    if (method === "goal.reassign") {const goal=this.#goal(String(input.goalId));if(goal.parentId!==context.goalBinding!.goalId)throw new Error("reassignment target must be a child of the Goal bound to this Turn");return await this.reassignGoal({ id:String(input.id),goalId:goal.id,expectedGoalRevision:Number(input.expectedGoalRevision),newOwner:String(input.newOwner),brief:(input.brief??null) as JsonValue,reason:String(input.reason),evidence:numberArray(input.evidence),sourceTurnId:turnId },agent,sourceWakeId) as unknown as JsonValue;}
    if (method === "goal.revise") return this.reviseChildGoal(String(input.goalId),String(input.objective),String(input.observationMethod),String(input.verificationMethod),agent,String(input.reason),numberArray(input.evidence),sourceWakeId,turnId) as unknown as JsonValue;
    if (method === "goal.pause" || method === "goal.resume") { const goal=this.#goal(String(input.goalId)); const directRoot=!context.goalBinding&&context.source.kind==="human"&&goal.parentId===null; if(!context.goalBinding&&!directRoot) throw new Error(`${method} requires a Goal-bound Turn`); const next=this.transitionGoal(goal.id,method==="goal.pause"?"paused":"active",directRoot?"human":agent,!directRoot,turnId); if(method==="goal.resume"&&directRoot){context.goalBinding={goalId:next.id,goalRevision:next.revision};this.ledger.putTurn({...this.ledger.turn(turnId)!,goalId:next.id,goalRevision:next.revision},"supervisor");return {goal:next,goalBinding:context.goalBinding} as unknown as JsonValue;} return next as unknown as JsonValue; }
    if (method === "goal.complete") { const goal=this.#goal(String(input.goalId)); const directRoot=!context.goalBinding&&context.source.kind==="human"&&goal.parentId===null; if(!context.goalBinding&&!directRoot) throw new Error("goal.complete requires a Goal-bound Turn"); return this.completeGoal({goalId:goal.id,revision:Number(input.revision),reason:String(input.reason),evidence:numberArray(input.evidence),sourceTurnId:turnId},directRoot?"human":agent,sourceWakeId) as unknown as JsonValue; }
    if (method === "mail.send") { const mail: MailSnapshot = { id:randomUUID(),to:String(input.to),from:agent,level:String(input.level) as MailSnapshot["level"],body:(input.body??null) as JsonValue,readAt:null }; this.ledger.putMail(mail,agent,sourceWakeId); return mail as unknown as JsonValue; }
    if (method === "human.request") { const evidence=numberArray(input.evidence);if(!evidence.length)throw new Error("evidence is required");for(const seq of evidence)if(!this.ledger.eventsSince(seq-1).some((event)=>event.seq===seq))throw new Error(`evidence event does not exist: ${seq}`);const mail: MailSnapshot = { id:randomUUID(),to:"human",from:agent,level:"decision",body:{ type:String(input.type),message:input.message??null,evidence },readAt:null }; this.ledger.putMail(mail,agent,sourceWakeId); return mail as unknown as JsonValue; }
    if (method === "schedule.set") return (this.planWake(agent,String(input.at),String(input.reason),agent,context.goalBinding)??{scheduled:true}) as unknown as JsonValue;
    if (method === "audit.ack") return this.ackAuditAdvice(String(input.actionId),agent) as unknown as JsonValue;
    if (method === "audit.write") return this.putAuditAdvice(String(input.actionId),{by:agent,body:(input.body??null) as JsonValue,evidence:numberArray(input.evidence)}) as unknown as JsonValue;
    if (method === "goal.put") {const next=input.goal as unknown as GoalSnapshot;const current=this.ledger.goal(next.id);const operation=!current?"create":current.phase!==next.phase?(next.phase==="paused"?"pause":next.phase==="active"?"resume":next.phase==="blocked"?"block":"complete"):current.owner!==next.owner?"reassign":"revise";this.ledger.putGoal(next,agent,sourceWakeId,{operation,reason:String(input.reason??"Advanced Goal mutation"),evidence:numberArray(input.evidence??[]),sourceTurnId:turnId,...(sourceWakeId?{sourceWakeId}:{})}); return input.goal as JsonValue; }
    if (method === "memory.append") { const note=String(input.note??"").trim(); if(!note) throw new Error("memory note cannot be empty"); const event=this.ledger.appendEvent({streamId:memoryStream(agent),ts:this.#now(),actor:agent,type:"memory.appended",data:{note,turnId}}); return {seq:event.seq} as unknown as JsonValue; }
    const action=await this.submitAction({id:String(input.id),agent,createdInTurn:turnId,kind:String(input.kind),payload:(input.payload??null) as JsonValue,reason:String(input.reason),evidence:numberArray(input.evidence),auditAdvice:null,adviceAcked:false},String(input.connector),sourceWakeId); return action as unknown as JsonValue;
  }

  async #collectMetrics(): Promise<void> {
    const now = this.clock.now().getTime();
    for (const registration of this.#metricCollectors.values()) {
      if (registration.nextAt > now) continue;
      registration.nextAt = now + registration.intervalMs;
      const sample = await runJsonProcess<MetricSample>(registration.spec, { goalId: registration.goalId });
      this.recordMetric({ ...sample, goalId: registration.goalId });
    }
  }

  #scheduleMetricAlerts(): void {
    for (const [goalId, contract] of this.#metricContracts) {
      const goal = this.ledger.goal(goalId);
      if (!goal) continue;
      const samples = this.ledger.metricSamples(goal.id);
      const evaluation = evaluateMetric(contract, samples, this.#now());
      if (evaluation.shouldWakeOwner) this.#enqueueTrigger(goal.owner, `metric:${goal.id}:${evaluation.status}:${samples.at(-1)?.observedAt ?? "none"}`,{goalId:goal.id,goalRevision:goal.revision});
    }
  }

  /** The one mechanical floor: total ledger silence. Any event from anyone resets the clock; stall policy is the CEO's business, not the supervisor's. */
  #checkSystemSilence(): void {
    if (!this.#silence) return;
    const last = this.ledger.latestEvent();
    if (!last) return;
    const silentMs = this.clock.now().getTime() - Date.parse(last.ts);
    if (silentMs <= this.#silence.maxSilentMs) return;
    const fact = { silentMs, lastEventSeq: last.seq, lastEventAt: last.ts };
    this.ledger.appendEvent({ streamId: controlStream("watchdog"), ts: this.#now(), actor: "supervisor", type: "watchdog.system_silence", data: { ...fact, notify: this.#silence.notify } });
    const root=this.#activeRoot();this.ledger.putMail({ id: `silence:${last.seq}`, to: this.#silence.notify, from: "supervisor", level: "decision", readAt: null, body: { type: "system_silence", ...fact,...(root?{goalId:root.id}:{}), note: "No ledger events system-wide within the silence window. Confirm this is expected and hand off." } }, "supervisor");
  }
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
    const activeWake = agentWakes.find((wake) => wake.status==="claimed"||wake.status==="queued");
    const threadIds=new Set(threads.filter((thread)=>thread.agent===agent).map((thread)=>thread.id));const activeTurn=turns.find((turn)=>threadIds.has(turn.threadId)&&turn.status==="in_progress");
    const nextWakeAt = schedules.filter((schedule) => schedule.agent === agent && schedule.nextWakeAt > now).map((schedule) => schedule.nextWakeAt).sort()[0] ?? null;
    const lastHandoff = [...handoffs].reverse().find((event) => event.actor === agent) ?? null;
    const blocker = lastHandoff && typeof lastHandoff.data === "object" && lastHandoff.data !== null && !Array.isArray(lastHandoff.data)
      ? ((lastHandoff.data as Record<string, JsonValue>).blocker ?? ((lastHandoff.data as Record<string, JsonValue>).outcome === "blocked" ? "blocked" : null))
      : null;
    let status: TeamMemberView["status"];
    if (live.length === 0) status = "retired";
    else if (activeTurn) status = "running";
    else if (activeWake) status = "queued";
    else if (nextWakeAt) status = "scheduled";
    else if (live.every((goal) => goal.phase === "blocked")) status = "blocked";
    else if (live.every((goal) => goal.phase === "paused") || typeof blocker === "string" && blocker.length > 0) status = "waiting";
    else status = "idle_unplanned";
    return { agent, goalIds: owned.map((goal) => goal.id), status, lastHandoffSeq: lastHandoff?.seq ?? null, lastWakeStatus: agentWakes[0]?.status ?? null, nextWakeAt };
  });
}

export function renderDashboard(ledger: Ledger): string {
  const rows = (values: unknown[]) => values.map((value) => `<tr><td><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>goah status</title><style>body{font:14px ui-monospace;margin:32px;background:#101418;color:#dce3e4}section{margin:32px 0}pre{white-space:pre-wrap;border:1px solid #334;padding:12px}</style></head><body><h1>goah</h1><p>seq ${ledger.events().at(-1)?.seq ?? 0}</p><section><h2>Team</h2><table>${rows(deriveTeam(ledger))}</table></section><section><h2>Goals</h2><table>${rows(ledger.goals())}</table></section><section><h2>Wakes</h2><table>${rows(ledger.wakes())}</table></section><section><h2>Actions</h2><table>${rows(ledger.actions())}</table></section><section><h2>Mailbox</h2><table>${rows(ledger.mailbox())}</table></section></body></html>`;
}

async function runConnector<T>(spec: ConnectorProcessSpec, operation: "dispatch" | "query", action: ActionSnapshot): Promise<T> {
  return runJsonProcess<T>(spec, { operation, action });
}

async function runJsonProcess<T>(spec: MetricProcessSpec | ConnectorProcessSpec, input: unknown): Promise<T> {
  const child = spawn(spec.command, spec.args, { detached: process.platform !== "win32", env: minimalEnvironment(spec.env), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let outputOverflow=false;const append=(channel:"stdout"|"stderr",chunk:Buffer)=>{const text=chunk.toString();const remaining=Math.max(0,1_000_000-stdout.length-stderr.length);if(channel==="stdout")stdout+=text.slice(0,remaining);else stderr+=text.slice(0,remaining);if(text.length>remaining&&!outputOverflow){outputOverflow=true;void terminateChild(child,500);}};child.stdout.on("data",(chunk:Buffer)=>append("stdout",chunk));child.stderr.on("data",(chunk:Buffer)=>append("stderr",chunk));
  child.stdin.end(`${JSON.stringify(input)}\n`);
  const timeoutMs = spec.timeoutMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  timer = setTimeout(() => { void terminateChild(child, 500); }, timeoutMs);
  let result:{code:number|null;signal:NodeJS.Signals|null};
  try{result=await exit;}finally{clearTimeout(timer);}
  if(outputOverflow)throw new Error("connector or metric output exceeded 1 MB");
  if (result.code !== 0) throw new Error(stderr.trim() || `connector exited (${result.code ?? result.signal})`);
  return JSON.parse(stdout.trim()) as T;
}

async function terminateChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  signalPid(child.pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (child.exitCode === null && child.signalCode === null) signalPid(child.pid, "SIGKILL");
}
function signalPid(pid: number, signal: NodeJS.Signals): void { try { process.kill(process.platform === "win32" ? pid : -pid, signal); } catch {} }
function minimalEnvironment(explicit: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...explicit };
}
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }
function messageTextContent(content: unknown): string { if (typeof content === "string") return content; if (!Array.isArray(content)) return ""; return content.map((part) => part && typeof part === "object" && !Array.isArray(part) && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : "").filter(Boolean).join("\n"); }
function handoffBlocked(handoff: Handoff): boolean { return "goalId" in handoff ? handoff.outcome === "blocked" : Boolean(handoff.blocker); }
function handoffTriggersCeo(handoff: Handoff): boolean { return "goalId" in handoff ? handoff.outcome === "blocked" || handoff.outcome === "completion_proposed" : Boolean(handoff.material || handoff.blocker); }
function goalBoundCapability(method: AgentCapability): boolean { return ["goal.delegate", "goal.reassign", "goal.revise", "goal.put", "work_record.update", "mail.send", "schedule.set", "human.request"].includes(method); }
function asRecord(value: JsonValue): Record<string, JsonValue> { if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("RPC params must be an object"); return value; }
function numberArray(value: JsonValue | undefined): number[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "number")) throw new Error("RPC evidence must be a number array"); return value as number[]; }
function asChildGoal(value: JsonValue | undefined): { id: string; objective: string; observationMethod: string; verificationMethod: string; owner: string } {
  const input = asRecord(value ?? null);
  return { id: String(input.id), objective: String(input.objective), observationMethod: String(input.observationMethod), verificationMethod: String(input.verificationMethod), owner: String(input.owner) };
}
function defaultCapabilities(role: AgentRole): AgentCapability[] {
  if (role === "ceo") return ["ledger.search", "mail.send", "schedule.set", "action.submit", "audit.ack", "team.list", "goal.get", "goal.create", "goal.work", "goal.delegate", "goal.reassign", "goal.revise", "goal.pause", "goal.resume", "goal.complete", "human.request", "work_record.list", "work_record.read", "work_record.history", "work_record.diff", "work_record.search", "work_record.update"];
  if (role === "verifier") return ["ledger.search", "mail.send", "memory.append", "audit.write"];
  if (role === "audit") return ["ledger.search", "mail.send", "memory.append", "audit.write"];
  return ["ledger.search", "mail.send", "schedule.set", "action.submit", "audit.ack", "goal.get", "work_record.list", "work_record.read", "work_record.history", "work_record.diff", "work_record.search", "work_record.update"];
}

export * from "./verification.js";
export * from "./roles.js";
