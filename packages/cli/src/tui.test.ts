import assert from "node:assert/strict";
import test from "node:test";
import { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
import { classifyTuiControlKey, classifyTuiInput, commandAwaitingArgument, ConversationView, createTuiAutocompleteProvider, findLiveTurnId, renderFrame, renderTuiCommandHelp, renderTuiHeader, renderUserMessage, sensitiveMessageWarning, StreamCoordinator, TUI_COMMANDS, WelcomeLockup } from "./tui.js";
import type { WelcomeSnapshot } from "./welcome.js";
import { stripAnsi } from "./tui-theme.js";
import { looksLikeCredential } from "./sensitive-text.js";

test("TUI routes ordinary text, queued follow-ups, and commands", () => {
  assert.deepEqual(classifyTuiInput("Launch the store", false), { action: "send", text: "Launch the store" });
  assert.deepEqual(classifyTuiInput("correct the budget", true), { action: "steer", text: "correct the budget" });
  assert.equal(classifyTuiInput("/approve a --reason ok --evidence 1", false).action, "unknown");
  assert.equal(classifyTuiInput("/stop", true).action, "stop");
  assert.equal(classifyTuiInput("/records", false).action, "records");
  assert.equal(classifyTuiInput("/history root", false).action, "records");
  assert.equal(classifyTuiInput("/model", false).action, "model");
  assert.equal(classifyTuiInput("/login zai", false).action, "login");
  assert.equal(classifyTuiInput("/logout", false).action, "logout");
  assert.equal(classifyTuiInput("/setup model", false).action, "setup");
  assert.equal(classifyTuiInput("/goal", false).action, "goal");
  assert.equal(classifyTuiInput("/history", false).action, "records");
  assert.equal(classifyTuiInput("/modle", false).action, "unknown");
  assert.equal(classifyTuiInput("/help", false).action, "help");
  assert.equal(classifyTuiInput("/status extra", false).action, "unknown");
});

test("credential-like messages require an explicit second submission",()=>{assert.equal(looksLikeCredential("API password: very-secret-value"),true);assert.equal(looksLikeCredential("review the password field validation"),false);assert.match(stripAnsi(sensitiveMessageWarning()),/Press Enter again/);assert.match(stripAnsi(sensitiveMessageWarning()),/ignored local file/);});

test("slash commands share one discoverable registry and preserve required argument input",async()=>{assert.equal(commandAwaitingArgument("/goal"),"/goal ");assert.equal(commandAwaitingArgument("/history "),"/history ");assert.equal(commandAwaitingArgument("/status"),null);const provider=createTuiAutocompleteProvider(process.cwd());const suggestions=await provider.getSuggestions(["/"],0,1,{signal:new AbortController().signal});assert.ok(suggestions);assert.deepEqual(suggestions!.items.slice(0,4).map((item)=>item.value),["goal","model","status","setup"]);const completed=provider.applyCompletion(["/g"],0,2,suggestions!.items[0]!,"/g");assert.deepEqual(completed.lines,["/goal "]);const help=stripAnsi(renderTuiCommandHelp());for(const command of TUI_COMMANDS)assert.match(help,new RegExp(`/${command.name}\\b`));assert.match(help,/Ctrl\+C.*Clear input/);assert.match(help,/Ctrl\+D.*Exit when idle/);});

test("TUI control keys clear drafts, interrupt work, and exit only from an idle prompt", () => {
  assert.equal(classifyTuiControlKey("\x03", "draft", false), "clear");
  assert.equal(classifyTuiControlKey("\x03", "", true), "interrupt");
  assert.equal(classifyTuiControlKey("\x03", "", false), "exit");
  assert.equal(classifyTuiControlKey("\x1b[99;5u", "", false), "exit");
  assert.equal(classifyTuiControlKey("\x1b[99;5:3u", "", false), "forward");
  assert.equal(classifyTuiControlKey("\x04", "", false), "exit");
  assert.equal(classifyTuiControlKey("\x04", "draft", false), "forward");
  assert.equal(classifyTuiControlKey("\x04", "", true), "forward");
  assert.equal(classifyTuiControlKey("x", "", false), "forward");
});

test("welcome lockup is horizontal, compact, and falls back to the official Braille mark", () => {
  const snapshot: WelcomeSnapshot = { root: null, team: [], handoffs: [], conversation: [], runner: "pi", target: "zai/glm-5.3" };
  const fallback = stripAnsi(new WelcomeLockup(snapshot, false).render(100).join("\n"));
  assert.match(fallback, /⣾|⣿/);
  assert.match(fallback, /Ready when you are\./);
  assert.match(fallback, /zai\/glm-5\.3 · pi/);
  assert.ok(fallback.split("\n").length <= 8);

  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
  try {
    const onePixelPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    assert.match(new WelcomeLockup(snapshot, false, onePixelPng).render(100).join("\n"), /\x1b_G/);
  } finally { resetCapabilitiesCache(); }
});

test("TUI reconnect selects the newest live Human interaction only", () => {
  assert.equal(findLiveTurnId([{ id: "goal", triggerKind: "wake", status: "in_progress" }, { id: "human", triggerKind: "user_message", status: "in_progress" }]), "human");
  assert.equal(findLiveTurnId([{ id: "done", triggerKind: "user_message", status: "completed" }]), null);
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

test("TUI replaces live text and thinking from bounded snapshots",()=>{let live:{text:string;thinking:string;active:boolean}|null=null;renderFrame({type:"event",event:{type:"message.assistant.live",data:{messageId:"m",revision:42,text:"working",thinking:"inspect",thinkingActive:true}}},()=>undefined,()=>undefined,()=>undefined,()=>undefined,()=>undefined,()=>undefined,()=>undefined,()=>undefined,(text,thinking,active)=>{live={text,thinking,active};});assert.deepEqual(live,{text:"working",thinking:"inspect",active:true});});

test("TUI commits canonical assistant blocks instead of raw provider whitespace",()=>{let committed="";renderFrame({type:"event",event:{type:"message.assistant.completed",data:{message:{content:[{type:"text",text:"  first\r\n"},{type:"text",text:" second  \n"}]},commitState:"committed"}}},()=>undefined,()=>undefined,(text)=>{committed=text;});assert.equal(committed,"first\nsecond");});

test("TUI keeps a normalized Handoff response provisional until Supervisor commits it",()=>{const committed:string[]=[];let cleared=0;const render=(frame:Parameters<typeof renderFrame>[0])=>renderFrame(frame,()=>undefined,()=>undefined,(text)=>committed.push(text),()=>undefined,()=>undefined,()=>undefined,()=>undefined,()=>{cleared+=1;});const message={content:[{type:"text",text:"Goal completed."}]};render({type:"event",event:{type:"message.assistant.completed",data:{message,commitState:"provisional"}}});assert.deepEqual(committed,[]);assert.equal(cleared,1);render({type:"event",event:{type:"response.committed",data:{text:"Goal completed.",messageItemId:"m"}}});assert.deepEqual(committed,["Goal completed."]);});

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
  assert.deepEqual(rendered.map(stripAnsi), [`  你好${" ".repeat(24)}`]);
  assert.doesNotMatch(rendered.join("\n"), /you/i);
});

test("stream takeover marks orphaned running tools as failed", () => {
  const view = new ConversationView([]);
  view.updateTool({ kind: "tool", callId: "old", name: "read", detail: "src/index.ts", status: "running" });
  view.updateTool({ kind: "tool", callId: "done", name: "write", detail: "out.txt", status: "done" });
  view.stopRunningTools();
  const rendered = stripAnsi(view.render(80).join("\n"));
  assert.match(rendered, /failed\s+read/);
  assert.match(rendered, /done\s+write/);
  assert.doesNotMatch(rendered, /running\s+read/);
});

test("stream ownership preserves the active stream on rejection and fences it after acceptance",()=>{const streams=new StreamCoordinator();const first=new AbortController();const rejected=new AbortController();const accepted=new AbortController();assert.equal(streams.begin(first).owns,true);assert.equal(streams.begin(rejected).owns,false);streams.reject(rejected);assert.equal(streams.isCurrent(first),true);assert.equal(first.signal.aborted,false);assert.equal(streams.begin(accepted).owns,false);streams.accept(accepted);assert.equal(first.signal.aborted,true);assert.equal(streams.isCurrent(first),false);assert.equal(streams.isCurrent(accepted),true);streams.retire();assert.equal(accepted.signal.aborted,true);assert.equal(streams.active,null);});

test("a newer durable Turn supersedes both active and pending streams before attach",()=>{const streams=new StreamCoordinator();const active=new AbortController();const pending=new AbortController();const attached=new AbortController();streams.begin(active);streams.begin(pending);streams.supersede();assert.equal(active.signal.aborted,true);assert.equal(pending.signal.aborted,true);assert.equal(streams.hasPending,false);assert.equal(streams.begin(attached).owns,true);assert.equal(streams.isCurrent(attached),true);});

test("ending a transient Turn clears partial prose and thinking while closing running tools",()=>{const view=new ConversationView([]);view.appendLiveMarkdown("partial answer");view.updateThinking({phase:"delta",text:"private"});view.updateTool({kind:"tool",callId:"call",name:"read",detail:"file",status:"running"});view.endTransientTurn();const rendered=stripAnsi(view.render(80).join("\n"));assert.doesNotMatch(rendered,/partial answer|private|running/);assert.match(rendered,/failed\s+read/);});

test("consecutive duplicate terminal errors render once",()=>{const view=new ConversationView([]);view.addText("error  failed");view.addText("error  failed");assert.equal(stripAnsi(view.render(80).join("\n")).match(/error  failed/g)?.length,1);});

test("response commit does not repeat an Assistant Item shown before later tools",()=>{const view=new ConversationView([]);view.addMarkdown("Work Record updated.","message-1");view.updateTool({kind:"tool",callId:"handoff",name:"handoff",detail:"",status:"done"});view.addMarkdown("Work Record updated.","message-1");assert.equal(stripAnsi(view.render(80).join("\n")).match(/Work Record updated\./g)?.length,1);});
