import type { EventInput, EventRecord, JsonValue } from "./kernel.js";

export const TRANSCRIPT_FORMAT_VERSION = 1;
export const TRANSCRIPT_MIN_READABLE_VERSION = 0;
export type TranscriptEventType = "transcript.started" | "request.prepared" | "turn.started" | "message.user" | "message.assistant.delta" | "message.assistant.completed" | "tool.called" | "tool.completed" | "context.compacted" | "turn.completed" | "transcript.completed" | "transcript.interrupted";
export interface TranscriptStarted { formatVersion: typeof TRANSCRIPT_FORMAT_VERSION; provider: string; model: string; runner: string; contextWindowTokens: number; maxOutputTokensPerTurn: number }
export interface TranscriptMessage { id: string; role: "user" | "assistant" | "tool"; content: JsonValue; toolCallId?: string; usage?: JsonValue; stopReason?: string; errorMessage?: string }
export interface RequestSnapshot { provider: string; model: string; systemPrompt: string; activeContext: string; messages: JsonValue[]; tools: JsonValue[]; modelConfig: JsonValue; sourceSeqs: number[] }
export interface ReplayedTranscript { messages: TranscriptMessage[]; status: "running" | "completed" | "interrupted"; openToolCalls: Array<{ callId: string; name: string; arguments: JsonValue }>; lastRequest: RequestSnapshot | null }

const TRANSCRIPT_TYPES = new Set<TranscriptEventType>(["transcript.started", "request.prepared", "turn.started", "message.user", "message.assistant.delta", "message.assistant.completed", "tool.called", "tool.completed", "context.compacted", "turn.completed", "transcript.completed", "transcript.interrupted"]);
export function isTranscriptEvent(event: Pick<EventRecord, "type">): event is EventRecord & { type: TranscriptEventType } { return TRANSCRIPT_TYPES.has(event.type as TranscriptEventType); }

export class TranscriptFormatUnsupportedError extends Error {
  constructor(readonly foundVersion: number, readonly supportedVersion = TRANSCRIPT_FORMAT_VERSION) { super(`transcript format ${foundVersion} is unsupported by this harness (supports ${supportedVersion}); upgrade the harness`); this.name = "TranscriptFormatUnsupportedError"; }
}
export class TranscriptEventUnsupportedError extends Error { constructor(readonly eventType: string) { super(`required transcript event is unknown to this harness: ${eventType}`); this.name = "TranscriptEventUnsupportedError"; } }
export class TranscriptCorruptionError extends Error { constructor(message: string) { super(message); this.name = "TranscriptCorruptionError"; } }

/** Import supported legacy records without rewriting the append-only source log. */
export function upgradeTranscriptEvents(source: readonly EventRecord[]): EventRecord[] {
  assertContiguous(source);
  const starts = source.filter((event) => event.type === "transcript.started");
  if (starts.length === 0) {
    if (source.some((event) => isTranscriptNamespace(event.type))) throw new TranscriptCorruptionError("transcript events exist without transcript.started");
    return [...source];
  }
  if (starts.length !== 1) throw new TranscriptCorruptionError("turn transcript stream contains multiple transcript.started events");
  const rawVersion = field(starts[0]!.data, "formatVersion");
  let version = rawVersion === undefined ? 0 : Number(rawVersion);
  if (!Number.isSafeInteger(version) || version < TRANSCRIPT_MIN_READABLE_VERSION) throw new TranscriptCorruptionError(`invalid transcript format version: ${String(rawVersion)}`);
  if (version > TRANSCRIPT_FORMAT_VERSION) throw new TranscriptFormatUnsupportedError(version);
  let events = [...source];
  while (version < TRANSCRIPT_FORMAT_VERSION) {
    if (version === 0) {
      events = events.map((event) => event.type === "transcript.started" ? { ...event, data: { ...(event.data as Record<string, JsonValue>), formatVersion: 1 } } : event);
      version = 1;
    } else throw new TranscriptFormatUnsupportedError(version);
  }
  for (const event of events) {
    if (!isTranscriptEvent(event) && isTranscriptNamespace(event.type) && event.ignorable !== true) throw new TranscriptEventUnsupportedError(event.type);
  }
  return events;
}

/** Rebuild the model-visible transcript from canonical, normalized transcript events. */
export function replayTranscript(events: readonly EventRecord[]): ReplayedTranscript {
  const upgraded = upgradeTranscriptEvents(events);
  const messages: TranscriptMessage[] = [];
  const calls = new Map<string, { callId: string; name: string; arguments: JsonValue }>();
  let status: ReplayedTranscript["status"] = "running";
  let lastRequest: RequestSnapshot | null = null;
  for (const event of upgraded) {
    if (!isTranscriptEvent(event)) continue;
    const data = event.data as Record<string, unknown>;
    if (event.type === "message.user" || event.type === "message.assistant.completed") messages.push(data.message as TranscriptMessage);
    else if (event.type === "tool.called") {
      const call = { callId: String(data.callId), name: String(data.name), arguments: (data.arguments ?? null) as JsonValue };
      calls.set(call.callId, call);
    } else if (event.type === "tool.completed") {
      const callId = String(data.callId);
      calls.delete(callId);
      messages.push({ id: String(data.messageId ?? `tool:${callId}`), role: "tool", toolCallId: callId, content: (data.result ?? null) as JsonValue });
    } else if (event.type === "context.compacted") {
      const replaced = new Set(Array.isArray(data.replacedMessageIds) ? data.replacedMessageIds.map(String) : []);
      const kept = messages.filter((message) => !replaced.has(message.id));
      messages.splice(0, messages.length, ...kept);
      messages.unshift({ id: String(data.summaryMessageId), role: "user", content: String(data.summary) });
    } else if (event.type === "request.prepared") lastRequest = event.data as unknown as RequestSnapshot;
    else if (event.type === "transcript.completed") status = "completed";
    else if (event.type === "transcript.interrupted") status = "interrupted";
  }
  return { messages, status, openToolCalls: [...calls.values()], lastRequest };
}

/** Synthetic facts that close an interrupted Turn transcript without hiding unknown tool outcomes. */
export function interruptedTranscriptEvents(events: readonly EventRecord[], ts: string, actor: string): EventInput[] {
  const replayed = replayTranscript(events);
  if (replayed.status !== "running" || !events.some((event) => event.type === "transcript.started")) return [];
  const streamId = events[0]!.streamId;
  const repairs: EventInput[] = replayed.openToolCalls.map((call) => ({ streamId, ts, actor, type: "tool.completed", data: { callId: call.callId, messageId: `repair:${call.callId}`, result: { outcome: "unknown", synthetic: true, reason: "runner interrupted before a durable result" } } }));
  repairs.push({ streamId, ts, actor, type: "transcript.interrupted", data: { reason: "runner interrupted" } });
  return repairs;
}

function assertContiguous(events: readonly EventRecord[]): void {
  let expected = events[0]?.streamSeq ?? 1;
  for (const event of events) {
    if (event.streamSeq !== expected) throw new TranscriptCorruptionError(`turn transcript stream gap: expected ${expected}, got ${event.streamSeq}`);
    expected += 1;
  }
}
function isTranscriptNamespace(type: string): boolean { return ["transcript.", "request.", "turn.", "message.", "tool.", "context."].some((prefix) => type.startsWith(prefix)); }
function field(value: unknown, key: string): unknown { return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }
