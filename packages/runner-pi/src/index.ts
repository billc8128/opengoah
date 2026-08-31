import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveEnvSpec } from "./env-spec.js";
import { fileURLToPath } from "node:url";
import {
  assertTurnOutput,
  type AgentHandoff,
  type HandoffValidationResult,
  type JsonValue,
  type RunRequest,
  type Runner,
  type RunnerHandle,
  type RunnerLiveEvent,
  type RunnerCandidateResult,
  type RunnerRpcMethod,
  type TurnContext,
  type TurnOutput,
} from "goah-ledger-contract";

export {
  defaultAuthFile,
  modelCatalog,
  providerCatalog,
  LOCAL_PROVIDERS,
  type ModelSummary,
  type ProviderSummary,
} from "./model-provider.js";
export {
  createPiProcessRunner,
  piConfig,
  piEnvironment,
  piRunnerConfigurator,
  type PiRunnerConfig,
} from "./configurator.js";
export { resolveEnvSpec } from "./env-spec.js";

export interface PiAssistantResponse {
  content: string;
}
export interface PiStep {
  trace?: Array<{ type: string; data: JsonValue }>;
  response?: PiAssistantResponse;
  handoff?: { response: PiAssistantResponse; handoff: AgentHandoff };
  stopped?: boolean;
}
export interface PiRunnerSession {
  step(): Promise<PiStep>;
  feedback(validation: Exclude<HandoffValidationResult, { accepted: true }>): Promise<void>;
  close(): Promise<void>;
}
export interface PiDriver {
  createRunnerSession(request: RunRequest): Promise<PiRunnerSession>;
}

/** In-process adapter for tests and for use inside a ProcessRunner worker. */
export class PiRunnerAdapter {
  constructor(private readonly driver: PiDriver) {}

  prepare(request: RunRequest): RunnerHandle {
    let started = false;
    let resolveResult!: (result: RunnerCandidateResult) => void;
    const result = new Promise<RunnerCandidateResult>((resolve) => {
      resolveResult = resolve;
    });
    return {
      pid: null,
      begin: () => {
        if (started) return;
        started = true;
        void this.#run(request).then(resolveResult, (error) =>
          resolveResult({
            outcome: "abnormal",
            reason: error instanceof Error ? error.message : String(error),
          }),
        );
      },
      result,
      terminate: async () => undefined,
    };
  }

  async terminateProcess(pid: number): Promise<void> {
    await terminatePid(pid, 500);
  }

  async #run(request: RunRequest): Promise<RunnerCandidateResult> {
    const runnerSession = await this.driver.createRunnerSession(request);
    let messageSequence = 0;
    try {
      while (true) {
        const step = await runnerSession.step();
        for (const trace of step.trace ?? []) request.emit(trace);
        if (step.response) {
          const finalMessageId = `adapter:${request.execution.id}:attempt:${request.execution.attempt}:message:${++messageSequence}`;
          request.emit({
            type: "message.assistant.completed",
            data: {
              message: {
                id: finalMessageId,
                role: "assistant",
                content: [{ type: "text", text: step.response.content }],
              },
              commitState: "committed",
            },
          });
          return { outcome: "completed", finalMessageId };
        }
        if (step.handoff) {
          const messageItemId = `adapter:${request.execution.id}:attempt:${request.execution.attempt}:message:${++messageSequence}`;
          const validation = (await request.rpc?.("goal.handoff.validate", {
            handoff: step.handoff.handoff,
            candidateMessageId: messageItemId,
            candidateMessage: step.handoff.response.content,
          } as unknown as JsonValue)) as unknown as HandoffValidationResult | undefined;
          if (!validation)
            return { outcome: "abnormal", reason: "Handoff validation is unavailable" };
          request.emit({
            type: "message.assistant.completed",
            data: {
              message: {
                id: messageItemId,
                role: "assistant",
                content: [{ type: "text", text: step.handoff.response.content }],
                stopReason: "toolUse",
              },
              commitState: "provisional",
            },
          });
          if (!validation.accepted) {
            if (validation.fatal)
              return {
                outcome: "abnormal",
                reason: validation.issues.map((issue) => issue.message).join("; "),
              };
            await runnerSession.feedback(validation);
            request.emit({
              type: "runner.handoff_rejected",
              data: {
                attemptId: validation.attemptId,
                issues: validation.issues,
              } as unknown as JsonValue,
            });
            continue;
          }
          if (validation.messageItemId !== messageItemId)
            return {
              outcome: "abnormal",
              reason: "Handoff validation returned a different assistant message identity",
            };
          const output: TurnOutput = {
            validationAttemptId: validation.attemptId,
            validationToken: validation.token,
            handoff: step.handoff.handoff,
          };
          assertTurnOutput(output);
          return { outcome: "completed", finalMessageId: messageItemId, handoff: output };
        }
        if (step.stopped)
          return {
            outcome: "abnormal",
            reason: request.turn.goalCommitment
              ? "runner stopped without a readable response and valid handoff"
              : "runner stopped without a response",
          };
      }
    } catch (error) {
      return {
        outcome: "abnormal",
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await runnerSession.close();
    }
  }
}

