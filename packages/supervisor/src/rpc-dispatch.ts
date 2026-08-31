// Agent RPC dispatch: validates Turn/Goal fences and executes each Runner
// capability method. Extracted verbatim from index.ts; behavior is unchanged.
import { randomUUID } from "node:crypto";
import {
  goalRoute,
  memoryStream,
  type AgentCapability,
  type AgentProfile,
  type AgentRole,
  type DelegationRequest,
  type DelegationResult,
  type GoalCompletionRequest,
  type GoalPhase,
  type GoalSnapshot,
  type JsonValue,
  type Ledger,
  type MailSnapshot,
  type ReassignmentRequest,
  type ReassignmentResult,
  type RunnerRpcMethod,
  type TeamMemberView,
  type TurnContext,
  type TurnSnapshot,
  type WakeSnapshot,
} from "goah-ledger-contract";
import type { HandoffValidator } from "./handoff.js";
import { defaultCapabilities } from "./turn-context.js";

/** Supervisor operations and state the Agent RPC dispatcher executes against. */
export interface AgentRpcDeps {
  ledger: Ledger;
  now(): string;
  profiles: ReadonlyMap<string, AgentProfile>;
  handoff: HandoffValidator;
  role(agent: string): AgentRole;
  goal(id: string): GoalSnapshot;
  validGoalOwner(agent: string, goal: GoalSnapshot): boolean;
  knownAgent(agent: string): boolean;
  teamList(): TeamMemberView[];
  createRootGoal(objective: string, id?: string, sourceTurnId?: string): GoalSnapshot;
  delegate(request: DelegationRequest, actor?: string, wakeId?: string): DelegationResult;
  reassignGoal(
    request: ReassignmentRequest,
    actor?: string,
    wakeId?: string,
  ): Promise<ReassignmentResult>;
  reviseChildGoal(
    id: string,
    objective: string,
    observationMethod: string,
    verificationMethod: string,
    actor: string,
    reason: string,
    evidence: number[],
    wakeId?: string,
    sourceTurnId?: string,
  ): GoalSnapshot;
  transitionGoal(
    id: string,
    phase: GoalPhase,
    actor?: string,
    scheduleMotion?: boolean,
    sourceTurnId?: string,
  ): GoalSnapshot;
  completeGoal(request: GoalCompletionRequest, actor?: string, wakeId?: string): GoalSnapshot;
  planWake(
    agent: string,
    at: string,
    reason: string,
    setBy: string,
    target?: { goalId: string },
  ): WakeSnapshot | null;
}

