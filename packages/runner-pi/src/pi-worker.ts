import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type, type Message } from "@earendil-works/pi-ai";
import { TRANSCRIPT_FORMAT_VERSION, type AgentCapability, type AgentHandoff, type JsonValue, type RunnerCandidateResult, type TranscriptMessage } from "goah-ledger-contract";
import { runProcessWorker, type WorkerRpc } from "./index.js";
import { createPiModel } from "./model-provider.js";


export function compactMessages(messages: AgentMessage[], maxRecent = 8): AgentMessage[] {
  if (messages.length <= maxRecent + 1) return messages;
  const removed = messages.slice(1, -maxRecent);
  const summary = removed.map((message, index) => `${index + 1}. ${messageText(message).slice(0, 240)}`).join("\n");
  return [
    messages[0]!,
    { role: "user", content: `Compacted model view. Original trace is unchanged. Source message indexes 1-${removed.length}:\n${summary}`, timestamp: Date.now() },
    ...messages.slice(-maxRecent),
  ];
}

export async function runPiWorker(): Promise<void> {
  await runProcessWorker(async (request, emit, rpc, controls): Promise<RunnerCandidateResult> => {
    const contextRecord = typeof request.context === "object" && request.context !== null && !Array.isArray(request.context) ? request.context : {};
    const legacyRequest = request.turn === undefined;
    const binding = request.turn?.goalBinding;
    const goalState: { bound: boolean; binding?: { goalId: string; goalRevision: number }; recordRevision?: number } = { bound: legacyRequest || binding !== undefined, ...(binding ? { binding } : {}) };
    const profile = contextRecord.runnerProfile && typeof contextRecord.runnerProfile === "object" && !Array.isArray(contextRecord.runnerProfile) ? contextRecord.runnerProfile as Record<string, unknown> : {};
    const runnerConfig = profile.config && typeof profile.config === "object" && !Array.isArray(profile.config) ? profile.config as Record<string, unknown> : {};
    const provider = typeof runnerConfig.provider === "string" ? runnerConfig.provider : process.env.GOAH_PI_PROVIDER ?? "anthropic";
    const modelId = typeof runnerConfig.model === "string" ? runnerConfig.model : process.env.GOAH_PI_MODEL;
    if (!modelId) throw new Error("GOAH_PI_MODEL is required");
    const configured = createPiModel(provider, modelId);
    const { models } = configured;
    const privateAuth = request.runtime && typeof request.runtime === "object" && !Array.isArray(request.runtime) ? request.runtime as Record<string, unknown> : {};
    const protectedPaths = Array.isArray(privateAuth.protectedPaths) ? privateAuth.protectedPaths.filter((value): value is string => typeof value === "string").map((path) => resolve(path)) : [];
    const model = typeof privateAuth.baseUrl === "string" ? { ...configured.model, baseUrl: privateAuth.baseUrl } : configured.model;
    if (provider === "faux") {
      const faux = configured.faux!;
      if (process.env.GOAH_PI_FAUX_ERROR) {
        faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: process.env.GOAH_PI_FAUX_ERROR })]);
      } else if (goalState.bound && !legacyRequest) {
        const handoff = JSON.parse(process.env.GOAH_PI_FAUX_HANDOFF ?? "{}") as Record<string, unknown>;
        const current = contextRecord.workRecord && typeof contextRecord.workRecord === "object" && !Array.isArray(contextRecord.workRecord) ? contextRecord.workRecord as Record<string, unknown> : {};
        const evidence = Array.isArray(contextRecord.sourceSeqs) ? contextRecord.sourceSeqs.filter((value): value is number => typeof value === "number") : [];
        const outcome=["progress","waiting","blocked","completion_proposed"].includes(String(handoff.outcome))?String(handoff.outcome):"progress";const handoffEvidence=Array.isArray(handoff.evidence)&&handoff.evidence.every((value)=>typeof value==="number")?handoff.evidence:evidence.length?[Math.max(...evidence)]:[];
        const record = `# Current State\n\nFaux Goal outcome: ${outcome}.\n\n# Observations\n\nSee the cited Ledger evidence.\n\n# Work Completed\n\nExecuted the scripted faux Goal turn.\n\n# Decisions\n\nRecord the scripted result from ${request.execution.id}.\n\n# Blockers\n\n${outcome==="blocked"?"Blocked.":"None."}\n\n# Next Steps\n\nFollow the current Goal and explicit tools.\n`;
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("work_record_update", { expectedRevision: Number(current.recordRevision ?? 0), content: record, reason: "record faux Goal progress", evidence: evidence.length ? [Math.max(...evidence)] : [] }), { stopReason: "toolUse" }),
          fauxAssistantMessage([fauxText(String(handoff.message??`Goal work recorded with outcome ${outcome}.`)),fauxToolCall("handoff", {outcome,evidence:handoffEvidence})], { stopReason: "toolUse" }),
        ]);
      } else if (!goalState.bound) {
        faux.setResponses([fauxAssistantMessage([fauxText(process.env.GOAH_PI_FAUX_RESPONSE ?? "Hello from Goah.")])]);
      } else {
        const handoff = JSON.parse(process.env.GOAH_PI_FAUX_HANDOFF ?? "{}") as Record<string, unknown>;
        const{message,...handoffData}=handoff;faux.setResponses([fauxAssistantMessage([fauxText(String(message??"Goal work recorded.")),fauxToolCall("handoff",handoffData)], { stopReason: "toolUse" })]);
      }
    }

    let output: AgentHandoff | null = null;
    let response = "";
    let responseFailure = "";
    let compactions = 0;
    let messageCounter = 0;
    const messageIds = new WeakMap<object, string>();
    const emittedUsers = new Set<string>();
    const idFor = (message: AgentMessage): string => {
      if (typeof message !== "object" || message === null) return `message:${++messageCounter}`;
      const existing = messageIds.get(message);
      if (existing) return existing;
      const id = `message:${++messageCounter}`;
      messageIds.set(message, id);
      return id;
    };
    const root = resolve(process.cwd());
    const capabilities = Array.isArray(contextRecord.capabilities)
      ? new Set(contextRecord.capabilities.filter((value): value is AgentCapability => typeof value === "string"))
      : undefined;
    if (contextRecord.workRecord && typeof contextRecord.workRecord === "object" && !Array.isArray(contextRecord.workRecord) && typeof contextRecord.workRecord.recordRevision === "number") goalState.recordRevision = contextRecord.workRecord.recordRevision;
    const tools = createTools(root, (value) => { output = value; }, rpc, capabilities, goalState, protectedPaths);
    const contextPolicy = resolveContextPolicy(model.contextWindow, process.env);
    emit({ type: "transcript.started", data: { formatVersion: TRANSCRIPT_FORMAT_VERSION, provider, model: modelId, runner: "pi", contextWindowTokens: model.contextWindow, maxOutputTokensPerTurn: model.maxTokens } });
    const suppliedPrompt = typeof contextRecord.systemPrompt === "string" ? contextRecord.systemPrompt : undefined;
    const activeContext = typeof contextRecord.text === "string" ? contextRecord.text : JSON.stringify(request.context);
    const sourceSeqs = Array.isArray(contextRecord.sourceSeqs) ? contextRecord.sourceSeqs.filter((value): value is number => Number.isInteger(value)) : [];
    const basePrompt = process.env.GOAH_PI_SYSTEM_PROMPT ?? suppliedPrompt ?? (request.turn?.source.kind === "human" ? "You are Goah's primary Agent. Respond naturally to the Human." : `You are Goah Agent ${request.agent}. Inspect the supplied context and respond appropriately.`);
    const systemPrompt = goalState.bound
      ? `${basePrompt}\nThis Turn is Goal-bound. You must update its Work Record, write a concise human-readable assistant message describing what happened, and call handoff exactly once with only machine-readable outcome and evidence. The message and Handoff are separate outputs. Treat the supplied context as authoritative.`
      : request.turn?.source.kind === "human"
        ? `${basePrompt}\nThis Human Turn starts without a Goal binding. Finish with an ordinary response unless a Goal tool establishes a binding during this Turn; after a binding is established, update that Goal's Work Record, write a concise human-readable assistant message, and call handoff exactly once with separate machine-readable outcome and evidence. Treat the supplied context as authoritative.`
        : `${basePrompt}\nThis Turn has no Goal binding. Finish with an ordinary response and do not call handoff. Treat the supplied context as authoritative.`;
    const agent = new Agent({
      initialState: {
        systemPrompt,
        model,
        thinkingLevel: typeof runnerConfig.thinking === "string" ? runnerConfig.thinking as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" : "off",
        tools,
      },
      streamFn: async (requestModel, context, options) => {
        emit({
          type: "request.prepared",
          data: {
            provider: requestModel.provider,
            model: requestModel.id,
            systemPrompt: context.systemPrompt ?? "",
            activeContext,
            messages: JSON.parse(JSON.stringify(context.messages)) as JsonValue,
            tools: (context.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters as unknown as JsonValue })),
            modelConfig: snapshotModelConfig(options),
            sourceSeqs,
          },
        });
        const runtimeProvider = models.getProvider(requestModel.provider);
        if (!runtimeProvider) throw new Error(`Provider not found: ${requestModel.provider}`);
        const runtimeModel = typeof privateAuth.baseUrl === "string" ? { ...requestModel, baseUrl: privateAuth.baseUrl } : requestModel;
        return runtimeProvider.streamSimple(runtimeModel, context, { ...options, ...(typeof privateAuth.apiKey === "string" ? { apiKey: privateAuth.apiKey } : {}), ...(privateAuth.headers && typeof privateAuth.headers === "object" && !Array.isArray(privateAuth.headers) ? { headers: privateAuth.headers as Record<string, string> } : {}), ...(process.env.GOAH_PI_CACHE_RETENTION === "none" ? { cacheRetention: "none" as const } : {}) });
      },
      getApiKey: () => typeof privateAuth.apiKey === "string" ? privateAuth.apiKey : undefined,
      transformContext: async (messages) => {
        let view = messages;
        if (estimateMessages(messages) >= contextPolicy.compactAtTokens) {
          compactions += 1;
          view = compactMessagesToTokenBudget(messages, contextPolicy.retainAfterCompactTokens);
          const retained = new Set(view.filter((message) => messages.includes(message)));
          const summary = view.find((message) => !messages.includes(message));
          if (summary) emit({ type: "context.compacted", data: { compaction: compactions, sourceMessageCount: messages.length, replacedMessageIds: messages.filter((message) => !retained.has(message)).map(idFor), retainedMessageIds: messages.filter((message) => retained.has(message)).map(idFor), summaryMessageId: idFor(summary), summary: messageText(summary) } });
        }
        return view;
      },
      shouldStopAfterTurn: () => output !== null,
      toolExecution: "sequential",
    });
    let acceptingSteering = true;
    controls.onSteer((message) => {
      if (!acceptingSteering) return false;
      agent.steer({ role: "user", content: message, timestamp: Date.now() });
      return true;
    });
    agent.subscribe((event) => {
      if (event.type === "turn_start") emit({ type: "turn.started", data: {} });
      else if (event.type === "message_start" && event.message.role === "user") {
        const id = idFor(event.message);
        if (!emittedUsers.has(id)) { emittedUsers.add(id); emit({ type: "message.user", data: { message: transcriptMessage(event.message, id) as unknown as JsonValue } }); }
      } else if (event.type === "message_update") {
        emit({ type: "message.assistant.delta", data: { messageId: idFor(event.message), delta: JSON.parse(JSON.stringify(event.assistantMessageEvent)) as JsonValue } });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        response = assistantResponseText(event.message);
        if ((event.message.stopReason === "error" || event.message.stopReason === "aborted") && event.message.errorMessage) responseFailure = event.message.errorMessage;
        emit({ type: "message.assistant.completed", data: { message: transcriptMessage(event.message, idFor(event.message)) as unknown as JsonValue } });
      } else if (event.type === "tool_execution_start") emit({ type: "tool.called", data: { callId: event.toolCallId, name: event.toolName, arguments: JSON.parse(JSON.stringify(event.args)) as JsonValue } });
      else if (event.type === "tool_execution_end") emit({ type: "tool.completed", data: { callId: event.toolCallId, messageId: `tool:${event.toolCallId}`, name: event.toolName, result: JSON.parse(JSON.stringify(event.result)) as JsonValue, isError: event.isError } });
      else if (event.type === "turn_end") emit({ type: "turn.completed", data: {} });
    });
    const abortAgent = () => agent.abort();
    process.once("SIGTERM", abortAgent);
    process.once("SIGINT", abortAgent);
    try {
      await agent.prompt(`Turn started at: ${request.execution.startedAt}\n\n${activeContext}\n\nRunner root: ${root}. Manage local files directly when the goal requires them.`);
    } finally {
      acceptingSteering = false;
      process.off("SIGTERM", abortAgent);
      process.off("SIGINT", abortAgent);
    }
    if (!goalState.bound) return response ? { outcome: "response", response: { content: response } } : { outcome: "abnormal", reason: responseFailure || "Pi worker exited without a response" };
    if (responseFailure) return { outcome: "abnormal", reason: responseFailure };
    if (!output||!response) return { outcome: "abnormal", reason: "Pi worker exited without a readable response and valid handoff" };
    return { outcome: "handoff", output:{response:{content:response},handoff:output} };
  });
}

