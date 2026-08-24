import assert from "node:assert/strict";
import test from "node:test";
import { classifyTuiInput, renderFrame } from "./tui.js";

test("TUI routes ordinary text, queued follow-ups, and approvals", () => {
  assert.deepEqual(classifyTuiInput("Launch the store", false), { action: "send", text: "Launch the store" });
  assert.deepEqual(classifyTuiInput("correct the budget", true), { action: "queue", text: "correct the budget" });
  assert.equal(classifyTuiInput("/approve a --reason ok --evidence 1", false).action, "approval");
  assert.equal(classifyTuiInput("/stop", true).action, "stop");
  assert.equal(classifyTuiInput("/help", false).action, "help");
});

test("TUI renders streamed assistant text and tool completion", () => {
  const lines: string[] = []; let live = ""; let completed = "";
  renderFrame({ type: "event", event: { type: "message.assistant.delta", data: { delta: { delta: "working" } } } }, (line) => lines.push(line), (text) => { live += text; }, (text) => { completed = text; });
  renderFrame({ type: "event", event: { type: "tool.completed", data: { name: "read", isError: false } } }, (line) => lines.push(line));
  renderFrame({ type: "event", event: { type: "message.assistant.completed", data: { message: { content: [{ type: "text", text: "done" }] } } } }, (line) => lines.push(line), (text) => { live += text; }, (text) => { completed = text; });
  assert.equal(live, "working");
  assert.equal(completed, "done");
  assert.deepEqual(lines, ["✓ read completed"]);
});