export async function dispatchAgentRpc(
  deps: AgentRpcDeps,
  turnId: string,
  agent: string,
  context: TurnContext,
  method: RunnerRpcMethod,
  params: JsonValue,
  sourceWakeId?: string,
): Promise<JsonValue> {
  const handoffAttemptId =
    method === "goal.handoff.validate" ? deps.handoff.beginAttempt(turnId) : null;
  const execution = deps.ledger.turn(turnId);
  if (
    !execution ||
    execution.status !== "in_progress" ||
    !execution.leaseToken ||
    !execution.leaseUntil ||
    execution.leaseUntil < deps.now()
  )
    throw new Error("stale Turn RPC rejected");
  if (context.goalCommitment) {
    const goal = deps.ledger.goal(context.goalCommitment.goalId);
    const thread = deps.ledger.thread(execution.threadId);
    if (
      !goal ||
      goal.phase !== "active" ||
      goal.revision !== context.goalCommitment.goalRevision ||
      goal.owner !== agent ||
      execution.goalId !== goal.id ||
      execution.goalRevision !== goal.revision ||
      thread?.agent !== agent
    )
      throw new Error("stale committed Turn RPC rejected");
  }
  const input = asRecord(params);
  if (method === "goal.handoff.validate") {
    const candidate = String(input.candidateMessage ?? "");
    const candidateMessageId = String(input.candidateMessageId ?? "");
    deps.ledger.appendEvent({
      streamId: `turn:${turnId}`,
      ts: deps.now(),
      actor: agent,
      type: "rpc.goal.handoff.validate",
      data: {
        attemptId: handoffAttemptId!,
        handoff: input.handoff ?? null,
        candidateMessageId,
        candidateMessagePresent: Boolean(candidate.trim()),
        candidateMessageChars: candidate.length,
      },
      ignorable: true,
    });
    return deps.handoff.validateDraft(
      deps.ledger,
      turnId,
      handoffAttemptId!,
      agent,
      execution,
      context,
      input,
    ) as unknown as JsonValue;
  }
  const profile = deps.profiles.get(agent) ?? { agent, role: "child" as const };
  const allowed = new Set(profile.capabilities ?? defaultCapabilities(profile.role));
  if (!allowed.has(method))
    throw new Error(`${profile.role} agent is not allowed to call ${method}`);
  if (!context.goalCommitment && goalBoundCapability(method))
    throw new Error(`${method} requires a Goal commitment`);
  deps.ledger.appendEvent({
    streamId: `turn:${turnId}`,
    ts: deps.now(),
    actor: agent,
    type: `rpc.${method}`,
    data: params,
    ignorable: true,
  });
  if (method === "ledger.search")
    return deps.ledger.searchEvents(
      requireString("ledger.search", input, "query"),
      optionalNumber("ledger.search", input, "limit", 20),
    ) as unknown as JsonValue;
  if (method === "team.list") return deps.teamList() as unknown as JsonValue;
  if (method === "goal.get") {
    const visibleId = context.goalCommitment?.goalId ?? context.activeGoal?.id;
    return (visibleId ? deps.ledger.goal(visibleId) : null) as unknown as JsonValue;
  }
  if (method === "goal.create") {
    if (context.trigger.kind !== "user_message" || context.goalCommitment || agent !== "ceo")
      throw new Error("Root Goal creation requires an uncommitted direct CEO Turn");
    const goal = deps.createRootGoal(
      requireString("goal.create", input, "objective"),
      typeof input.id === "string" ? input.id : undefined,
      turnId,
    );
    context.activeGoal = goal;
    context.goalCommitment = { goalId: goal.id, goalRevision: goal.revision };
    deps.ledger.commitTurnToGoal(turnId, context.goalCommitment, "supervisor");
    return { goal, goalCommitment: context.goalCommitment } as unknown as JsonValue;
  }
  if (method === "goal.work") {
    if (context.trigger.kind !== "user_message" || context.goalCommitment)
      throw new Error("work_on_goal requires an uncommitted direct CEO Turn");
    const goal = deps.goal(requireString("goal.work", input, "goalId"));
    if (goal.phase !== "active" || !deps.validGoalOwner(agent, goal))
      throw new Error("work_on_goal requires the active owned Root Goal");
    context.activeGoal = goal;
    context.goalCommitment = { goalId: goal.id, goalRevision: goal.revision };
    deps.ledger.commitTurnToGoal(turnId, context.goalCommitment, "supervisor");
    return { goal, goalCommitment: context.goalCommitment } as unknown as JsonValue;
  }
  if (method === "work_record.list") return deps.ledger.workRecords() as unknown as JsonValue;
  if (method === "work_record.read")
    return deps.ledger.workRecord(
      optionalString("work_record.read", input, "goalId") ??
        context.goalCommitment?.goalId ??
        context.activeGoal?.id ??
        "",
    ) as unknown as JsonValue;
  if (method === "work_record.history")
    return deps.ledger.workRecordHistory(
      optionalString("work_record.history", input, "goalId") ??
        context.goalCommitment?.goalId ??
        context.activeGoal?.id ??
        "",
    ) as unknown as JsonValue;
  if (method === "work_record.diff")
    return deps.ledger.workRecordDiff(
      optionalString("work_record.diff", input, "goalId") ??
        context.goalCommitment?.goalId ??
        context.activeGoal?.id ??
        "",
      requireNumber("work_record.diff", input, "fromRevision"),
      requireNumber("work_record.diff", input, "toRevision"),
    ) as unknown as JsonValue;
  if (method === "work_record.search")
    return deps.ledger.searchWorkRecords(
      requireString("work_record.search", input, "query"),
      optionalNumber("work_record.search", input, "limit", 20),
    ) as unknown as JsonValue;
  if (method === "work_record.update") {
    const binding = context.goalCommitment!;
    return deps.ledger.updateWorkRecord(
      {
        goalId: binding.goalId,
        goalRevision: binding.goalRevision,
        expectedRevision: requireNumber("work_record.update", input, "expectedRevision"),
        content: requireString("work_record.update", input, "content", { allowEmpty: true }),
        reason: requireString("work_record.update", input, "reason", { allowEmpty: true }),
        evidence: numberArray(input.evidence),
        turnId,
        ...(sourceWakeId ? { sourceWakeId } : {}),
      },
      agent,
    ) as unknown as JsonValue;
  }
  if (method === "goal.delegate") {
    const binding = context.goalCommitment!;
    if (requireString("goal.delegate", input, "parentGoalId") !== binding.goalId)
      throw new Error("delegation parent must be the Goal committed to this Turn");
    return deps.delegate(
      {
        id: requireString("goal.delegate", input, "id"),
        parentGoalId: binding.goalId,
        expectedParentRevision: requireNumber("goal.delegate", input, "expectedParentRevision"),
        childGoal: asChildGoal("goal.delegate", input.childGoal),
        brief: (input.brief ?? null) as JsonValue,
        reason: requireString("goal.delegate", input, "reason", { allowEmpty: true }),
        evidence: numberArray(input.evidence),
        sourceTurnId: turnId,
      },
      agent,
      sourceWakeId,
    ) as unknown as JsonValue;
  }
  if (method === "goal.reassign") {
    const goal = deps.goal(requireString("goal.reassign", input, "goalId"));
    if (goal.parentId !== context.goalCommitment!.goalId)
      throw new Error("reassignment target must be a child of the Goal committed to this Turn");
    return (await deps.reassignGoal(
      {
        id: requireString("goal.reassign", input, "id"),
        goalId: goal.id,
        expectedGoalRevision: requireNumber("goal.reassign", input, "expectedGoalRevision"),
        newOwner: requireString("goal.reassign", input, "newOwner"),
        brief: (input.brief ?? null) as JsonValue,
        reason: requireString("goal.reassign", input, "reason", { allowEmpty: true }),
        evidence: numberArray(input.evidence),
        sourceTurnId: turnId,
      },
      agent,
      sourceWakeId,
    )) as unknown as JsonValue;
  }
  if (method === "goal.revise")
    return deps.reviseChildGoal(
      requireString("goal.revise", input, "goalId"),
      requireString("goal.revise", input, "objective"),
      requireString("goal.revise", input, "observationMethod"),
      requireString("goal.revise", input, "verificationMethod"),
      agent,
      requireString("goal.revise", input, "reason"),
      numberArray(input.evidence),
      sourceWakeId,
      turnId,
    ) as unknown as JsonValue;
  if (method === "goal.pause" || method === "goal.resume") {
    const goal = deps.goal(requireString(method, input, "goalId"));
    const directRoot =
      !context.goalCommitment && context.trigger.kind === "user_message" && goal.parentId === null;
    if (!context.goalCommitment && !directRoot)
      throw new Error(`${method} requires a Goal commitment`);
    const next = deps.transitionGoal(
      goal.id,
      method === "goal.pause" ? "paused" : "active",
      directRoot ? "human" : agent,
      !directRoot,
      turnId,
    );
    if (method === "goal.resume" && directRoot) {
      context.activeGoal = next;
      context.goalCommitment = { goalId: next.id, goalRevision: next.revision };
      deps.ledger.commitTurnToGoal(turnId, context.goalCommitment, "supervisor");
      return { goal: next, goalCommitment: context.goalCommitment } as unknown as JsonValue;
    }
    return next as unknown as JsonValue;
  }
  if (method === "goal.complete") {
    const goal = deps.goal(requireString("goal.complete", input, "goalId"));
    const directRoot =
      !context.goalCommitment && context.trigger.kind === "user_message" && goal.parentId === null;
    if (!context.goalCommitment && !directRoot)
      throw new Error("goal.complete requires a Goal commitment or direct Human Root authority");
    return deps.completeGoal(
      {
        goalId: goal.id,
        revision: requireNumber("goal.complete", input, "revision"),
        reason: requireString("goal.complete", input, "reason", { allowEmpty: true }),
        evidence: numberArray(input.evidence),
        sourceTurnId: turnId,
      },
      directRoot ? "human" : agent,
      sourceWakeId,
    ) as unknown as JsonValue;
  }
  if (method === "mail.send") {
    const to = requireString("mail.send", input, "to");
    if (!deps.knownAgent(to))
      throw new Error(`unknown Agent recipient: ${to}; Mail addresses Agents only`);
    const goalId = (optionalString("mail.send", input, "goalId") ?? "").trim();
    if (!goalId) throw new Error("Agent Mail requires a Goal route");
    const goal = deps.goal(goalId);
    if (!deps.validGoalOwner(to, goal))
      throw new Error("Agent Mail Goal route does not match the recipient role and ownership");
    if (input.level !== "fyi" && input.level !== "decision" && input.level !== "emergency")
      throw new Error(`invalid parameter level for mail.send`);
    const mail: MailSnapshot = {
      id: randomUUID(),
      to,
      from: agent,
      level: input.level,
      ...goalRoute(goalId),
      body: (input.body ?? null) as JsonValue,
      readAt: null,
    };
    deps.ledger.putMail(mail, agent, sourceWakeId);
    return mail as unknown as JsonValue;
  }
  if (method === "schedule.set")
    return (deps.planWake(
      agent,
      requireString("schedule.set", input, "at"),
      requireString("schedule.set", input, "reason", { allowEmpty: true }),
      agent,
      context.goalCommitment ?? undefined,
    ) ?? { scheduled: true }) as unknown as JsonValue;
  if (method === "goal.put") {
    const candidate = input.goal;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
      throw new Error(`missing parameter goal for goal.put`);
    if (typeof candidate.owner !== "string" || !candidate.owner.trim())
      throw new Error(`invalid parameter goal.owner for goal.put`);
    if (typeof candidate.id !== "string" || !candidate.id.trim())
      throw new Error(`invalid parameter goal.id for goal.put`);
    const next = candidate as unknown as GoalSnapshot;
    if (!deps.validGoalOwner(next.owner, next))
      throw new Error("Goal owner role does not match Root/Child position");
    const current = deps.ledger.goal(next.id);
    const operation = !current
      ? "create"
      : current.phase !== next.phase
        ? next.phase === "paused"
          ? "pause"
          : next.phase === "active"
            ? "resume"
            : next.phase === "blocked"
              ? "block"
              : "complete"
        : current.owner !== next.owner
          ? "reassign"
          : "revise";
    deps.ledger.putGoal(next, agent, sourceWakeId, {
      operation,
      reason: optionalString("goal.put", input, "reason") ?? "Advanced Goal mutation",
      evidence: numberArray(input.evidence ?? []),
      sourceTurnId: turnId,
      ...(sourceWakeId ? { sourceWakeId } : {}),
    });
    return input.goal as JsonValue;
  }
  if (method === "memory.append") {
    const note = optionalString("memory.append", input, "note")?.trim() ?? "";
    if (!note) throw new Error("memory note cannot be empty");
    const event = deps.ledger.appendEvent({
      streamId: memoryStream(agent),
      ts: deps.now(),
      actor: agent,
      type: "memory.appended",
      data: { note, turnId },
    });
    return { seq: event.seq } as unknown as JsonValue;
  }
  throw new Error(`unsupported Agent capability: ${method}`);
}

