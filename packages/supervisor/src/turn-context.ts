// Turn context assembly: renders the durable context each Runner request sees.
// Extracted verbatim from index.ts; behavior is unchanged.
import {
  goalAutomaticTarget,
  memoryStream,
  type AgentCapability,
  type AgentProfile,
  type AgentRole,
  type AutomaticTarget,
  type GoalSnapshot,
  type JsonValue,
  type Ledger,
  type MailSnapshot,
  type RunnerProfile,
  type TeamMemberView,
  type TurnContext,
  type WakeSnapshot,
  type WakeTriggerSnapshot,
} from "goah-ledger-contract";
import { composeActiveContext, selectRecoveryEvents, selectWorkingMemory } from "./context-view.js";
import { defaultTurnPrompt } from "./roles.js";
import { childRetryExhaustedTurnId, parseRecoveryTrigger } from "./recovery.js";

/** Supervisor state the context assembly reads. */
export interface TurnContextDeps {
  ledger: Ledger;
  profiles: ReadonlyMap<string, AgentProfile>;
  runnerProfiles: ReadonlyMap<string, RunnerProfile>;
  memoryTailChars: number;
  role(agent: string): AgentRole;
  goal(id: string): GoalSnapshot;
  currentRoot(): GoalSnapshot | null;
  teamList(): TeamMemberView[];
}

export function defaultCapabilities(role: AgentRole): AgentCapability[] {
  if (role === "ceo")
    return [
      "ledger.search",
      "mail.send",
      "schedule.set",
      "team.list",
      "goal.get",
      "goal.create",
      "goal.work",
      "goal.delegate",
      "goal.reassign",
      "goal.revise",
      "goal.pause",
      "goal.resume",
      "goal.complete",
      "work_record.list",
      "work_record.read",
      "work_record.history",
      "work_record.diff",
      "work_record.search",
      "work_record.update",
    ];
  if (role === "verifier" || role === "audit")
    return ["ledger.search", "mail.send", "memory.append"];
  return [
    "ledger.search",
    "mail.send",
    "schedule.set",
    "goal.get",
    "work_record.list",
    "work_record.read",
    "work_record.history",
    "work_record.diff",
    "work_record.search",
    "work_record.update",
  ];
}

