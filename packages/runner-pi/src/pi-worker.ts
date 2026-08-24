import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall, Type, type Message } from "@earendil-works/pi-ai";
import { SESSION_FORMAT_VERSION, type AgentCapability, type JsonValue, type RunnerResult, type SessionMessage, type WakeOutput } from "goah-ledger-contract";
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
  await runProcessWorker(async (request, emit, rpc): Promise<RunnerResult> => {
    const contextRecord = typeof request.context === "object" && request.context !== null && !Array.isArray(request.context) ? request.context : {};
    const goalState: { bound: boolean; binding?: { goalId: string; goalRevision: number }; recordRevision?: number } = { bound: request.turn.goalBinding !== undefined, ...(request.turn.goalBinding ? { binding: request.turn.goalBinding } : {}) };
    const profile = contextRecord.runnerProfile && typeof contextRecord.runnerProfile === "object" && !Array.isArray(contextRecord.runnerProfile) ? contextRecord.runnerProfile as Record<string, unknown> : {};
    const runnerConfig = profile.config && typeof profile.config === "object" && !Array.isArray(profile.config) ? profile.config as Record<string, unknown> : {};
    const provider = typeof runnerConfig.provider === "string" ? runnerConfig.provider : process.env.GOAH_PI_PROVIDER ?? "anthropic";
    const modelId = typeof runnerConfig.model === "string" ? runnerConfig.model : process.env.GOAH_PI_MODEL;
    if (!modelId) throw new Error("GOAH_PI_MODEL is required");
    const configured = createPiModel(provider, modelId);
    const { models } = configured;
    const privateAuth = request.runtime && typeof request.runtime === "object" && !Array.isArray(request.runtime) ? request.runtime as Record<string, unknown> : {};
    const model = typeof privateAuth.baseUrl === "string" ? { ...configured.model, baseUrl: privateAuth.baseUrl } : configured.model;
    if (provider === "faux") {
      const faux = configured.faux!;
      if (goalState.bound) {
        const handoff = JSON.parse(process.env.GOAH_PI_FAUX_HANDOFF ?? "{}") as Record<string, unknown>;
        const current = contextRecord.workRecord && typeof contextRecord.workRecord === "object" && !Array.isArray(contextRecord.workRecord) ? contextRecord.workRecord as Record<string, unknown> : {};
        const evidence = Array.isArray(contextRecord.sourceSeqs) ? contextRecord.sourceSeqs.filter((value): value is number => typeof value === "number") : [];
        const record = `# Current State\n\nFaux Goal work completed.\n\n# Observations\n\n${JSON.stringify(handoff.observations ?? [])}\n\n# Work Completed\n\n${JSON.stringify(handoff.results ?? [])}\n\n# Decisions\n\nRecord the scripted result from ${request.wake.id}.\n\n# Blockers\n\n${String(handoff.blocker ?? "None.")}\n\n# Next Steps\n\n${JSON.stringify(handoff.nextSteps ?? [])}\n`;
        faux.setResponses([
          fauxAssistantMessage(fauxToolCall("work_record_update", { expectedRevision: Number(current.recordRevision ?? 0), content: record, reason: "record faux Goal progress", evidence: evidence.length ? [Math.max(...evidence)] : [] }), { stopReason: "toolUse" }),
          fauxAssistantMessage(fauxToolCall("handoff", handoff), { stopReason: "toolUse" }),
        ]);
      } else {
        faux.setResponses([fauxAssistantMessage([fauxText(process.env.GOAH_PI_FAUX_RESPONSE ?? "Hello from Goah.")])]);
      }
    }

    let output: WakeOutput | null = null;
    let response = "";
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
    const tools = createTools(root, (value) => { output = value; }, rpc, request.wake.startedAt, capabilities, goalState);
    const contextPolicy = resolveContextPolicy(model.contextWindow, process.env);
    emit({ type: "session.started", data: { formatVersion: SESSION_FORMAT_VERSION, provider, model: modelId, runner: "pi", contextWindowTokens: model.contextWindow, maxOutputTokensPerTurn: model.maxTokens } });
    const suppliedPrompt = typeof contextRecord.systemPrompt === "string" ? contextRecord.systemPrompt : undefined;
    const activeContext = typeof contextRecord.text === "string" ? contextRecord.text : JSON.stringify(request.context);
    const sourceSeqs = Array.isArray(contextRecord.sourceSeqs) ? contextRecord.sourceSeqs.filter((value): value is number => Number.isInteger(value)) : [];
    const systemPrompt = goalState.bound
      ? `${process.env.GOAH_PI_SYSTEM_PROMPT ?? suppliedPrompt ?? "You are a goal-oriented worker."}\nYou must finish by calling handoff exactly once. Treat the supplied context as authoritative.`
      : `${process.env.GOAH_PI_SYSTEM_PROMPT ?? suppliedPrompt ?? "You are Goah's primary Agent."}\nRespond normally to the Human. Do not create a Goal for routine single-turn work. When the Human expresses a durable Goal, call create_goal; after create_goal, work_on_goal, or a Root resume succeeds with a Goal binding, update the Goal Work Record and finish by calling handoff. Treat the supplied context as authoritative.`;
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
    agent.subscribe((event) => {
      if (event.type === "turn_start") emit({ type: "turn.started", data: {} });
      else if (event.type === "message_start" && event.message.role === "user") {
        const id = idFor(event.message);
        if (!emittedUsers.has(id)) { emittedUsers.add(id); emit({ type: "message.user", data: { message: sessionMessage(event.message, id) as unknown as JsonValue } }); }
      } else if (event.type === "message_update") {
        emit({ type: "message.assistant.delta", data: { messageId: idFor(event.message), delta: JSON.parse(JSON.stringify(event.assistantMessageEvent)) as JsonValue } });
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        response = messageText(event.message);
        emit({ type: "message.assistant.completed", data: { message: sessionMessage(event.message, idFor(event.message)) as unknown as JsonValue } });
      } else if (event.type === "tool_execution_start") emit({ type: "tool.called", data: { callId: event.toolCallId, name: event.toolName, arguments: JSON.parse(JSON.stringify(event.args)) as JsonValue } });
      else if (event.type === "tool_execution_end") emit({ type: "tool.completed", data: { callId: event.toolCallId, messageId: `tool:${event.toolCallId}`, name: event.toolName, result: JSON.parse(JSON.stringify(event.result)) as JsonValue, isError: event.isError } });
      else if (event.type === "turn_end") emit({ type: "turn.completed", data: {} });
      else if (event.type === "agent_end") emit({ type: "session.completed", data: {} });
    });
    await agent.prompt(`Wake started at: ${request.wake.startedAt ?? "unknown"}\n\n${activeContext}\n\nRunner root: ${root}. Manage local files directly when the goal requires them.`);
    if (!goalState.bound) return response ? { outcome: "response", response: { content: response } } : { outcome: "abnormal", reason: "Pi worker exited without a response" };
    if (!output) return { outcome: "abnormal", reason: "Pi worker exited without a valid handoff" };
    return { outcome: "handoff", output };
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

function sessionMessage(message: AgentMessage, id: string): SessionMessage {
  const value = JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
  const role = message.role === "assistant" ? "assistant" : message.role === "user" ? "user" : "tool";
  return { id, role, content: (value.content ?? value) as JsonValue, ...(value.usage !== undefined ? { usage: value.usage as JsonValue } : {}) };
}

function createTools(root: string, handoff: (output: WakeOutput) => void, rpc: WorkerRpc, wakeStartedAt: string | null, capabilities: ReadonlySet<AgentCapability> | undefined, goalState: { bound: boolean; binding?: { goalId: string; goalRevision: number }; recordRevision?: number }): AgentTool<any>[] {
  const handoffTool: AgentTool<any> = {
    name: "handoff",
    label: "Handoff",
    description: "Record a structured handoff and end the wake.",
    parameters: Type.Object({
      observations: Type.Optional(Type.Array(Type.String())),
      results: Type.Optional(Type.Array(Type.String())),
      nextSteps: Type.Optional(Type.Array(Type.String())),
      blocker: Type.Optional(Type.String()),
      material: Type.Optional(Type.Boolean()),
      outcome: Type.Optional(Type.Union([Type.Literal("progress"), Type.Literal("waiting"), Type.Literal("blocked"), Type.Literal("completion_proposed")])),
      evidence: Type.Optional(Type.Array(Type.Number())),
      nextWakeAt: Type.Optional(Type.String()),
    }),
    execute: async (_id, params) => {
      const input = params as { observations?: string[]; results?: string[]; nextSteps?: string[]; blocker?: string; material?: boolean; outcome?: "progress" | "waiting" | "blocked" | "completion_proposed"; evidence?: number[]; nextWakeAt?: string };
      const compact = goalState.binding && goalState.recordRevision !== undefined
        ? { goalId: goalState.binding.goalId, goalRevision: goalState.binding.goalRevision, recordRevision: goalState.recordRevision, outcome: input.outcome ?? (input.blocker ? "blocked" : input.material ? "completion_proposed" : "progress"), evidence: input.evidence ?? [] }
        : null;
      const value: WakeOutput = { handoff: compact ?? { observations: input.observations ?? [], results: input.results ?? [], nextSteps: input.nextSteps ?? [], ...(input.blocker ? { blocker: input.blocker } : {}), ...(input.material === true ? { material: true } : {}) }, mail: [], nextWakeAt: validateNextWakeAt(input.nextWakeAt, wakeStartedAt) };
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
    execute: async (_id, params) => { const input = params as { path: string }; return { content: [{ type: "text", text: await readFile(scoped(root, input.path), "utf8") }], details: {} }; },
  };
  const writeTool: AgentTool<any> = {
    name: "write", label: "Write", description: "Create or replace a UTF-8 file inside the current working directory.",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    execute: async (_id, params) => { const input = params as { path: string; content: string }; const path = scoped(root, input.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, input.content); return { content: [{ type: "text", text: "written" }], details: {} }; },
  };
  const editTool: AgentTool<any> = {
    name: "edit", label: "Edit", description: "Replace one exact text occurrence in a UTF-8 file inside the current working directory.",
    parameters: Type.Object({ path: Type.String(), oldText: Type.String(), newText: Type.String() }),
    execute: async (_id, params) => {
      const input = params as { path: string; oldText: string; newText: string };
      const path = scoped(root, input.path);
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
    description: "Run a shell command inside the local runner root. The command's process group is killed after the timeout; declare timeoutMs explicitly for builds, installs, or deployment waits that need longer.",
    parameters: Type.Object({ command: Type.String(), timeoutMs: Type.Optional(Type.Number()) }), executionMode: "sequential",
    execute: async (_id, params, signal) => runBashCommand(root, params as { command: string; timeoutMs?: number }, signal),
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
export async function runBashCommand(root: string, input: { command: string; timeoutMs?: number }, signal?: AbortSignal): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown; isError?: boolean }> {
  const timeoutMs = bashTimeoutMs(input.timeoutMs);
  const child = spawn("/bin/sh", ["-lc", input.command], { cwd: root, env: toolEnvironment(), detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let outputOverflow = false;
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 1_000_000) outputOverflow = true; });
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); if (stderr.length > 1_000_000) outputOverflow = true; });
  const killGroup = () => { if (child.pid) { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {} } };
  const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
  const onAbort = () => killGroup();
  signal?.addEventListener("abort", onAbort, { once: true });
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signalName) => resolve({ code, signal: signalName }));
  });
  try {
    if (outputOverflow) killGroup();
    const result = await close;
    if (timedOut) return { content: [{ type: "text", text: `Command timed out after ${timeoutMs}ms and its process group was killed. Declare a larger timeoutMs for long-running commands.` }], details: { command: input.command, timedOutAfterMs: timeoutMs }, isError: true };
    if (signal?.aborted) return { content: [{ type: "text", text: "Command aborted with the wake." }], details: { command: input.command }, isError: true };
    return { content: [{ type: "text", text: `${stdout}${stderr}`.slice(-50_000) }], details: { command: input.command, exitCode: result.code, signal: result.signal, ...(outputOverflow ? { outputOverflow: true } : {}) }, ...(outputOverflow ? { isError: true } : {}) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function validateNextWakeAt(value: string | undefined, wakeStartedAt: string | null): string | null {
  if (value === undefined) return null;
  const next = Date.parse(value);
  const started = wakeStartedAt === null ? Number.NaN : Date.parse(wakeStartedAt);
  if (!Number.isFinite(next) || !Number.isFinite(started) || next <= started) throw new Error("nextWakeAt must be a valid time later than the current wake start");
  return new Date(next).toISOString();
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
    ["mail.send", tool("send_mail", "Send a durable message to another agent or human.", "mail.send", Type.Object({ to: Type.String(), level: Type.Union([Type.Literal("fyi"), Type.Literal("decision"), Type.Literal("emergency")]), body: Type.Any() }))],
    ["schedule.set", tool("schedule_wake", "Schedule this agent's next wake.", "schedule.set", Type.Object({ at: Type.String(), reason: Type.String() }))],
    ["action.submit", tool("submit_action", "Submit a gated external action with evidence.", "action.submit", Type.Object({ id: Type.String(), kind: Type.String(), connector: Type.String(), payload: Type.Any(), reason: Type.String(), evidence: Type.Array(Type.Number()) }))],
    ["audit.ack", tool("ack_audit_advice", "Acknowledge audit advice after incorporating it.", "audit.ack", Type.Object({ actionId: Type.String() }))],
    ["audit.write", tool("write_audit_advice", "Write audit advice for an action.", "audit.write", Type.Object({ actionId: Type.String(), body: Type.Any(), evidence: Type.Array(Type.Number()) }))],
    ["team.list", tool("team_list", "Read the ledger-derived team roster and liveness state.", "team.list", Type.Object({}))],
    ["goal.get", tool("get_goal", "Read the Goal bound to this Turn, or null when the Turn is unbound.", "goal.get", Type.Object({}))],
    ["goal.create", tool("create_goal", "Create a Root Goal from durable Human intent and bind this Turn. Do not use for greetings, questions, or routine single-turn work.", "goal.create", Type.Object({ objective: Type.String(), id: Type.Optional(Type.String()) }))],
    ["goal.work", tool("work_on_goal", "Bind this Human Turn to an existing active Goal owned by this Agent.", "goal.work", Type.Object({ goalId: Type.String() }))],
    ["goal.delegate", tool("delegate_goal", "Atomically create a Child Goal with observation and verification methods, its Work Record, decision brief, and initial Wake.", "goal.delegate", Type.Object({ id: Type.String(), parentGoalId: Type.String(), childGoal: Type.Object({ id: Type.String(), objective: Type.String(), observationMethod: Type.String(), verificationMethod: Type.String(), owner: Type.String() }), brief: Type.Any(), reason: Type.String(), evidence: Type.Array(Type.Number()) }))],
    ["goal.reassign", tool("reassign_goal", "Atomically transfer a child goal, notify both owners, and queue the new owner.", "goal.reassign", Type.Object({ id: Type.String(), goalId: Type.String(), newOwner: Type.String(), brief: Type.Any(), reason: Type.String(), evidence: Type.Array(Type.Number()) }))],
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
    ["goal.put", tool("put_goal", "Create or update a goal using parent-layer authority.", "goal.put", Type.Object({ goal: Type.Any() }))],
  ];
  return definitions.filter(([capability]) => !allowed || allowed.has(capability)).map(([, value]) => value);
}

function scoped(root: string, path: string): string {
  const resolved = resolve(root, path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) throw new Error("path escapes runner root");
  return resolved;
}
function toolEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SHELL", "TERM", "USER"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
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
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) await runPiWorker();
