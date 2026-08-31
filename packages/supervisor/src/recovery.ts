// Recovery and scheduling: retry scheduling for failed Turns, the recovery
// read model, and the recovery trigger-ref vocabulary. Extracted verbatim
// from index.ts; behavior is unchanged.
import {
  goalAutomaticTarget,
  specialistAutomaticTarget,
  type AgentRole,
  type Clock,
  type Ledger,
  type WakeSnapshot,
  type WakeTriggerSnapshot,
} from "goah-ledger-contract";

/** Supervisor state the recovery scheduler reads. */
export interface TurnRecoveryDeps {
  ledger: Ledger;
  clock: Clock;
  now(): string;
  role(agent: string): AgentRole;
  retryPolicy: { maxAttempts: number; baseDelayMs: number };
  enqueueTrigger(
    agent: string,
    triggerRef: string,
    target?: { goalId: string },
  ): WakeSnapshot | null;
}

export function scheduleTurnRecovery(
  deps: TurnRecoveryDeps,
  sourceWake: WakeSnapshot | null,
  triggers: WakeTriggerSnapshot[],
  turnId: string,
  agent: string,
): void {
  const turn = deps.ledger.turn(turnId);
  if (!turn) return;
  const role = deps.role(agent);
  const goal = turn.goalId ? deps.ledger.goal(turn.goalId) : null;
  if (
    (turn.goalId && (!goal || goal.phase !== "active" || goal.owner !== agent)) ||
    (!turn.goalId && (turn.triggerKind !== "wake" || (role !== "verifier" && role !== "audit")))
  )
    return;
  const prior = Math.max(
    0,
    ...triggers.map((trigger) => parseRecoveryTrigger(trigger.triggerRef)?.attempt ?? 0),
  );
  const next = prior + 1;
  if (next < deps.retryPolicy.maxAttempts) {
    const delay = deps.retryPolicy.baseDelayMs * 2 ** prior;
    const target = goal
      ? goalAutomaticTarget(agent, goal.id)
      : specialistAutomaticTarget(agent, role as "verifier" | "audit");
    deps.ledger.putSchedule(
      {
        id: recoveryScheduleId(turnId, next),
        ...target,
        nextWakeAt: new Date(deps.clock.now().getTime() + delay).toISOString(),
        reason: recoveryRef(turnId),
        setBy: "supervisor",
        status: "pending",
        resolvedAt: null,
      },
      "supervisor",
      sourceWake?.id,
    );
  } else if (role === "child" && goal?.parentId) {
    const parent = deps.ledger.goal(goal.parentId);
    if (parent?.phase === "active")
      deps.enqueueTrigger(parent.owner, childRetryExhaustedRef(turnId), { goalId: parent.id });
  }
}

export interface RecoveryView {
  turnId: string;
  agent: string;
  state: "scheduled" | "queued" | "running" | "recovered" | "escalated" | "superseded" | "needed";
  actionable: boolean;
}