export interface ProcessRunnerOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Unresolved env spec (may contain `env:NAME` references); resolved at every spawn. */
  envSpec?: Record<string, string> | undefined;
  inheritEnv?: string[];
  /** Worker implements the live steering control message. */
  steering?: boolean;
  steerAckTimeoutMs?: number;
  killGraceMs?: number;
  timeoutMs?: number;
  /** Resolve private per-wake runtime material (for example scoped model auth) before the worker starts. Never enters RunRequest context or Ledger events. */
  prepareRuntime?: (request: RunRequest) => Promise<JsonValue | undefined>;
}

export function piWorkerPath(): string {
  return fileURLToPath(new URL("./pi-worker.js", import.meta.url));
}
export function verificationWorkerPath(): string {
  return fileURLToPath(new URL("./verification-worker.js", import.meta.url));
}

type WorkerRequest = Omit<RunRequest, "now" | "emit" | "emitLive" | "rpc" | "turn"> & {
  turn?: TurnContext;
  runtime?: JsonValue;
};
type WorkerMessage =
  | { type: "trace"; event: { type: string; data: JsonValue } }
  | { type: "live"; event: RunnerLiveEvent }
  | { type: "rpc_request"; id: string; method: RunnerRpcMethod; params: JsonValue }
  | { type: "steer_ack"; id: string; accepted: boolean }
  | { type: "result"; result: RunnerCandidateResult };
type ParentMessage =
  | { type: "start"; request: WorkerRequest }
  | { type: "rpc_response"; id: string; result?: unknown; error?: string }
  | { type: "steer"; id: string; message: string };

/** Real process boundary. The child stays idle until begin() sends its request. */
export class ProcessRunner implements Runner {
  readonly isolation = "process" as const;
  constructor(readonly options: ProcessRunnerOptions) {}

