import { type EventInput, type EventRecord, type EventStore, type JsonValue } from "./kernel.js";

export type WakeStatus = "queued" | "claimed" | "consumed" | "cancelled";
export type WakeTriggerStatus = "pending" | "resolved";
export type ScheduleStatus = "pending" | "consumed" | "cancelled" | "superseded";
export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export type TurnStatus = "in_progress" | "completed" | "failed" | "interrupted";
export type TurnTriggerKind = "user_message" | "wake";
export type SpecialistRole = "verifier" | "audit";
export type AgentRole = "child" | "ceo" | "verifier" | "audit";
export type AutomaticTarget =
  | { targetKind: "goal"; agent: string; goalId: string; specialistRole: null }
  | { targetKind: "specialist"; agent: string; goalId: null; specialistRole: SpecialistRole };
export type MailRoute =
  | { routeKind: "goal"; goalId: string; specialistRole: null }
  | { routeKind: "human_inbox"; goalId: null; specialistRole: null }
  | { routeKind: "human_request"; goalId: null; specialistRole: null }
  | { routeKind: "specialist_inbox"; goalId: null; specialistRole: SpecialistRole };
export function goalAutomaticTarget(agent: string, goalId: string): Extract<AutomaticTarget, { targetKind: "goal" }> {
  return { targetKind: "goal", agent, goalId, specialistRole: null };
}
export function specialistAutomaticTarget(agent: string, role: SpecialistRole): Extract<AutomaticTarget, { targetKind: "specialist" }> {
  return { targetKind: "specialist", agent, goalId: null, specialistRole: role };
}
export function goalRoute(goalId:string):Extract<MailRoute,{routeKind:"goal"}>{return{routeKind:"goal",goalId,specialistRole:null};}
export function humanInboxRoute():Extract<MailRoute,{routeKind:"human_inbox"}>{return{routeKind:"human_inbox",goalId:null,specialistRole:null};}
export function humanRequestRoute():Extract<MailRoute,{routeKind:"human_request"}>{return{routeKind:"human_request",goalId:null,specialistRole:null};}
export function specialistInboxRoute(role:SpecialistRole):Extract<MailRoute,{routeKind:"specialist_inbox"}>{return{routeKind:"specialist_inbox",goalId:null,specialistRole:role};}
export type TurnItemType = "user_message" | "assistant_message" | "reasoning" | "tool_call" | "tool_result" | "plan" | "handoff";
export type TurnItemStatus = "in_progress" | "completed" | "failed";
export interface ThreadSnapshot { id: string; agent: string; role: AgentRole; parentThreadId: string | null; createdAt: string; updatedAt: string }
export interface GoalCommitment { goalId: string; goalRevision: number }
export function noGoalCommitment(): { goalId: null; goalRevision: null } { return { goalId: null, goalRevision: null }; }
export function goalCommitment(goalId: string, goalRevision: number): GoalCommitment { return { goalId, goalRevision }; }
export type TurnSnapshot = {
  id: string;
  threadId: string;
  triggerKind: TurnTriggerKind;
  goalId: string | null;
  goalRevision: number | null;
  status: TurnStatus;
  attempt: number;
  error: JsonValue | null;
  startedAt: string;
  endedAt: string | null;
  leaseUntil: string | null;
  leaseToken: string | null;
  runnerPid: number | null;
  runnerProfileId?: string;
};
export interface TurnItemSnapshot { id: string; turnId: string; ordinal: number; type: TurnItemType; status: TurnItemStatus; data: JsonValue; createdAt: string; completedAt: string | null }
export interface GoalSnapshot { id: string; parentId: string | null; objective: string; observationMethod: string | null; verificationMethod: string | null; owner: string; phase: GoalPhase; revision: number }
export type GoalChangeOperation="create"|"revise"|"pause"|"resume"|"block"|"complete"|"reassign";
export type GoalChangeAuthority={kind:"human"}|{kind:"parent_goal";goalId:string;goalRevision:number}|{kind:"system";reason:string};
export interface GoalChangeMetadata {operation:GoalChangeOperation;reason:string;evidence:number[];authority?:GoalChangeAuthority;sourceTurnId?:string;sourceWakeId?:string;idempotencyKey?:string}
export interface GoalChangedData extends GoalChangeMetadata {version:1;previousRevision:number|null;snapshot:GoalSnapshot;authority:GoalChangeAuthority}
export interface WorkRecordSnapshot {
  goalId: string;
  recordRevision: number;
  goalRevision: number;
  content: string;
  updatedBy: string;
  updatedInTurn: string;
  sourceWakeId: string | null;
  updatedAt: string;
  reason: string;
  evidence: number[];
  lastEventSeq: number;
}
export interface WorkRecordUpdateRequest {
  goalId: string;
  expectedRevision: number;
  goalRevision: number;
  content: string;
  reason: string;
  evidence: number[];
  turnId: string;
  sourceWakeId?: string;
}
export interface WorkRecordDiff { goalId: string; fromRevision: number; toRevision: number; text: string }
export type ScheduleSnapshot = AutomaticTarget & { id: string; nextWakeAt: string; reason: string; setBy: string; status: ScheduleStatus; resolvedAt: string | null };
export type WakeSnapshot = AutomaticTarget & {
  id: string;
  /** Initial trigger retained for display and provenance. Runtime decisions use WakeTriggerSnapshot. */
  triggerRef: string;
  status: WakeStatus;
  attempt: number;
  enqueuedSeq: number;
  claimedAt: string | null;
  consumedAt: string | null;
  turnId: string | null;
};
export interface WakeTriggerSnapshot { wakeId: string; agent: string; triggerRef: string; source: "goal" | "system"; status: WakeTriggerStatus; addedAt: string; resolvedAt: string | null }
export type MailLevel = "fyi" | "decision" | "emergency";
export type MailSnapshot = MailRoute & { id: string; to: string; from: string; level: MailLevel; body: JsonValue; readAt: string | null };
export interface DelegationRequest {
  id: string;
  parentGoalId: string;
  expectedParentRevision: number;
  childGoal: { id: string; objective: string; observationMethod: string; verificationMethod: string; owner: string };
  brief: JsonValue;
  reason: string;
  evidence: number[];
  sourceTurnId?:string;
}
export interface DelegationResult { delegationId: string; goal: GoalSnapshot; mail: MailSnapshot; wake: WakeSnapshot }
export interface ReassignmentRequest {
  id: string;
  goalId: string;
  expectedGoalRevision: number;
  newOwner: string;
  brief: JsonValue;
  reason: string;
  evidence: number[];
  sourceTurnId?:string;
}
export interface ReassignmentResult { reassignmentId: string; goal: GoalSnapshot; mail: MailSnapshot[]; wake: WakeSnapshot | null }
export interface GoalCompletionRequest { goalId: string; revision: number; reason: string; evidence: number[];sourceTurnId?:string }
export type TeamMemberMotion = "running" | "queued" | "scheduled" | "idle" | "retired";
export interface TeamMemberView {
  agent: string;
  goalIds: string[];
  motion: TeamMemberMotion;
  lastOutcome: GoalOutcome | null;
  lastHandoffSeq: number | null;
  lastWakeStatus: WakeStatus | null;
  nextWakeAt: string | null;
}
export type GoalOutcome = "progress" | "waiting" | "blocked" | "completion_proposed";
export interface AgentHandoff { outcome: GoalOutcome; evidence: number[] }
export interface GoalHandoff extends AgentHandoff { goalId: string; goalRevision: number; recordRevision: number }
export type Handoff = GoalHandoff;
export interface HandoffValidationIssue { code:string;message:string;details?:JsonValue }
export type HandoffValidationResult=
  | {accepted:true;fatal:false;attemptId:number;token:string;goalId:string;goalRevision:number;messageItemId:string}
  | {accepted:false;fatal:boolean;attemptId:number;issues:HandoffValidationIssue[]};
