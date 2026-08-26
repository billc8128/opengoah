import { type EventInput, type EventRecord, type EventStore, type JsonValue } from "./kernel.js";

export type WakeStatus = "queued" | "claimed" | "consumed" | "cancelled";
export type WakeTriggerStatus = "pending" | "resolved";
export type ScheduleStatus = "pending" | "consumed" | "cancelled" | "superseded";
export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export type TurnStatus = "in_progress" | "completed" | "failed" | "interrupted";
export type TurnSourceKind = "human" | "goal" | "system";
export type TurnItemType = "user_message" | "assistant_message" | "reasoning" | "tool_call" | "tool_result" | "plan" | "handoff";
export type TurnItemStatus = "in_progress" | "completed" | "failed";
export interface ThreadSnapshot { id: string; agent: string; parentThreadId: string | null; createdAt: string; updatedAt: string }
export interface TurnSnapshot { id: string; threadId: string; source: TurnSourceKind; goalId: string | null; goalRevision: number | null; status: TurnStatus; attempt: number; error: JsonValue | null; startedAt: string; endedAt: string | null; leaseUntil: string | null; leaseToken: string | null; runnerPid: number | null; runnerProfileId?: string }
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
export interface ScheduleSnapshot { id: string; agent: string; nextWakeAt: string; reason: string; setBy: string; status: ScheduleStatus; resolvedAt: string | null; goalId?: string }
export interface WakeSnapshot {
  id: string;
  agent: string;
  /** Initial trigger retained for display and provenance. Runtime decisions use WakeTriggerSnapshot. */
  triggerRef: string;
  status: WakeStatus;
  attempt: number;
  enqueuedSeq: number;
  claimedAt: string | null;
  consumedAt: string | null;
  turnId: string | null;
  goalId?: string;
}
export interface WakeTriggerSnapshot { wakeId: string; agent: string; triggerRef: string; source: TurnSourceKind; status: WakeTriggerStatus; addedAt: string; resolvedAt: string | null }
export type MailLevel = "fyi" | "decision" | "emergency";
export interface MailSnapshot { id: string; to: string; from: string; level: MailLevel; body: JsonValue; readAt: string | null }
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
export interface ReassignmentResult { reassignmentId: string; goal: GoalSnapshot; mail: MailSnapshot[]; wake: WakeSnapshot }
export interface GoalCompletionRequest { goalId: string; revision: number; reason: string; evidence: number[];sourceTurnId?:string }
export type TeamMemberStatus = "running" | "queued" | "scheduled" | "waiting" | "blocked" | "idle_unplanned" | "retired";
export interface TeamMemberView {
  agent: string;
  goalIds: string[];
  status: TeamMemberStatus;
  lastHandoffSeq: number | null;
  lastWakeStatus: WakeStatus | null;
  nextWakeAt: string | null;
}
export interface LegacyHandoff { observations: string[]; results: string[]; nextSteps: string[]; blocker?: string; material?: boolean }
export interface GoalHandoff { goalId: string; goalRevision: number; recordRevision: number; outcome: "progress" | "waiting" | "blocked" | "completion_proposed"; evidence: number[] }
export type Handoff = LegacyHandoff | GoalHandoff;
export interface MailDraft { to: string; level: MailLevel; body: JsonValue }
export interface TurnOutput { handoff: Handoff; mail: MailDraft[]; nextWakeAt: string | null }
export interface RunnerTraceEvent { type: string; data: JsonValue }

