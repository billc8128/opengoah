/** Full-screen goah TUI: streaming CEO transcript over the resident Supervisor control socket. */
import { TuiAltScreen, Text, Markdown, Editor, Image, HStack, ProcessTerminal, ScrollView, VStack, CombinedAutocompleteProvider, Key, getCapabilities, isKeyRelease, matchesKey, type Component, type MarkdownTheme, type SlashCommand } from "@earendil-works/pi-tui";
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
export class ConversationView implements Component {
  private entries: Array<{ kind: "text" | "user" | "thinking"; content: string } | { kind:"markdown";content:string;messageId?:string } | { kind: "component"; component: Component } | ToolActivity>;
  private liveMarkdown = "";
  private liveThinking = "";
  private thinkingActive = false;
  constructor(initial: string[]) { this.entries = initial.length ? [{ kind: "text", content: initial.join("\n") }] : []; }
  addComponent(component: Component): void { this.entries.push({ kind: "component", component }); }
  addText(content: string): void { const previous=this.entries.at(-1);if(previous?.kind==="text"&&previous.content===content)return;this.entries.push({ kind: "text", content }); this.trim(); }
  addUser(content: string): void { this.entries.push({ kind: "user", content }); this.trim(); }
  addMarkdown(content: string,messageId?:string): void {
    this.liveMarkdown = "";
    content = content.trim();
    if (!content) return;
    if(messageId&&this.entries.some((entry)=>entry.kind==="markdown"&&entry.messageId===messageId))return;
    const previous = this.entries.at(-1);
    if (previous?.kind === "markdown" && previous.content === content) return;
    this.entries.push({ kind: "markdown", content,...(messageId?{messageId}:{}) }); this.trim();
  }
  appendLiveMarkdown(content: string): void { this.liveMarkdown += content; }
  setLive(text:string,thinking:string,thinkingActive:boolean):void{this.liveMarkdown=text;this.liveThinking=thinking;this.thinkingActive=thinkingActive;}
  clearLiveMarkdown(): void { this.liveMarkdown = ""; }
  updateThinking(activity: ThinkingActivity): void {
    if (activity.phase === "start") { this.liveThinking = ""; this.thinkingActive = true; return; }
    if (activity.phase === "delta") { this.liveThinking += activity.text; this.thinkingActive = true; return; }
    if (activity.phase === "clear") { this.liveThinking = ""; this.thinkingActive = false; return; }
    const content = (activity.text || this.liveThinking).trim();
    this.liveThinking = ""; this.thinkingActive = false;
    const previous = this.entries.at(-1);
    if (content && !(previous?.kind === "thinking" && previous.content === content)) this.entries.push({ kind: "thinking", content });
    this.trim();
  }
  updateTool(activity: ToolActivity): void {
    const previous = this.entries.findLast((entry) => entry.kind === "tool" && entry.callId === activity.callId);
    if (previous?.kind === "tool") Object.assign(previous, { ...activity, detail: activity.detail || previous.detail });
    else this.entries.push(activity);
    this.trim();
  }
  stopRunningTools(): void {
    for (const entry of this.entries) if (entry.kind === "tool" && entry.status === "running") entry.status = "failed";
  }
  endTransientTurn(): void { this.liveMarkdown="";this.liveThinking="";this.thinkingActive=false;this.stopRunningTools(); }
  private trim(): void { if (this.entries.length > 240) this.entries.splice(1, this.entries.length - 240); }
  render(width: number): string[] {
    const rendered = this.entries.flatMap((entry) => entry.kind === "component"
      ? entry.component.render(width)
      : entry.kind === "markdown"
      ? [...new Markdown(entry.content, 2, 0, markdownTheme).render(width), ""]
      : entry.kind === "user"
        ? renderUserMessage(entry.content, width)
      : entry.kind === "thinking"
        ? [tuiTheme.muted("  thinking"), ...new Markdown(entry.content, 2, 0, markdownTheme, { color: tuiTheme.muted, italic: true }).render(width), ""]
      : entry.kind === "tool"
        ? new Text(toolActivityLine(entry), 2, 0).render(width)
        : new Text(entry.content, 2, 0).render(width));
    if (this.liveThinking) rendered.push(tuiTheme.muted("  thinking"), ...new Markdown(this.liveThinking, 2, 0, markdownTheme, { color: tuiTheme.muted, italic: true }).render(width));
    else if (this.thinkingActive) rendered.push(tuiTheme.muted("  thinking…"));
    if (this.liveMarkdown) rendered.push(...new Markdown(this.liveMarkdown, 2, 0, markdownTheme).render(width));
    return rendered;
  }
  invalidate(): void {}
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
export function renderUserMessage(content: string, width: number): string[] { return new Text(content, 2, 0, tuiTheme.userMessage).render(width); }
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

export type TuiControlAction = "forward" | "clear" | "interrupt" | "exit";
export function classifyTuiControlKey(data: string, inputText: string, busy: boolean): TuiControlAction {
  if (isKeyRelease(data)) return "forward";
  if (matchesKey(data, Key.ctrl("c"))) {
    if (inputText.length > 0) return "clear";
    return busy ? "interrupt" : "exit";
  }
  if (matchesKey(data, Key.ctrl("d")) && !inputText && !busy) return "exit";
  return "forward";
}

export async function runGoahTui(configPath: string, stateDir: string, initialMessage: string | null): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return runNonInteractive(configPath, stateDir, initialMessage);
  const runner = readRunnerDisplay(configPath);
  const snapshot = welcomeSnapshot(stateDir, runner);
  const hasHistory = Boolean(snapshot.root || snapshot.handoffs.length || snapshot.conversation.length);
  await ensureDaemon(configPath, stateDir);
  const liveSnapshot = await requestControl(stateDir, { op: "status" }).catch(() => null);
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
  const goalView = new GoalBar(snapshot.root);
  const input = new Editor(tui, {
    borderColor: tuiTheme.accent,
    selectList: { selectedPrefix: tuiTheme.accent, selectedText: tuiTheme.strong, description: tuiTheme.muted, scrollInfo: tuiTheme.muted, noMatch: tuiTheme.error },
  }, { paddingX: 1, autocompleteMaxVisible: 6 });
  input.setAutocompleteProvider(createTuiAutocompleteProvider());
  const statusView = new Text(statusText("ready"), 1, 0);
  const shell = new VStack([
    { component: headerView, basis: 1, shrink: 0 },
    { component: conversationScroll, grow: 1, minSize: 1 },
    { component: goalView, basis: 1, shrink: 0 },
    { component: statusView, basis: 1, shrink: 0 },
    { component: input, basis: "auto", minSize: 3, maxSize: 11, shrink: 0 },
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
  const setWakeState = (mode: "queued" | "working"): void => { statusView.setText(statusText(mode, mode === "queued" ? 1 : queued.length)); tui.requestRender(); };
  const finishIdle = async (): Promise<void> => {
    busy.active = false;
    interrupting = false;
    await refreshGoalBar(stateDir, goalView, tui);
    statusView.setText(statusText(queuedTurnIds.length || queued.length ? "queued" : "ready", queuedTurnIds.length + queued.length));
    continuePending();
  };
  const endVisibleTurn = (): void => { transcriptView.endTransientTurn();tui.requestRender(); };
  const takeStream = (controller:AbortController):void => { streams.accept(controller);endVisibleTurn(); };
  const supersedeStreams = ():void => { streams.supersede();endVisibleTurn(); };

  const send = async (message: string, showUser = true,request:ControlRequest={op:"interact",message}): Promise<void> => {
    const controller = new AbortController();
    let started:{owns:boolean;previous:AbortController|null};try{started=streams.begin(controller);}catch(error){push(errorLine(error));return;}let ownsStream=started.owns;
    let rejectionShown = false;
    if (ownsStream) { busy.active = true; statusView.setText(statusText("working", queued.length)); }
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
    statusView.setText(statusText("queued", 1));
    try { await streamControl(stateDir, { op: "turn.attach", turnId }, (frame) => { if(!streams.isCurrent(controller))return;if (frame.type === "result" || frame.type === "error") activeInteractionTurnId = null; renderFrame(frame, push, appendLive, commitLive, pushResponse, updateTool, updateThinking, setWakeState, () => commitLive(""),replaceLive); }, controller.signal); }
    catch (error) { if(streams.isCurrent(controller)&&!controller.signal.aborted)push(errorLine(error)); }
    finally {
      if(!streams.complete(controller))return;
      busy.active = false;
      interrupting = false;
      await refreshGoalBar(stateDir, goalView, tui);
      statusView.setText(statusText("ready"));
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
      statusView.setText(queuedBySupervisor?`${tuiTheme.warning("new Turn")}  ${tuiTheme.muted("Runner stopped accepting steering; continuing in a fresh Turn")}`:`${tuiTheme.accent("working")}  ${tuiTheme.muted("your update is steering this turn · /stop cancels")}`);
      tui.requestRender();
      if (queuedBySupervisor && !busy.active) continuePending();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (reason.includes("no longer accepting steering messages")) {
        queued.push(message);
        statusView.setText(statusText("working", queued.length));
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
    statusView.setText(statusText("setup"));
    tui.stop();
    try { await work(); }
    catch (error) { push(errorLine(error)); }
    finally { configuring = false; if (!exiting) { tui.start(); tui.requestRender(true); statusView.setText(statusText("ready")); continuePending(); } }
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

  input.onSubmit = (line) => {
    const waiting=commandAwaitingArgument(line);if(waiting){input.setText(waiting);return;}
    const { action, text } = classifyTuiInput(line, busy.active);
    if(["send","steer","goal"].includes(action)&&looksLikeCredential(text)&&sensitiveConfirmation!==text){sensitiveConfirmation=text;input.setText(text);push(sensitiveMessageWarning());return;}
    sensitiveConfirmation=null;
    input.setText("");
    if (action === "quit") { exiting = true; streams.abortAll(); tui.stop(); resolveExit(); return; }
    if (action === "help") { push(renderTuiCommandHelp()); return; }
    if (action === "status") { void printStatus(stateDir, push).finally(() => refreshGoalBar(stateDir, goalView, tui)); return; }
    if (action === "records") { void printRecords(text, stateDir, push); return; }
    if (action === "stop") { void stopCeoWake(stateDir, push); return; }
    if (action === "model") { if (text === "/model") void launchRunnerCommand("model"); else void switchModelCommand(text, configPath, stateDir, push); return; }
    if (action === "login") { void launchRunnerCommand("auth", ["login", text.slice("/login".length).trim()].filter(Boolean)); return; }
    if (action === "logout") { void launchRunnerCommand("auth", ["logout", text.slice("/logout".length).trim()].filter(Boolean)); return; }
    if (action === "setup") { void launchSetup(text); return; }
    if (action === "goal") { void slashGoal(text, stateDir, push,(objective)=>send(`/goal ${objective}`,true,{op:"goal.interact",objective})).finally(() => refreshGoalBar(stateDir, goalView, tui)); return; }
    if (action === "unknown") { push(errorLine(`Unknown command: ${text.split(/\s+/, 1)[0]}. Use /help to list commands.`)); return; }
    if (action === "steer") { submitSteer(text); return; }
    if (action === "send") void send(text);
  };

  tui.setLayoutRoot(shell);
  tui.setFocus(input);
  const { promise: exited, resolve: resolveExit } = Promise.withResolvers<void>();
  tui.addInputListener((data) => {
    const action = classifyTuiControlKey(data, input.getText(), busy.active);
    if (action === "forward") return undefined;
    if (action === "clear") {
      input.setText("");
      tui.requestRender();
      return { consume: true };
    }
    if (action === "interrupt" && !interrupting) {
      interrupting = true;
      statusView.setText(`${tuiTheme.warning("stopping")}  ${tuiTheme.muted("press Ctrl+C again to exit")}`);
      tui.requestRender();
      void stopCeoWake(stateDir, push);
      return { consume: true };
    }
    exiting = true;
    streams.abortAll();
    tui.stop();
    resolveExit();
    return { consume: true };
  });
  tui.start();
  if(initialMessage&&looksLikeCredential(initialMessage)){sensitiveConfirmation=initialMessage;input.setText(initialMessage);push(sensitiveMessageWarning());}
  else if (initialMessage) void send(initialMessage); else if (typeof liveInteractionTurnId === "string") void attachTurn(liveInteractionTurnId);
  await exited;
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

async function refreshGoalBar(stateDir: string, view: GoalBar, tui: TuiAltScreen): Promise<void> {
  try {
    const status = await requestControl(stateDir, { op: "ceo.status" });
    const root = status && typeof status === "object" && !Array.isArray(status) && (status as Record<string,unknown>).root && typeof (status as Record<string,unknown>).root === "object" ? (status as Record<string,unknown>).root as Record<string,unknown> : null;
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
