export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

export interface GoalView {
  id: string
  parentId: string | null
  objective: string
  observationMethod: string | null
  verificationMethod: string | null
  owner: string
  phase: "active" | "paused" | "blocked" | "complete"
  revision: number
}

export interface TeamView {
  agent: string
  goalIds: string[]
  motion: "running" | "queued" | "scheduled" | "idle" | "retired"
  lastOutcome: "progress" | "waiting" | "blocked" | "completion_proposed" | null
  lastHandoffSeq: number | null
  lastWakeStatus: string | null
  nextWakeAt: string | null
}

export interface WakeView {
  id: string
  bindingKind:"human"|"goal"|"specialist"
  agent: string
  goalId:string|null
  specialistRole:"verifier"|"audit"|null
  triggerRef: string
  status: "queued" | "claimed" | "consumed" | "cancelled"
  attempt: number
  enqueuedSeq: number
  claimedAt: string | null
  consumedAt: string | null
  turnId: string | null
}
export interface WakeTriggerView { wakeId:string;agent:string;triggerRef:string;source:"human"|"goal"|"system";status:"pending"|"resolved";addedAt:string;resolvedAt:string|null }

export interface ScheduleView { id: string; bindingKind:"goal"|"specialist";agent: string;goalId:string|null;specialistRole:"verifier"|"audit"|null;nextWakeAt: string; reason: string; setBy: string; status: "pending" | "consumed" | "cancelled" | "superseded"; resolvedAt: string | null }
export interface MailView { id: string;routeKind:"goal"|"human_inbox"|"human_request"|"specialist_inbox";to: string; from: string;level: string;goalId:string|null;specialistRole:"verifier"|"audit"|null;body: JsonValue; readAt: string | null }
export interface EventView { seq: number; streamId: string; streamSeq: number; ts: string; actor: string; type: string; data: JsonValue }
export interface TrajectoryItemView { event: EventView; agent: string; wakeId: string | null }
export interface TrajectoryPageView { items: TrajectoryItemView[]; nextBeforeSeq: number | null }
export interface ThreadView {
  id: string
  agent: string
  parentThreadId: string | null
  createdAt: string
  updatedAt: string
}
export interface TurnView {
  id: string
  threadId: string
  source: "human" | "goal" | "system"
  bindingKind: "human" | "goal" | "specialist"
  goalId: string | null
  goalRevision: number | null
  specialistRole: "verifier" | "audit" | null
  status: "in_progress" | "completed" | "failed" | "interrupted"
  attempt: number
  error: JsonValue | null
  startedAt: string
  endedAt: string | null
  leaseUntil: string | null
  leaseToken: string | null
  runnerPid: number | null
}
export interface TurnItemView {
  id: string
  turnId: string
  ordinal: number
  type: "user_message" | "assistant_message" | "reasoning" | "tool_call" | "tool_result" | "plan" | "handoff"
  status: "in_progress" | "completed" | "failed"
  data: JsonValue
  createdAt: string
  completedAt: string | null
}
export interface ThreadDetailView { thread: ThreadView; turns: Array<TurnView & { items: TurnItemView[] }> }

export interface ConsoleSnapshot {
  seq: number
  now: string
  goals: GoalView[]
  team: TeamView[]
  threads: ThreadView[]
  turns: TurnView[]
  wakes: WakeView[]
  wakeTriggers:WakeTriggerView[]
  schedules: ScheduleView[]
  recoveries:Array<{turnId:string;agent:string;state:"scheduled"|"queued"|"running"|"recovered"|"escalated"|"superseded"|"needed";actionable:boolean}>
  mailbox: MailView[]
  events: EventView[]
}