export type AgentRole = "child" | "ceo" | "verifier" | "audit";
export type AgentCapability = "ledger.search" | "mail.send" | "schedule.set" | "goal.put"
  | "team.list" | "goal.get" | "goal.create" | "goal.work" | "goal.delegate" | "goal.reassign" | "goal.revise" | "goal.pause" | "goal.resume" | "goal.complete" | "human.request"
  | "work_record.list" | "work_record.read" | "work_record.history" | "work_record.diff" | "work_record.search" | "work_record.update"
  | "memory.append";
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
export type TurnSource = { kind: "human" } | { kind: "goal"; round: number } | { kind: "system"; reason: string };
export interface GoalBinding { goalId: string; goalRevision: number }
export interface TurnContext { source: TurnSource; goalBinding?: GoalBinding }
export interface AssistantResponse { content: string }
export interface RunRequest { agent: string; execution: TurnSnapshot; sourceWake?: WakeSnapshot; sourceWakeTriggers?: WakeTriggerSnapshot[]; turn: TurnContext; context: JsonValue; now(): string; emit(event: RunnerTraceEvent): void; rpc?(method: AgentCapability, params: JsonValue): Promise<JsonValue> }
export type RunnerCandidateResult = { outcome: "response"; response: AssistantResponse } | { outcome: "handoff"; output: TurnOutput } | { outcome: "abnormal"; reason: string };
export interface RunnerHandle { pid: number | null; begin(): void; result: Promise<RunnerCandidateResult>; steer?(message: string): Promise<void>; terminate(): Promise<void> }
export interface Runner { readonly isolation: "process"; prepare(request: RunRequest): RunnerHandle; terminateProcess(pid: number, runnerProfileId?: string): Promise<void> }

export interface HandoffCommit { agent: string; turnId: string; sourceWakeId: string | null; mailIds: string[]; ts: string; output: TurnOutput; outgoingMail: MailSnapshot[]; schedule: ScheduleSnapshot | null; item: TurnItemSnapshot }

/** Standard execution modules composed on top of the generic event store. */
export interface Ledger extends EventStore {
  putThread(thread: ThreadSnapshot, actor: string): EventRecord;
  putTurn(turn: TurnSnapshot, actor: string): EventRecord;
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
  consumeWake(id: string, turnId: string, now: string): WakeSnapshot;
  releaseWake(id: string, now: string): WakeSnapshot;
  cancelWake(id: string, now: string): WakeSnapshot;
  attachTurnProcess(id: string, leaseToken: string, pid: number): TurnSnapshot;
  renewTurnLease(id: string, leaseToken: string, leaseUntil: string, now: string): TurnSnapshot;
  appendTurnEvent(input: EventInput, leaseToken: string): EventRecord;
  repairTurnAttempt(id:string,reason:string,now:string,actor:string):TurnItemSnapshot[];
  finishTurn(id:string,status:"completed"|"failed"|"interrupted",error:JsonValue|null,now:string,actor:string,mailIds?:string[]):TurnSnapshot;
  putMail(mail: MailSnapshot, actor: string, wakeId?: string): EventRecord;
  putMails(mail: MailSnapshot[], actor: string, wakeId?: string): EventRecord[];
  commitHandoff(commit: HandoffCommit): EventRecord;
  dueSchedules(now: string): ScheduleSnapshot[];
  unreadMail(agent: string): MailSnapshot[];
  lastEvent(actor: string, type: string): EventRecord | null;
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
  if ("goalId" in value) {
    if (!value.goalId.trim() || !Number.isInteger(value.goalRevision) || value.goalRevision<0 || !Number.isInteger(value.recordRevision) || value.recordRevision<1 || !["progress", "waiting", "blocked", "completion_proposed"].includes(value.outcome) || !Array.isArray(value.evidence) || value.evidence.length===0) throw new Error("invalid Goal handoff");
    return;
  }
  if (!Array.isArray(value.observations) || !Array.isArray(value.results) || !Array.isArray(value.nextSteps)) throw new Error("invalid handoff: observations, results and nextSteps are required arrays");
}
export function assertGoalSnapshot(value: GoalSnapshot): void {
  if (!value.objective.trim() || !value.owner.trim()) throw new Error("goal objective and owner are required");
  if (value.observationMethod !== null && !value.observationMethod.trim()) throw new Error("goal observation method cannot be blank");
  if (value.verificationMethod !== null && !value.verificationMethod.trim()) throw new Error("goal verification method cannot be blank");
  if (value.parentId !== null && value.observationMethod === null) throw new Error("child goal observation method is required");
  if (value.parentId !== null && value.verificationMethod === null) throw new Error("child goal verification method is required");
  if (!["active", "paused", "blocked", "complete"].includes(value.phase)) throw new Error(`invalid goal phase: ${value.phase}`);
}
