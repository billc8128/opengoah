import assert from "node:assert/strict";
import test from "node:test";
import { classifyTuiInput, findLiveTurnId, renderFrame, renderTuiHeader, renderUserMessage } from "./tui.js";
import { stripAnsi } from "./tui-theme.js";

test("TUI routes ordinary text, queued follow-ups, and approvals", () => {
  assert.deepEqual(classifyTuiInput("Launch the store", false), { action: "send", text: "Launch the store" });
  assert.deepEqual(classifyTuiInput("correct the budget", true), { action: "steer", text: "correct the budget" });
  assert.equal(classifyTuiInput("/approve a --reason ok --evidence 1", false).action, "approval");
  assert.equal(classifyTuiInput("/stop", true).action, "stop");
  assert.equal(classifyTuiInput("/records", false).action, "records");
  assert.equal(classifyTuiInput("/history root", false).action, "records");
  assert.equal(classifyTuiInput("/model", false).action, "model");
  assert.equal(classifyTuiInput("/login zai", false).action, "login");
  assert.equal(classifyTuiInput("/logout", false).action, "logout");
  assert.equal(classifyTuiInput("/setup model", false).action, "setup");
  assert.equal(classifyTuiInput("/modle", false).action, "unknown");
  assert.equal(classifyTuiInput("/help", false).action, "help");
});

test("TUI reconnect selects the newest live Human interaction only", () => {
  assert.equal(findLiveTurnId([{ id: "goal", source: "goal", status: "in_progress" }, { id: "human", source: "human", status: "in_progress" }]), "human");
  assert.equal(findLiveTurnId([{ id: "done", source: "human", status: "completed" }]), null);
});

test("TUI renders streamed assistant text and tool completion", () => {
  const lines: string[] = []; const tools = new Map<string, { status: string; detail: string }>(); const thinking: string[] = []; const wakeStates: string[] = []; let live = ""; let completed = "";
  const render = (frame: Parameters<typeof renderFrame>[0]) => renderFrame(frame, (line) => lines.push(line), (text) => { live += text; }, (text) => { completed = text; }, (text) => lines.push(text), (tool) => tools.set(tool.callId, tool), (activity) => thinking.push(`${activity.phase}:${activity.text}`), (state) => wakeStates.push(state));
  render({ type: "accepted", turnId: "wake", value: { wake: { status: "queued" } } });
  render({ type: "event", event: { type: "turn.started", data: {} } });
  render({ type: "event", event: { type: "message.assistant.delta", data: { delta: { type: "thinking_start" } } } });
  render({ type: "event", event: { type: "message.assistant.delta", data: { delta: { type: "thinking_delta", delta: "private reasoning" } } } });
  render({ type: "event", event: { type: "message.assistant.delta", data: { delta: { type: "thinking_end", content: "private reasoning" } } } });
  render({ type: "event", event: { type: "message.assistant.delta", data: { delta: { type: "text_delta", delta: "working" } } } });
  render({ type: "event", event: { type: "tool.called", data: { callId: "call-1", name: "read", arguments: { path: "src/index.ts" } } } });
  render({ type: "event", event: { type: "tool.completed", data: { callId: "call-1", name: "read", isError: false } } });
  render({ type: "event", event: { type: "message.assistant.completed", data: { message: { content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "done" }] } } } });
  assert.equal(live, "working");
  assert.equal(completed, "done");
  assert.deepEqual(wakeStates, ["queued", "working"]);
  assert.deepEqual(thinking.slice(0, 3), ["start:", "delta:private reasoning", "done:private reasoning"]);
  assert.deepEqual(tools.get("call-1"), { kind: "tool", callId: "call-1", name: "read", detail: "", status: "done" });
  render({ type: "result", value: { response: { content: "final answer" } } });
  assert.equal(lines.at(-1), "final answer");
});

test("TUI discards assistant text from a failed completed message", () => {
  const committed: string[] = []; let cleared = 0;
  renderFrame({ type: "event", event: { type: "message.assistant.completed", data: { message: { stopReason: "error", errorMessage: "provider failed", content: [{ type: "text", text: "partial answer" }] } } } }, () => undefined, () => undefined, (text) => committed.push(text), () => undefined, () => undefined, () => undefined, () => undefined, () => { cleared += 1; });
  assert.deepEqual(committed, []); assert.equal(cleared, 1);
});

test("TUI hides internal wake ids and credential-shaped environment errors", () => {
  const lines: string[] = [];
  renderFrame({ type: "accepted", turnId: "private-wake-id", value: {} }, (line) => lines.push(line));
  renderFrame({ type: "event", event: { type: "transcript.interrupted", data: { reason: "environment variable is missing: pasted-secret-ZAI_API_KEY (set it)" } } }, (line) => lines.push(line));
  assert.deepEqual(lines.map((line) => stripAnsi(line).trim()), ["error  environment variable is missing: [REDACTED] (set it)"]);
  const stack: string[] = [];
  renderFrame({ type: "event", event: { type: "transcript.interrupted", data: { reason: "file:///Users/test/pi-worker.js:24\n  const x = missing.value\n            ^\n\nTypeError: Cannot read properties of undefined (reading 'value')\n    at file:///Users/test/pi-worker.js:24:9" } } }, (line) => stack.push(line));
  assert.deepEqual(stack.map((line) => stripAnsi(line).trim()), ["error  TypeError: Cannot read properties of undefined (reading 'value')"]);
  const provider: string[] = [];
  renderFrame({ type: "event", event: { type: "transcript.interrupted", data: { reason: '429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Resets Thursday"}' } } }, (line) => provider.push(line));
  assert.deepEqual(provider.map((line) => stripAnsi(line).trim()), ["error  Provider 429: Weekly/Monthly Limit Exhausted. Resets Thursday"]);
});

test("TUI header is a stable full-width brand rail", () => {
  const wide = stripAnsi(renderTuiHeader(80, "pi", "zai/glm-5.3", "0.11.2"));
  const narrow = stripAnsi(renderTuiHeader(24, "pi", "zai/glm-5.3", "0.11.2"));
  assert.equal(wide.length, 80);
  assert.equal(narrow.length, 24);
  assert.match(wide, /^ GOAH  pi · zai\/glm-5\.3/);
  assert.doesNotMatch(narrow, /v0\.11\.2/);
});

test("user messages render as unlabeled full-width background blocks", () => {
  const rendered = renderUserMessage("你好", 30);
  assert.deepEqual(rendered.map(stripAnsi), [" ".repeat(30), `  你好${" ".repeat(24)}`, " ".repeat(30)]);
  assert.doesNotMatch(rendered.join("\n"), /you/i);
});
