/** Full-screen goah TUI: streaming CEO transcript over the resident Supervisor control socket. */
import { TuiAltScreen, Text, Markdown, Editor, ProcessTerminal, ScrollView, VStack, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { controlAvailable, requestControl, streamControl, type ControlFrame } from "./control.js";
import { readConsoleMetadata } from "./index.js";
import { switchModel, reloadDaemon, readRunnerDisplay } from "./live-config.js";
import { welcomeSnapshot, renderWelcome } from "./welcome.js";
import { runSetupWizard, applyWizardResult } from "./setup-wizard.js";
import { installedVersion } from "./update.js";
import { tuiTheme } from "./tui-theme.js";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";

interface CancellableState { active: boolean }
class HeaderBar implements Component {
  constructor(private readonly runner: string, private readonly target: string, private readonly version: string) {}
  render(width: number): string[] { return [renderTuiHeader(width, this.runner, this.target, this.version)]; }
  invalidate(): void {}
}
class GoalBar implements Component {
  constructor(private root: { objective: string; phase: string } | null) {}
  setRoot(root: { objective: string; phase: string } | null): void { this.root = root; }
  render(width: number): string[] {
    const line = this.root ? `${tuiTheme.active(" GOAL ")}  ${this.root.objective}  ${tuiTheme.muted(this.root.phase)}` : `${tuiTheme.muted("no active Goal")}  ${tuiTheme.accent("/goal")}`;
    return new Text(line, 1, 0).render(width);
  }
  invalidate(): void {}
}
const markdownTheme: MarkdownTheme = {
  heading: tuiTheme.accent, link: tuiTheme.accent, linkUrl: tuiTheme.muted, code: tuiTheme.warning,
  codeBlock: tuiTheme.subtle, codeBlockBorder: tuiTheme.muted, quote: tuiTheme.subtle, quoteBorder: tuiTheme.accent,
  hr: tuiTheme.muted, listBullet: tuiTheme.accent, bold: tuiTheme.strong, italic: tuiTheme.muted,
  strikethrough: tuiTheme.muted, underline: tuiTheme.underline, codeBlockIndent: "  ",
};
class ConversationView implements Component {
  private entries: Array<{ kind: "text" | "markdown"; content: string }>;
  private liveMarkdown = "";
  constructor(initial: string[]) { this.entries = [{ kind: "text", content: initial.join("\n") }]; }
  addText(content: string): void { this.entries.push({ kind: "text", content }); this.trim(); }
  addMarkdown(content: string): void { this.liveMarkdown = ""; this.entries.push({ kind: "markdown", content }); this.trim(); }
  setLiveMarkdown(content: string): void { this.liveMarkdown = content; }
  clearLiveMarkdown(): void { this.liveMarkdown = ""; }
  private trim(): void { if (this.entries.length > 240) this.entries.splice(1, this.entries.length - 240); }
  render(width: number): string[] {
    const rendered = this.entries.flatMap((entry) => entry.kind === "markdown"
      ? [tuiTheme.accent("  goah"), ...new Markdown(entry.content, 2, 0, markdownTheme).render(width), ""]
      : new Text(entry.content, 2, 0).render(width));
    if (this.liveMarkdown) rendered.push(tuiTheme.accent("  goah"), ...new Markdown(this.liveMarkdown, 2, 0, markdownTheme).render(width));
    return rendered;
  }
  invalidate(): void {}
}
export function renderTuiHeader(width: number, runner: string, target: string, version: string): string {
  const brand = " GOAH ";
  const release = width >= 34 ? ` v${version} ` : "";
  const rawContext = ` ${runner || "runner"} · ${target || "unconfigured"}`;
  const contextWidth = Math.max(1, width - brand.length - release.length - 1);
  const context = rawContext.length > contextWidth ? `${rawContext.slice(0, Math.max(1, contextWidth - 1))}…` : rawContext;
  const fill = " ".repeat(Math.max(0, width - brand.length - context.length - release.length));
  return `${tuiTheme.brand(brand)}${tuiTheme.rail(`${context}${fill}${release}`)}`;
}
function statusText(mode: "ready" | "working" | "queued" | "setup", queued = 0): string {
  if (mode === "working") return `${tuiTheme.accent("working")}  ${tuiTheme.muted(queued ? `${queued} queued · /stop cancels` : "/stop cancels")}`;
  if (mode === "queued") return `${tuiTheme.warning(`${queued} queued`)}  ${tuiTheme.muted("continuing in order")}`;
  if (mode === "setup") return tuiTheme.accent("opening setup…");
  return `${tuiTheme.muted("ready")}  ${tuiTheme.accent("/help")}`;
}
export type TuiInputAction = "quit" | "help" | "status" | "records" | "stop" | "model" | "setup" | "goal" | "approval" | "empty" | "queue" | "send";
export function classifyTuiInput(value: string, busy: boolean): { action: TuiInputAction; text: string } {
  const text = value.trim();
  if (!text) return { action: "empty", text };
  if (text === "/quit" || text === "/exit") return { action: "quit", text };
  if (text === "/help") return { action: "help", text };
  if (text === "/status") return { action: "status", text };
  if (text === "/records" || text.startsWith("/records ") || text.startsWith("/history ")) return { action: "records", text };
  if (text === "/stop") return { action: "stop", text };
  if (text === "/model" || text.startsWith("/model ")) return { action: "model", text };
  if (text === "/setup") return { action: "setup", text };
  if (text.startsWith("/goal ") || text.startsWith("/observe ")) return { action: "goal", text };
  if (text.startsWith("/approve ") || text.startsWith("/reject ")) return { action: "approval", text };
  return { action: busy ? "queue" : "send", text };
}

export async function runGoahTui(configPath: string, stateDir: string, initialMessage: string | null): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return runNonInteractive(configPath, stateDir, initialMessage);
  const runner = readRunnerDisplay(configPath);
  const snapshot = welcomeSnapshot(stateDir, runner);
  const welcome = renderWelcome(snapshot, Boolean(snapshot.root || snapshot.handoffs.length || snapshot.conversation.length));
  await ensureDaemon(configPath, stateDir);
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: true });
  terminal.setTitle(`Goah · ${runner.target}`);
  const headerView = new HeaderBar(runner.runner, runner.target, installedVersion());
  const transcriptView = new ConversationView(welcome);
  const conversationScroll = new ScrollView(transcriptView, { follow: "end", primary: true, scrollbar: "auto", scrollbarStyle: tuiTheme.muted });
  const goalView = new GoalBar(snapshot.root);
  const input = new Editor(tui, {
    borderColor: tuiTheme.accent,
    selectList: { selectedPrefix: tuiTheme.accent, selectedText: tuiTheme.strong, description: tuiTheme.muted, scrollInfo: tuiTheme.muted, noMatch: tuiTheme.error },
  }, { paddingX: 1, autocompleteMaxVisible: 6 });
  const statusView = new Text(statusText("ready"), 1, 0);
  const shell = new VStack([
    { component: headerView, basis: 1, shrink: 0 },
    { component: conversationScroll, grow: 1, minSize: 1 },
    { component: goalView, basis: 1, shrink: 0 },
    { component: statusView, basis: 1, shrink: 0 },
    { component: input, basis: "auto", minSize: 3, maxSize: 8, shrink: 0 },
  ]);
  const busy: CancellableState = { active: false };
  const queued: string[] = [];
  let activeStream: AbortController | null = null;
  let exiting = false;

  const push = (line: string): void => {
    transcriptView.addText(line);
    tui.requestRender();
  };
  let liveText = "";
  const appendLive = (text: string): void => { liveText += text; transcriptView.setLiveMarkdown(liveText); tui.requestRender(); };
  const commitLive = (text: string): void => { liveText = ""; if (text) transcriptView.addMarkdown(text); tui.requestRender(); };
  const pushResponse = (text: string): void => { transcriptView.addMarkdown(text); tui.requestRender(); };

  const send = async (message: string): Promise<void> => {
    busy.active = true;
    const controller = new AbortController(); activeStream = controller;
    statusView.setText(statusText("working", queued.length));
    push(`${tuiTheme.human("you")}  ${message}`);
    try {
      await streamControl(stateDir, { op: "interact", message }, (frame) => renderFrame(frame, push, appendLive, commitLive, pushResponse), controller.signal);
    } catch (error) {
      transcriptView.clearLiveMarkdown();
      if (!controller.signal.aborted) push(errorLine(error));
    } finally {
      if (activeStream === controller) activeStream = null;
      busy.active = false;
      await refreshGoalBar(stateDir, goalView, tui);
      statusView.setText(statusText(queued.length ? "queued" : "ready", queued.length));
      const next = exiting ? undefined : queued.shift();
      if (next) void send(next);
    }
  };
  const launchSetup = async (): Promise<void> => {
    if (busy.active) { push("Wait for the current wake or use /stop before changing Runner configuration."); return; }
    statusView.setText(statusText("setup"));
    tui.stop();
    try { await runSetupReload(configPath, stateDir, push); }
    finally { if (!exiting) { tui.start(); tui.requestRender(true); statusView.setText(statusText("ready")); } }
  };

  input.onSubmit = (line) => {
    const { action, text } = classifyTuiInput(line, busy.active);
    input.setText("");
    if (action === "quit") { exiting = true; activeStream?.abort(); tui.stop(); resolveExit(); return; }
    if (action === "help") { push(`${tuiTheme.strong("Commands")}\n  /model  /setup  /status  /records  /history\n  /goal   /observe  /approve  /reject  /stop  /quit\n`); return; }
    if (action === "status") { void printStatus(stateDir, push).finally(() => refreshGoalBar(stateDir, goalView, tui)); return; }
    if (action === "records") { void printRecords(text, stateDir, push); return; }
    if (action === "stop") { void stopCeoWake(stateDir, push); return; }
    if (action === "model") { if (text === "/model") void launchSetup(); else void switchModelCommand(text, configPath, stateDir, push); return; }
    if (action === "setup") { void launchSetup(); return; }
    if (action === "goal") { void slashGoal(text, stateDir, push).finally(() => refreshGoalBar(stateDir, goalView, tui)); return; }
    if (action === "approval") { void slashApprove(text, stateDir, push); return; }
    if (action === "queue") { queued.push(text); push(tuiTheme.muted(`queued  ${text}`)); statusView.setText(statusText("working", queued.length)); return; }
    if (action === "send") void send(text);
  };

  tui.setLayoutRoot(shell);
  tui.setFocus(input);
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>();
  tui.addInputListener((data) => {
    if (data !== "\x03") return undefined;
    exiting = true;
    push(busy.active ? "Detached — the current wake continues in the daemon. Use /stop before detaching when you intend to cancel it." : "Detached.");
    activeStream?.abort();
    tui.stop(); resolveExit();
    return { consume: true };
  });
  tui.start();
  if (initialMessage) void send(initialMessage);
  await exited;
}

