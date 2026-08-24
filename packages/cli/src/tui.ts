/** Full-screen goah TUI: streaming CEO transcript over the resident Supervisor control socket. */
import { TUI, Text, Input, ProcessTerminal, type Component } from "@mariozechner/pi-tui";
import { controlAvailable, requestControl, streamControl, type ControlFrame } from "./control.js";
import { readConsoleMetadata } from "./index.js";
import { switchModel, reloadDaemon, readRunnerDisplay } from "./live-config.js";
import { welcomeSnapshot, renderWelcome } from "./welcome.js";
import { runSetupWizard, applyWizardResult } from "./setup-wizard.js";
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";

interface CancellableState { active: boolean }
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
  const transcript: string[] = renderWelcome(snapshot, snapshot.handoffs.length > 0);
  await ensureDaemon(configPath, stateDir);
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const transcriptView = new Text(transcript.join("\n"));
  const input = new Input();
  const statusView = new Text("Ready · Enter sends · Ctrl+C detaches · /help lists commands");
  const busy: CancellableState = { active: false };
  const queued: string[] = [];
  let liveText = "";
  let activeStream: AbortController | null = null;
  let exiting = false;

  const render = (): void => {
    const kept = transcript.slice(-500);
    transcript.length = 0;
    transcript.push(...kept);
    transcriptView.setText([...transcript, ...(liveText ? [liveText] : [])].join("\n"));
    tui.requestRender();
  };

  const push = (line: string): void => {
    transcript.push(line);
    render();
  };
  const appendLive = (text: string): void => { liveText += text; render(); };
  const commitLive = (text: string): void => { liveText = ""; if (text) transcript.push(text); render(); };

  const send = async (message: string): Promise<void> => {
    busy.active = true;
    const controller = new AbortController(); activeStream = controller;
    statusView.setText(`Working · ${queued.length} queued · new messages become follow-ups`);
    push(`> ${message}`);
    try {
      await streamControl(stateDir, { op: "interact", message }, (frame) => renderFrame(frame, push, appendLive, commitLive), controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) push(`! ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (activeStream === controller) activeStream = null;
      busy.active = false;
      statusView.setText(queued.length ? `${queued.length} follow-up queued` : "Ready · Enter sends · Ctrl+C detaches · /help lists commands");
      const next = exiting ? undefined : queued.shift();
      if (next) void send(next);
    }
  };
  const launchSetup = async (): Promise<void> => {
    if (busy.active) { push("Wait for the current wake or use /stop before changing Runner configuration."); return; }
    statusView.setText("Opening setup…");
    tui.stop();
    try { await runSetupReload(configPath, stateDir, push); }
    finally { if (!exiting) { tui.start(); tui.requestRender(true); statusView.setText("Ready · Enter sends · Ctrl+C detaches · /help lists commands"); } }
  };

  input.onSubmit = (line) => {
    const { action, text } = classifyTuiInput(line, busy.active);
    input.setValue("");
    if (action === "quit") { exiting = true; activeStream?.abort(); tui.stop(); resolveExit(); return; }
    if (action === "help") { push("Commands: /status · /records [GOAL] · /history GOAL · /stop · /model · /setup · /goal TEXT · /observe TEXT · /approve · /reject · /quit"); return; }
    if (action === "status") { void printStatus(stateDir, push); return; }
    if (action === "records") { void printRecords(text, stateDir, push); return; }
    if (action === "stop") { void stopCeoWake(stateDir, push); return; }
    if (action === "model") { if (text === "/model") void launchSetup(); else void switchModelCommand(text, configPath, stateDir, push); return; }
    if (action === "setup") { void launchSetup(); return; }
    if (action === "goal") { void slashGoal(text, stateDir, push); return; }
    if (action === "approval") { void slashApprove(text, stateDir, push); return; }
    if (action === "queue") { queued.push(text); push(`↳ queued follow-up: ${text}`); statusView.setText(`Working · ${queued.length} queued`); return; }
    if (action === "send") void send(text);
  };

  tui.addChild(transcriptView);
  tui.addChild(statusView);
  tui.addChild(input);
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
export function renderFrame(frame: ControlFrame, push: (line: string) => void, appendLive: (text: string) => void = push, commitLive: (text: string) => void = push): void {
  if (frame.type === "error") { push(`! ${safeError(frame.error)}`); return; }
  if (frame.type === "accepted") return;
  if (frame.type === "result") {
    const value = frame.value && typeof frame.value === "object" && !Array.isArray(frame.value) ? frame.value as Record<string, unknown> : {};
    const response = value.response && typeof value.response === "object" && !Array.isArray(value.response) ? value.response as Record<string, unknown> : {};
    if (typeof response.content === "string" && response.content.trim()) push(response.content.trim());
    return;
  }
  if (frame.type !== "event") return;
  const event = frame.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const record = event as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
  if (record.type === "tool.called") {
    push(`→ ${String(data.name)}`);
  } else if (record.type === "tool.completed") {
    push(`${data.isError ? "✗" : "✓"} ${String(data.name ?? "tool")} ${data.isError ? "failed" : "completed"}`);
  } else if (record.type === "message.assistant.delta") {
    const delta = data.delta && typeof data.delta === "object" && !Array.isArray(data.delta) ? data.delta as Record<string, unknown> : {};
    if (typeof delta.delta === "string") appendLive(delta.delta);
  } else if (record.type === "message.assistant.completed") {
    const message = data.message && typeof data.message === "object" ? data.message as Record<string, unknown> : {};
    const text = messageText(message.content);
    if (text) commitLive(text);
  } else if (record.type === "handoff.recorded") {
    if (typeof data.goalId === "string") push(`${data.outcome === "blocked" ? "!" : "✓"} Goal ${String(data.outcome).replaceAll("_", " ")} · record r${String(data.recordRevision)}`);
    else {
      const results = Array.isArray(data.results) ? data.results : [];
      for (const result of results) if (typeof result === "string") push(`✓ ${result}`);
    }
  } else if (record.type === "ceo.human_requested") {
    push(`? human decision requested: ${safeError(compact(record.data ?? {}))}`);
  } else if (record.type === "wake.abnormal_reason") {
    push(`! ${safeError(typeof data.reason === "string" ? data.reason : "Wake failed")}`);
  }
}

async function printStatus(stateDir: string, push: (line: string) => void): Promise<void> {
  try {
    const status = await requestControl(stateDir, { op: "ceo.status" });
    const value = status && typeof status === "object" && !Array.isArray(status) ? status as Record<string, unknown> : {};
    const roots = Array.isArray(value.roots) ? value.roots as Array<Record<string, unknown>> : [];
    const team = Array.isArray(value.team) ? value.team as Array<Record<string, unknown>> : [];
    const pending = Array.isArray(value.pendingHuman) ? value.pendingHuman.length : 0;
    push([roots[0] ? `Goal: ${String(roots[0].objective)} [${String(roots[0].phase)}]` : "Goal: none", `Team: ${team.map((member) => `${String(member.agent)}=${String(member.status)}`).join(" · ") || "none"}`, `Needs you: ${pending}`].join("\n"));
  } catch (error) { push(`! ${error instanceof Error ? error.message : String(error)}`); }
}

async function printRecords(text: string, stateDir: string, push: (line: string) => void): Promise<void> {
  try {
    if (text === "/records") {
      const records = await requestControl(stateDir, { op: "work.records" });
      const values = Array.isArray(records) ? records as Array<Record<string, unknown>> : [];
      push(values.map((record) => `${String(record.goalId)} · r${String(record.recordRevision)} · ${String(record.updatedBy)}`).join("\n") || "No Goal Work Records.");
      return;
    }
    const history = text.startsWith("/history ");
    const goalId = text.slice(history ? 9 : 9).trim();
    const value = await requestControl(stateDir, history ? { op: "work.history", goalId } : { op: "work.record", goalId });
    if (history && Array.isArray(value)) push((value as Array<Record<string, unknown>>).map((record) => `r${String(record.recordRevision)} · ${String(record.updatedBy)} · ${String(record.reason)}`).join("\n"));
    else if (value && typeof value === "object" && !Array.isArray(value)) push(String((value as Record<string, unknown>).content ?? "Record is empty."));
    else push("Work Record not found.");
  } catch (error) { push(`! ${error instanceof Error ? error.message : String(error)}`); }
}

async function stopCeoWake(stateDir: string, push: (line: string) => void): Promise<void> {
  try {
    const wake = await requestControl(stateDir, { op: "wake.stop", agent: "ceo" });
    push(wake ? "Stopping the current CEO wake; its durable trace will close as interrupted." : "No active CEO wake.");
  } catch (error) { push(`! ${error instanceof Error ? error.message : String(error)}`); }
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
      push(JSON.stringify(await requestControl(stateDir, { op: "goal.start", objective: value }), null, 2));
      return;
    }
    const op = isGoal
      ? { op: "goal.update" as const, id: String(root.id), objective: value }
      : { op: "goal.observe" as const, id: String(root.id), observationMethod: value };
    push(JSON.stringify(await requestControl(stateDir, op), null, 2));
  } catch (error) { push(`! ${error instanceof Error ? error.message : String(error)}`); }
}

/** /approve ID --reason TEXT --evidence SEQ[,SEQ] (and /reject with the same shape). */
async function slashApprove(text: string, stateDir: string, push: (line: string) => void): Promise<void> {
  const approve = text.startsWith("/approve ");
  const rest = text.slice(approve ? 9 : 8).match(/^(\S+)(?:\s+--reason\s+(.*?))?(?:\s+--evidence\s+([\d,]+))?$/);
  if (!rest) { push("! usage: /approve ACTION_ID --reason TEXT --evidence SEQ[,SEQ]"); return; }
  const [, id = "", reason = "terminal approval", evidence = ""] = rest;
  try {
    const op = approve ? { op: "action.approve" as const, id, reason, evidence: evidence ? evidence.split(",").map(Number) : [] }
      : { op: "action.reject" as const, id, reason, evidence: evidence ? evidence.split(",").map(Number) : [] };
    push(JSON.stringify(await requestControl(stateDir, op), null, 2));
  } catch (error) { push(`! ${error instanceof Error ? error.message : String(error)}`); }
}

async function ensureDaemon(configPath: string, stateDir: string): Promise<void> {
  if (await controlAvailable(stateDir)) return;
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
function safeError(value: string): string {
  return value
    .replace(/environment variable is missing:\s*[^\s(]+/gi, "environment variable is missing: [REDACTED]")
    .replace(/(?:sk|key|token)[-_][A-Za-z0-9._-]{12,}/gi, "[REDACTED]");
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
  if (!model) { push("! usage: /model MODEL_ID"); return; }
  try { push(await switchModel(configPath, stateDir, model)); }
  catch (error) { push(`! ${error instanceof Error ? error.message : String(error)}`); }
}

/** /setup — re-enter the wizard, then reload the daemon so changes apply to the next wake. */
async function runSetupReload(configPath: string, stateDir: string, push: (line: string) => void): Promise<void> {
  const result = await runSetupWizard();
  if (!result.profile) { push("setup cancelled; nothing changed"); return; }
  applyWizardResult(result, configPath);
  push(await reloadDaemon(stateDir, configPath) ? "config reloaded — applies to the next wake" : `saved to ${resolve(configPath)}; daemon will pick it up on next start`);
}