/** Persist only model behavior, never transport credentials or abort handles. */
export function snapshotModelConfig(options: unknown): JsonValue {
  if (!options || typeof options !== "object" || Array.isArray(options)) return {};
  const record = options as Record<string, unknown>;
  const allowed = ["transport", "toolExecution", "temperature", "topP", "maxTokens", "reasoning", "thinkingLevel", "toolChoice"];
  return Object.fromEntries(allowed.flatMap((key) => isJson(record[key]) ? [[key, JSON.parse(JSON.stringify(record[key])) as JsonValue]] : []));
}

function isJson(value: unknown): boolean {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJson);
  return Boolean(value && typeof value === "object" && Object.values(value as Record<string, unknown>).every(isJson));
}

function transcriptMessage(message: AgentMessage, id: string): TranscriptMessage {
  const value = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
  const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "tool";
  return { id, role, content: (value.content ?? value) as JsonValue, ...(value.usage !== undefined ? { usage: value.usage as JsonValue } : {}), ...(typeof value.stopReason === "string" ? { stopReason: value.stopReason } : {}), ...(typeof value.errorMessage === "string" ? { errorMessage: value.errorMessage } : {}) };
}

function createTools(root: string, handoff: (output: AgentHandoff) => void, rpc: WorkerRpc, capabilities: ReadonlySet<AgentCapability> | undefined, goalState: { bound: boolean; binding?: { goalId: string; goalRevision: number }; recordRevision?: number }, protectedPaths: string[] = []): AgentTool<any>[] {
  const handoffTool: AgentTool<any> = {
    name: "handoff",
    label: "Handoff",
    description: "Record a structured handoff and end the Goal-bound Turn.",
    parameters: Type.Object({
      outcome: Type.Union([Type.Literal("progress"), Type.Literal("waiting"), Type.Literal("blocked"), Type.Literal("completion_proposed")]),
      evidence: Type.Array(Type.Number()),
    }),
    execute: async (_id, params) => {
      const input = params as {outcome: "progress" | "waiting" | "blocked" | "completion_proposed"; evidence: number[] };
      const value: AgentHandoff = {outcome:input.outcome,evidence:input.evidence};
      handoff(value);
      return { content: [{ type: "text", text: "handoff recorded" }], details: value, terminate: true };
    },
  };
  const rpcTools = createRpcTools(rpc, capabilities, (method, result) => {
    if ((method === "goal.create" || method === "goal.work" || method === "goal.resume") && result && typeof result === "object" && !Array.isArray(result) && result.goalBinding && typeof result.goalBinding === "object" && !Array.isArray(result.goalBinding)) {
      const binding = result.goalBinding as Record<string, JsonValue>;
      if (typeof binding.goalId === "string" && typeof binding.goalRevision === "number") { goalState.bound = true; goalState.binding = { goalId: binding.goalId, goalRevision: binding.goalRevision }; }
    }
    if (method === "work_record.update" && result && typeof result === "object" && !Array.isArray(result) && typeof result.recordRevision === "number") goalState.recordRevision = result.recordRevision;
  });
  const readTool: AgentTool<any> = {
    name: "read", label: "Read", description: "Read a UTF-8 file inside the current working directory.",
    parameters: Type.Object({ path: Type.String() }),
    execute: async (_id, params) => { const input = params as { path: string }; return { content: [{ type: "text", text: await readFile(scopedRunnerPath(root, input.path, protectedPaths), "utf8") }], details: {} }; },
  };
  const writeTool: AgentTool<any> = {
    name: "write", label: "Write", description: "Create or replace a UTF-8 file inside the current working directory.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, params) => { const input = params as { path: string; content: string }; const path = scopedRunnerPath(root, input.path, protectedPaths); await mkdir(dirname(path), { recursive: true }); await writeFile(path, input.content); return { content: [{ type: "text", text: "written" }], details: {} }; },
  };
  const editTool: AgentTool<any> = {
    name: "edit", label: "Edit", description: "Replace one exact text occurrence in a UTF-8 file inside the current working directory.",
    parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
    execute: async (_id, params) => {
      const input = params as { path: string; oldText: string; newText: string };
      const path = scopedRunnerPath(root, input.path, protectedPaths);
      const source = await readFile(path, "utf8");
      const first = source.indexOf(input.oldText);
      if (first < 0) throw new Error("edit oldText was not found");
      if (source.indexOf(input.oldText, first + input.oldText.length) >= 0) throw new Error("edit oldText is not unique");
      await writeFile(path, `${source.slice(0, first)}${input.newText}${source.slice(first + input.oldText.length)}`);
      return { content: [{ type: "text", text: "edited" }], details: { path: input.path } };
    },
  };
  const bashTool: AgentTool<any> = {
    name: "bash", label: "Bash",
    description: "Run a sandboxed shell command inside the local runner root. Goah credential/control state is masked. If protected state shares the root, use the write tool to create new top-level paths. The command's process group is killed after timeout.",
    parameters: Type.Object({ command: Type.String(), timeoutMs: Type.Optional(Type.Number()) }), executionMode: "sequential",
    execute: async (_id, params, signal) => runBashCommand(root, params as { command: string; timeoutMs?: number }, signal, protectedPaths),
  };
  return [readTool, writeTool, editTool, bashTool, ...rpcTools, handoffTool];
}