async function runNonInteractive(configPath: string, stateDir: string, initialMessage: string | null): Promise<void> {
  await ensureDaemon(configPath, stateDir);
  console.log(`Console: ${(await waitForConsoleMetadata(stateDir)).url}`);
  if (!initialMessage) return;
  await streamControl(stateDir, { op: "interact", message: initialMessage }, (frame) => {
    const line = frameToLine(frame);
    if (line) console.log(line);
  });
}

function waitForConsoleMetadata(stateDir: string): Promise<{ url: string }> {
  const deadline = Date.now() + 10_000;
  const { promise, resolve, reject } = Promise.withResolvers<{ url: string }>();
  const poll = (): void => {
    try {
      const metadata = readConsoleMetadata(stateDir);
      if (metadata) resolve({ url: metadata.url });
      else if (Date.now() > deadline) reject(new Error("Goah Console did not start; restart the resident Supervisor"));
      else setTimeout(poll, 100);
    } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
  };
  poll();
  return promise;
}

/** One frame to one printable line (shared with the TUI transcript renderer). */
function frameToLine(frame: ControlFrame): string | null {
  const lines: string[] = [];
  renderFrame(frame, (line) => lines.push(line));
  return lines.length ? lines.join("\n") : null;
}
/** Render one control-protocol frame into a transcript line. */
export function renderFrame(frame: ControlFrame, push: (line: string) => void, appendLive: (text: string) => void = push, commitLive: (text: string) => void = push, pushResponse: (text: string) => void = push): void {
  if (frame.type === "error") { push(`${tuiTheme.error("error")}  ${safeError(frame.error)}\n`); return; }
  if (frame.type === "accepted") return;
  if (frame.type === "result") {
    const value = frame.value && typeof frame.value === "object" && !Array.isArray(frame.value) ? frame.value as Record<string, unknown> : {};
    const response = value.response && typeof value.response === "object" && !Array.isArray(value.response) ? value.response as Record<string, unknown> : {};
    if (typeof response.content === "string" && response.content.trim()) pushResponse(response.content.trim());
    return;
  }
  if (frame.type !== "event") return;
  const event = frame.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const record = event as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
  if (record.type === "tool.called") {
    return;
  } else if (record.type === "tool.completed") {
    push(`  ${tuiTheme.muted(String(data.name ?? "tool"))}  ${data.isError ? tuiTheme.error("failed") : tuiTheme.success("done")}`);
  } else if (record.type === "message.assistant.delta") {
    const delta = data.delta && typeof data.delta === "object" && !Array.isArray(data.delta) ? data.delta as Record<string, unknown> : {};
    if (typeof delta.delta === "string") appendLive(delta.delta);
  } else if (record.type === "message.assistant.completed") {
    const message = data.message && typeof data.message === "object" ? data.message as Record<string, unknown> : {};
    const text = messageText(message.content);
    if (text) commitLive(text);
  } else if (record.type === "handoff.recorded") {
    if (typeof data.goalId === "string") push(`${data.outcome === "blocked" ? tuiTheme.error("goal blocked") : tuiTheme.success("goal saved")}  ${tuiTheme.muted(`${String(data.outcome).replaceAll("_", " ")} · record r${String(data.recordRevision)}`)}`);
    else {
      const results = Array.isArray(data.results) ? data.results : [];
      for (const result of results) if (typeof result === "string") push(`${tuiTheme.success("done")}  ${result}`);
    }
  } else if (record.type === "ceo.human_requested") {
    push(`${tuiTheme.warning("needs you")}  ${safeError(compact(record.data ?? {}))}`);
  } else if (record.type === "wake.abnormal_reason") {
    push(`${tuiTheme.error("error")}  ${safeError(typeof data.reason === "string" ? data.reason : "Wake failed")}\n`);
  }
}

