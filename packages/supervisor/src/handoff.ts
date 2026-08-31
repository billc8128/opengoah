/**
 * Handoff validation: per-Turn attempt sequencing, validation tokens, and the
 * committed-Turn handoff commit path.
 *
 * ## Threat model
 *
 * The defense here is against a self-spawned Runner subprocess returning a
 * stale or fabricated Handoff: replaying an old validation token, attaching
 * another Turn's work, or committing against a Goal fence it no longer holds.
 * The Supervisor trusts the Ledger, never the Runner's self-report.
 *
 * `validateDraft` mints an unguessable token only when the draft carries a
 * readable Assistant message and a current-Turn Work Record update.
 * `commitTurnGoalWork` then re-checks an equality chain before committing.
 * The load-bearing lines are:
 *
 * - **Message identity** — `messageItemId` plus the full normalized message
 *   text must equal the Turn's committed response. This binds the declarative
 *   outcome to the exact prose the organization (and Human) will read, so the
 *   Runner cannot swap cheerful text for a validated bleak draft.
 * - **Goal fence** — `goalId` and `goalRevision` must equal the Turn's frozen
 *   commitment, so a superseded Goal cannot be completed by stale work.
 *
 * The remaining fields are fail-closed redundancy against narrower confusions;
 * they can be reduced if they ever block a legitimate flow, with the
 * conformance and handoff tests as the safety net:
 *
 * - `token`/`turnId`/`agent` — the token was minted for this Turn and agent.
 * - `attemptId` + the Turn's attempt sequence — only the newest validation
 *   attempt is valid; `beginAttempt` invalidates every older token.
 * - `attempt`/`leaseToken` — minted under the Turn's current retry attempt and
 *   lease, so a fenced or preempted execution cannot commit.
 * - `outcome`/`evidence` — the committed values equal the validated draft, so
 *   the Runner cannot bait-and-switch after acceptance.
 */
import { randomUUID } from "node:crypto";
import {
  assertAgentHandoff,
  assertHandoff,
  assertTurnOutput,
  normalizeAssistantText,
  type AgentHandoff,
  type CommittedTurnOutput,
  type GoalHandoff,
  type HandoffValidationRequest,
  type HandoffValidationResult,
  type GoalSnapshot,
  type JsonValue,
  type Ledger,
  type TurnContext,
  type TurnItemSnapshot,
  type TurnOutput,
  type TurnSnapshot,
} from "goah-ledger-contract";

/** Supervisor state the handoff commit path reads. */
export interface HandoffCommitDeps {
  ledger: Ledger;
  now(): string;
  goal(id: string): GoalSnapshot;
  validator: HandoffValidator;
}

export interface HandoffValidationState {
  turnId: string;
  attemptId: number;
  agent: string;
  attempt: number;
  leaseToken: string;
  goalId: string;
  goalRevision: number;
  messageItemId: string;
  message: string;
  handoff: AgentHandoff;
}

/**
 * Owns per-Turn handoff validation attempts and tokens. State and logic are
 * moved verbatim from the Supervisor class; behavior is unchanged.
 */
export class HandoffValidator {
  readonly #validations = new Map<string, HandoffValidationState>();
  readonly #attemptSeq = new Map<string, number>();

  validationFor(token: string): HandoffValidationState | undefined {
    return this.#validations.get(token);
  }
  attemptFor(turnId: string): number | undefined {
    return this.#attemptSeq.get(turnId);
  }

