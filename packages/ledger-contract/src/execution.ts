import { CONTRACT_VERSION, type EventInput, type EventRecord, type EventStore, type JsonValue } from "./kernel.js";
import type { MetricSample } from "./metrics.js";

export type WakeStatus = "queued" | "leased" | "running" | "done" | "abnormal" | "merge_blocked";
export type ActionStatus = "requested" | "approved" | "dispatching" | "confirmed" | "failed" | "unknown";
export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export type TurnStatus = "in_progress" | "completed" | "failed" | "interrupted";
export type TurnSourceKind = "human" | "goal" | "system";
export type TurnItemType = "user_message" | "assistant_message" | "reasoning" | "tool_call" | "tool_result" | "plan" | "handoff";
export type TurnItemStatus = "in_progress" | "completed" | "failed";
export interface SessionSnapshot { id: string; agent: string; parentSessionId: string | null; createdAt: string; updatedAt: string }
export interface TurnSnapshot { id: string; sessionId: string; source: TurnSourceKind; goalId: string | null; goalRevision: number | null; status: TurnStatus; error: JsonValue | null; startedAt: string; endedAt: string | null; leaseUntil: string | null; leaseToken: string | null; runnerPid: number | null }
export interface TurnItemSnapshot { id: string; turnId: string; ordinal: number; type: TurnItemType; status: TurnItemStatus; data: JsonValue; createdAt: string; completedAt: string | null }
export interface GoalSnapshot { id: string; parentId: string | null; objective: string; observationMethod: string | null; verificationMethod: string | null; owner: string; phase: GoalPhase; revision: number }
export interface WorkRecordSnapshot {
  goalId: string;
  recordRevision: number;
  goalRevision: number;
  content: string;
  updatedBy: string;
  updatedInTurn: string;
  updatedInWake: string | null;
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
  wakeId?: string;
}
export interface WorkRecordDiff { goalId: string; fromRevision: number; toRevision: number; text: string }
export interface ScheduleSnapshot { id: string; agent: string; nextWakeAt: string; reason: string; setBy: string }
export interface WakeSnapshot { id: string; agent: string; triggerRef: string; status: WakeStatus; leaseUntil: string | null; attempt: number; startedAt: string | null; endedAt: string | null; enqueuedSeq: number; leaseToken: string | null; runnerPid: number | null }
export type MailLevel = "fyi" | "decision" | "emergency";
export interface MailSnapshot { id: string; to: string; from: string; level: MailLevel; body: JsonValue; readAt: string | null }
export interface DelegationRequest {
  id: string;
  parentGoalId: string;
  childGoal: { id: string; objective: string; observationMethod: string; verificationMethod: string; owner: string };
  brief: JsonValue;
  reason: string;
  evidence: number[];
}
export interface DelegationResult { delegationId: string; goal: GoalSnapshot; mail: MailSnapshot; wake: WakeSnapshot }
export interface ReassignmentRequest {
  id: string;
  goalId: string;
  newOwner: string;
  brief: JsonValue;
  reason: string;
  evidence: number[];
}
export interface ReassignmentResult { reassignmentId: string; goal: GoalSnapshot; mail: MailSnapshot[]; wake: WakeSnapshot }
export interface GoalCompletionRequest { goalId: string; revision: number; reason: string; evidence: number[] }
export type TeamMemberStatus = "running" | "queued" | "scheduled" | "waiting" | "blocked" | "idle_unplanned" | "retired";
export interface TeamMemberView {
  agent: string;
  goalIds: string[];
  status: TeamMemberStatus;
  lastHandoffSeq: number | null;
  lastWakeStatus: WakeStatus | null;
  nextWakeAt: string | null;
}
export interface AuditAdvice { by: string; at: string; body: JsonValue; evidence: number[] }
export interface ActionSnapshot { id: string; agent: string; kind: string; connector: string; payload: JsonValue; reason: string; evidence: number[]; gated: boolean; status: ActionStatus; reconciledAt: string | null; externalRef: string | null; auditAdvice: AuditAdvice | null; adviceAcked: boolean }
export interface LegacyHandoff { observations: string[]; results: string[]; nextSteps: string[]; blocker?: string; material?: boolean }
export interface GoalHandoff { goalId: string; goalRevision: number; recordRevision: number; outcome: "progress" | "waiting" | "blocked" | "completion_proposed"; evidence: number[] }
export type Handoff = LegacyHandoff | GoalHandoff;
export interface MailDraft { to: string; level: MailLevel; body: JsonValue }
export interface WakeOutput { handoff: Handoff; mail: MailDraft[]; nextWakeAt: string | null }
export interface RunnerTraceEvent { type: string; data: JsonValue }