async function printStatus(stateDir: string, push: (line: string) => void): Promise<void> {
  try {
    const status = await requestControl(stateDir, { op: "ceo.status" });
    const value = status && typeof status === "object" && !Array.isArray(status) ? status as Record<string, unknown> : {};
    const roots = Array.isArray(value.roots) ? value.roots as Array<Record<string, unknown>> : [];
    const team = Array.isArray(value.team) ? value.team as Array<Record<string, unknown>> : [];
    const pending = Array.isArray(value.pendingHuman) ? value.pendingHuman.length : 0;
    push([tuiTheme.strong("Status"), roots[0] ? `  ${tuiTheme.active(" GOAL ")}  ${String(roots[0].objective)}  ${tuiTheme.muted(String(roots[0].phase))}` : `  ${tuiTheme.muted("No active Goal")}`, `  ${tuiTheme.muted(team.length ? team.map((member) => `${String(member.agent)} ${String(member.status)}`).join(" · ") : "No Goal Agents")}`, ...(pending ? [`  ${tuiTheme.warning(`${pending} decision${pending === 1 ? "" : "s"} need you`)}`] : []), ""].join("\n"));
  } catch (error) { push(errorLine(error)); }
}

async function refreshGoalBar(stateDir: string, view: GoalBar, tui: TuiAltScreen): Promise<void> {
  try {
    const status = await requestControl(stateDir, { op: "ceo.status" });
    const roots = status && typeof status === "object" && !Array.isArray(status) && Array.isArray((status as Record<string, unknown>).roots) ? (status as Record<string, unknown>).roots as Array<Record<string, unknown>> : [];
    const root = roots[0];
    view.setRoot(root ? { objective: String(root.objective), phase: String(root.phase) } : null);
    tui.requestRender();
  } catch {}
}

