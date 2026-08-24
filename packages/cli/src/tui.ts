/** Full-screen goah TUI: streaming CEO transcript over the resident Supervisor control socket. */
import { TUI, Text, Input, ProcessTerminal, type Component } from "@mariozechner/pi-tui";
import { controlAvailable, requestControl, streamControl, type ControlFrame } from "./control.js";
import { readConsoleMetadata } from "./index.js";
import { switchModel, reloadDaemon, readRunnerEnv } from "./live-config.js";
import { welcomeSnapshot, renderWelcome } from "./welcome.js";
import { runSetupWizard, applyWizardResult } from "./setup-wizard.js";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

interface CancellableState { active: boolean }

export async function runGoahTui(configPath: string, stateDir: string, initialMessage: string | null): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return runNonInteractive(configPath, stateDir, initialMessage);
  const runnerEnv = readRunnerEnv(configPath);
  const snapshot = welcomeSnapshot(stateDir, runnerEnv);
  const transcript: string[] = renderWelcome(snapshot, snapshot.handoffs.length > 0);
  await ensureDaemon(configPath, stateDir);
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const transcriptView = new Text(transcript.join("\n"));
  const input = new Input();
  const busy: CancellableState = { active: false };

  const push = (line: string): void => {
    transcript.push(line);
    // Keep the transcript bounded: the TUI renders every line we keep.
    const kept = transcript.slice(-500);
    transcript.length = 0;
    transcript.push(...kept);
    transcriptView.setText(transcript.join("\n"));
    tui.requestRender();
  };

  const send = async (message: string): Promise<void> => {
    busy.active = true;
    push(`> ${message}`);
    try {
      await streamControl(stateDir, { op: "interact", message }, (frame) => renderFrame(frame, push));
    } catch (error) {
      push(`! ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy.active = false;
    }
  };

  input.onSubmit = (line) => {
    const text = line.trim();
    input.setValue("");
    if (text === "/quit" || text === "/exit") { tui.stop(); resolveExit(); return; }
    if (text === "/status") { void printStatus(stateDir, push); return; }
    if (text.startsWith("/model ")) { void switchModelCommand(text, configPath, stateDir, push); return; }
    if (text === "/setup") { void runSetupReload(configPath, stateDir, push); return; }
    if (text.startsWith("/goal ") || text.startsWith("/observe ")) { void slashGoal(text, stateDir, push); return; }
  };

  tui.addChild(transcriptView);
  tui.addChild(input);
  tui.setFocus(input);
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>();
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
function renderFrame(frame: ControlFrame, push: (line: string) => void): void {
  if (frame.type === "error") { push(`! ${frame.error}`); return; }
  if (frame.type === "accepted") { push(`[ceo wake ${frame.wakeId}]`); return; }
  if (frame.type !== "event") return;
  const event = frame.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const record = event as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
  if (record.type === "tool.called") {
    push(`→ ${String(data.name)} ${compact(data.arguments ?? {})}`);
  } else if (record.type === "message.assistant.completed") {
    const message = data.message && typeof data.message === "object" ? data.message as Record<string, unknown> : {};
    const text = messageText(message.content);
    if (text) push(text);
  } else if (record.type === "handoff.recorded") {
    const results = Array.isArray(data.results) ? data.results : [];
    for (const result of results) if (typeof result === "string") push(`✓ ${result}`);
  } else if (record.type === "ceo.human_requested") {
    push(`? human decision requested: ${compact(record.data ?? {})}`);
  } else if (record.type === "wake.abnormal_reason") {
    push(`! ${JSON.stringify(record.data)}`);
  }
}

async function printStatus(stateDir: string, push: (line: string) => void): Promise<void> {
  try {
    const status = await requestControl(stateDir, { op: "ceo.status" });
    push(JSON.stringify(status, null, 2));
  } catch (error) { push(`! ${error instanceof Error ? error.message : String(error)}`); }
}

async function slashGoal(text: string, stateDir: string, push: (line: string) => void): Promise<void> {
  const isGoal = text.startsWith("/goal ");
  const value = text.slice(isGoal ? 6 : 9).trim();
  try {
    const status = await requestControl(stateDir, { op: "ceo.status" });
    const roots = status && typeof status === "object" && !Array.isArray(status) && Array.isArray((status as Record<string, unknown>).roots) ? (status as Record<string, unknown>).roots as unknown[] : [];
    const root = roots.find((item) => item && typeof item === "object" && !Array.isArray(item)) as Record<string, unknown> | undefined;
    if (!root) throw new Error("no active root goal");
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
  spawn(process.execPath, [process.argv[1]!, "start", "--config", resolve(configPath)], { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env }).unref();
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
  push("Leaving the TUI for setup — it returns after the wizard finishes.");
  const result = await runSetupWizard();
  if (!result.options.provider) { push("setup cancelled; nothing changed"); return; }
  applyWizardResult(result, configPath);
  push(await reloadDaemon(stateDir, configPath) ? "config reloaded — applies to the next wake" : `saved to ${resolve(configPath)}; daemon will pick it up on next start`);
}