export interface HandoffValidationRequest {handoff:AgentHandoff;candidateMessageId:string;candidateMessage:string}
export interface TurnOutput { validationAttemptId:number;validationToken:string;handoff: AgentHandoff }
export interface CommittedTurnOutput { handoff: GoalHandoff }
export interface RunnerTraceEvent { type: string; data: JsonValue }
export type AssistantLiveDelta =
  | {type:"start"|"text_start"|"text_end"|"thinking_start"|"thinking_end"|"toolcall_start"|"toolcall_end";contentIndex?:number}
  | {type:"text_delta"|"thinking_delta"|"toolcall_delta";contentIndex:number;delta:string};
export interface RunnerLiveEvent {type:"message.assistant.delta";data:{messageId:string;delta:AssistantLiveDelta}}
export interface TurnLiveSnapshot {revision:number;messageId:string;text:string;thinking:string;thinkingActive:boolean}

export type AgentCapability = "ledger.search" | "mail.send" | "schedule.set" | "goal.put"
  | "team.list" | "goal.get" | "goal.create" | "goal.work" | "goal.delegate" | "goal.reassign" | "goal.revise" | "goal.pause" | "goal.resume" | "goal.complete" | "human.request"
  | "work_record.list" | "work_record.read" | "work_record.history" | "work_record.diff" | "work_record.search" | "work_record.update"
  | "memory.append";