async function printRecords(text: string, stateDir: string, push: (line: string) => void): Promise<void> {
  try {
    if (text === "/records") {
      const records = await requestControl(stateDir, { op: "work.records" });
      const values = Array.isArray(records) ? records as Array<Record<string, unknown>> : [];
      push(values.length ? `${tuiTheme.strong("Work Records")}\n${values.map((record) => `  ${tuiTheme.accent(String(record.goalId))}  ${tuiTheme.muted(`r${String(record.recordRevision)} · ${String(record.updatedBy)}`)}`).join("\n")}\n` : tuiTheme.muted("No Goal Work Records."));
      return;
    }
    const history = text.startsWith("/history ");
    const goalId = text.slice(history ? 9 : 9).trim();
    const value = await requestControl(stateDir, history ? { op: "work.history", goalId } : { op: "work.record", goalId });
    if (history && Array.isArray(value)) push(`${tuiTheme.strong(`History · ${goalId}`)}\n${(value as Array<Record<string, unknown>>).map((record) => `  ${tuiTheme.accent(`r${String(record.recordRevision)}`)}  ${String(record.updatedBy)} · ${tuiTheme.muted(String(record.reason))}`).join("\n")}\n`);
    else if (value && typeof value === "object" && !Array.isArray(value)) push(String((value as Record<string, unknown>).content ?? "Record is empty."));
    else push("Work Record not found.");
  } catch (error) { push(errorLine(error)); }
}