export type AgentRole = "child" | "ceo" | "verifier" | "audit";
export type AgentCapability = "ledger.search" | "mail.send" | "schedule.set" | "action.submit" | "audit.ack" | "audit.write" | "goal.put"
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
export type TurnSource = { kind: "human" } | { kind: "goal_driver"; round: number } | { kind: "system"; reason: string };
export interface GoalBinding { goalId: string; goalRevision: number }
export interface TurnContext { source: TurnSource; goalBinding?: GoalBinding }
export interface AssistantResponse { content: string }
export interface RunRequest { wake: WakeSnapshot; turn: TurnContext; context: JsonValue; now(): string; emit(event: RunnerTraceEvent): void; rpc?(method: AgentCapability, params: JsonValue): Promise<JsonValue> }
export type RunnerResult = { outcome: "response"; response: AssistantResponse } | { outcome: "handoff"; output: WakeOutput } | { outcome: "abnormal"; reason: string };
export interface RunnerHandle { pid: number | null; begin(): void; result: Promise<RunnerResult>; steer?(message: string): Promise<void>; terminate(): Promise<void> }
export interface Runner { readonly isolation: "process"; prepare(request: RunRequest): RunnerHandle; terminateProcess(pid: number): Promise<void> }

export interface ConnectorCapability { kind: string; nativeIdempotency: boolean; query: "by_idempotency_key" | "by_external_ref" | "none"; automaticRetry: boolean; risk: "reversible" | "gated" | "irreversible" }
export interface ConnectorManifest { contractVersion: typeof CONTRACT_VERSION; connector: string; dryRun: boolean; capabilities: ConnectorCapability[] }
export interface ConnectorDispatchResult { status: "confirmed" | "failed"; externalRef?: string }
export interface ConnectorQueryResult { status: "confirmed" | "failed" | "pending"; externalRef?: string }
export interface ConnectorProcessSpec { manifest: ConnectorManifest; command: string; args: string[]; env?: Record<string, string>; timeoutMs?: number }
export interface HandoffCommit { agent: string; wakeId: string; mailIds: string[]; ts: string; output: WakeOutput; outgoingMail: MailSnapshot[]; schedule: ScheduleSnapshot | null }
export interface InteractionCommit { agent: string; wakeId: string; mailId: string; mailIds?: string[]; ts: string; response: AssistantResponse }
export interface InteractionFailureCommit { agent: string; mailId: string; mailIds: string[]; ts: string; reason: string; outcome: "exhausted" | "cancelled"; notification?: MailSnapshot }

/** Standard execution modules composed on top of the generic event store. */
export interface Ledger extends EventStore {
  putSession(session: SessionSnapshot, actor: string): EventRecord;
  putTurn(turn: TurnSnapshot, actor: string): EventRecord;
  putTurnItem(item: TurnItemSnapshot, actor: string): EventRecord;
  session(id: string): SessionSnapshot | null;
  sessions(): SessionSnapshot[];
  turn(id: string): TurnSnapshot | null;
  turns(sessionId?: string): TurnSnapshot[];
  turnItems(turnId: string): TurnItemSnapshot[];
  activeTurn(sessionId: string): TurnSnapshot | null;
  putGoal(goal: GoalSnapshot, actor: string, wakeId?: string): EventRecord;
  updateWorkRecord(request: WorkRecordUpdateRequest, actor: string): WorkRecordSnapshot;
  commitDelegation(request: DelegationRequest, actor: string, wakeId?: string): DelegationResult;
  commitReassignment(request: ReassignmentRequest, actor: string, wakeId?: string): ReassignmentResult;
  completeGoal(request: GoalCompletionRequest, actor: string, wakeId?: string): GoalSnapshot;
  putSchedule(schedule: ScheduleSnapshot, actor: string, wakeId?: string): EventRecord;
  enqueueWake(wake: WakeSnapshot, actor: string): { event: EventRecord; created: boolean };
  claimNextWake(now: string, leaseUntil: string, leaseToken: string): WakeSnapshot | null;
  markWakeRunning(id: string, now: string, leaseToken: string): WakeSnapshot;
  attachWakeProcess(id: string, leaseToken: string, pid: number, now: string): WakeSnapshot;
  renewWakeLease(id: string, leaseToken: string, leaseUntil: string, now: string): WakeSnapshot;
  finishWake(id: string, status: "done" | "abnormal" | "merge_blocked", now: string): WakeSnapshot;
  expiredWakes(now: string): WakeSnapshot[];
  recoverExpiredWake(id: string, now: string): WakeSnapshot;
  appendRunnerEvent(input: EventInput, leaseToken: string): EventRecord;
  requestAction(action: ActionSnapshot, actor: string, wakeId?: string): EventRecord;
  approveAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot;
  rejectAction(id: string, approver: string, reason: string, evidence: number[]): ActionSnapshot;
  transitionAction(id: string, status: ActionStatus, patch?: Partial<Pick<ActionSnapshot, "externalRef" | "reconciledAt">>): ActionSnapshot;
  recoverDispatchingActions(): ActionSnapshot[];
  putAuditAdvice(id: string, advice: Omit<AuditAdvice, "at">, wakeId?: string): ActionSnapshot;
  ackAuditAdvice(id: string, agent: string): ActionSnapshot;
  putMail(mail: MailSnapshot, actor: string, wakeId?: string): EventRecord;
  commitHandoff(commit: HandoffCommit): EventRecord;
  commitInteraction(commit: InteractionCommit): EventRecord;
  failInteraction(commit: InteractionFailureCommit): EventRecord;
  dueSchedules(now: string): ScheduleSnapshot[];
  unreadMail(agent: string): MailSnapshot[];
  unackedAuditAdvice(agent: string): ActionSnapshot[];
  lastEvent(actor: string, type: string): EventRecord | null;
  latestEvent(): EventRecord | null;
  eventsForWake(wakeId: string): EventRecord[];
  wake(id: string): WakeSnapshot | null;
  wakeByTrigger(agent: string, triggerRef: string): WakeSnapshot | null;
  queuedWakeForAgent(agent: string): WakeSnapshot | null;
  action(id: string): ActionSnapshot | null;
  goalsForOwner(owner: string): GoalSnapshot[];
  goal(id: string): GoalSnapshot | null;
  workRecord(goalId: string): WorkRecordSnapshot | null;
  workRecordHistory(goalId: string): WorkRecordSnapshot[];
  workRecordDiff(goalId: string, fromRevision: number, toRevision: number): WorkRecordDiff;
  searchWorkRecords(query: string, limit?: number): WorkRecordSnapshot[];
  triggeringMail(): MailSnapshot[];
  searchEvents(query: string, limit?: number): EventRecord[];
  metricSamples(goalId: string): MetricSample[];
  goals(): GoalSnapshot[];
  workRecords(): WorkRecordSnapshot[];
  schedules(): ScheduleSnapshot[];
  wakes(): WakeSnapshot[];
  actions(): ActionSnapshot[];
  mailbox(): MailSnapshot[];
  rebuildProjections(): void;
  close(): void;
}