const BASH_TIMEOUT_HARD_CAP_MS = 600_000;

export function bashTimeoutMs(requested: number | undefined, env: NodeJS.ProcessEnv = process.env): number {
  const fallback = integerSetting(env.GOAH_PI_BASH_TIMEOUT_MS, 120_000);
  const value = requested ?? fallback;
  return Number.isFinite(value) && value > 0 ? Math.min(value, BASH_TIMEOUT_HARD_CAP_MS) : fallback;
}

/** Shell execution with a process-group timeout: a hung command becomes a model-visible tool error instead of a stalled wake. */
export async function runBashCommand(root: string, input: { command: string; timeoutMs?: number }, signal?: AbortSignal, protectedPaths: string[] = []): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
  const timeoutMs = bashTimeoutMs(input.timeoutMs);
  const sandboxTemp = mkdtempSync(join(tmpdir(), "goah-bash-"));
  const launch = sandboxedShell(input.command, root, protectedPaths, sandboxTemp);
  if (!launch) { if (sandboxTemp) rmSync(sandboxTemp, { recursive: true, force: true }); return { content: [{ type: "text", text: "Bash is unavailable because this platform cannot isolate Goah credential and control state." }], details: { command: input.command }, isError: true }; }
  const child = spawn(launch.command, launch.args, { cwd: root, env: toolEnvironment(sandboxTemp), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let outputOverflow = false;
  const killGroup = () => { if (child.pid) { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {} } };
  const appendOutput = (channel: "stdout" | "stderr", chunk: Buffer): void => {
    if (outputOverflow) return;
    const text = chunk.toString(); const remaining = Math.max(0, 1_000_000 - stdout.length - stderr.length);
    if (channel === "stdout") stdout += text.slice(0, remaining); else stderr += text.slice(0, remaining);
    if (text.length > remaining) { outputOverflow = true; killGroup(); }
  };
  child.stdout?.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
  const onAbort = () => killGroup();
  signal?.addEventListener("abort", onAbort, { once: true });
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signalName) => resolve({ code, signal: signalName }));
  });
  try {
    const result = await close;
    if (timedOut) return { content: [{ type: "text", text: `Command timed out after ${timeoutMs}ms and its process group was killed. Declare a larger timeoutMs for long-running commands.` }], details: { command: input.command, timedOutAfterMs: timeoutMs }, isError: true };
    if (signal?.aborted) return { content: [{ type: "text", text: "Command aborted with the wake." }], details: { command: input.command }, isError: true };
    killGroup();
    const failed = outputOverflow || result.code !== 0 || result.signal !== null;
    return { content: [{ type: "text", text: `${stdout}${stderr}`.slice(-50_000) }], details: { command: input.command, exitCode: result.code, signal: result.signal, ...(outputOverflow ? { outputOverflow: true } : {}) }, ...(failed ? { isError: true } : {}) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    if (sandboxTemp) rmSync(sandboxTemp, { recursive: true, force: true });
  }
}


