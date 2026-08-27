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

interface WakeViewBase {
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
export type WakeView = WakeViewBase & (
  | { bindingKind: "human"; agent: "ceo"; goalId: null; specialistRole: null }
  | { bindingKind: "goal"; goalId: string; specialistRole: null }
  | { bindingKind: "specialist"; goalId: null; specialistRole: "verifier" | "audit" }
)
export interface WakeTriggerView { wakeId:string;agent:string;triggerRef:string;source:"human"|"goal"|"system";status:"pending"|"resolved";addedAt:string;resolvedAt:string|null }

interface ScheduleViewBase { id: string;agent: string;nextWakeAt: string; reason: string; setBy: string; status: "pending" | "consumed" | "cancelled" | "superseded"; resolvedAt: string | null }
export type ScheduleView = ScheduleViewBase & ({ bindingKind:"goal";goalId:string;specialistRole:null } | { bindingKind:"specialist";goalId:null;specialistRole:"verifier"|"audit" })
interface MailViewBase {id:string;to:string;from:string;level:string;body:JsonValue;readAt:string|null}
export type MailView=MailViewBase&(
  | {routeKind:"goal";goalId:string;specialistRole:null}
  | {routeKind:"human_inbox"|"human_request";goalId:null;specialistRole:null}
  | {routeKind:"specialist_inbox";goalId:null;specialistRole:"verifier"|"audit"}
)
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
interface TurnViewBase {
  id: string
  threadId: string
  source: "human" | "goal" | "system"
  status: "in_progress" | "completed" | "failed" | "interrupted"
  attempt: number
  error: JsonValue | null
  startedAt: string
  endedAt: string | null
  leaseUntil: string | null
  leaseToken: string | null
  runnerPid: number | null
}
export type TurnView = TurnViewBase & (
  | { source: "human"; bindingKind: "human"; goalId: null; goalRevision: null; specialistRole: null }
  | { source: "human" | "goal"; bindingKind: "goal"; goalId: string; goalRevision: number; specialistRole: null }
  | { source: "system"; bindingKind: "specialist"; goalId: null; goalRevision: null; specialistRole: "verifier" | "audit" }
)
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
  currentRoot: GoalView | null
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