const wakeTransitions: Record<WakeStatus, readonly WakeStatus[]> = { queued: ["leased", "abnormal"], leased: ["queued", "running", "abnormal"], running: ["done", "abnormal", "merge_blocked"], done: [], abnormal: [], merge_blocked: [] };
const actionTransitions: Record<ActionStatus, readonly ActionStatus[]> = { requested: ["approved", "failed"], approved: ["dispatching", "failed"], dispatching: ["confirmed", "failed", "unknown"], unknown: ["dispatching", "confirmed", "failed"], confirmed: [], failed: [] };
const goalTransitions: Record<GoalPhase, readonly GoalPhase[]> = { active: ["paused", "blocked", "complete"], paused: ["active", "complete"], blocked: ["active", "complete"], complete: [] };
export function assertWakeTransition(from: WakeStatus, to: WakeStatus): void { if (!wakeTransitions[from].includes(to)) throw new Error(`invalid wake transition: ${from} -> ${to}`); }
export function assertActionTransition(from: ActionStatus, to: ActionStatus): void { if (!actionTransitions[from].includes(to)) throw new Error(`invalid action transition: ${from} -> ${to}`); }
export function assertGoalTransition(from: GoalPhase, to: GoalPhase): void { if (from !== to && !goalTransitions[from].includes(to)) throw new Error(`invalid goal transition: ${from} -> ${to}`); }
export function assertHandoff(value: Handoff): void {
  if ("goalId" in value) {
    if (!value.goalId.trim() || !Number.isInteger(value.goalRevision) || !Number.isInteger(value.recordRevision) || !["progress", "waiting", "blocked", "completion_proposed"].includes(value.outcome) || !Array.isArray(value.evidence)) throw new Error("invalid Goal handoff");
    return;
  }
  if (!Array.isArray(value.observations) || !Array.isArray(value.results) || !Array.isArray(value.nextSteps)) throw new Error("invalid handoff: observations, results and nextSteps are required arrays");
}
export function assertActionRequest(value: ActionSnapshot): void { if (!value.reason.trim()) throw new Error("action reason is required"); if (value.evidence.length === 0) throw new Error("action evidence is required"); if (value.status !== "requested") throw new Error("new action must be requested"); if (!value.connector.trim()) throw new Error("action connector is required"); if (value.reconciledAt !== null) throw new Error("requested action cannot be reconciled"); }
export function assertGoalSnapshot(value: GoalSnapshot): void {
  if (!value.objective.trim() || !value.owner.trim()) throw new Error("goal objective and owner are required");
  if (value.observationMethod !== null && !value.observationMethod.trim()) throw new Error("goal observation method cannot be blank");
  if (value.verificationMethod !== null && !value.verificationMethod.trim()) throw new Error("goal verification method cannot be blank");
  if (value.parentId !== null && value.observationMethod === null) throw new Error("child goal observation method is required");
  if (value.parentId !== null && value.verificationMethod === null) throw new Error("child goal verification method is required");
  if (!["active", "paused", "blocked", "complete"].includes(value.phase)) throw new Error(`invalid goal phase: ${value.phase}`);
}
export function capabilityFor(manifest: ConnectorManifest, kind: string): ConnectorCapability | null { return manifest.capabilities.find((capability) => capability.kind === kind) ?? null; }