export interface ContextPolicy {
  compactAtTokens: number;
  retainAfterCompactTokens: number;
}

export function resolveContextPolicy(contextWindowTokens: number, env: NodeJS.ProcessEnv): ContextPolicy {
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) throw new Error("model context window is missing");
  const compactAtTokens = integerSetting(env.GOAH_PI_COMPACT_AT_TOKENS, Math.floor(contextWindowTokens * 0.7));
  const retainAfterCompactTokens = integerSetting(env.GOAH_PI_RETAIN_CONTEXT_TOKENS, Math.floor(contextWindowTokens * 0.2));
  if (retainAfterCompactTokens >= compactAtTokens || compactAtTokens >= contextWindowTokens) throw new Error("invalid Pi context policy");
  return { compactAtTokens, retainAfterCompactTokens };
}

export function compactMessagesToTokenBudget(messages: AgentMessage[], retainTokens: number): AgentMessage[] {
  if (messages.length <= 2 || estimateMessages(messages) <= retainTokens) return messages;
  const tailBudget = Math.max(1, Math.floor(retainTokens * 0.6));
  let start = messages.length;
  let retained = 0;
  while (start > 1) {
    const tokens = estimateMessages([messages[start - 1]!]);
    if (retained > 0 && retained + tokens > tailBudget) break;
    retained += tokens;
    start -= 1;
  }
  const removed = messages.slice(1, start);
  const rawSummary = removed.map((message, index) => `${index + 1}. ${messageText(message).slice(0, 240)}`).join("\n");
  const summaryChars = Math.max(0, (retainTokens - retained - 80) * 4);
  const summary = summaryChars === 0 ? "[older entries truncated]"
    : rawSummary.length <= summaryChars ? rawSummary : `[older entries truncated]\n${rawSummary.slice(-summaryChars)}`;
  return [
    messages[0]!,
    { role: "user", content: `Compacted model view. Original trace is unchanged. Source message indexes 1-${removed.length}:\n${summary}`, timestamp: Date.now() },
    ...messages.slice(start),
  ];
}

