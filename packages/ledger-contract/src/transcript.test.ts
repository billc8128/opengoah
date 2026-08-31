import assert from "node:assert/strict";
import test from "node:test";
import {
  interruptedTranscriptEvents,
  replayTranscript,
  requestComponentHash,
  TRANSCRIPT_FORMAT_VERSION,
  TranscriptCorruptionError,
  TranscriptEventUnsupportedError,
  TranscriptFormatUnsupportedError,
  type EventRecord,
  type JsonValue,
  type RequestComponentKind,
} from "./index.js";

function event(
  streamSeq: number,
  type: string,
  data: EventRecord["data"],
  ignorable = false,
): EventRecord {
  return {
    seq: streamSeq,
    streamId: "wake:w",
    streamSeq,
    ts: "2030-01-01T00:00:00.000Z",
    actor: "worker",
    type,
    data,
    ...(ignorable ? { ignorable: true as const } : {}),
  };
}
function component(streamSeq: number, kind: RequestComponentKind, content: JsonValue): EventRecord {
  const hash = requestComponentHash(kind, content);
  return event(streamSeq, "request.component", { hash, kind, content });
}

test("Turn transcript replay derives messages from normalized facts and applies compaction without deleting history", () => {
  const events = [
    event(1, "transcript.started", { formatVersion: TRANSCRIPT_FORMAT_VERSION }),
    event(2, "message.user", { message: { id: "u1", role: "user", content: "start" } }),
    event(3, "message.assistant.delta", { messageId: "a1", delta: "par" }),
    event(4, "message.assistant.completed", {
      message: { id: "a1", role: "assistant", content: "partial answer" },
    }),
    event(5, "tool.called", { callId: "t1", name: "read", arguments: { path: "x" } }),
    event(6, "tool.completed", { callId: "t1", result: { text: "ok" } }),
    event(7, "context.compacted", {
      replacedMessageIds: ["u1", "a1", "tool:t1"],
      retainedMessageIds: [],
      summaryMessageId: "s1",
      summary: "work so far",
    }),
    component(8, "system_prompt", "s"),
    component(9, "active_context", "ctx"),
    component(10, "toolset", []),
    event(11, "request.prepared", {
      provider: "faux",
      model: "m",
      systemPromptHash: requestComponentHash("system_prompt", "s"),
      activeContextHash: requestComponentHash("active_context", "ctx"),
      messageHashes: [],
      toolsetHash: requestComponentHash("toolset", []),
      modelConfig: {},
      sourceSeqs: [2],
    }),
    event(12, "transcript.completed", {}),
  ];
  const replayed = replayTranscript(events);
  assert.deepEqual(replayed.messages, [{ id: "s1", role: "user", content: "work so far" }]);
  assert.equal(replayed.status, "completed");
  assert.equal(replayed.lastRequest?.activeContext, "ctx");
  assert.equal(events.length, 12);
});

test("interrupted transcript repair preserves an unknown tool outcome", () => {
  const events = [
    event(1, "transcript.started", { formatVersion: TRANSCRIPT_FORMAT_VERSION }),
    event(2, "tool.called", { callId: "t1", name: "publish", arguments: {} }),
  ];
  const repair = interruptedTranscriptEvents(events, "2030-01-01T00:01:00.000Z", "supervisor");
  assert.deepEqual(
    repair.map((item) => item.type),
    ["tool.completed", "transcript.interrupted"],
  );
  assert.equal((repair[0]!.data as { result: { outcome: string } }).result.outcome, "unknown");
});

test("Turn transcript replay rejects a gap in the stream", () => {
  assert.throws(
    () =>
      replayTranscript([
        event(1, "transcript.started", { formatVersion: TRANSCRIPT_FORMAT_VERSION }),
        event(3, "transcript.completed", {}),
      ]),
    /stream gap/,
  );
});

test("request components are content-addressed and required for materialization", () => {
  const started = event(1, "transcript.started", { formatVersion: TRANSCRIPT_FORMAT_VERSION });
  const missing = event(2, "request.prepared", {
    provider: "faux",
    model: "m",
    systemPromptHash: "missing",
    activeContextHash: "missing",
    messageHashes: [],
    toolsetHash: "missing",
    modelConfig: {},
    sourceSeqs: [],
  });
  assert.throws(() => replayTranscript([started, missing]), /missing system_prompt component/);
  const corrupt = event(2, "request.component", {
    hash: "wrong",
    kind: "system_prompt",
    content: "s",
  });
  assert.throws(() => replayTranscript([started, corrupt]), /hash mismatch/);
});

test("future formats and unknown required events fail closed while informational events may be skipped", () => {
  assert.throws(
    () =>
      replayTranscript([
        event(1, "transcript.started", { formatVersion: TRANSCRIPT_FORMAT_VERSION + 1 }),
      ]),
    TranscriptFormatUnsupportedError,
  );
  assert.throws(
    () =>
      replayTranscript([
        event(1, "transcript.started", { formatVersion: TRANSCRIPT_FORMAT_VERSION - 1 }),
      ]),
    TranscriptCorruptionError,
  );
  const started = event(1, "transcript.started", { formatVersion: TRANSCRIPT_FORMAT_VERSION });
  assert.throws(
    () => replayTranscript([started, event(2, "message.future", {})]),
    TranscriptEventUnsupportedError,
  );
  assert.equal(
    replayTranscript([
      started,
      event(2, "message.future", {}, true),
      event(3, "transcript.completed", {}),
    ]).status,
    "completed",
  );
  assert.throws(
    () =>
      replayTranscript([
        event(1, "message.user", { message: { id: "u", role: "user", content: "x" } }),
      ]),
    TranscriptCorruptionError,
  );
});
