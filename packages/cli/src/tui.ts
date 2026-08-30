/** Full-screen goah TUI: streaming CEO transcript over the resident Supervisor control socket. */
import { TuiAltScreen, Text, Markdown, Editor, Image, HStack, ProcessTerminal, ScrollView, VStack, CombinedAutocompleteProvider, CURSOR_MARKER, Key, getCapabilities, isKeyRelease, matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, type Component, type Focusable, type MarkdownTheme, type SlashCommand } from "@earendil-works/pi-tui";
import { controlAvailable, requestControl, streamControl, type ControlFrame, type ControlRequest } from "./control.js";
import { loadConfig, readConsoleMetadata, readDefaultRunnerProfile } from "./index.js";
import { switchModel, reloadDaemon, readRunnerDisplay } from "./live-config.js";
import { GOAH_TERMINAL_MARK, welcomeSnapshot, type WelcomeSnapshot } from "./welcome.js";
import { chooseSetupSection, runRunnerCommandWizard, runSetupWizard, applyWizardResult, type SetupSection } from "./setup-wizard.js";
import { installedVersion } from "./update.js";
import { tuiTheme } from "./tui-theme.js";
import { ensureDaemon } from "./daemon-client.js";
import { normalizeAssistantText } from "goah-ledger-contract";
import { looksLikeCredential, redactSensitiveText } from "./sensitive-text.js";
import { existsSync, readFileSync } from "node:fs";