  prepare(request: RunRequest): RunnerHandle {
    const explicit = this.options.envSpec
      ? resolveEnvSpec(this.options.envSpec, { root: this.options.cwd ?? process.cwd() })
      : this.options.env;
    const child = spawn(this.options.command, this.options.args ?? [], {
      detached: process.platform !== "win32",
      ...(this.options.cwd ? { cwd: this.options.cwd } : {}),
      env: childEnvironment(explicit, this.options.inheritEnv),
    });
    let started = false;
    let timedOut = false;
    let messageResult: RunnerCandidateResult | null = null;
    let protocolError: string | null = null;
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let resolveStartReady!: () => void;
    const startReady = new Promise<void>((resolve) => {
      resolveStartReady = resolve;
    });
    let resolveResult!: (result: RunnerCandidateResult) => void;
    const pendingSteering = new Map<
      string,
      { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }
    >();
    const result = new Promise<RunnerCandidateResult>((resolve) => {
      resolveResult = resolve;
    });
    const settle = (value: RunnerCandidateResult) => {
      if (!settled) {
        settled = true;
        resolveResult(value);
      }
    };

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-65_536);
    });
    let protocolLineBytes = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 10) protocolLineBytes = 0;
        else if (++protocolLineBytes > 1_000_000 && !protocolError) {
          protocolError = "runner protocol line exceeded 1 MB";
          void terminate();
          break;
        }
      }
    });
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      if (protocolError) return;
      try {
        const message = JSON.parse(line) as WorkerMessage;
        if (message.type === "trace") request.emit(message.event);
        else if (message.type === "live") request.emitLive?.(message.event);
        else if (message.type === "steer_ack") {
          const pending = pendingSteering.get(message.id);
          if (pending) {
            pendingSteering.delete(message.id);
            clearTimeout(pending.timer);
            if (message.accepted) pending.resolve();
            else pending.reject(new Error("runner is no longer accepting steering messages"));
          }
        } else if (message.type === "rpc_request") {
          void Promise.resolve(
            request.rpc?.(message.method, message.params) ??
              Promise.reject(new Error("runner RPC is unavailable")),
          )
            .then((result) =>
              child.stdin?.write(
                `${JSON.stringify({ type: "rpc_response", id: message.id, result } satisfies ParentMessage)}\n`,
              ),
            )
            .catch((error) =>
              child.stdin?.write(
                `${JSON.stringify({ type: "rpc_response", id: message.id, error: error instanceof Error ? error.message : String(error) } satisfies ParentMessage)}\n`,
              ),
            );
        } else messageResult = message.result;
      } catch (error) {
        protocolError = error instanceof Error ? error.message : String(error);
        void terminate();
      }
    });
    child.once("error", (error) => {
      resolveStartReady();
      if (timer) clearTimeout(timer);
      settle({ outcome: "abnormal", reason: error.message });
    });
    child.once("close", (code, signal) => {
      resolveStartReady();
      for (const pending of pendingSteering.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("runner closed before acknowledging the steering message"));
      }
      pendingSteering.clear();
      if (timer) clearTimeout(timer);
      if (protocolError)
        settle({ outcome: "abnormal", reason: `runner protocol error: ${protocolError}` });
      else if (messageResult) settle(messageResult);
      else if (timedOut)
        settle({
          outcome: "abnormal",
          reason: "runner-specific timeout exceeded and process was killed",
        });
      else
        settle({
          outcome: "abnormal",
          reason:
            stderr.trim() || `runner exited without a result (${code ?? signal ?? "unknown"})`,
        });
    });

    const terminate = async () => {
      if (child.pid) await terminateOwnedChild(child, this.options.killGraceMs ?? 500);
    };
    return {
      pid: child.pid ?? null,
      begin: () => {
        if (started) return;
        started = true;
        void (async () => {
          try {
            const runtime = await this.options.prepareRuntime?.(request);
            const serializable: WorkerRequest = {
              agent: request.agent,
              execution: request.execution,
              ...(request.sourceWake ? { sourceWake: request.sourceWake } : {}),
              ...(request.sourceWakeTriggers
                ? { sourceWakeTriggers: request.sourceWakeTriggers }
                : {}),
              turn: request.turn,
              context: request.context,
              ...(runtime !== undefined ? { runtime } : {}),
            };
            child.stdin?.write(
              `${JSON.stringify({ type: "start", request: serializable } satisfies ParentMessage)}\n`,
            );
            resolveStartReady();
            if (this.options.timeoutMs)
              timer = setTimeout(() => {
                timedOut = true;
                void terminate();
              }, this.options.timeoutMs);
          } catch (error) {
            protocolError = error instanceof Error ? error.message : String(error);
            resolveStartReady();
            await terminate();
          }
        })();
      },
      result,
      ...(this.options.steering
        ? {
            steer: async (message: string) => {
              if (!started) throw new Error("runner is not accepting steering messages");
              await startReady;
              if (settled || protocolError || !child.stdin?.writable)
                throw new Error("runner is not accepting steering messages");
              const id = crypto.randomUUID();
              await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => {
                  pendingSteering.delete(id);
                  reject(new Error("runner did not acknowledge the steering message in time"));
                }, this.options.steerAckTimeoutMs ?? 2_000);
                timer.unref();
                pendingSteering.set(id, { resolve, reject, timer });
                child.stdin!.write(
                  `${JSON.stringify({ type: "steer", id, message } satisfies ParentMessage)}\n`,
                  (error) => {
                    if (error) {
                      const pending = pendingSteering.get(id);
                      if (pending) clearTimeout(pending.timer);
                      pendingSteering.delete(id);
                      reject(error);
                    }
                  },
                );
              });
            },
          }
        : {}),
      terminate,
    };
  }

  async terminateProcess(pid: number): Promise<void> {
    await terminatePid(pid, this.options.killGraceMs ?? 500);
  }
}

