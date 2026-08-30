import { replayTranscript, type EventRecord, type JsonValue, type ReplayedTranscript, type TurnItemSnapshot, type TurnSnapshot } from "goah-ledger-contract";
import type { SqliteLedger } from "goah-ledger-sqlite";
import { redactSensitiveValue } from "./sensitive-text.js";

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
  turns: Array<TurnSnapshot & { items: TurnItemSnapshot[]; transcript:ReplayedTranscript|null }>;
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
  return { thread: summarizeThread(ledger, threadId), turns: ledger.turns(threadId).map((turn) => {const events=ledger.readStream(`turn:${turn.id}`);return{...turn,leaseToken:null,items:ledger.turnItems(turn.id),transcript:events.some((event)=>event.type==="transcript.started")?replayTranscript(events):null};}) };
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
  return redactSensitiveValue(value,key);
}

function summarizeThread(ledger: SqliteLedger, threadId: string): ThreadListItem {
  const thread = ledger.thread(threadId); if (!thread) throw new Error(`thread not found: ${threadId}`); const turns = ledger.turns(threadId); const items = turns.flatMap((turn) => ledger.turnItems(turn.id));
  return { threadId,agent:thread.agent,status:turns.some((turn) => turn.status === "in_progress") ? "in_progress" : "idle",turnCount:turns.length,itemCount:items.length,toolCalls:items.filter((item) => item.type === "tool_call").length,updatedAt:thread.updatedAt };
}

function contextSnapshot(events: EventRecord[]): TurnContextSnapshot | null {
  const event = events.findLast((candidate) => candidate.type === "request.prepared");
  if (!event) return null;
  const request = replayTranscript(events).lastRequest;
  if(!request)return null;
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