export type RunnerControlMethod="goal.handoff.validate";
export type RunnerRpcMethod=AgentCapability|RunnerControlMethod;
export interface RunnerProfile { id: string; runner: string; config: JsonValue; credentialRefs?: string[] }
export interface AgentProfile { agent: string; role: AgentRole; capabilities?: AgentCapability[]; systemPrompt?: string; runnerProfile?: string }
export interface RunnerChoice { value: string; label: string; description?: string }
export interface RunnerSetupProgress { current: number; total: number }
export interface RunnerSetupInteraction {
  select(input: { title: string; description?: string; choices: RunnerChoice[]; progress?: RunnerSetupProgress }): Promise<string | null>;
  input(input: { title: string; description?: string; prompt: string; initial?: string; secret?: boolean; progress?: RunnerSetupProgress }): Promise<string | null>;
  notify(message: string): void;
  openUrl?(url: string): void;
}
export interface RunnerManifest { id: string; name: string; description: string; commands?: Array<{ name: string; description: string }> }
export interface RunnerDiagnostic { ok: boolean; name: string; detail: string; severity?: "warning" | "error" }
export interface RunnerCommandResult { config?: JsonValue; output: string[]; rollback?(): Promise<void> }
export interface RunnerSetupTransaction { config: JsonValue | null; commit(): Promise<JsonValue | null>; rollback(): Promise<void> }
export interface RunnerConfigurator {
  describe(): RunnerManifest;
  setup(current: JsonValue | null, interaction: RunnerSetupInteraction): Promise<JsonValue | null>;
  beginSetup?(current: JsonValue | null, interaction: RunnerSetupInteraction): Promise<RunnerSetupTransaction>;
  doctor(config: JsonValue, context?: { root: string }): Promise<RunnerDiagnostic[]>;
  summarize?(config: JsonValue): Array<{ label: string; value: string }>;
  runCommand?(command: string, args: string[], config: JsonValue, interaction: RunnerSetupInteraction): Promise<RunnerCommandResult>;
}
export type TurnTrigger = { kind: "user_message" } | { kind: "wake"; reasons: string[] };
export interface TurnContext { trigger: TurnTrigger; activeGoal: GoalSnapshot | null; goalCommitment: GoalCommitment | null }
/** Canonical user-visible assistant prose. Raw provider events remain unchanged. */
export function normalizeAssistantText(text: string): string { return text.replace(/\r\n?/g, "\n").trim(); }
export interface RunRequest { agent: string; execution: TurnSnapshot; sourceWake?: WakeSnapshot; sourceWakeTriggers?: WakeTriggerSnapshot[]; turn: TurnContext; context: JsonValue; now(): string; emit(event: RunnerTraceEvent): void; emitLive?(event:RunnerLiveEvent):void; rpc?(method: RunnerRpcMethod, params: JsonValue): Promise<JsonValue> }
export type RunnerCandidateResult = { outcome: "completed"; finalMessageId: string; handoff?: TurnOutput } | { outcome: "abnormal"; reason: string };
export interface RunnerHandle { pid: number | null; begin(): void; result: Promise<RunnerCandidateResult>; steer?(message: string): Promise<void>; terminate(): Promise<void> }
export interface Runner { readonly isolation: "process"; prepare(request: RunRequest): RunnerHandle; terminateProcess(pid: number, runnerProfileId?: string): Promise<void> }