function goalBoundCapability(method: AgentCapability): boolean {
  return [
    "goal.delegate",
    "goal.reassign",
    "goal.revise",
    "goal.put",
    "work_record.update",
    "schedule.set",
  ].includes(method);
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("RPC params must be an object");
  return value;
}

function requireString(
  method: string,
  input: Record<string, JsonValue>,
  name: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = input[name];
  if (value === undefined) throw new Error(`missing parameter ${name} for ${method}`);
  if (typeof value !== "string") throw new Error(`invalid parameter ${name} for ${method}`);
  if (!options.allowEmpty && !value.trim())
    throw new Error(`invalid parameter ${name} for ${method}`);
  return value;
}

function optionalString(
  method: string,
  input: Record<string, JsonValue>,
  name: string,
): string | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`invalid parameter ${name} for ${method}`);
  return value;
}

function requireNumber(method: string, input: Record<string, JsonValue>, name: string): number {
  const value = input[name];
  if (value === undefined) throw new Error(`missing parameter ${name} for ${method}`);
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`invalid parameter ${name} for ${method}`);
  return value;
}

function optionalNumber(
  method: string,
  input: Record<string, JsonValue>,
  name: string,
  fallback: number,
): number {
  const value = input[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`invalid parameter ${name} for ${method}`);
  return value;
}

function numberArray(value: JsonValue | undefined): number[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "number"))
    throw new Error("RPC evidence must be a number array");
  return value as number[];
}

function asChildGoal(
  method: string,
  value: JsonValue | undefined,
): {
  id: string;
  objective: string;
  observationMethod: string;
  verificationMethod: string;
  owner: string;
} {
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`missing parameter childGoal for ${method}`);
  const input = asRecord(value);
  const field = (name: string): string => {
    const child = input[name];
    if (child === undefined) throw new Error(`missing parameter childGoal.${name} for ${method}`);
    if (typeof child !== "string" || !child.trim())
      throw new Error(`invalid parameter childGoal.${name} for ${method}`);
    return child;
  };
  return {
    id: field("id"),
    objective: field("objective"),
    observationMethod: field("observationMethod"),
    verificationMethod: field("verificationMethod"),
    owner: field("owner"),
  };
}