interface CancellableState { active: boolean }
class HeaderBar implements Component {
  constructor(private readonly runner: string, private readonly target: string, private readonly version: string) {}
  render(width: number): string[] { return [renderTuiHeader(width, this.runner, this.target, this.version)]; }
  invalidate(): void {}
}
export interface OrganizationStatus {
  goal: string | null;
  model: string | null;
  childAgents: number;
  nextWakeAt: string | null;
}
class OrganizationStatusLine implements Component {
  constructor(private value: OrganizationStatus) {}
  set(value: OrganizationStatus): void { this.value = value; }
  render(width: number): string[] { return [renderOrganizationStatus(this.value, width)]; }
  invalidate(): void {}
}
class MessageComposer implements Component, Focusable {
  #focused = false;
  constructor(readonly editor: Editor) {}
  get focused(): boolean { return this.#focused; }
  set focused(value: boolean) { this.#focused = value; this.editor.focused = value; }
  render(width: number): string[] {
    const lines = this.editor.render(width);
    if (this.editor.getText() || lines.length < 3) return lines;
    return [lines[0]!, renderMessagePlaceholder(width, this.focused), ...lines.slice(2)];
  }
  handleInput(data: string): void { this.editor.handleInput(data); }
  invalidate(): void { this.editor.invalidate(); }
}
export function renderMessagePlaceholder(width: number, focused: boolean): string {
  return truncateToWidth(` ${tuiTheme.accent("›")} ${focused ? CURSOR_MARKER : ""}${tuiTheme.muted("Message Goah…")}`, width, "", true);
}
const markdownTheme: MarkdownTheme = {
  heading: tuiTheme.accent, link: tuiTheme.accent, linkUrl: tuiTheme.muted, code: tuiTheme.warning,
  codeBlock: tuiTheme.subtle, codeBlockBorder: tuiTheme.muted, quote: tuiTheme.subtle, quoteBorder: tuiTheme.accent,
  hr: tuiTheme.muted, listBullet: tuiTheme.accent, bold: tuiTheme.strong, italic: tuiTheme.muted,
  strikethrough: tuiTheme.muted, underline: tuiTheme.underline, codeBlockIndent: "  ",
};
interface StoredToolActivity extends ToolActivity { startedAt?: number; elapsedMs?: number }
interface TurnPresentation {
  kind: "turn";
  users: string[];
  thinking: string;
  thinkingActive: boolean;
  thinkingStartedAt?: number;
  thinkingElapsedMs?: number;
  tools: StoredToolActivity[];
  responses: Array<{ content: string; messageId?: string }>;
  liveMarkdown: string;
  notices: string[];
}
type ConversationEntry = { kind: "component"; component: Component } | { kind: "notice"; content: string } | TurnPresentation;
export class ConversationView implements Component {
  private entries: ConversationEntry[];
  private details = true;
  constructor(initial: string[]) { this.entries = initial.length ? [{ kind: "notice", content: initial.join("\n") }] : []; }
  addComponent(component: Component): void { this.entries.push({ kind: "component", component }); }
  addText(content: string): void {
    const turn = this.lastTurn();
    const plain = stripTerminalSequences(content).trim().toLowerCase();
    if (turn && /^(error|failed|goal |stopping|new turn)/.test(plain)) {
      if (turn.notices.at(-1) !== content) turn.notices.push(content);
    } else {
      const previous = this.entries.at(-1);
      if (previous?.kind !== "notice" || previous.content !== content) this.entries.push({ kind: "notice", content });
    }
    this.trim();
  }
  addUser(content: string): void {
    const previous = this.lastTurn();
    if (previous && previous.responses.length === 0 && previous.notices.length === 0) previous.users.push(content);
    else this.entries.push(newTurn(content));
    this.trim();
  }
  addMarkdown(content: string, messageId?: string): void {
    content = content.trim();
    if (!content) return;
    if (messageId && this.entries.some((entry) => entry.kind === "turn" && entry.responses.some((response) => response.messageId === messageId))) return;
    const turn = this.currentTurn();
    turn.liveMarkdown = "";
    if (turn.responses.at(-1)?.content === content) return;
    turn.responses.push({ content, ...(messageId ? { messageId } : {}) });
    this.trim();
  }
  appendLiveMarkdown(content: string): void { this.currentTurn().liveMarkdown += content; }
  setLive(text: string, thinking: string, thinkingActive: boolean): void {
    const turn = this.currentTurn();
    turn.liveMarkdown = text;
    turn.thinking = thinking;
    turn.thinkingActive = thinkingActive;
    if (thinkingActive && turn.thinkingStartedAt === undefined) turn.thinkingStartedAt = Date.now();
  }
  clearLiveMarkdown(): void { const turn = this.lastTurn(); if (turn) turn.liveMarkdown = ""; }
  updateThinking(activity: ThinkingActivity): void {
    const turn = this.currentTurn();
    if (activity.phase === "start") { turn.thinking = ""; turn.thinkingActive = true; turn.thinkingStartedAt = Date.now(); return; }
    if (activity.phase === "delta") { turn.thinking += activity.text; turn.thinkingActive = true; turn.thinkingStartedAt ??= Date.now(); return; }
    if (activity.phase === "clear") { turn.thinking = ""; turn.thinkingActive = false; delete turn.thinkingStartedAt; delete turn.thinkingElapsedMs; return; }
    turn.thinking = (activity.text || turn.thinking).trim();
    turn.thinkingActive = false;
    if (turn.thinkingStartedAt !== undefined) turn.thinkingElapsedMs = Math.max(0, Date.now() - turn.thinkingStartedAt);
  }
  updateTool(activity: ToolActivity): void {
    const turn = this.currentTurn();
    const previous = turn.tools.find((tool) => tool.callId === activity.callId);
    if (previous) {
      Object.assign(previous, { ...activity, detail: activity.detail || previous.detail });
      if (activity.status !== "running" && previous.startedAt !== undefined) previous.elapsedMs = Math.max(0, Date.now() - previous.startedAt);
    } else turn.tools.push({ ...activity, ...(activity.status === "running" ? { startedAt: Date.now() } : {}) });
    this.trim();
  }
  stopRunningTools(): void {
    for (const entry of this.entries) if (entry.kind === "turn") for (const tool of entry.tools) if (tool.status === "running") { tool.status = "failed"; if (tool.startedAt !== undefined) tool.elapsedMs = Math.max(0, Date.now() - tool.startedAt); }
  }
  toggleDetails(): void { this.details = !this.details; }
  endTransientTurn(): void { const turn = this.lastTurn();if(turn){turn.liveMarkdown="";turn.thinking="";turn.thinkingActive=false;}this.stopRunningTools(); }
  private currentTurn(): TurnPresentation { const turn=this.lastTurn();if(turn)return turn;const created=newTurn();this.entries.push(created);return created; }
  private lastTurn(): TurnPresentation | null { const entry=this.entries.at(-1);return entry?.kind==="turn"?entry:null; }
  private trim(): void { if (this.entries.length > 120) this.entries.splice(this.entries[0]?.kind === "component" ? 1 : 0, this.entries.length - 120); }
  render(width: number): string[] {
    return this.entries.flatMap((entry) => entry.kind === "component" ? entry.component.render(width) : entry.kind === "notice" ? [...new Text(entry.content, 2, 0).render(width), ""] : renderTurn(entry, width, this.details));
  }
  invalidate(): void {}
}

function newTurn(user?: string): TurnPresentation {
  return { kind: "turn", users: user ? [user] : [], thinking: "", thinkingActive: false, tools: [], responses: [], liveMarkdown: "", notices: [] };
}

function renderTurn(turn: TurnPresentation, width: number, details: boolean): string[] {
  const lines: string[] = [];
  for (const user of turn.users) lines.push(...renderUserMessage(user, width), "");
  const hasActivity = turn.thinkingActive || Boolean(turn.thinking) || turn.tools.length > 0;
  if (hasActivity) lines.push(...(details ? renderLedgerActivity(turn, width) : renderActivitySummary(turn, width)), "");
  for (const response of turn.responses) lines.push(...new Markdown(response.content, 4, 0, markdownTheme).render(width), "");
  if (turn.liveMarkdown) lines.push(...new Markdown(turn.liveMarkdown, 4, 0, markdownTheme).render(width));
  for (const notice of turn.notices) lines.push(...new Text(notice, 4, 0).render(width));
  if (turn.users.length || hasActivity || turn.responses.length || turn.liveMarkdown || turn.notices.length) lines.push("");
  return lines;
}

function renderLedgerActivity(turn: TurnPresentation, width: number): string[] {
  const lines: string[] = [];
  const thinking = turn.thinkingActive || Boolean(turn.thinking);
  if (thinking) {
    const elapsed = formatDuration(turn.thinkingElapsedMs ?? (turn.thinkingStartedAt === undefined ? undefined : Date.now() - turn.thinkingStartedAt));
    const label = `  │ thinking${elapsed ? ` · ${elapsed}` : ""}`;
    const action = tuiTheme.muted("^O close");
    const available = Math.max(0, width - visibleWidth(label) - visibleWidth(action) - 2);
    const summary = truncateToWidth(thinkingSummary(turn.thinking), available, "…");
    const fill = " ".repeat(Math.max(1, available - visibleWidth(summary) + 1));
    lines.push(`${tuiTheme.muted(label)}${summary ? `  ${tuiTheme.muted(summary)}` : ""}${fill}${action}`);
  }
  for (let index = 0; index < turn.tools.length; index += 1) lines.push(renderLedgerTool(turn.tools[index]!, index === turn.tools.length - 1 ? "└" : "├", width));
  return lines;
}

function renderActivitySummary(turn: TurnPresentation, width: number): string[] {
  const done = turn.tools.filter((tool) => tool.status === "done").length;
  const failed = turn.tools.filter((tool) => tool.status === "failed").length;
  const running = turn.tools.find((tool) => tool.status === "running");
  const marker = failed ? tuiTheme.error("×") : running || turn.thinkingActive ? tuiTheme.accent("●") : tuiTheme.success("✓");
  const state = failed ? "failed" : `${done}/${turn.tools.length || 1} done`;
  const detail = running?.name ?? (turn.thinkingActive ? "thinking" : "work");
  return [truncateToWidth(`  ${marker} ${tuiTheme.muted(`work · ${state} · ${detail}`)}  ${tuiTheme.muted("^O details")}`, width, "…", true)];
}

function renderLedgerTool(tool: StoredToolActivity, branch: "├" | "└", width: number): string {
  const marker = tool.status === "running" ? tuiTheme.accent("●") : tool.status === "failed" ? tuiTheme.error("×") : tuiTheme.success("✓");
  const prefix = tuiTheme.muted(`  ${branch} `) + marker + " ";
  const nameWidth = Math.min(24, Math.max(12, Math.floor(width * 0.25)));
  const name = tuiTheme.strong(tool.name.padEnd(nameWidth));
  const elapsed = formatDuration(tool.elapsedMs);
  const time = elapsed ? tuiTheme.muted(elapsed) : "";
  const available = Math.max(0, width - visibleWidth(prefix) - nameWidth - visibleWidth(time) - 2);
  const detail = tuiTheme.muted(truncateToWidth(tool.detail, available, "…").padEnd(available));
  return truncateToWidth(`${prefix}${name} ${detail}${time ? ` ${time}` : ""}`, width, "…", true);
}

function thinkingSummary(content: string): string {
  return content.split("\n").map((line)=>line.replace(/^[\s#>*-]+/,"").trim()).filter(Boolean).at(-1)?.replace(/\s+/g," ") ?? "";
}

function formatDuration(value?: number): string {
  if (value === undefined) return "";
  if (value < 1_000) return `${Math.max(1, Math.round(value))}ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)}s`;
  return `${Math.floor(value / 60_000)}m${String(Math.floor(value / 1_000) % 60).padStart(2,"0")}s`;
}

export class WelcomeLockup implements Component {
  private readonly mark: Component;
  private readonly details: Component;
  private readonly horizontal: HStack;
  constructor(snapshot: WelcomeSnapshot, hasHistory: boolean, imageData: string | null = null) {
    this.mark = imageData
      ? new Image(imageData, "image/png", { fallbackColor: tuiTheme.accent }, { maxWidthCells: 10, maxHeightCells: 5, filename: "Goah" })
      : new Text(GOAH_TERMINAL_MARK.map((line) => tuiTheme.accent(line)).join("\n"), 0, 0);
    const lines = [
      tuiTheme.strong(hasHistory ? "Welcome back." : "Ready when you are."),
      `${tuiTheme.accent(snapshot.target)} ${tuiTheme.muted(`· ${snapshot.runner}`)}`,
    ];
    if (!snapshot.root) lines.push(tuiTheme.muted("Chat normally · /goal for durable work · /help"));
    if (snapshot.team.length) lines.push(tuiTheme.muted(`${snapshot.team.length} Goal Agent${snapshot.team.length === 1 ? "" : "s"} in the organization`));
    this.details = new Text(lines.join("\n"), 0, 0);
    this.horizontal = new HStack([
      { component: this.mark, basis: 14, shrink: 0 },
      { component: this.details, grow: 1, minSize: 24 },
    ], { gap: 2, align: "center" });
  }
  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    if (width < 58) {
      return ["", ...this.mark.render(Math.min(14, contentWidth)).map((line) => `  ${line}`), "", ...this.details.render(contentWidth).map((line) => `  ${line}`), ""];
    }
    return ["", ...this.horizontal.render(contentWidth).map((line) => `  ${line}`), ""];
  }
  invalidate(): void { this.mark.invalidate(); this.details.invalidate(); this.horizontal.invalidate(); }
}

function terminalLogoData(): string | null {
  if (getCapabilities().images !== "kitty") return null;
  try { return readFileSync(new URL("./console/goah-orbital-mark.png", import.meta.url)).toString("base64"); }
  catch { return null; }
}
export class StreamCoordinator {
  #active:AbortController|null=null;
  #pending:AbortController|null=null;
  get active():AbortController|null{return this.#active;}
  get hasPending():boolean{return this.#pending!==null;}
  begin(controller:AbortController):{owns:boolean;previous:AbortController|null}{if(this.#pending)throw new Error("Another Turn is waiting to be accepted.");const previous=this.#active;if(previous)this.#pending=controller;else this.#active=controller;return{owns:previous===null,previous};}
  accept(controller:AbortController):AbortController|null{if(this.#pending!==controller)throw new Error("Stream candidate is no longer pending.");const previous=this.#active;this.#pending=null;this.#active=controller;previous?.abort();return previous;}
  reject(controller:AbortController):void{if(this.#pending===controller)this.#pending=null;}
  isCurrent(controller:AbortController):boolean{return this.#active===controller;}
  complete(controller:AbortController):boolean{if(this.#active!==controller)return false;this.#active=null;return true;}
  retire():void{const previous=this.#active;this.#active=null;previous?.abort();}
  supersede():void{this.#active?.abort();this.#pending?.abort();this.#active=null;this.#pending=null;}
  abortAll():void{this.supersede();}
}
export function renderUserMessage(content: string, width: number): string[] {
  const body = new Text(content, 0, 0).render(Math.max(1, width - 4));
  return body.map((line, index) => truncateToWidth(`${index === 0 ? `  ${tuiTheme.accent("›")} ` : "    "}${line}`, width, "", true));
}
export function organizationStatusFromValue(value: unknown, fallbackGoal: string | null = null, fallbackModel: string | null = null): OrganizationStatus {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const root = record.root && typeof record.root === "object" && !Array.isArray(record.root) ? record.root as Record<string, unknown> : null;
  const team = Array.isArray(record.team) ? record.team.filter((member): member is Record<string, unknown> => Boolean(member) && typeof member === "object" && !Array.isArray(member)) : [];
  const childAgents = team.filter((member) => member.agent !== "ceo" && member.motion !== "retired").length;
  const nextWakeAt = team.map((member) => member.nextWakeAt).filter((item): item is string => typeof item === "string" && Number.isFinite(Date.parse(item))).sort()[0] ?? null;
  return { goal: typeof root?.objective === "string" ? root.objective : fallbackGoal, model: fallbackModel, childAgents, nextWakeAt };
}
export function renderOrganizationStatus(value: OrganizationStatus, width: number, now = new Date()): string {
  const separator = tuiTheme.subtle(" │ ");
  const modelValue = truncateToWidth(value.model ?? "—", width < 64 ? 10 : width < 96 ? 18 : 28, "…");
  if (width < 96) {
    const wakeValue = formatWake(value.nextWakeAt, now).replace(/^tomorrow /, "");
    const tail = `${separator}${tuiTheme.accent("M")} ${tuiTheme.muted(modelValue)}${separator}${tuiTheme.accent("C")}${tuiTheme.muted(String(value.childAgents))}${separator}${tuiTheme.accent("W")}${tuiTheme.muted(wakeValue)}`;
    const label = value.goal ? "GOAL" : "CHAT";
    const available = Math.max(0, width - visibleWidth(tail) - visibleWidth(label) - 1);
    const goal = value.goal ? truncateToWidth(value.goal.replace(/\s+/g," ").trim(), available, "…") : "";
    return truncateToWidth(`${tuiTheme.accent(label)}${goal?` ${tuiTheme.muted(goal)}`:""}${tail}`,width,"",true);
  }
  const model = `${tuiTheme.accent("MODEL")} ${tuiTheme.muted(modelValue)}`;
  const child = `${tuiTheme.accent("CHILD")} ${tuiTheme.muted(String(value.childAgents))}`;
  const wake = `${tuiTheme.accent("WAKE")} ${tuiTheme.muted(formatWake(value.nextWakeAt, now))}`;
  const tail = `${separator}${model}${separator}${child}${separator}${wake}`;
  const goalLabel = value.goal ? "GOAL" : "CHAT";
  const available = Math.max(0, width - visibleWidth(tail) - visibleWidth(goalLabel) - 2);
  const goal = value.goal ? truncateToWidth(value.goal.replace(/\s+/g, " ").trim(), available, "…") : "";
  const head = `${tuiTheme.accent(goalLabel)}${goal ? ` ${tuiTheme.muted(goal)}` : ""}`;
  return truncateToWidth(`${head}${tail}`, width, "", true);
}
function formatWake(value: string | null, now: Date): string {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  const time = `${String(date.getHours()).padStart(2,"0")}:${String(date.getMinutes()).padStart(2,"0")}`;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((target - start) / 86_400_000);
  if (days === 0) return time;
  if (days === 1) return `tomorrow ${time}`;
  return `${date.toLocaleString("en-US", { month: "short", day: "numeric" })} ${time}`;
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
export type TuiInputAction = "quit" | "help" | "status" | "records" | "stop" | "model" | "login" | "logout" | "setup" | "goal" | "unknown" | "empty" | "steer" | "send";
export interface TuiCommandDefinition extends SlashCommand { action:Exclude<TuiInputAction,"unknown"|"empty"|"steer"|"send">;acceptsArguments?:boolean;requiresArgument?:boolean;aliases?:string[] }
export const TUI_COMMANDS:TuiCommandDefinition[]=[
  {name:"goal",action:"goal",description:"Start or revise durable work",argumentHint:"<objective>",acceptsArguments:true,requiresArgument:true},
  {name:"model",action:"model",description:"Choose a provider and model",argumentHint:"[provider/model]",acceptsArguments:true},
  {name:"status",action:"status",description:"Inspect the current workspace"},
  {name:"setup",action:"setup",description:"Configure Goah",argumentHint:"[runner|model|auth]",acceptsArguments:true},
  {name:"records",action:"records",description:"Browse current work records",argumentHint:"[goal]",acceptsArguments:true},
  {name:"history",action:"records",description:"Show a Goal's record history",argumentHint:"<goal>",acceptsArguments:true,requiresArgument:true},
  {name:"observe",action:"goal",description:"Set how the active Goal is observed",argumentHint:"<method>",acceptsArguments:true,requiresArgument:true},
  {name:"login",action:"login",description:"Add provider credentials",argumentHint:"[provider]",acceptsArguments:true},
  {name:"logout",action:"logout",description:"Remove provider credentials",argumentHint:"[provider]",acceptsArguments:true},
  {name:"stop",action:"stop",description:"Stop the current Turn"},
  {name:"help",action:"help",description:"Show all commands"},
  {name:"quit",action:"quit",description:"Leave Goah",aliases:["exit"]},
];
function commandDefinition(text:string):{definition:TuiCommandDefinition;hasArguments:boolean}|null{const token=text.trim().split(/\s+/,1)[0]??"";if(!token.startsWith("/"))return null;const name=token.slice(1);const definition=TUI_COMMANDS.find((candidate)=>candidate.name===name||candidate.aliases?.includes(name));if(!definition)return null;return{definition,hasArguments:Boolean(text.trim().slice(token.length).trim())};}
export function commandAwaitingArgument(text:string):string|null{const match=commandDefinition(text);return match&&match.definition.requiresArgument&&!match.hasArguments?`/${match.definition.name} `:null;}
export function createTuiAutocompleteProvider(basePath=process.cwd()):CombinedAutocompleteProvider{const commands:SlashCommand[]=TUI_COMMANDS.map(({name,description,argumentHint,getArgumentCompletions})=>({name,...(description?{description}:{}),...(argumentHint?{argumentHint}:{}),...(getArgumentCompletions?{getArgumentCompletions}:{})}));return new CombinedAutocompleteProvider(commands,basePath);}
export function renderTuiCommandHelp():string{return [tuiTheme.strong("Commands"),...TUI_COMMANDS.map((command)=>{const invocation=`/${command.name}${command.argumentHint?` ${command.argumentHint}`:""}`;return `  ${invocation.padEnd(28)} ${tuiTheme.muted(command.description??"")}`;}),"",tuiTheme.strong("Keyboard"),`  ${"Ctrl+C".padEnd(28)} ${tuiTheme.muted("Clear input · interrupt current Turn · exit when idle")}`,`  ${"Ctrl+D".padEnd(28)} ${tuiTheme.muted("Exit when idle")}`,""].join("\n");}
export function classifyTuiInput(value: string, busy: boolean): { action: TuiInputAction; text: string } {
  const text = value.trim();
  if (!text) return { action: "empty", text };
  const command=commandDefinition(text);if(command){if(command.hasArguments&&!command.definition.acceptsArguments)return{action:"unknown",text};return{action:command.definition.action,text};}
  if (text.startsWith("/")) return { action: "unknown", text };
  return { action: busy ? "steer" : "send", text };
}

export type TuiControlAction = "forward" | "clear" | "interrupt" | "toggle_details" | "exit";
export function classifyTuiControlKey(data: string, inputText: string, busy: boolean): TuiControlAction {
  if (isKeyRelease(data)) return "forward";
  if (matchesKey(data, Key.ctrl("o"))) return "toggle_details";
  if (matchesKey(data, Key.ctrl("c"))) {
    if (inputText.length > 0) return "clear";
    return busy ? "interrupt" : "exit";
  }
  if (matchesKey(data, Key.ctrl("d")) && !inputText && !busy) return "exit";
  return "forward";
}

interface TuiSignalSource {
  on(signal: "SIGTERM" | "SIGHUP", listener: () => void): unknown;
  off(signal: "SIGTERM" | "SIGHUP", listener: () => void): unknown;
}

export function bindTuiTerminationSignals(shutdown: () => void, source: TuiSignalSource = process): () => void {
  source.on("SIGTERM", shutdown);
  source.on("SIGHUP", shutdown);
  return () => {
    source.off("SIGTERM", shutdown);
    source.off("SIGHUP", shutdown);
  };
}

export async function runGoahTui(configPath: string, stateDir: string, initialMessage: string | null): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return runNonInteractive(configPath, stateDir, initialMessage);
  const runner = readRunnerDisplay(configPath);
  const currentModel = (): string => readRunnerDisplay(configPath).target;
  const snapshot = welcomeSnapshot(stateDir, runner);
  const hasHistory = Boolean(snapshot.root || snapshot.handoffs.length || snapshot.conversation.length);
  await ensureDaemon(configPath, stateDir);
  const liveSnapshot = await requestControl(stateDir, { op: "status" }).catch(() => null);
  const initialOrganization = await requestControl(stateDir, { op: "ceo.status" }).catch(() => null);
  const liveTurns = liveSnapshot && typeof liveSnapshot === "object" && !Array.isArray(liveSnapshot) && Array.isArray(liveSnapshot.turns) ? liveSnapshot.turns as Array<Record<string, unknown>> : [];
  const liveInteractionTurnId = findLiveTurnId(liveTurns);
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, true, undefined, { mouse: true });
  terminal.setTitle(`Goah · ${runner.target}`);
  const headerView = new HeaderBar(runner.runner, runner.target, installedVersion());
  const transcriptView = new ConversationView([]);
  transcriptView.addComponent(new WelcomeLockup(snapshot, hasHistory, terminalLogoData()));
  for (const row of snapshot.conversation) if (row.speaker === "You") transcriptView.addUser(row.text); else transcriptView.addMarkdown(row.text);
  const conversationScroll = new ScrollView(transcriptView, { follow: "end", primary: true, scrollbar: "auto", scrollbarStyle: tuiTheme.muted });
  const organizationView = new OrganizationStatusLine(organizationStatusFromValue(initialOrganization, snapshot.root?.objective ?? null, runner.target));
  const input = new Editor(tui, {
    borderColor: tuiTheme.accent,
    selectList: { selectedPrefix: tuiTheme.accent, selectedText: tuiTheme.strong, description: tuiTheme.muted, scrollInfo: tuiTheme.muted, noMatch: tuiTheme.error },
  }, { paddingX: 1, autocompleteMaxVisible: 6 });
  input.setAutocompleteProvider(createTuiAutocompleteProvider());
  const composer = new MessageComposer(input);
  const shell = new VStack([
    { component: headerView, basis: 1, shrink: 0 },
    { component: conversationScroll, grow: 1, minSize: 1 },
    { component: organizationView, basis: 1, shrink: 0 },
    { component: composer, basis: "auto", minSize: 3, maxSize: 11, shrink: 0 },
  ]);
  const busy: CancellableState = { active: false };
  const queued: string[] = [];
  const queuedTurnIds: string[] = [];
  const streams=new StreamCoordinator();
  let activeInteractionTurnId: string | null = null;
  let steeringTail: Promise<void> = Promise.resolve();
  let configuring = false;
  let exiting = false;
  let interrupting = false;
  let sensitiveConfirmation: string | null = null;

  const push = (line: string): void => {
    transcriptView.addText(line);
    tui.requestRender();
  };
  const appendLive = (text: string): void => { transcriptView.appendLiveMarkdown(text); tui.requestRender(); };
  const commitLive = (text: string,messageId?:string): void => { transcriptView.clearLiveMarkdown(); if (text) transcriptView.addMarkdown(text,messageId); tui.requestRender(); };
  const pushResponse = (text: string,messageId?:string): void => { transcriptView.addMarkdown(text,messageId); tui.requestRender(); };
  const updateTool = (activity: ToolActivity): void => { transcriptView.updateTool(activity); tui.requestRender(); };
  const updateThinking = (activity: ThinkingActivity): void => { transcriptView.updateThinking(activity); tui.requestRender(); };
  const replaceLive = (text:string,thinking:string,thinkingActive:boolean):void => {transcriptView.setLive(text,thinking,thinkingActive);tui.requestRender();};
  const setWakeState = (): void => {};
  const finishIdle = async (): Promise<void> => {
    busy.active = false;
    interrupting = false;
    await refreshOrganizationStatus(stateDir, organizationView, tui, currentModel());
    continuePending();
  };
  const endVisibleTurn = (): void => { transcriptView.endTransientTurn();tui.requestRender(); };
  const takeStream = (controller:AbortController):void => { streams.accept(controller);endVisibleTurn(); };
  const supersedeStreams = ():void => { streams.supersede();endVisibleTurn(); };

  const send = async (message: string, showUser = true,request:ControlRequest={op:"interact",message}): Promise<void> => {
    const controller = new AbortController();
    let started:{owns:boolean;previous:AbortController|null};try{started=streams.begin(controller);}catch(error){push(errorLine(error));return;}let ownsStream=started.owns;
    let rejectionShown = false;
    if (ownsStream) busy.active = true;
    if (showUser) { transcriptView.addUser(message); tui.requestRender(); }
    try {
      await streamControl(stateDir, request, (frame) => {
        if (frame.type === "accepted" && !ownsStream) {
          ownsStream = true;
          takeStream(controller);
        }
        if (!ownsStream) {
          if (frame.type === "error") { rejectionShown = true; push(errorLine(frame.error)); }
          return;
        }
        if (!streams.isCurrent(controller)) return;
        if (frame.type === "accepted") activeInteractionTurnId = frame.turnId;
        if (frame.type === "result" || frame.type === "error") activeInteractionTurnId = null;
        renderFrame(frame, push, appendLive, commitLive, pushResponse, updateTool, updateThinking, setWakeState, () => commitLive(""),replaceLive);
      }, controller.signal);
    } catch (error) {
      if (!ownsStream) { if (!controller.signal.aborted) { rejectionShown = true; push(errorLine(error)); } return; }
      if(!streams.isCurrent(controller))return;
      transcriptView.clearLiveMarkdown();
      transcriptView.updateThinking({ phase: "clear", text: "" });
      if (!controller.signal.aborted) push(errorLine(error));
    } finally {
      if (!ownsStream) {
        streams.reject(controller);
        if (!rejectionShown && !controller.signal.aborted) push(errorLine("Turn request ended before it was accepted."));
        if (!streams.active) await finishIdle();
        return;
      }
      if(!streams.complete(controller))return;
      if (streams.hasPending) return;
      await finishIdle();
    }
  };
  const attachTurn = async (turnId: string): Promise<void> => {
    busy.active = true;
    activeInteractionTurnId = turnId;
    const controller = new AbortController();try{if(!streams.begin(controller).owns)throw new Error("Cannot attach a Turn while another stream is active.");}catch(error){busy.active=false;push(errorLine(error));continuePending();return;}
    try { await streamControl(stateDir, { op: "turn.attach", turnId }, (frame) => { if(!streams.isCurrent(controller))return;if (frame.type === "result" || frame.type === "error") activeInteractionTurnId = null; renderFrame(frame, push, appendLive, commitLive, pushResponse, updateTool, updateThinking, setWakeState, () => commitLive(""),replaceLive); }, controller.signal); }
    catch (error) { if(streams.isCurrent(controller)&&!controller.signal.aborted)push(errorLine(error)); }
    finally {
      if(!streams.complete(controller))return;
      busy.active = false;
      interrupting = false;
      await refreshOrganizationStatus(stateDir, organizationView, tui, currentModel());
      continuePending();
    }
  };
  const continuePending = (): void => {
    if (exiting || configuring || busy.active) return;
    const turnId = queuedTurnIds.shift();
    if (turnId) { void attachTurn(turnId); return; }
    const next = queued.shift();
    if (next) void send(next, false);
  };
  const steer = async (message: string): Promise<void> => {
    try {
      const outcome=await requestControl(stateDir, { op: "turn.steer", message });const value=outcome&&typeof outcome==="object"&&!Array.isArray(outcome)?outcome as Record<string,unknown>:{};const queuedBySupervisor=value.steered===false&&typeof value.turnId==="string";
      if(queuedBySupervisor){queuedTurnIds.push(String(value.turnId));supersedeStreams();busy.active=false;}
      if(queuedBySupervisor)push(`${tuiTheme.warning("new Turn")}  ${tuiTheme.muted("Continuing your message in a fresh Turn.")}`);
      if (queuedBySupervisor && !busy.active) continuePending();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes("no longer accepting steering messages")) {
        queued.push(message);
        if (!busy.active) continuePending();
      } else push(errorLine(error));
    }
  };
  const submitSteer = (message: string): void => {
    transcriptView.addUser(message); tui.requestRender();
    steeringTail = steeringTail.then(() => exiting ? undefined : steer(message));
  };
  const withConfigurationScreen = async (work: () => Promise<void>): Promise<void> => {
    if (busy.active) {
      const snapshot = await requestControl(stateDir, { op: "status" }).catch(() => null);
      if (!snapshot) { push("Cannot inspect the current turn; use /stop before changing Runner configuration."); return; }
      const turns = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) && Array.isArray(snapshot.turns) ? snapshot.turns as Array<Record<string, unknown>> : [];
      if (turns.some((turn) => turn.status === "in_progress")) { push("Wait for the current Turn or use /stop before changing Runner configuration."); return; }
    } else configuring = true;
    tui.stop();
    try { await work(); }
    catch (error) { push(errorLine(error)); }
    finally { configuring = false; if (!exiting) { tui.start(); await refreshOrganizationStatus(stateDir,organizationView,tui,currentModel());tui.requestRender(true); continuePending(); } }
  };
  const launchRunnerCommand = async (command: "model" | "auth", commandArgs: string[] = []): Promise<void> => withConfigurationScreen(async () => {
    const current = configuredRunnerProfile(configPath);
    if (!current) throw new Error("No Runner Profile is configured; use /setup first.");
    const result = await runRunnerCommandWizard(current, command, commandArgs);
    try { await applyWizardResult({ profile: result.profile }, existsSync(configPath) ? configPath : null); }
    catch (error) { await result.rollback?.(); throw error; }
    for (const line of result.output) push(line);
    push(await reloadDaemon(stateDir, configPath) ? "Configuration updated — applies to the next Turn." : "Configuration saved — restart Goah to apply it.");
  });
  const launchSetup = async (text: string): Promise<void> => withConfigurationScreen(async () => {
    const current = configuredRunnerProfile(configPath);
    const requested = text.slice("/setup".length).trim() as SetupSection | "";
    if (requested && !["runner", "model", "auth"].includes(requested)) throw new Error("usage: /setup [runner|model|auth]");
    const section = requested || (current ? await chooseSetupSection(current) : "runner");
    if (!section) return;
    if (section === "runner" || !current) {
      const result = await runSetupWizard(current);
      if (!result.profile) return;
      await applyWizardResult(result, existsSync(configPath) ? configPath : null);
      push(await reloadDaemon(stateDir, configPath) ? "Runner profile updated — applies to the next Turn." : "Runner profile saved — restart Goah to apply it.");
      return;
    }
    const result = await runRunnerCommandWizard(current, section === "model" ? "model" : "auth");
    try { await applyWizardResult({ profile: result.profile }, existsSync(configPath) ? configPath : null); }
    catch (error) { await result.rollback?.(); throw error; }
    for (const line of result.output) push(line);
    push(await reloadDaemon(stateDir, configPath) ? "Configuration updated — applies to the next Turn." : "Configuration saved — restart Goah to apply it.");
  });

  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>();
  const shutdown = (): void => {
    if (exiting) return;
    exiting = true;
    streams.abortAll();
    tui.stop();
    resolveExit();
  };

  input.onSubmit = (line) => {
    const waiting=commandAwaitingArgument(line);if(waiting){input.setText(waiting);return;}
    const { action, text } = classifyTuiInput(line, busy.active);
    if(["send","steer","goal"].includes(action)&&looksLikeCredential(text)&&sensitiveConfirmation!==text){sensitiveConfirmation=text;input.setText(text);push(sensitiveMessageWarning());return;}
    sensitiveConfirmation=null;
    input.setText("");
    if (action === "quit") { shutdown(); return; }
    if (action === "help") { push(renderTuiCommandHelp()); return; }
    if (action === "status") { void printStatus(stateDir, push).finally(() => refreshOrganizationStatus(stateDir, organizationView, tui,currentModel())); return; }
    if (action === "records") { void printRecords(text, stateDir, push); return; }
    if (action === "stop") { void stopCeoWake(stateDir, push); return; }
    if (action === "model") { if (text === "/model") void launchRunnerCommand("model"); else void switchModelCommand(text, configPath, stateDir, push); return; }
    if (action === "login") { void launchRunnerCommand("auth", ["login", text.slice("/login".length).trim()].filter(Boolean)); return; }
    if (action === "logout") { void launchRunnerCommand("auth", ["logout", text.slice("/logout".length).trim()].filter(Boolean)); return; }
    if (action === "setup") { void launchSetup(text); return; }
    if (action === "goal") { void slashGoal(text, stateDir, push,(objective)=>send(`/goal ${objective}`,true,{op:"goal.interact",objective})).finally(() => refreshOrganizationStatus(stateDir, organizationView, tui,currentModel())); return; }
    if (action === "unknown") { push(errorLine(`Unknown command: ${text.split(/\s+/, 1)[0]}. Use /help to list commands.`)); return; }
    if (action === "steer") { submitSteer(text); return; }
    if (action === "send") void send(text);
  };

  tui.setLayoutRoot(shell);
  tui.setFocus(composer);
  tui.addInputListener((data) => {
    const action = classifyTuiControlKey(data, input.getText(), busy.active);
    if (action === "forward") return undefined;
    if (action === "clear") {
      input.setText("");
      tui.requestRender();
      return { consume: true };
    }
    if (action === "toggle_details") {
      transcriptView.toggleDetails();
      tui.requestRender();
      return { consume: true };
    }
    if (action === "interrupt" && !interrupting) {
      interrupting = true;
      push(`${tuiTheme.warning("stopping")}  ${tuiTheme.muted("Current Turn is being interrupted; press Ctrl+C again to exit.")}`);
      void stopCeoWake(stateDir, push);
      return { consume: true };
    }
    shutdown();
    return { consume: true };
  });
  const unbindTerminationSignals = bindTuiTerminationSignals(shutdown);
  try {
    tui.start();
    if(initialMessage&&looksLikeCredential(initialMessage)){sensitiveConfirmation=initialMessage;input.setText(initialMessage);push(sensitiveMessageWarning());}
    else if (initialMessage) void send(initialMessage); else if (typeof liveInteractionTurnId === "string") void attachTurn(liveInteractionTurnId);
    await exited;
  } finally {
    unbindTerminationSignals();
    streams.abortAll();
    tui.stop();
  }
}

export function findLiveTurnId(turns: Array<Record<string, unknown>>): string | null {
  const id = [...turns].reverse().find((turn) => turn.status === "in_progress" && turn.triggerKind === "user_message")?.id;
  return typeof id === "string" ? id : null;
}

async function runNonInteractive(configPath: string, stateDir: string, initialMessage: string | null): Promise<void> {
  if(initialMessage&&looksLikeCredential(initialMessage))throw new Error("Credential-like input is not accepted non-interactively. Put the secret in an ignored local file, then tell Goah only its path.");
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
export interface ToolActivity { kind: "tool"; callId: string; name: string; detail: string; status: "running" | "done" | "failed" }
export interface ThinkingActivity { phase: "start" | "delta" | "done" | "clear"; text: string }

/** Render one structured control-protocol frame into its own transcript channel. */
export function renderFrame(frame: ControlFrame, push: (line: string) => void, appendLive: (text: string) => void = push, commitLive: (text: string,messageId?:string) => void = push, pushResponse: (text: string,messageId?:string) => void = push, updateTool: (activity: ToolActivity) => void = (activity) => push(toolActivityLine(activity)), updateThinking: (activity: ThinkingActivity) => void = () => {}, setWakeState: (state: "queued" | "working") => void = () => {}, clearLive: () => void = () => {},replaceLive:(text:string,thinking:string,thinkingActive:boolean)=>void=()=>{}): void {
  if (frame.type === "error") { updateThinking({ phase: "clear", text: "" }); clearLive(); push(`${tuiTheme.error("error")}  ${safeError(frame.error)}\n`); return; }
  if (frame.type === "accepted") {
    const value = frame.value && typeof frame.value === "object" && !Array.isArray(frame.value) ? frame.value as Record<string, unknown> : {};
    setWakeState(value.steered === true ? "working" : "queued");
    return;
  }
  if (frame.type === "result") {
    const value = frame.value && typeof frame.value === "object" && !Array.isArray(frame.value) ? frame.value as Record<string, unknown> : {};
    const response = value.response && typeof value.response === "object" && !Array.isArray(value.response) ? value.response as Record<string, unknown> : {};
    const turn=value.turn&&typeof value.turn==="object"&&!Array.isArray(value.turn)?value.turn as Record<string,unknown>:{};const error=turn.error&&typeof turn.error==="object"&&!Array.isArray(turn.error)?turn.error as Record<string,unknown>:{};
    updateThinking({ phase: "done", text: "" });
    if (typeof response.content === "string" && response.content.trim()) pushResponse(response.content.trim());
    else if(turn.status==="failed"&&typeof error.message==="string")push(`${tuiTheme.error("error")}  ${safeError(error.message)}\n`);
    return;
  }
  if (frame.type !== "event") return;
  const event = frame.event;
  if (!event || typeof event !== "object" || Array.isArray(event)) return;
  const record = event as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : {};
  if (record.type === "wake.enqueued") { setWakeState("queued"); return; }
  if (record.type === "turn.started" || record.type === "transcript.started") { setWakeState("working"); return; }
  if(record.type==="message.assistant.live"){replaceLive(typeof data.text==="string"?data.text:"",typeof data.thinking==="string"?data.thinking:"",data.thinkingActive===true);return;}
  if (record.type === "tool.called") {
    updateThinking({ phase: "done", text: "" });
    updateTool({ kind: "tool", callId: String(data.callId ?? "tool"), name: String(data.name ?? "tool"), detail: toolDetail(data.arguments), status: "running" });
  } else if (record.type === "tool.completed") {
    updateTool({ kind: "tool", callId: String(data.callId ?? "tool"), name: String(data.name ?? "tool"), detail: "", status: data.isError ? "failed" : "done" });
  } else if (record.type === "message.assistant.delta") {
    const delta = data.delta && typeof data.delta === "object" && !Array.isArray(data.delta) ? data.delta as Record<string, unknown> : {};
    if (delta.type === "thinking_start") updateThinking({ phase: "start", text: "" });
    else if (delta.type === "thinking_delta" && typeof delta.delta === "string") updateThinking({ phase: "delta", text: delta.delta });
    else if (delta.type === "thinking_end") updateThinking({ phase: "done", text: typeof delta.content === "string" ? delta.content : "" });
    else if (delta.type === "text_start" || delta.type === "text_delta") {
      updateThinking({ phase: "done", text: "" });
      if (delta.type === "text_delta" && typeof delta.delta === "string") appendLive(delta.delta);
    } else if (delta.type === "toolcall_start" || delta.type === "toolcall_delta") updateThinking({ phase: "done", text: "" });
  } else if (record.type === "message.assistant.completed") {
    updateThinking({ phase: "done", text: "" });
    const message = data.message && typeof data.message === "object" ? data.message as Record<string, unknown> : {};
    if (message.stopReason === "error" || message.stopReason === "aborted") { clearLive(); return; }
    const text = messageText(message.content);const messageId=typeof message.id==="string"?message.id:undefined;
    if(data.commitState==="provisional"){clearLive();return;}
    if (text) commitLive(text,messageId);
  } else if(record.type==="response.committed"){
    if(typeof data.text==="string"&&data.text.trim())commitLive(data.text.trim(),typeof data.messageItemId==="string"?data.messageItemId:undefined);
  } else if (record.type === "handoff.recorded") {
    if (typeof data.goalId === "string") push(`${data.outcome === "blocked" ? tuiTheme.error("goal blocked") : tuiTheme.success("goal saved")}  ${tuiTheme.muted(`${String(data.outcome).replaceAll("_", " ")} · record r${String(data.recordRevision)}`)}`);
  } else if (record.type === "transcript.interrupted") {
    updateThinking({ phase: "clear", text: "" });
    clearLive();
    push(`${tuiTheme.error("error")}  ${safeError(typeof data.reason === "string" ? data.reason : "Turn failed")}\n`);
  }
}

function toolDetail(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const args = value as Record<string, unknown>;
  const candidate = [args.path, args.file_path, args.query, args.command, args.goalId].find((item) => typeof item === "string") as string | undefined;
  if (!candidate) return "";
  const oneLine = candidate.replace(/\s+/g, " ").trim();
  return oneLine.length > 72 ? `${oneLine.slice(0, 69)}…` : oneLine;
}

function toolActivityLine(activity: ToolActivity): string {
  const state = activity.status === "running" ? tuiTheme.accent("running") : activity.status === "failed" ? tuiTheme.error("failed") : tuiTheme.success("done");
  const detail = activity.detail ? `  ${tuiTheme.muted(activity.detail)}` : "";
  return `  ${state}  ${tuiTheme.strong(activity.name)}${detail}`;
}

async function printStatus(stateDir: string, push: (line: string) => void): Promise<void> {
  try {
    const status = await requestControl(stateDir, { op: "ceo.status" });
    const value = status && typeof status === "object" && !Array.isArray(status) ? status as Record<string, unknown> : {};
    const root = value.root&&typeof value.root==="object"&&!Array.isArray(value.root)?value.root as Record<string,unknown>:null;
    const team = Array.isArray(value.team) ? value.team as Array<Record<string, unknown>> : [];
    push([tuiTheme.strong("Status"), root ? `  ${tuiTheme.active(" GOAL ")}  ${String(root.objective)}  ${tuiTheme.muted(String(root.phase))}` : `  ${tuiTheme.muted("No current Goal")}`, `  ${tuiTheme.muted(team.length ? team.map((member) => `${String(member.agent)} ${String(member.motion)}${member.lastOutcome?`/${String(member.lastOutcome)}`:""}`).join(" · ") : "No Goal Agents")}`, ""].join("\n"));
  } catch (error) { push(errorLine(error)); }
}

async function refreshOrganizationStatus(stateDir: string, view: OrganizationStatusLine, tui: TuiAltScreen, model: string): Promise<void> {
  try {
    const status = await requestControl(stateDir, { op: "ceo.status" });
    view.set(organizationStatusFromValue(status,null,model));
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
    const snapshot = await requestControl(stateDir, { op: "status" }); const turns = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) && Array.isArray(snapshot.turns) ? snapshot.turns as Array<Record<string, unknown>> : []; const turnId = findLiveTurnId(turns);
    if (!turnId) { push(tuiTheme.muted("No active Turn.")); return; }
    await requestControl(stateDir, { op: "turn.interrupt", turnId }); push(`${tuiTheme.warning("stopping")}  Current Turn was interrupted.`);
  } catch (error) { push(errorLine(error)); }
}

async function slashGoal(text: string, stateDir: string, push: (line: string) => void,startGoal?:(objective:string)=>Promise<void>): Promise<void> {
  const isGoal = text.startsWith("/goal ");
  const value = text.slice(isGoal ? 6 : 9).trim();
  try {
    const status = await requestControl(stateDir, { op: "ceo.status" });
    const root = status && typeof status === "object" && !Array.isArray(status) && (status as Record<string,unknown>).root && typeof (status as Record<string,unknown>).root === "object" ? (status as Record<string,unknown>).root as Record<string,unknown> : undefined;
    if (!root) {
      if (!isGoal) throw new Error("no active root goal");
      if(startGoal){await startGoal(value);return;}
      const created = await requestControl(stateDir, { op: "goal.interact", objective: value });
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

function compact(value: unknown): string {
  const json = JSON.stringify(value) ?? "";
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}
function errorLine(error: unknown): string { return `${tuiTheme.error("error")}  ${safeError(error instanceof Error ? error.message : String(error))}\n`; }
function safeError(value: string): string {
  const sanitized = redactSensitiveText(value)
    .replace(/environment variable is missing:\s*[^\s(]+/gi, "environment variable is missing: [REDACTED]")
    .replace(/(?:sk|key|token)[-_][A-Za-z0-9._-]{12,}/gi, "[REDACTED]");
  const provider = sanitized.match(/^(\d{3}):\s*(\{.*\})$/s);
  if (provider) {
    try { const body = JSON.parse(provider[2]!) as { message?: unknown }; if (typeof body.message === "string") return `Provider ${provider[1]}: ${body.message}`; } catch {}
  }
  const named = sanitized.match(/^(?:TypeError|RangeError|ReferenceError|SyntaxError|Error):\s*[^\n]+/m)?.[0];
  if (named) return named;
  return sanitized.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("file://") && !line.startsWith("at ") && line !== "^") ?? "Turn failed";
}
export function sensitiveMessageWarning():string{return `${tuiTheme.warning("credential-like message")}  ${tuiTheme.muted("Press Enter again to send it to the model and Ledger, or put the secret in an ignored local file and mention only its path.")}`;}

function messageText(value: unknown): string {
  if (typeof value === "string") return normalizeAssistantText(value);
  if (!Array.isArray(value)) return "";
  return (value as unknown[])
    .map((item) => item && typeof item === "object" && !Array.isArray(item) && (item as Record<string, unknown>).type === "text" && typeof (item as Record<string, unknown>).text === "string" ? normalizeAssistantText((item as Record<string, unknown>).text as string) : "")
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

function configuredRunnerProfile(configPath: string) {
  const workspace = existsSync(configPath) ? loadConfig(configPath) : null;
  return workspace?.runnerProfiles?.find((profile) => profile.id === "default") ?? workspace?.runnerProfiles?.[0] ?? readDefaultRunnerProfile();
}