export interface HandoffCommit { agent: string; turnId: string; sourceWakeId: string | null; mailIds: string[]; ts: string; output: CommittedTurnOutput; responseItemId:string;item: TurnItemSnapshot }
export interface HumanTurnAdmissionRequest { thread:ThreadSnapshot;turn:TurnSnapshot;messageItem:TurnItemSnapshot;replaceTurnId:string|null;rootGoal?:GoalSnapshot }
export interface HumanTurnAdmissionResult { turn:TurnSnapshot;replacedTurn:TurnSnapshot|null;goal:GoalSnapshot|null }

/** Standard execution modules composed on top of the generic event store. */
export interface Ledger extends EventStore {
  putThread(thread: ThreadSnapshot, actor: string): EventRecord;
  putTurn(turn: TurnSnapshot, actor: string): EventRecord;
  admitHumanTurn(request:HumanTurnAdmissionRequest):HumanTurnAdmissionResult;
  commitTurnToGoal(turnId: string, goal: GoalCommitment, actor: string): TurnSnapshot;
  putTurnItem(item: TurnItemSnapshot, actor: string): EventRecord;
  thread(id: string): ThreadSnapshot | null;
  threads(): ThreadSnapshot[];
  turn(id: string): TurnSnapshot | null;
  turns(threadId?: string): TurnSnapshot[];
  turnItems(turnId: string): TurnItemSnapshot[];
  activeTurn(threadId: string): TurnSnapshot | null;
  putGoal(goal: GoalSnapshot, actor: string, wakeId?: string,change?:GoalChangeMetadata): EventRecord;
  updateWorkRecord(request: WorkRecordUpdateRequest, actor: string): WorkRecordSnapshot;
  commitDelegation(request: DelegationRequest, actor: string, wakeId?: string): DelegationResult;
  commitReassignment(request: ReassignmentRequest, actor: string, wakeId?: string): ReassignmentResult;
  completeGoal(request: GoalCompletionRequest, actor: string, wakeId?: string): GoalSnapshot;
  putSchedule(schedule: ScheduleSnapshot, actor: string, wakeId?: string): EventRecord;
  consumeSchedule(id: string, wake: WakeSnapshot, now: string): { schedule: ScheduleSnapshot; wake: WakeSnapshot };
  cancelSchedule(id: string, now: string): ScheduleSnapshot;
  supersedeSchedule(id: string, now: string): ScheduleSnapshot;
  enqueueWake(wake: WakeSnapshot, actor: string): { event: EventRecord; created: boolean };
  addWakeTrigger(wakeId: string, triggerRef: string, actor: string): WakeTriggerSnapshot;
  claimNextWake(now: string): WakeSnapshot | null;
  startTurnFromWake(id: string, turn: TurnSnapshot, now: string): WakeSnapshot;
  releaseWake(id: string, now: string): WakeSnapshot;
  cancelWake(id: string, now: string): WakeSnapshot;
  attachTurnProcess(id: string, leaseToken: string, pid: number): TurnSnapshot;
  renewTurnLease(id: string, leaseToken: string, leaseUntil: string, now: string): TurnSnapshot;
  appendTurnEvent(input: EventInput, leaseToken: string): EventRecord;
  repairTurnAttempt(id:string,reason:string,now:string,actor:string):TurnItemSnapshot[];
  finishTurn(id:string,status:"failed"|"interrupted",error:JsonValue,now:string,actor:string):TurnSnapshot;
  commitTurnResponse(id:string,responseItemId:string,now:string,actor:string,mailIds?:string[]):TurnSnapshot;
  releaseTurnProcess(id:string,actor:string):TurnSnapshot;
  putMail(mail: MailSnapshot, actor: string, wakeId?: string): EventRecord;
  putMails(mail: MailSnapshot[], actor: string, wakeId?: string): EventRecord[];
  commitHandoff(commit: HandoffCommit): EventRecord;
  dueSchedules(now: string): ScheduleSnapshot[];
  unreadMail(agent: string): MailSnapshot[];
  lastEvent(actor: string, type: string): EventRecord | null;
  lastGoalHandoff(goalId:string):EventRecord|null;
  latestEvent(): EventRecord | null;
  eventsForWake(wakeId: string): EventRecord[];
  wake(id: string): WakeSnapshot | null;
  wakeByTrigger(agent: string, triggerRef: string): WakeSnapshot | null;
  wakeTriggers(wakeId: string): WakeTriggerSnapshot[];
  wakeTriggersForAgent(agent: string): WakeTriggerSnapshot[];
  queuedWakeForAgent(agent: string): WakeSnapshot | null;
  goalsForOwner(owner: string): GoalSnapshot[];
  goal(id: string): GoalSnapshot | null;
  workRecord(goalId: string): WorkRecordSnapshot | null;
  workRecordHistory(goalId: string): WorkRecordSnapshot[];
  workRecordDiff(goalId: string, fromRevision: number, toRevision: number): WorkRecordDiff;
  searchWorkRecords(query: string, limit?: number): WorkRecordSnapshot[];
  triggeringMail(): MailSnapshot[];
  searchEvents(query: string, limit?: number): EventRecord[];
  goals(): GoalSnapshot[];
  workRecords(): WorkRecordSnapshot[];
  schedules(): ScheduleSnapshot[];
  wakes(): WakeSnapshot[];
  mailbox(): MailSnapshot[];
  rebuildProjections(): void;
  close(): void;
}

