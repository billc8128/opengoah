import type { AgentCapability, AgentRole, EventRecord, GoalSnapshot, JsonValue, MailSnapshot, TeamMemberView, WakeSnapshot, WakeTriggerSnapshot } from "goah-ledger-contract";

export interface ActiveContextView {
  role: AgentRole;
  capabilities: AgentCapability[];
  systemPrompt: string;
  text: string;
  sourceSeqs: number[];
}

export interface ActiveContextInput {
  role: AgentRole;
  capabilities: AgentCapability[];
  systemPrompt: string;
  wake: WakeSnapshot;
  wakeTriggers: WakeTriggerSnapshot[];
  goals: GoalSnapshot[];
  mail: MailSnapshot[];
  lastHandoff: EventRecord | null;
  teamHandoffs: EventRecord[];
  team: TeamMemberView[];
  revisionWarnings: string[];
  recoveryEvents: EventRecord[];
  /** Durable agent-owned working-memory facts; injected as a bounded advisory tail. */
  workingMemory?: readonly EventRecord[];
}

/** Keep recovery actionable and bounded; raw Turn transcript remains queryable in the ledger. */
export function selectRecoveryEvents(events: EventRecord[]): EventRecord[] {
  const unknownCalls = new Set(events.filter((event) => event.type === "tool.completed" && field(field(event.data, "result"), "outcome") === "unknown").map((event) => String(field(event.data, "callId"))));
  return events.filter((event) => {
    if (["transcript.interrupted", "context.compacted", "ceo.motion_invalid"].includes(event.type)) return true;
    if (event.type === "tool.called") return unknownCalls.has(String(field(event.data, "callId")));
    if (event.type === "tool.completed") return unknownCalls.has(String(field(event.data, "callId")));
    return false;
  });
}

/** Keep the newest notes within a character budget; the full stream is never compacted. */
export function selectWorkingMemory(events: readonly EventRecord[], charBudget: number): EventRecord[] {
  const notes = events.filter((event) => event.type === "memory.appended");
  const tail: EventRecord[] = [];
  let used = 0;
  for (let index = notes.length - 1; index >= 0; index -= 1) {
    const event = notes[index]!;
    const length = String(field(event.data, "note") ?? "").length;
    if (tail.length > 0 && used + length > charBudget) break;
    tail.push(event);
    used += length;
  }
  return tail.reverse();
}

/** Deterministically render structured projections into the model's short working set. */
export function composeActiveContext(input: ActiveContextInput): ActiveContextView {
  const handoff = input.lastHandoff?.data as { outcome?: unknown } | undefined;
  const sourceSeqs = new Set<number>();
  if (input.lastHandoff) sourceSeqs.add(input.lastHandoff.seq);
  for (const event of input.teamHandoffs) sourceSeqs.add(event.seq);
  for (const event of input.recoveryEvents) sourceSeqs.add(event.seq);
  for (const event of input.workingMemory ?? []) sourceSeqs.add(event.seq);

  const sections: Array<[string, string[]]> = [
    ["Objectives", input.goals.map((goal) => `- [${goal.id}] ${goal.objective} (owner: ${goal.owner}, phase: ${goal.phase}, revision: ${goal.revision})`)],
    ["Observation methods", input.goals.map((goal) => `## ${goal.id}\n\n${goal.observationMethod ?? "MISSING — inspect the project and request authoritative confirmation before claiming progress or completion."}`)],
    ["Verification methods", input.goals.map((goal) => `## ${goal.id}\n\n${goal.verificationMethod ?? "MISSING — define authoritative completion evidence before claiming completion."}`)],
    ["Revision barriers", input.revisionWarnings.map((warning) => `- ${warning}`)],
    ["Wake", [...input.wakeTriggers.filter((trigger)=>trigger.status==="pending").map((trigger)=>`- [${trigger.source}] ${trigger.triggerRef}`), `- Attempt: ${input.wake.attempt}`]],
    ["Working memory", (input.workingMemory ?? []).map((event) => `- ${String(field(event.data, "note") ?? "")} [event:${event.seq}]`)],
    ["Last outcome", typeof handoff?.outcome === "string" ? [`- ${handoff.outcome}${input.lastHandoff ? ` [event:${input.lastHandoff.seq}]` : ""}`] : []],
    ["Incoming", input.mail.map((mail) => `- [${mail.level}] ${mail.id} from ${mail.from}: ${render(mail.body,2_000)}`)],
    ["Team motion", input.team.map((member) => `- ${member.agent}: ${member.status}; goals=${member.goalIds.join(",") || "none"}; next=${member.nextWakeAt ?? "none"}; handoff=${member.lastHandoffSeq ?? "none"}`)],
    ["Team handoffs", input.teamHandoffs.map((event) => `- ${event.actor}: ${render(event.data)} [event:${event.seq}]`)],
    ["Recovery", input.recoveryEvents.map((event) => `- ${event.type}: ${render(event.data)} [event:${event.seq}]`)],
  ];
  const text = sections.filter(([, values]) => values.length > 0).map(([title, values]) => `# ${title}\n\n${values.join("\n")}`).join("\n\n");
  return { role: input.role, capabilities: input.capabilities, systemPrompt: input.systemPrompt, text, sourceSeqs: [...sourceSeqs].sort((a, b) => a - b) };
}

function render(value: JsonValue,maxChars=Number.POSITIVE_INFINITY): string { const text=typeof value === "string" ? value : JSON.stringify(value);return text.length<=maxChars?text:`${text.slice(0,maxChars)}…`; }
function field(value: unknown, key: string): unknown { return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }
