import assert from "node:assert/strict";
import test from "node:test";
import { classifyTuiInput, renderFrame, renderTuiHeader } from "./tui.js";
import { stripAnsi } from "./tui-theme.js";

test("TUI routes ordinary text, queued follow-ups, and approvals", () => {
  assert.deepEqual(classifyTuiInput("Launch the store", false), { action: "send", text: "Launch the store" });
  assert.deepEqual(classifyTuiInput("correct the budget", true), { action: "queue", text: "correct the budget" });
  assert.equal(classifyTuiInput("/approve a --reason ok --evidence 1", false).action, "approval");
  assert.equal(classifyTuiInput("/stop", true).action, "stop");
  assert.equal(classifyTuiInput("/records", false).action, "records");
  assert.equal(classifyTuiInput("/history root", false).action, "records");
  assert.equal(classifyTuiInput("/model", false).action, "model");
  assert.equal(classifyTuiInput("/help", false).action, "help");
});

test("TUI renders streamed assistant text and tool completion", () => {
  const lines: string[] = []; let live = ""; let completed = "";
  renderFrame({ type: "event", event: { type: "message.assistant.delta", data: { delta: { delta: "working" } } } }, (line) => lines.push(line), (text) => { live += text; }, (text) => { completed = text; });
  renderFrame({ type: "event", event: { type: "tool.completed", data: { name: "read", isError: false } } }, (line) => lines.push(line));
  renderFrame({ type: "event", event: { type: "message.assistant.completed", data: { message: { content: [{ type: "text", text: "done" }] } } } }, (line) => lines.push(line), (text) => { live += text; }, (text) => { completed = text; });
  assert.equal(live, "working");
  assert.equal(completed, "done");
  assert.deepEqual(lines.map(stripAnsi), ["  read  done"]);
  renderFrame({ type: "result", value: { response: { content: "final answer" } } }, (line) => lines.push(line));
  assert.equal(lines.at(-1), "final answer");
});

test("TUI hides internal wake ids and credential-shaped environment errors", () => {
  const lines: string[] = [];
  renderFrame({ type: "accepted", wakeId: "private-wake-id", value: {} }, (line) => lines.push(line));
  renderFrame({ type: "event", event: { type: "wake.abnormal_reason", data: { reason: "environment variable is missing: pasted-secret-ZAI_API_KEY (set it)" } } }, (line) => lines.push(line));
  assert.deepEqual(lines.map((line) => stripAnsi(line).trim()), ["error  environment variable is missing: [REDACTED] (set it)"]);
  const stack: string[] = [];
  renderFrame({ type: "event", event: { type: "wake.abnormal_reason", data: { reason: "file:///Users/test/pi-worker.js:24\n  const x = missing.value\n            ^\n\nTypeError: Cannot read properties of undefined (reading 'value')\n    at file:///Users/test/pi-worker.js:24:9" } } }, (line) => stack.push(line));
  assert.deepEqual(stack.map((line) => stripAnsi(line).trim()), ["error  TypeError: Cannot read properties of undefined (reading 'value')"]);
});

test("TUI header is a stable full-width brand rail", () => {
  const wide = stripAnsi(renderTuiHeader(80, "pi", "zai/glm-5.3", "0.11.2"));
  const narrow = stripAnsi(renderTuiHeader(24, "pi", "zai/glm-5.3", "0.11.2"));
  assert.equal(wide.length, 80);
  assert.equal(narrow.length, 24);
  assert.match(wide, /^ GOAH  pi · zai\/glm-5\.3/);
  assert.doesNotMatch(narrow, /v0\.11\.2/);
});