const wakeTransitions: Record<WakeStatus, readonly WakeStatus[]> = { queued: ["claimed", "cancelled"], claimed: ["queued", "consumed", "cancelled"], consumed: [], cancelled: [] };
const goalTransitions: Record<GoalPhase, readonly GoalPhase[]> = { active: ["paused", "blocked", "complete"], paused: ["active", "complete"], blocked: ["active", "complete"], complete: [] };
export function assertWakeTransition(from: WakeStatus, to: WakeStatus): void { if (!wakeTransitions[from].includes(to)) throw new Error(`invalid wake transition: ${from} -> ${to}`); }
export function assertGoalTransition(from: GoalPhase, to: GoalPhase): void { if (from !== to && !goalTransitions[from].includes(to)) throw new Error(`invalid goal transition: ${from} -> ${to}`); }
export function assertHandoff(value: Handoff): void {
  assertAgentHandoff(value);
  if (!value.goalId.trim() || !Number.isInteger(value.goalRevision) || value.goalRevision<0 || !Number.isInteger(value.recordRevision) || value.recordRevision<1) throw new Error("invalid Goal handoff");
}
export function assertAgentHandoff(value:AgentHandoff):void{if(!["progress", "waiting", "blocked", "completion_proposed"].includes(value.outcome)||!Array.isArray(value.evidence)||value.evidence.length===0)throw new Error("invalid Agent handoff");}
export function assertTurnOutput(value:TurnOutput):void{if(!Number.isInteger(value.validationAttemptId)||value.validationAttemptId<=0||typeof value.validationToken!=="string"||!value.validationToken.trim())throw new Error("committed Turn requires an accepted Handoff validation attempt and token");assertAgentHandoff(value.handoff);}
export function assertGoalSnapshot(value: GoalSnapshot): void {
  if (!value.objective.trim() || !value.owner.trim()) throw new Error("goal objective and owner are required");
  if (value.observationMethod !== null && !value.observationMethod.trim()) throw new Error("goal observation method cannot be blank");
  if (value.verificationMethod !== null && !value.verificationMethod.trim()) throw new Error("goal verification method cannot be blank");
  if (value.parentId !== null && value.observationMethod === null) throw new Error("child goal observation method is required");
  if (value.parentId !== null && value.verificationMethod === null) throw new Error("child goal verification method is required");
  if (!["active", "paused", "blocked", "complete"].includes(value.phase)) throw new Error(`invalid goal phase: ${value.phase}`);
}