export function deriveRecoveryViews(ledger: Ledger): RecoveryView[] {
  const views: RecoveryView[] = [];
  const wakes = ledger.wakes();
  const schedules = ledger.schedules();
  const triggers = wakes.flatMap((wake) => ledger.wakeTriggers(wake.id));
  for (const turn of ledger.turns()) {
    if (turn.status !== "failed") continue;
    const sourceWake = wakes.find((wake) => wake.turnId === turn.id);
    const thread = ledger.thread(turn.threadId);
    const goal = turn.goalId ? ledger.goal(turn.goalId) : null;
    const goalFailure = Boolean(
      thread && goal && goal.phase === "active" && goal.owner === thread.agent,
    );
    const specialistFailure = Boolean(
      !turn.goalId &&
      thread &&
      (thread.role === "verifier" || thread.role === "audit") &&
      sourceWake?.targetKind === "specialist" &&
      sourceWake.agent === thread.agent &&
      sourceWake.specialistRole === thread.role,
    );
    if (!thread || (!goalFailure && !specialistFailure)) continue;
    const base = { turnId: turn.id, agent: thread.agent };
    const scheduled = schedules.some((schedule) => {
      const recovery = parseRecoveryTrigger(schedule.id);
      const sameTarget = goalFailure
        ? schedule.targetKind === "goal" && schedule.goalId === goal!.id
        : schedule.targetKind === "specialist" && thread && schedule.specialistRole === thread.role;
      return (
        schedule.status === "pending" &&
        schedule.setBy === "supervisor" &&
        schedule.agent === thread.agent &&
        sameTarget &&
        schedule.reason === recoveryRef(turn.id) &&
        recovery?.turnId === turn.id &&
        recovery.attempt > 0
      );
    });
    if (scheduled) {
      views.push({ ...base, state: "scheduled", actionable: false });
      continue;
    }
    const recoveryWake = triggers
      .flatMap((trigger) => {
        const recovery = parseRecoveryTrigger(trigger.triggerRef);
        const wake =
          recovery?.turnId === turn.id
            ? wakes.find((candidate) => candidate.id === trigger.wakeId)
            : null;
        const sameTarget = goalFailure
          ? wake?.targetKind === "goal" && wake.goalId === goal!.id
          : wake?.targetKind === "specialist" && thread && wake.specialistRole === thread.role;
        return wake?.agent === thread.agent && sameTarget ? [wake] : [];
      })
      .sort((left, right) => right.enqueuedSeq - left.enqueuedSeq)[0];
    if (recoveryWake?.status === "queued" || recoveryWake?.status === "claimed") {
      views.push({ ...base, state: "queued", actionable: false });
      continue;
    }
    if (recoveryWake?.status === "consumed" && recoveryWake.turnId) {
      const retry = ledger.turn(recoveryWake.turnId);
      const state: RecoveryView["state"] =
        retry?.status === "in_progress"
          ? "running"
          : retry?.status === "completed"
            ? "recovered"
            : "superseded";
      views.push({ ...base, state, actionable: false });
      continue;
    }
    const parent = goalFailure && goal!.parentId ? ledger.goal(goal!.parentId) : null;
    const escalation = triggers
      .flatMap((trigger) => {
        const wake =
          trigger.triggerRef === childRetryExhaustedRef(turn.id)
            ? wakes.find((candidate) => candidate.id === trigger.wakeId)
            : null;
        return wake?.targetKind === "goal" &&
          parent &&
          wake.agent === parent.owner &&
          wake.goalId === parent.id &&
          parent.phase === "active"
          ? [wake]
          : [];
      })
      .find(
        (wake) =>
          wake.status === "queued" || wake.status === "claimed" || wake.status === "consumed",
      );
    if (escalation) {
      views.push({ ...base, state: "escalated", actionable: false });
      continue;
    }
    views.push({ ...base, state: "needed", actionable: true });
  }
  return views;
}

export function recoveryRef(turnId: string): string {
  return `recovery:${turnId}`;
}

export function recoveryScheduleId(turnId: string, attempt: number): string {
  return `${recoveryRef(turnId)}:${attempt}`;
}

export function childRetryExhaustedRef(turnId: string): string {
  return `child-retry-exhausted:${turnId}`;
}

export function childRetryExhaustedTurnId(triggerRef: string): string | null {
  return triggerRef.startsWith("child-retry-exhausted:")
    ? triggerRef.slice("child-retry-exhausted:".length) || null
    : null;
}

export function parseRecoveryTrigger(
  triggerRef: string,
): { turnId: string; attempt: number } | null {
  if (!triggerRef.startsWith("recovery:")) return null;
  const [turnId, rawAttempt] = triggerRef.slice("recovery:".length).split("@")[0]!.split(":");
  if (!turnId) return null;
  const attempt = rawAttempt === undefined ? 0 : Number(rawAttempt);
  return Number.isInteger(attempt) && attempt >= 0 ? { turnId, attempt } : null;
}

export function mailDeliveryAttempt(triggerRef: string, base: string): number | null {
  if (triggerRef === base) return 0;
  const prefix = `${base}@redelivery:`;
  if (!triggerRef.startsWith(prefix)) return null;
  const attempt = Number(triggerRef.slice(prefix.length));
  return Number.isInteger(attempt) && attempt > 0 ? attempt : null;
}
