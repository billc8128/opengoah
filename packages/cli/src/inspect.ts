import { homedir } from "node:os";
import { type EventRecord, type JsonValue, type RequestSnapshot, type TurnItemSnapshot, type TurnSnapshot } from "goah-ledger-contract";
import type { SqliteLedger } from "goah-ledger-sqlite";

export interface SessionListItem {
  sessionId: string;
  agent: string;
  status: "idle" | "in_progress";
  turnCount: number;
  itemCount: number;
  toolCalls: number;
  updatedAt: string;
}

export interface SessionDetail {
  session: SessionListItem;
  turns: Array<TurnSnapshot & { items: TurnItemSnapshot[] }>;
}

export interface SessionContextSnapshot {
  eventSeq: number;
  provider: string;
  model: string;
  systemPrompt: string;
  text: string;
  sourceSeqs: number[];
  toolCount: number;
  messageCount: number;
  modelConfig: JsonValue;
}

export interface SessionExport {
  format: "goah.session-export.v2";
  exportedAt: string;
  redacted: boolean;
  session: SessionListItem;
  events: EventRecord[];
}

export function listSessions(ledger: SqliteLedger): SessionListItem[] {
  return ledger.sessions().map((session) => summarizeSession(ledger, session.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function showSession(ledger: SqliteLedger, sessionId: string): SessionDetail {
  if (!ledger.session(sessionId)) throw new Error(`session not found: ${sessionId}`);
  return { session: summarizeSession(ledger, sessionId), turns: ledger.turns(sessionId).map((turn) => ({ ...turn, items: ledger.turnItems(turn.id) })) };
}

export function replayWakeSession(ledger: SqliteLedger, sessionId: string): SessionDetail {
  return showSession(ledger, sessionId);
}

export function showSessionContext(ledger: SqliteLedger, wakeId: string): SessionContextSnapshot | null {
  if (!ledger.turn(wakeId)) throw new Error(`turn not found: ${wakeId}`);
  return contextSnapshot(ledger.readStream(`turn:${wakeId}`));
}

export function streamEvents(ledger: SqliteLedger, streamId: string, fromStreamSeq = 1): EventRecord[] {
  if (!streamId.trim()) throw new Error("--stream is required");
  if (!Number.isInteger(fromStreamSeq) || fromStreamSeq < 1) throw new Error("--from must be a positive integer");
  return ledger.readStream(streamId, fromStreamSeq);
}

export function exportSession(ledger: SqliteLedger, sessionId: string, options: { raw?: boolean; now?: string } = {}): SessionExport {
  const detail = showSession(ledger, sessionId);
  const value: SessionExport = {
    format: "goah.session-export.v2",
    exportedAt: options.now ?? new Date().toISOString(),
    redacted: !options.raw,
    session: detail.session,
    events: ledger.turns(sessionId).flatMap((turn) => ledger.readStream(`turn:${turn.id}`)).sort((a,b) => a.seq-b.seq),
  };
  return options.raw ? value : redactValue(value) as unknown as SessionExport;
}

export function redactValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]));
  if (typeof value !== "string") return value;
  return value
    .replaceAll(homedir(), "<HOME>")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|ak|key)[-_][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]");
}

function summarizeSession(ledger: SqliteLedger, sessionId: string): SessionListItem {
  const session = ledger.session(sessionId); if (!session) throw new Error(`session not found: ${sessionId}`); const turns = ledger.turns(sessionId); const items = turns.flatMap((turn) => ledger.turnItems(turn.id));
  return { sessionId,agent:session.agent,status:turns.some((turn) => turn.status === "in_progress") ? "in_progress" : "idle",turnCount:turns.length,itemCount:items.length,toolCalls:items.filter((item) => item.type === "tool_call").length,updatedAt:session.updatedAt };
}

function contextSnapshot(events: EventRecord[]): SessionContextSnapshot | null {
  const event = events.findLast((candidate) => candidate.type === "request.prepared");
  if (!event) return null;
  const request = event.data as unknown as RequestSnapshot;
  return {
    eventSeq: event.seq,
    provider: request.provider,
    model: request.model,
    systemPrompt: request.systemPrompt,
    text: request.activeContext,
    sourceSeqs: request.sourceSeqs,
    toolCount: request.tools.length,
    messageCount: request.messages.length,
    modelConfig: request.modelConfig,
  };
}

const SENSITIVE_KEY = /^(?:api[_-]?key|token|secret|password|authorization|cookie|set-cookie)$/i;
