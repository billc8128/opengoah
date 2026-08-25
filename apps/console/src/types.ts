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
  status: "running" | "queued" | "scheduled" | "waiting" | "blocked" | "idle_unplanned" | "retired"
  lastHandoffSeq: number | null
  lastWakeStatus: string | null
  nextWakeAt: string | null
}

export interface WakeView {
  id: string
  agent: string
  triggerRef: string
  status: "queued" | "claimed" | "consumed" | "cancelled"
  attempt: number
  enqueuedSeq: number
  claimedAt: string | null
  consumedAt: string | null
  turnId: string | null
}

export interface ActionView {
  id: string
  agent: string
  createdInTurn: string
  kind: string
  connector: string
  reason: string
  status: string
  gated: boolean
  evidence: number[]
}

export interface ScheduleView { id: string; agent: string; nextWakeAt: string; reason: string; setBy: string }
export interface MailView { id: string; to: string; from: string; level: string; body: JsonValue; readAt: string | null }
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
  goalId: string | null
  goalRevision: number | null
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
  actions: ActionView[]
  schedules: ScheduleView[]
  mailbox: MailView[]
  events: EventView[]
}