function createRpcTools(rpc: WorkerRpc, allowed?: ReadonlySet<AgentCapability>, onResult?: (method: AgentCapability, result: JsonValue) => void): AgentTool<any>[] {
  const tool = (name: string, description: string, method: AgentCapability, parameters: ReturnType<typeof Type.Object>): AgentTool<any> => ({
    name, label: name, description, parameters,
    execute: async (_id, params) => { const result = await rpc(method, params as JsonValue); onResult?.(method, result); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result }; },
  });
  const definitions: Array<[AgentCapability, AgentTool<any>]> = [
    ["ledger.search", tool("ledger_search", "Search durable ledger facts.", "ledger.search", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }))],
    ["memory.append", tool("memory_append", "Append a durable working-memory note that is injected into your future wakes. Record procedural knowledge, active hypotheses, and abandoned approaches with the reason; keep notes concise.", "memory.append", Type.Object({ note: Type.String() }))],
    ["mail.send", tool("send_mail", "Send durable Mail to another Goal owner. goalId is required and routes the Mail into that owner's Goal Turn. Human communication must use request_human.", "mail.send", Type.Object({ to: Type.String(), goalId: Type.String(), level: Type.Union([Type.Literal("fyi"), Type.Literal("decision"), Type.Literal("emergency")]), body: Type.Any() }))],
    ["schedule.set", tool("schedule_wake", "Schedule this agent's next wake.", "schedule.set", Type.Object({ at: Type.String(), reason: Type.String() }))],
    ["team.list", tool("team_list", "Read the ledger-derived team roster and liveness state.", "team.list", Type.Object({}))],
    ["goal.get", tool("get_goal", "Read the Goal bound to this Turn, or null when the Turn is unbound.", "goal.get", Type.Object({}))],
    ["goal.create", tool("create_goal", "Create a Root Goal from durable Human intent and bind this Turn. Do not use for greetings, questions, or routine single-turn work.", "goal.create", Type.Object({ objective: Type.String(), id: Type.Optional(Type.String()) }))],
    ["goal.work", tool("work_on_goal", "Bind this Human Turn to an existing active Goal owned by this Agent.", "goal.work", Type.Object({ goalId: Type.String() }))],
    ["goal.delegate", tool("delegate_goal", "Atomically create a Child Goal with observation and verification methods, its Work Record, decision brief, and initial Wake.", "goal.delegate", Type.Object({ id: Type.String(), parentGoalId: Type.String(),expectedParentRevision:Type.Number(), childGoal: Type.Object({ id: Type.String(), objective: Type.String(), observationMethod: Type.String(), verificationMethod: Type.String(), owner: Type.String() }), brief: Type.Any(), reason: Type.String(), evidence: Type.Array(Type.Number()) }))],
    ["goal.reassign", tool("reassign_goal", "Atomically transfer a child goal, notify both owners, and queue the new owner.", "goal.reassign", Type.Object({ id: Type.String(), goalId: Type.String(),expectedGoalRevision:Type.Number(), newOwner: Type.String(), brief: Type.Any(), reason: Type.String(), evidence: Type.Array(Type.Number()) }))],
    ["goal.revise", tool("revise_goal", "Revise a Child Goal objective, observation method, and verification method as one new revision.", "goal.revise", Type.Object({ goalId: Type.String(), objective: Type.String(), observationMethod: Type.String(), verificationMethod: Type.String(), reason: Type.String(), evidence: Type.Array(Type.Number()) }))],
    ["goal.pause", tool("pause_goal", "Pause a child goal and suppress queued motion.", "goal.pause", Type.Object({ goalId: Type.String() }))],
    ["goal.resume", tool("resume_goal", "Resume a Goal. A direct Human Root resume binds the current Turn; Child Goal resume requires an already bound parent Turn.", "goal.resume", Type.Object({ goalId: Type.String() }))],
    ["goal.complete", tool("complete_goal", "Complete a child goal with evidence produced under its current observation method. Root completion remains human authority.", "goal.complete", Type.Object({ goalId: Type.String(), revision: Type.Number(), reason: Type.String(), evidence: Type.Array(Type.Number()) }))],
    ["human.request", tool("request_human", "Ask the human for a decision, observation-method confirmation, or root completion with evidence.", "human.request", Type.Object({ type: Type.Union([Type.Literal("decision"), Type.Literal("observation_method_confirmation"), Type.Literal("completion_recommendation")]), message: Type.Any(), evidence: Type.Array(Type.Number()) }))],
    ["work_record.list", tool("work_record_list", "List the current Work Record for every Goal in the organization.", "work_record.list", Type.Object({}))],
    ["work_record.read", tool("work_record_read", "Read one current Goal Work Record. Omit goalId for the Goal bound to this Turn.", "work_record.read", Type.Object({ goalId: Type.Optional(Type.String()) }))],
    ["work_record.history", tool("work_record_history", "Read the version timeline for a Goal Work Record.", "work_record.history", Type.Object({ goalId: Type.Optional(Type.String()) }))],
    ["work_record.diff", tool("work_record_diff", "Compare two revisions of a Goal Work Record.", "work_record.diff", Type.Object({ goalId: Type.Optional(Type.String()), fromRevision: Type.Number(), toRevision: Type.Number() }))],
    ["work_record.search", tool("work_record_search", "Search every Goal Work Record.", "work_record.search", Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()) }))],
    ["work_record.update", tool("work_record_update", "Create the next version of the Work Record bound to this Turn with Ledger evidence.", "work_record.update", Type.Object({ expectedRevision: Type.Number(), content: Type.String(), reason: Type.String(), evidence: Type.Array(Type.Number()) }))],
    ["goal.put", tool("put_goal", "Create or update a Goal through the authoritative goal.changed protocol using parent-layer authority.", "goal.put", Type.Object({ goal: Type.Any(),reason:Type.String(),evidence:Type.Array(Type.Number()) }))],
  ];
  return definitions.filter(([capability]) => !allowed || allowed.has(capability)).map(([, value]) => value);
}

