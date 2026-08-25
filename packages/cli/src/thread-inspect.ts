import { homedir } from "node:os";
import { type EventRecord, type JsonValue, type RequestSnapshot, type TurnItemSnapshot, type TurnSnapshot } from "goah-ledger-contract";
import type { SqliteLedger } from "goah-ledger-sqlite";

export interface ThreadListItem {
  threadId: string;
  agent: string;
  status: "idle" | "in_progress";
  turnCount: number;
  itemCount: number;
  toolCalls: number;
  updatedAt: string;
}

export interface ThreadDetail {
  thread: ThreadListItem;
  turns: Array<TurnSnapshot & { items: TurnItemSnapshot[] }>;
}

export interface TurnContextSnapshot {
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

export interface ThreadExport {
  format: "goah.thread-export.v1";
  exportedAt: string;
  redacted: boolean;
  thread: ThreadListItem;
  events: EventRecord[];
}

export function listThreads(ledger: SqliteLedger): ThreadListItem[] {
  return ledger.threads().map((thread) => summarizeThread(ledger, thread.id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function showThread(ledger: SqliteLedger, threadId: string): ThreadDetail {
  if (!ledger.thread(threadId)) throw new Error(`thread not found: ${threadId}`);
  return { thread: summarizeThread(ledger, threadId), turns: ledger.turns(threadId).map((turn) => ({ ...turn, items: ledger.turnItems(turn.id) })) };
}

export function replayThread(ledger: SqliteLedger, threadId: string): ThreadDetail {
  return showThread(ledger, threadId);
}

export function showTurnContext(ledger: SqliteLedger, turnId: string): TurnContextSnapshot | null {
  if (!ledger.turn(turnId)) throw new Error(`turn not found: ${turnId}`);
  return contextSnapshot(ledger.readStream(`turn:${turnId}`));
}

export function streamEvents(ledger: SqliteLedger, streamId: string, fromStreamSeq = 1): EventRecord[] {
  if (!streamId.trim()) throw new Error("--stream is required");
  if (!Number.isInteger(fromStreamSeq) || fromStreamSeq < 1) throw new Error("--from must be a positive integer");
  return ledger.readStream(streamId, fromStreamSeq);
}

export function exportThread(ledger: SqliteLedger, threadId: string, options: { raw?: boolean; now?: string } = {}): ThreadExport {
  const detail = showThread(ledger, threadId);
  const value: ThreadExport = {
    format: "goah.thread-export.v1",
    exportedAt: options.now ?? new Date().toISOString(),
    redacted: !options.raw,
    thread: detail.thread,
    events: ledger.turns(threadId).flatMap((turn) => ledger.readStream(`turn:${turn.id}`)).sort((a,b) => a.seq-b.seq),
  };
  return options.raw ? value : redactValue(value) as unknown as ThreadExport;
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

function summarizeThread(ledger: SqliteLedger, threadId: string): ThreadListItem {
  const thread = ledger.thread(threadId); if (!thread) throw new Error(`thread not found: ${threadId}`); const turns = ledger.turns(threadId); const items = turns.flatMap((turn) => ledger.turnItems(turn.id));
  return { threadId,agent:thread.agent,status:turns.some((turn) => turn.status === "in_progress") ? "in_progress" : "idle",turnCount:turns.length,itemCount:items.length,toolCalls:items.filter((item) => item.type === "tool_call").length,updatedAt:thread.updatedAt };
}

function contextSnapshot(events: EventRecord[]): TurnContextSnapshot | null {
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