/** Resolves to an opaque JSON-serializable capability result. */
export type WorkerRpc = (method: RunnerRpcMethod, params: JsonValue) => Promise<unknown>;
export interface WorkerControls {
  onSteer(listener: (message: string) => boolean): void;
}
export type WorkerRun = (
  request: WorkerRequest,
  emit: (event: { type: string; data: JsonValue }) => void,
  rpc: WorkerRpc,
  controls: WorkerControls,
  emitLive: (event: RunnerLiveEvent) => void,
) => Promise<RunnerCandidateResult>;

/** Entry helper for runner executables. It exits when its parent disappears. */
export async function runProcessWorker(run: WorkerRun): Promise<void> {
  const parent = process.ppid;
  const monitor = setInterval(() => {
    if (process.ppid !== parent || !isAlive(parent)) process.exit(70);
  }, 250);
  monitor.unref();
  const input = createInterface({ input: process.stdin });
  const iterator = input[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done) throw new Error("runner parent closed before start");
  const start = JSON.parse(first.value) as ParentMessage;
  if (start.type !== "start") throw new Error("first runner message must be start");
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const queuedSteering: Array<{ id: string; message: string }> = [];
  let steerListener: ((message: string) => boolean) | undefined;
  const deliverSteer = (id: string, message: string): void => {
    let accepted = false;
    try {
      accepted = steerListener?.(message) === true;
    } catch {}
    process.stdout.write(
      `${JSON.stringify({ type: "steer_ack", id, accepted } satisfies WorkerMessage)}\n`,
    );
  };
  void (async () => {
    for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
      const message = JSON.parse(line) as ParentMessage;
      if (message.type === "steer") {
        if (steerListener) deliverSteer(message.id, message.message);
        else queuedSteering.push(message);
        continue;
      }
      if (message.type !== "rpc_response") continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error));
      else waiter.resolve(message.result ?? null);
    }
  })();
  const rpc: WorkerRpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      pending.set(id, { resolve, reject });
      process.stdout.write(`${JSON.stringify({ type: "rpc_request", id, method, params })}\n`);
    });
  const controls: WorkerControls = {
    onSteer: (listener) => {
      steerListener = listener;
      for (const message of queuedSteering.splice(0)) deliverSteer(message.id, message.message);
    },
  };
  const result = await run(
    start.request,
    (event) => process.stdout.write(`${JSON.stringify({ type: "trace", event })}\n`),
    rpc,
    controls,
    (event) =>
      process.stdout.write(`${JSON.stringify({ type: "live", event } satisfies WorkerMessage)}\n`),
  );
  process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
  input.close();
  process.stdin.unref();
  clearInterval(monitor);
}

async function terminateOwnedChild(child: ChildProcess, graceMs: number): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  signalPid(child.pid, "SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    delay(graceMs),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    signalPid(child.pid, "SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
}

async function terminatePid(pid: number, graceMs: number): Promise<void> {
  if (!isAlive(pid)) return;
  signalPid(pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < deadline) await delay(25);
  if (isAlive(pid)) signalPid(pid, "SIGKILL");
  const killDeadline = Date.now() + graceMs;
  while (isAlive(pid) && Date.now() < killDeadline) await delay(25);
  if (isAlive(pid)) throw new Error(`runner process ${pid} did not exit after SIGKILL`);
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {}
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function childEnvironment(
  explicit: Record<string, string> = {},
  inherited: string[] = [],
): NodeJS.ProcessEnv {
  const names = new Set(["PATH", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT", ...inherited]);
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, ...explicit };
}