function boundedJson(value: JsonValue, maxChars = 2_000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

export function turnHistory(ledger: Ledger, turnId: string): string {
  const items = ledger.turnItems(turnId).map((item) => {
    const data = item.data as { text?: unknown; tool?: unknown; result?: unknown };
    if (item.type === "user_message") return `Human: ${String(data.text ?? "")}`;
    if (item.type === "assistant_message") return `Assistant: ${String(data.text ?? "")}`;
    if (item.type === "tool_call")
      return `Tool call: ${String(data.tool ?? "")} ${JSON.stringify(item.data)}`;
    if (item.type === "tool_result")
      return `Tool result: ${JSON.stringify(data.result ?? item.data)}`;
    return `${item.type}: ${JSON.stringify(item.data)}`;
  });
  const facts = ledger
    .readStream(`turn:${turnId}`)
    .filter((event) => event.type === "turn.retry_started")
    .map((event) => `${event.type}: ${JSON.stringify(event.data)}`);
  return [...items, ...facts].join("\n");
}

export function loadContext(
  deps: TurnContextDeps,
  wake: AutomaticTarget & { attempt: number },
  turn: TurnContext,
  mail: MailSnapshot[],
  wakeTriggers: WakeTriggerSnapshot[],
): JsonValue {
  const profile: AgentProfile = deps.profiles.get(wake.agent) ?? {
    agent: wake.agent,
    role: "child",
  };
  const role = profile.role;
  const capabilities = profile.capabilities ?? defaultCapabilities(role);
  const runnerProfile = deps.runnerProfiles.get(profile.runnerProfile ?? "default");
  const goals = role === "ceo" ? deps.ledger.goals() : deps.ledger.goalsForOwner(wake.agent);
  const handoff = turn.goalCommitment
    ? deps.ledger.lastGoalHandoff(turn.goalCommitment.goalId)
    : null;
  const recoveryIds = [
    ...new Set(
      wakeTriggers.flatMap((trigger) => {
        const parsed = parseRecoveryTrigger(trigger.triggerRef);
        const exhausted = childRetryExhaustedTurnId(trigger.triggerRef);
        return parsed ? [parsed.turnId] : exhausted ? [exhausted] : [];
      }),
    ),
  ];
  const recoveryEvents = recoveryIds.flatMap((recoveryId) =>
    selectRecoveryEvents(
      deps.ledger.turn(recoveryId)
        ? deps.ledger.readStream(`turn:${recoveryId}`)
        : deps.ledger.eventsForWake(recoveryId),
    ),
  );
  const teamHandoffs =
    role === "ceo"
      ? [...deps.ledger.eventsSince(0, ["handoff.recorded"])]
          .reverse()
          .filter(
            (event, index, all) =>
              all.findIndex((candidate) => candidate.actor === event.actor) === index,
          )
      : [];
  const workingMemory = selectWorkingMemory(
    deps.ledger.readStream(memoryStream(wake.agent)),
    deps.memoryTailChars,
  );
  const active = composeActiveContext({
    role,
    capabilities,
    systemPrompt: profile.systemPrompt ?? defaultTurnPrompt(role, wake.agent, turn),
    wake,
    wakeTriggers,
    goals,
    mail,
    lastHandoff: handoff,
    teamHandoffs,
    team: role === "ceo" ? deps.teamList() : [],
    recoveryEvents,
    workingMemory,
  });
  const records = deps.ledger.workRecords();
  const currentRecord = turn.goalCommitment
    ? deps.ledger.workRecord(turn.goalCommitment.goalId)
    : null;
  const currentGoal = turn.goalCommitment ? deps.ledger.goal(turn.goalCommitment.goalId) : null;
  const parentRecord = currentGoal?.parentId ? deps.ledger.workRecord(currentGoal.parentId) : null;
  const recordIndex = records.map(
    (record) =>
      `- /goals/${record.goalId}.md · r${record.recordRevision} · ${deps.ledger.goal(record.goalId)?.owner ?? "unknown"} · ${deps.ledger.goal(record.goalId)?.phase ?? "unknown"}`,
  );
  const workText = [
    `# Shared Work Record Index\n\n${recordIndex.join("\n")}`,
    ...(currentRecord ? [`# Your Work Record\n\n${currentRecord.content}`] : []),
    ...(parentRecord ? [`# Parent Work Record\n\n${parentRecord.content}`] : []),
  ].join("\n\n");
  return {
    ...active,
    text: `${active.text}\n\n${workText}`,
    activeGoal: turn.activeGoal,
    goalCommitment: turn.goalCommitment,
    sourceSeqs: [
      ...new Set([
        ...active.sourceSeqs,
        ...mailSourceSeqs(deps.ledger, mail),
        ...records.map((record) => record.lastEventSeq),
      ]),
    ].sort((a, b) => a - b),
    workRecord: currentRecord,
    sharedWorkRecords: records,
    ...(runnerProfile ? { runnerProfile } : {}),
  } as unknown as JsonValue;
}

export function humanContext(
  deps: TurnContextDeps,
  turnId: string,
  agent: string,
  mail: MailSnapshot[],
): JsonValue {
  const turn = deps.ledger.turn(turnId)!;
  const current = turnHistory(deps.ledger, turn.id);
  const turnSourceSeqs = deps.ledger
    .readStream(`turn:${turn.id}`)
    .filter((event) => event.type === "item.user_message.started")
    .map((event) => event.seq);
  if (turn.goalId !== null && turn.goalRevision !== null) {
    const goal = deps.goal(turn.goalId);
    const context: TurnContext = {
      trigger: { kind: "user_message" },
      activeGoal: goal,
      goalCommitment: { goalId: turn.goalId, goalRevision: turn.goalRevision },
    };
    const base = loadContext(
      deps,
      { ...goalAutomaticTarget(agent, turn.goalId), attempt: turn.attempt },
      context,
      mail,
      [],
    ) as Record<string, JsonValue>;
    const sourceSeqs = Array.isArray(base.sourceSeqs)
      ? base.sourceSeqs.filter((value): value is number => typeof value === "number")
      : [];
    return {
      ...base,
      text: `${String(base.text ?? "")}\n\n# Current Turn\n\n${current}`,
      sourceSeqs: [...new Set([...sourceSeqs, ...turnSourceSeqs])].sort((a, b) => a - b),
    } as unknown as JsonValue;
  }
  const profile = deps.profiles.get(agent) ?? { agent, role: "ceo" as const };
  const runnerProfile = deps.runnerProfiles.get(profile.runnerProfile ?? "default");
  const recent = deps.ledger
    .turns(turn.threadId)
    .filter((candidate) => candidate.id !== turn.id && candidate.status === "completed")
    .slice(-8)
    .flatMap((candidate) =>
      deps.ledger
        .turnItems(candidate.id)
        .filter((item) => item.type === "user_message" || item.type === "assistant_message")
        .map(
          (item) =>
            `${item.type === "user_message" ? "Human" : "Assistant"}: ${String((item.data as { text?: unknown }).text ?? "")}`,
        ),
    );
  const sourceSeqs = [...turnSourceSeqs, ...mailSourceSeqs(deps.ledger, mail)];
  const incoming = mail.map(
    (item) => `- [${item.level}] ${item.id} from ${item.from}: ${boundedJson(item.body)}`,
  );
  const activeGoal = deps.currentRoot();
  const context: TurnContext = {
    trigger: { kind: "user_message" },
    activeGoal,
    goalCommitment: null,
  };
  const goalText = activeGoal
    ? [
        `# Active Goal context\n\n[${activeGoal.id}] ${activeGoal.objective} (phase: ${activeGoal.phase}, revision: ${activeGoal.revision}). This is visible context, not a commitment to advance it.`,
      ]
    : [];
  return {
    text: [
      ...(recent.length ? [`# Recent conversation\n\n${recent.join("\n")}`] : []),
      ...goalText,
      ...(incoming.length ? [`# Incoming\n\n${incoming.join("\n")}`] : []),
      `# Current Turn\n\n${current}`,
    ].join("\n\n"),
    sourceSeqs,
    activeGoal,
    capabilities: profile.capabilities ?? defaultCapabilities(profile.role),
    systemPrompt: profile.systemPrompt ?? defaultTurnPrompt(profile.role, agent, context),
    ...(runnerProfile ? { runnerProfile } : {}),
  } as unknown as JsonValue;
}

export function goalContext(
  deps: TurnContextDeps,
  wake: WakeSnapshot,
  turn: TurnContext,
  turnId: string,
  mail: MailSnapshot[],
  wakeTriggers: WakeTriggerSnapshot[],
): JsonValue {
  const base = loadContext(deps, wake, turn, mail, wakeTriggers);
  if (!base || typeof base !== "object" || Array.isArray(base)) return base;
  const value = base as Record<string, JsonValue>;
  const history = turnHistory(deps.ledger, turnId);
  return {
    ...value,
    ...(history
      ? { text: `${String(value.text ?? "")}\n\n# Current Turn retry history\n\n${history}` }
      : {}),
  };
}

export function turnContextForWake(
  deps: TurnContextDeps,
  wake: WakeSnapshot,
  triggers = deps.ledger.wakeTriggers(wake.id).filter((trigger) => trigger.status === "pending"),
): TurnContext {
  const trigger = { kind: "wake" as const, reasons: triggers.map((item) => item.triggerRef) };
  if (wake.targetKind === "specialist") return { trigger, activeGoal: null, goalCommitment: null };
  const goal = deps.goal(wake.goalId);
  return {
    trigger,
    activeGoal: goal,
    goalCommitment: { goalId: goal.id, goalRevision: goal.revision },
  };
}

export function contextMail(
  deps: TurnContextDeps,
  agent: string,
  goalId: string | null,
): MailSnapshot[] {
  const selected: MailSnapshot[] = [];
  let used = 0;
  const role = deps.role(agent);
  const matches = (mail: MailSnapshot) =>
    goalId
      ? mail.routeKind === "goal" && mail.goalId === goalId
      : role === "ceo"
        ? mail.routeKind === "ceo_inbox"
        : mail.routeKind === "specialist_inbox" && mail.specialistRole === role;
  for (const mail of deps.ledger.unreadMail(agent).filter(matches)) {
    const cost = Math.min(JSON.stringify(mail.body).length, 2_000) + 128;
    if (selected.length >= 20 || (selected.length > 0 && used + cost > deps.memoryTailChars)) break;
    selected.push(mail);
    used += cost;
  }
  return selected;
}

export function mailSourceSeqs(ledger: Ledger, mail: MailSnapshot[]): number[] {
  const ids = new Set(mail.map((item) => item.id));
  if (!ids.size) return [];
  return ledger
    .eventsSince(0, ["mail.put"])
    .filter((event) => {
      const data =
        event.data && typeof event.data === "object" && !Array.isArray(event.data)
          ? (event.data as { snapshot?: { id?: unknown } })
          : {};
      return typeof data.snapshot?.id === "string" && ids.has(data.snapshot.id);
    })
    .map((event) => event.seq);
}