async function stopCeoWake(stateDir: string, push: (line: string) => void): Promise<void> {
  try {
    const wake = await requestControl(stateDir, { op: "wake.stop", agent: "ceo" });
    push(wake ? `${tuiTheme.warning("stopping")}  Current run will close as interrupted.` : tuiTheme.muted("No active run."));
  } catch (error) { push(errorLine(error)); }
}

async function slashGoal(text: string, stateDir: string, push: (line: string) => void): Promise<void> {
  const isGoal = text.startsWith("/goal ");
  const value = text.slice(isGoal ? 6 : 9).trim();
  try {
    const status = await requestControl(stateDir, { op: "ceo.status" });
    const roots = status && typeof status === "object" && !Array.isArray(status) && Array.isArray((status as Record<string, unknown>).roots) ? (status as Record<string, unknown>).roots as unknown[] : [];
    const root = roots.find((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown> | undefined;
    if (!root) {
      if (!isGoal) throw new Error("no active root goal");
      const created = await requestControl(stateDir, { op: "goal.start", objective: value });
      const goal = created && typeof created === "object" && !Array.isArray(created) ? (created as Record<string, unknown>).goal as Record<string, unknown> | undefined : undefined;
      push(`${tuiTheme.success("goal created")}  ${String(goal?.objective ?? value)}\n`);
      return;
    }
    const op = isGoal
      ? { op: "goal.update" as const, id: String(root.id), objective: value }
      : { op: "goal.observe" as const, id: String(root.id), observationMethod: value };
    const updated = await requestControl(stateDir, op);
    const goal = updated && typeof updated === "object" && !Array.isArray(updated) && (updated as Record<string, unknown>).goal && typeof (updated as Record<string, unknown>).goal === "object" ? (updated as Record<string, unknown>).goal as Record<string, unknown> : updated as Record<string, unknown>;
    push(`${tuiTheme.success(isGoal ? "goal updated" : "observation set")}  ${String(goal?.objective ?? value)}\n`);
  } catch (error) { push(errorLine(error)); }
}

/** /approve ID --reason TEXT --evidence SEQ[,SEQ] (and /reject with the same shape). */
async function slashApprove(text: string, stateDir: string, push: (line: string) => void): Promise<void> {
  const approve = text.startsWith("/approve ");
  const rest = text.slice(approve ? 9 : 8).match(/^(\S+)(?:\s+--reason\s+(.*?))?(?:\s+--evidence\s+([\d,]+))?$/);
  if (!rest) { push(errorLine("usage: /approve ACTION_ID --reason TEXT --evidence SEQ[,SEQ]")); return; }
  const [, id = "", reason = "terminal approval", evidence = ""] = rest;
  try {
    const op = approve ? { op: "action.approve" as const, id, reason, evidence: evidence ? evidence.split(",").map(Number) : [] }
      : { op: "action.reject" as const, id, reason, evidence: evidence ? evidence.split(",").map(Number) : [] };
    await requestControl(stateDir, op);
    push(`${tuiTheme.success(approve ? "approved" : "rejected")}  ${id}`);
  } catch (error) { push(errorLine(error)); }
}

async function ensureDaemon(configPath: string, stateDir: string): Promise<void> {
  if (await controlAvailable(stateDir)) {
    const version = await requestControl(stateDir, { op: "daemon.version" }).catch(() => null);
    if (version === installedVersion()) return;
    await requestControl(stateDir, { op: "daemon.stop" }).catch(() => undefined);
    const stopDeadline = Date.now() + 5_000;
    while (await controlAvailable(stateDir) && Date.now() < stopDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  mkdirSync(stateDir, { recursive: true });
  const log = openSync(join(stateDir, "daemon.log"), "a");
  spawn(process.execPath, [process.argv[1]!, "start", "--config", resolve(configPath)], { cwd: process.cwd(), detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
  closeSync(log);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await controlAvailable(stateDir)) return;
    const { promise: tick, resolve: resolveWait } = Promise.withResolvers<void>();
    setTimeout(resolveWait, 100);
    await tick;
  }
  throw new Error("Goah Supervisor did not start; run `goah doctor` and inspect the configured provider credentials");
}

function compact(value: unknown): string {
  const json = JSON.stringify(value) ?? "";
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}
function errorLine(error: unknown): string { return `${tuiTheme.error("error")}  ${safeError(error instanceof Error ? error.message : String(error))}\n`; }
function safeError(value: string): string {
  const sanitized = value
    .replace(/environment variable is missing:\s*[^\s(]+/gi, "environment variable is missing: [REDACTED]")
    .replace(/(?:sk|key|token)[-_][A-Za-z0-9._-]{12,}/gi, "[REDACTED]");
  const named = sanitized.match(/^(?:TypeError|RangeError|ReferenceError|SyntaxError|Error):\s*[^\n]+/m)?.[0];
  if (named) return named;
  return sanitized.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("file://") && !line.startsWith("at ") && line !== "^") ?? "Wake failed";
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return (value as unknown[])
    .map((item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string" ? (item as Record<string, unknown>).text as string : "")
    .filter(Boolean)
    .join("\n");
}

/** /model ID — write config and hot-reload the daemon runner. */
async function switchModelCommand(text: string, configPath: string, stateDir: string, push: (line: string) => void): Promise<void> {
  const model = text.slice(7).trim();
  if (!model) { push(errorLine("usage: /model MODEL_ID")); return; }
  try { push(await switchModel(configPath, stateDir, model)); }
  catch (error) { push(errorLine(error)); }
}

/** /setup — re-enter the wizard, then reload the daemon so changes apply to the next wake. */
async function runSetupReload(configPath: string, stateDir: string, push: (line: string) => void): Promise<void> {
  const result = await runSetupWizard();
  if (!result.profile) { push("setup cancelled; nothing changed"); return; }
  applyWizardResult(result, configPath);
  push(await reloadDaemon(stateDir, configPath) ? "config reloaded — applies to the next wake" : `saved to ${resolve(configPath)}; daemon will pick it up on next start`);
}