export function scopedRunnerPath(root: string, path: string, protectedPaths: string[] = []): string {
  const resolved = canonicalPath(resolve(root, path));
  const canonicalRoot = canonicalPath(root);
  if (resolved !== canonicalRoot && !resolved.startsWith(`${canonicalRoot}${sep}`)) throw new Error("path escapes runner root");
  if (protectedPaths.map(canonicalPath).some((privatePath) => resolved === privatePath || resolved.startsWith(`${privatePath}${sep}`))) throw new Error("path is protected Goah state");
  return resolved;
}
function sandboxedShell(command: string, root: string, protectedPaths: string[], sandboxTemp: string | null): { command: string; args: string[] } | null {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
    const workspacePaths = sandboxWorkspacePaths(canonicalPath(root), protectedPaths.map(canonicalPath));
    const workspaceAncestors = pathAncestors(canonicalPath(root));
    const toolchains = toolchainReadPaths(canonicalPath(root));
    const readableAncestors = toolchains.flatMap(pathAncestors);
    const readable = ["/System", "/usr", "/bin", "/sbin", "/Library", "/etc", "/dev", "/private/etc", "/private/var/select", "/Applications", ...toolchains, ...workspacePaths, ...(sandboxTemp ? [sandboxTemp] : [])].filter(existsSync).map(canonicalPath);
    const writable = [...workspacePaths, ...(sandboxTemp ? [sandboxTemp] : []), "/dev"].map(canonicalPath);
    const rules = ["(version 1)", "(deny default)", "(import \"system.sb\")", "(allow process*)", "(allow signal)", "(allow network*)", "(allow sysctl-read)", "(allow mach-lookup)", ...[...new Set([...workspaceAncestors, ...readableAncestors])].map((path) => `(allow file-read* (literal ${JSON.stringify(path)}))`), ...readable.map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`), ...writable.map((path) => `(allow file-write* (subpath ${JSON.stringify(path)}))`), ...protectedPaths.map(canonicalPath).map((path) => `(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`)];
    return { command: "/usr/bin/sandbox-exec", args: ["-p", rules.join(" "), "/bin/sh", "-lc", command] };
  }
  if (process.platform === "linux") {
    const bwrap = ["/usr/bin/bwrap", "/bin/bwrap"].find(existsSync);
    if (bwrap) {
      const canonicalRoot = canonicalPath(root);
      if (["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"].some((path) => canonicalRoot === path || canonicalRoot.startsWith(`${path}${sep}`))) return null;
      return { command: bwrap, args: linuxSandboxArgs(command, canonicalRoot, protectedPaths, sandboxTemp) };
    }
  }
  return null;
}
export function linuxSandboxArgs(command: string, root: string, protectedPaths: string[], sandboxTemp: string | null): string[] {
  const canonicalRoot = canonicalPath(root);
  const workspacePaths = sandboxWorkspacePaths(canonicalRoot, protectedPaths.map(canonicalPath));
  const systemPaths = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"].filter(existsSync).flatMap((path) => ["--ro-bind", path, path]);
  const mounted = ["/tmp", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
  const toolchains = toolchainReadPaths(canonicalRoot).filter((path) => !mounted.some((base) => path === base || path.startsWith(`${base}${sep}`)) && path !== canonicalRoot && !path.startsWith(`${canonicalRoot}${sep}`));
  const destinations = [canonicalRoot, ...toolchains].flatMap((path) => pathAncestors(path).slice(1)).filter((path) => !mounted.some((base) => path === base || path.startsWith(`${base}${sep}`)));
  const directories = [...new Set(destinations)].sort((left, right) => left.length - right.length).flatMap((path) => ["--dir", path]);
  return ["--die-with-parent", "--unshare-all", "--share-net", ...systemPaths, "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", ...(sandboxTemp ? ["--dir", canonicalPath(sandboxTemp)] : []), ...directories, ...toolchains.flatMap((path) => ["--ro-bind", path, path]), ...workspacePaths.flatMap((path) => ["--bind", path, path]), "--chdir", canonicalRoot, "/bin/sh", "-lc", command];
}
function toolchainReadPaths(root: string): string[] {
  const executable = canonicalPath(process.execPath);
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => resolve(path));
  const prefixes = ["/opt/homebrew", "/usr/local"].filter((prefix) => executable.startsWith(`${prefix}${sep}`) || pathEntries.some((path) => path.startsWith(`${prefix}${sep}`)));
  const home = canonicalPath(homedir());
  const managedHomeRuntime = [join(home, ".nvm", "versions", "node"), join(home, ".asdf", "installs", "node"), join(home, ".volta", "tools", "image", "node")].find((prefix) => executable.startsWith(`${prefix}${sep}`));
  const runtimeRoot = prefixes.length ? [] : managedHomeRuntime ? [executable.slice(0, executable.indexOf(`${sep}bin${sep}`, managedHomeRuntime.length))] : [dirname(executable)];
  return [...new Set([...prefixes, ...runtimeRoot])].filter((path) => path !== root && !path.startsWith(`${root}${sep}`));
}
export function sandboxWorkspacePaths(root: string, protectedPaths: string[]): string[] {
  if (!protectedPaths.some((path) => path === root || path.startsWith(`${root}${sep}`))) return [root];
  return [...new Set(readdirSync(root).flatMap((name) => { try { return [canonicalPath(join(root, name))]; } catch { return []; } }))]
    .filter((candidate) => candidate !== root && candidate.startsWith(`${root}${sep}`))
    .filter((candidate) => !protectedPaths.some((path) => path === candidate || path.startsWith(`${candidate}${sep}`) || candidate.startsWith(`${path}${sep}`)));
}
function canonicalPath(path: string): string {
  let current = resolve(path); const suffix: string[] = [];
  while (!existsSync(current)) { const parent = dirname(current); if (parent === current) break; suffix.unshift(current.slice(parent.length + 1)); current = parent; }
  return resolve(realpathSync(current), ...suffix);
}
function pathAncestors(path: string): string[] {
  const values: string[] = []; let current = resolve(path);
  while (true) { values.unshift(current); const parent = dirname(current); if (parent === current) return values; current = parent; }
}
function toolEnvironment(sandboxTemp: string | null = null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL", "TERM", "USER"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  if (sandboxTemp) { env.TMPDIR = sandboxTemp; env.TMP = sandboxTemp; env.TEMP = sandboxTemp; }
  if (process.platform === "darwin") {
    const developer = ["/Library/Developer/CommandLineTools", "/Applications/Xcode.app/Contents/Developer"].find(existsSync);
    if (developer) env.DEVELOPER_DIR = developer;
  }
  Object.assign(env, gitIdentityEnvironment());
  return env;
}
function gitIdentityEnvironment(): NodeJS.ProcessEnv {
  try {
    const source = readFileSync(join(homedir(), ".gitconfig"), "utf8"); const user = source.match(/^\[user\]\s*\n((?:[ \t].*(?:\n|$))*)/m)?.[1] ?? "";
    const name = user.match(/^\s*name\s*=\s*(.+)$/m)?.[1]?.trim(); const email = user.match(/^\s*email\s*=\s*(.+)$/m)?.[1]?.trim();
    return { ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}), ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}), GIT_CONFIG_GLOBAL: "/dev/null" };
  } catch { return { GIT_CONFIG_GLOBAL: "/dev/null" }; }
}
function estimateMessages(messages: AgentMessage[]): number { return Math.ceil(JSON.stringify(messages).length / 4); }
function integerSetting(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Pi token settings must be positive integers");
  return parsed;
}
function messageText(message: AgentMessage): string {
  const value = message as Message;
  if (value.role === "user") return typeof value.content === "string" ? value.content : value.content.map((item) => item.type === "text" ? item.text : "[image]").join(" ");
  if (value.role === "assistant") return value.content.map((item) => item.type === "text" ? item.text : item.type === "thinking" ? item.thinking : `[tool:${item.name}]`).join(" ");
  return value.content.map((item) => item.type === "text" ? item.text : "[image]").join(" ");
}

/** User-visible assistant prose only; reasoning and tool blocks stay structured in the ledger. */
export function assistantResponseText(message: AgentMessage): string {
  const value = message as Message;
  if (value.role !== "assistant") return messageText(message);
  return value.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await runPiWorker();
