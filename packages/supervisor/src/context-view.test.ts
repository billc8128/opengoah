import assert from "node:assert/strict";
import test from "node:test";
import type { EventRecord } from "goah-ledger-contract";
import { composeActiveContext, selectRecoveryEvents, selectWorkingMemory } from "./context-view.js";

function event(streamSeq: number, type: string, data: EventRecord["data"] = {}): EventRecord {
  return { seq: streamSeq, streamId: "wake:failed", streamSeq, ts: "2030-01-01T00:00:00.000Z", actor: "worker", type, data };
}

test("recovery context selects semantic failure facts instead of raw transcript traffic", () => {
  const events = [
    event(1, "transcript.started"),
    ...Array.from({ length: 200 }, (_, index) => event(index + 2, "message.assistant.delta", { delta: "x".repeat(100) })),
    event(202, "request.prepared", { activeContext: "large".repeat(1_000) }),
    event(203, "tool.called", { callId: "read", name: "read_file", arguments: {} }),
    event(204, "tool.completed", { callId: "read", result: { text: "ok" } }),
    event(205, "tool.called", { callId: "publish", name: "publish", arguments: { id: 1 } }),
    event(206, "turn.retry_started", { reason: "SIGKILL" }),
    event(207, "tool.completed", { callId: "publish", result: { outcome: "unknown", synthetic: true } }),
    event(208, "transcript.interrupted", { reason: "SIGKILL" }),
  ];
  const selected = selectRecoveryEvents(events);
  assert.deepEqual(selected.map((item) => item.type), ["tool.called", "tool.completed", "transcript.interrupted"]);
  const view = composeActiveContext({
    role: "child", capabilities: ["ledger.search"], systemPrompt: "worker", wake: { id: "retry", agent: "worker", triggerRef: "retry:failed", status: "consumed", attempt: 1, enqueuedSeq: 1, claimedAt:"2030-01-01T00:00:00.000Z",consumedAt:"2030-01-01T00:00:00.000Z",turnId:"turn" },
    goals: [], mail: [], actions: [], lastHandoff: null, teamHandoffs: [], team: [], revisionWarnings: [], recoveryEvents: selected,
  });
  assert.ok(view.text.length < 1_000);
  assert.doesNotMatch(view.text, /message\.assistant\.delta|request\.prepared/);
  assert.match(view.text, /unknown|SIGKILL/);
});

test("working memory keeps the newest notes inside the budget without compacting the stream", () => {
  const notes = [
    event(1, "memory.appended", { note: "a".repeat(40) }),
    event(2, "memory.appended", { note: "b".repeat(40) }),
    event(3, "memory.appended", { note: "c".repeat(40) }),
    event(4, "transcript.completed"),
  ];
  assert.deepEqual(selectWorkingMemory(notes, 100).map((item) => item.streamSeq), [2, 3]);
  assert.deepEqual(selectWorkingMemory(notes, 10).map((item) => item.streamSeq), [3]);
  assert.deepEqual(selectWorkingMemory([], 100), []);
});

test("active context renders working memory with evidence sequences", () => {
  const note = event(7, "memory.appended", { note: "integration tests fake-fail when the clock is mocked; approach A rejected: metric freshness" });
  const view = composeActiveContext({
    role: "child", capabilities: ["memory.append"], systemPrompt: "worker", wake: { id: "w2", agent: "worker", triggerRef: "schedule:worker", status: "consumed", attempt: 1, enqueuedSeq: 1, claimedAt:"2030-01-01T00:00:00.000Z",consumedAt:"2030-01-01T00:00:00.000Z",turnId:"turn" },
    goals: [], mail: [], actions: [], lastHandoff: null, teamHandoffs: [], team: [], revisionWarnings: [], recoveryEvents: [], workingMemory: [note],
  });
  assert.match(view.text, /# Working memory\n\n- integration tests fake-fail[^\n]*\[event:7\]/);
  assert.equal(view.sourceSeqs.includes(7), true);
});