  validateDraft(
    ledger: Ledger,
    turnId: string,
    attemptId: number,
    agent: string,
    execution: TurnSnapshot,
    context: TurnContext,
    input: Record<string, JsonValue>,
  ): HandoffValidationResult {
    if (!context.goalCommitment || execution.goalId === null)
      return {
        accepted: false,
        fatal: true,
        attemptId,
        issues: [
          { code: "turn_not_committed", message: "This Turn no longer has a Goal commitment." },
        ],
      };
    const request: HandoffValidationRequest = {
      handoff: (input.handoff ?? null) as unknown as HandoffValidationRequest["handoff"],
      candidateMessageId: String(input.candidateMessageId ?? "").trim(),
      candidateMessage: String(input.candidateMessage ?? ""),
    };
    const issues: import("goah-ledger-contract").HandoffValidationIssue[] = [];
    try {
      assertAgentHandoff(request.handoff);
    } catch {
      issues.push({
        code: "handoff_invalid",
        message: "Handoff requires a valid outcome and at least one evidence event.",
      });
    }
    const message = normalizeAssistantText(request.candidateMessage);
    const existingMessage = request.candidateMessageId
      ? ledger.turnItems(turnId).find((item) => item.id === request.candidateMessageId)
      : undefined;
    if (!request.candidateMessageId || !message)
      issues.push({
        code: "message_missing",
        message:
          "This committed Turn needs a readable assistant message Item before it can finish.",
      });
    else if (
      existingMessage &&
      (existingMessage.type !== "assistant_message" ||
        existingMessage.status !== "completed" ||
        normalizeAssistantText(String((existingMessage.data as { text?: unknown }).text ?? "")) !==
          message)
    )
      issues.push({
        code: "message_mismatch",
        message: "Handoff message identity does not match its assistant Item.",
      });
    const goal = ledger.goal(context.goalCommitment.goalId);
    if (
      !goal ||
      goal.phase !== "active" ||
      goal.owner !== agent ||
      goal.revision !== context.goalCommitment.goalRevision
    )
      return {
        accepted: false,
        fatal: true,
        attemptId,
        issues: [
          {
            code: "goal_fence_changed",
            message:
              "Goal ownership, phase, or revision changed; this Turn can no longer finish against the old commitment.",
          },
        ],
      };
    const record = ledger.workRecord(goal.id);
    if (!record || record.updatedInTurn !== turnId || record.goalRevision !== goal.revision)
      issues.push({
        code: "work_record_not_updated",
        message: "Update this Goal's Work Record in the current Turn before Handoff.",
        details: { goalId: goal.id, recordRevision: record?.recordRevision ?? null },
      });
    const evidence = Array.isArray(request.handoff?.evidence) ? request.handoff.evidence : [];
    for (const seq of evidence)
      if (!Number.isInteger(seq) || !ledger.eventExists(seq))
        issues.push({
          code: "evidence_not_found",
          message: `Evidence event ${String(seq)} does not exist in the Ledger.`,
          details: { seq },
        });
    if (issues.length) return { accepted: false, fatal: false, attemptId, issues };
    const token = randomUUID();
    this.#validations.set(token, {
      turnId,
      attemptId,
      agent,
      attempt: execution.attempt,
      leaseToken: execution.leaseToken!,
      goalId: goal.id,
      goalRevision: goal.revision,
      messageItemId: request.candidateMessageId,
      message,
      handoff: { outcome: request.handoff.outcome, evidence: [...request.handoff.evidence] },
    });
    return {
      accepted: true,
      fatal: false,
      attemptId,
      token,
      goalId: goal.id,
      goalRevision: goal.revision,
      messageItemId: request.candidateMessageId,
    };
  }

  beginAttempt(turnId: string): number {
    this.invalidateTokens(turnId);
    const attemptId = (this.#attemptSeq.get(turnId) ?? 0) + 1;
    this.#attemptSeq.set(turnId, attemptId);
    return attemptId;
  }

  invalidateTokens(turnId: string): void {
    for (const [token, value] of this.#validations)
      if (value.turnId === turnId) this.#validations.delete(token);
  }

  clear(turnId: string): void {
    this.invalidateTokens(turnId);
    this.#attemptSeq.delete(turnId);
  }
}

export function commitTurnGoalWork(
  deps: HandoffCommitDeps,
  turnId: string,
  agent: string,
  turn: TurnContext,
  responseItem: TurnItemSnapshot,
  raw: TurnOutput,
  sourceWakeId: string | null,
  mailIds: string[],
  revisionAtStart: number,
): void {
  const binding = turn.goalCommitment!;
  const goal = deps.goal(binding.goalId);
  if (goal.revision !== binding.goalRevision)
    throw new Error("Goal revision changed during the Turn");
  const record = deps.ledger.workRecord(goal.id);
  if (
    !record ||
    record.recordRevision <= revisionAtStart ||
    record.updatedInTurn !== turnId ||
    record.goalRevision !== goal.revision
  )
    throw new Error("committed Turn must update its Work Record before handoff");
  assertTurnOutput(raw);
  const validation = deps.validator.validationFor(raw.validationToken);
  const execution = deps.ledger.turn(turnId);
  const response = normalizeAssistantText(
    String((responseItem.data as { text?: unknown }).text ?? ""),
  );
  if (
    !validation ||
    !execution ||
    validation.turnId !== turnId ||
    validation.attemptId !== raw.validationAttemptId ||
    deps.validator.attemptFor(turnId) !== raw.validationAttemptId ||
    validation.agent !== agent ||
    validation.attempt !== execution.attempt ||
    validation.leaseToken !== execution.leaseToken ||
    validation.goalId !== goal.id ||
    validation.goalRevision !== goal.revision ||
    validation.messageItemId !== responseItem.id ||
    validation.message !== response ||
    validation.handoff.outcome !== raw.handoff.outcome ||
    !isSameNumbers(validation.handoff.evidence, raw.handoff.evidence)
  )
    throw new Error("Handoff validation token is stale or does not match this Turn result");
  const output = committedTurnOutput(deps.ledger, raw, binding);
  assertHandoff(output.handoff);
  const now = deps.now();
  const item: TurnItemSnapshot = {
    id: randomUUID(),
    turnId,
    ordinal: deps.ledger.turnItems(turnId).length + 1,
    type: "handoff",
    status: "completed",
    data: output.handoff as unknown as JsonValue,
    createdAt: now,
    completedAt: now,
  };
  deps.ledger.commitHandoff({
    agent,
    turnId,
    sourceWakeId,
    mailIds,
    ts: now,
    output,
    responseItemId: responseItem.id,
    item,
  });
  deps.validator.clear(turnId);
}

export function committedTurnOutput(
  ledger: Ledger,
  output: TurnOutput,
  binding: NonNullable<TurnContext["goalCommitment"]>,
): CommittedTurnOutput {
  const record = ledger.workRecord(binding.goalId);
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

function isSameNumbers(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
