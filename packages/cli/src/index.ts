import { accessSync, chmodSync, constants, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTRACT_VERSION, wakeStream, type AgentProfile, type MetricContract, type MetricProcessSpec, type RunnerProfile } from "goah-ledger-contract";
import { SQLITE_SCHEMA_VERSION, SqliteLedger } from "goah-ledger-sqlite";
import { createPiModel, piWorkerPath, ProcessRunner, resolveEnvSpec, type ProcessRunnerOptions } from "goah-runner-pi";
import { renderDashboard, runSupervisorDaemon, RunnerRouter, Supervisor } from "goah-supervisor";
import { runnerPlugin } from "./runner-registry.js";

export interface GoahConfig {
  version: 1 | 2;
  stateDir: string;
  runner?: { command: string; args: string[]; env?: Record<string, string>; inheritEnv?: string[] };
  runnerProfiles?: RunnerProfile[];
  profiles?: AgentProfile[];
  silencePolicy?: { maxSilentMs?: number; notify?: string } | null;
  retryPolicy?: { maxAttempts: number; baseDelayMs: number };
  verifyMetricsAfterWake?: boolean;
  metrics?: Array<{ goalId: string; contract: MetricContract; intervalMs: number; process: MetricProcessSpec }>;
}

export interface InitOptions {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  agent?: string;
  contextWindowTokens?: number;
  maxOutputTokensPerTurn?: number;
  baseUrl?: string;
}
export interface DoctorCheck { name: string; ok: boolean; detail: string; severity?: "warning" | "error" }
const configRoots = new WeakMap<GoahConfig, string>();

export function loadConfig(path = "goah.config.json"): GoahConfig {
  recoverProfileTransaction();
  const absolute = resolve(path);
  const config = JSON.parse(readFileSync(absolute, "utf8")) as GoahConfig & { workspace?: string; limits?: unknown; heartbeatPolicies?: unknown; progressPolicies?: unknown };
  if (config.version !== 1 && config.version !== 2) throw new Error(`unsupported goah config version: ${String(config.version)}`);
  const base = dirname(absolute);
  const root = config.workspace ? absolutePath(base, config.workspace) : base;
  delete config.workspace;
  delete config.limits;
  delete config.heartbeatPolicies;
  delete config.progressPolicies;
  configRoots.set(config, root);
  config.stateDir = absolutePath(base, config.stateDir);
  if (config.runner) {
    config.runner.command = resolveCommand(config.runner.command);
    config.runner.args = config.runner.args.map((arg) => arg === "$GOAH_PI_WORKER" ? piWorkerPath() : arg);
  }
  if (!config.runnerProfiles?.length && config.runner?.env?.GOAH_PI_PROVIDER && config.runner.env.GOAH_PI_MODEL) {
    const env = config.runner.env;
    const provider = env.GOAH_PI_PROVIDER!;
    const model = env.GOAH_PI_MODEL!;
    const keyRef = Object.entries(env).find(([key, value]) => key.endsWith("API_KEY") && value.startsWith("env:"));
    config.runnerProfiles = [{ id: "default", runner: "pi", config: { provider, model, ...(keyRef ? { apiKeyEnv: keyRef[1].slice(4) } : {}), ...(env.GOAH_PI_BASE_URL ? { baseUrl: env.GOAH_PI_BASE_URL } : {}) } }];
    if (config.profiles) config.profiles = config.profiles.map((profile) => ({ ...profile, runnerProfile: profile.runnerProfile ?? "default" }));
  }
  for (const metric of config.metrics ?? []) metric.process.command = resolveCommand(metric.process.command);
  return config;
}

export function createRuntime(config: GoahConfig): { ledger: SqliteLedger; supervisor: Supervisor } {
  mkdirSync(config.stateDir, { recursive: true });
  const ledger = new SqliteLedger(join(config.stateDir, "ledger.sqlite"));
  const runner = config.runnerProfiles?.length
    ? new RunnerRouter(new Map(config.runnerProfiles.map((profile) => [profile.id, runnerPlugin(profile.runner).create(profile.config, configRoot(config))])))
    : legacyRunner(config);
  const supervisor = new Supervisor(ledger, runner, new class { now(): Date { return new Date(); } }(), {
    ...(config.profiles ? { profiles: config.profiles } : {}),
    ...(config.runnerProfiles ? { runnerProfiles: config.runnerProfiles } : {}),
    ...(config.silencePolicy !== undefined ? { silence: config.silencePolicy } : {}),
    ...(config.retryPolicy ? { retryPolicy: config.retryPolicy } : {}),
    ...(config.verifyMetricsAfterWake !== undefined ? { verifyMetricsAfterWake: config.verifyMetricsAfterWake } : {}),
  });
  for (const metric of config.metrics ?? []) supervisor.registerMetricCollector(metric.goalId, metric.contract, metric.process, metric.intervalMs);
  return { ledger, supervisor };
}

export function defaultConfig(directory: string, options: InitOptions = {}): GoahConfig {
  const provider = options.provider ?? "faux";
  const model = options.model ?? defaultModel(provider);
  const runnerProfile: RunnerProfile = { id: "default", runner: "pi", config: { provider, model, thinking: "medium", ...(options.apiKeyEnv ? { apiKeyEnv: options.apiKeyEnv } : {}), ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}), ...(options.contextWindowTokens ? { contextWindowTokens: options.contextWindowTokens } : {}), ...(options.maxOutputTokensPerTurn ? { maxOutputTokens: options.maxOutputTokensPerTurn } : {}) } };
  return {
    version: 2,
    stateDir: defaultStateDir(directory),
    runnerProfiles: [runnerProfile],
    profiles: [{ agent: "ceo", role: "ceo", runnerProfile: "default" }, { agent: options.agent ?? "worker", role: "child", runnerProfile: "default" }],
    silencePolicy: { maxSilentMs: 12 * 3_600_000, notify: "ceo" },
  };
}

export class SupervisorLock {
  readonly path: string;
  #owned = false;
  constructor(stateDir: string) { this.path = join(stateDir, "supervisor.lock"); }
  acquire(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    if (existsSync(this.path)) {
      const pid = Number(readFileSync(this.path, "utf8"));
      if (Number.isInteger(pid) && alive(pid)) throw new Error(`supervisor already running with pid ${pid}`);
      rmSync(this.path);
    }
    const fd = openSync(this.path, "wx");
    writeFileSync(fd, String(process.pid)); closeSync(fd); this.#owned = true;
  }
  release(): void { if (this.#owned) { rmSync(this.path, { force: true }); this.#owned = false; } }
}

export function writeDefaultConfig(path = "goah.config.json", options: InitOptions = {}, overwrite = false): void {
  const absolute = resolve(path);
  if (existsSync(absolute) && !overwrite) throw new Error(`${absolute} already exists`);
  writeFileSync(absolute, `${JSON.stringify(defaultConfig(dirname(absolute), options), null, 2)}\n`);
}

export function profilePath(): string { return join(process.env.GOAH_STATE_HOME ?? join(homedir(), ".goah"), "profile.json"); }

export function readDefaultRunnerProfile(): RunnerProfile | null {
  recoverProfileTransaction();
  try {
    const raw = JSON.parse(readFileSync(profilePath(), "utf8")) as Record<string, unknown>;
    if (typeof raw.id === "string" && typeof raw.runner === "string" && raw.config && typeof raw.config === "object") return raw as unknown as RunnerProfile;
    if (typeof raw.provider === "string" && typeof raw.model === "string") {
      const { provider, model, apiKeyEnv, baseUrl, contextWindowTokens, maxOutputTokensPerTurn } = raw;
      return { id: "default", runner: "pi", config: { provider, model, ...(typeof apiKeyEnv === "string" ? { apiKeyEnv } : {}), ...(typeof baseUrl === "string" ? { baseUrl } : {}), ...(typeof contextWindowTokens === "number" ? { contextWindowTokens } : {}), ...(typeof maxOutputTokensPerTurn === "number" ? { maxOutputTokens: maxOutputTokensPerTurn } : {}) } };
    }
    return null;
  } catch { return null; }
}

export function writeDefaultRunnerProfile(profile: RunnerProfile): void {
  withProfileLock(() => { recoverProfileTransactionUnlocked(); writeDefaultRunnerProfileUnlocked(profile); });
}
function writeDefaultRunnerProfileUnlocked(profile: RunnerProfile): void {
  mkdirSync(dirname(profilePath()), { recursive: true });
  const temporary = `${profilePath()}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, profilePath());
  chmodSync(profilePath(), 0o600);
}

export function updateWorkspaceRunnerProfile(path: string, profile: RunnerProfile): void {
  withProfileLock(() => { recoverProfileTransactionUnlocked(); updateWorkspaceRunnerProfileUnlocked(path, profile); });
}
function updateWorkspaceRunnerProfileUnlocked(path: string, profile: RunnerProfile): void {
  const absolute = resolve(path);
  const current = existsSync(absolute) ? JSON.parse(readFileSync(absolute, "utf8")) as GoahConfig : defaultConfig(dirname(absolute));
  current.runnerProfiles = [...(current.runnerProfiles ?? []).filter((item) => item.id !== profile.id), profile];
  current.profiles = (current.profiles ?? [{ agent: "ceo", role: "ceo" }, { agent: "worker", role: "child" }]).map((agent) => ({ ...agent, runnerProfile: agent.runnerProfile ?? profile.id }));
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`);
  renameSync(temporary, absolute);
}

/** Persist default + workspace profile with a crash-recoverable rollback journal. */
export function persistRunnerProfile(profile: RunnerProfile, workspacePath: string | null): void {
  withProfileLock(() => {
    recoverProfileTransactionUnlocked();
    const targets = [profilePath(), ...(workspacePath ? [resolve(workspacePath)] : [])];
    const before = targets.map((path) => ({ path, content: existsSync(path) ? readFileSync(path) : null }));
    writeProfileTransaction(before);
    try {
      writeDefaultRunnerProfileUnlocked(profile);
      if (workspacePath) updateWorkspaceRunnerProfileUnlocked(workspacePath, profile);
      rmSync(profileTransactionPath(), { force: true });
    } catch (error) {
      restoreProfileSnapshots(before);
      rmSync(profileTransactionPath(), { force: true });
      throw error;
    }
  });
}

function withProfileLock<T>(operation: () => T): T {
  const lock = `${profilePath()}.lock`; const ownerPath = join(lock, "owner.json"); const token = randomUUID(); mkdirSync(dirname(lock), { recursive: true });
  acquireProfileLock(lock, ownerPath, token);
  try { return operation(); }
  finally { if (readProfileLockOwner(ownerPath)?.token === token) rmSync(lock, { recursive: true, force: true }); }
}

function acquireProfileLock(lock: string, ownerPath: string, token: string): void {
  while (true) {
    try {
      mkdirSync(lock);
      try { writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token }), { mode: 0o600 }); } catch (error) { rmSync(lock, { recursive: true, force: true }); throw error; }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = readProfileLockOwner(ownerPath);
    let oldUnownedLock = false;
    try { oldUnownedLock = !owner && Date.now() - statSync(lock).mtimeMs > 5_000; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (owner && processIsAlive(owner.pid) || !owner && !oldUnownedLock) throw new Error("Another Goah process is updating Runner Profiles; try again.");
    const stale = `${lock}.stale.${token}`;
    try { renameSync(lock, stale); rmSync(stale, { recursive: true, force: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

type ProfileSnapshot = { path: string; content: Buffer | null };
function profileTransactionPath(): string { return join(dirname(profilePath()), "profile-transaction.json"); }
function writeProfileTransaction(snapshots: ProfileSnapshot[]): void {
  const path = profileTransactionPath(); const temporary = `${path}.${process.pid}.tmp`; mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ version: 1, snapshots: snapshots.map((snapshot) => ({ path: snapshot.path, content: snapshot.content?.toString("base64") ?? null })) })}\n`, { mode: 0o600 });
  renameSync(temporary, path); chmodSync(path, 0o600);
}
function restoreProfileSnapshots(snapshots: ProfileSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.content === null) rmSync(snapshot.path, { force: true });
    else { mkdirSync(dirname(snapshot.path), { recursive: true }); const temporary = `${snapshot.path}.${process.pid}.rollback.tmp`; writeFileSync(temporary, snapshot.content, snapshot.path === profilePath() ? { mode: 0o600 } : undefined); renameSync(temporary, snapshot.path); if (snapshot.path === profilePath()) chmodSync(snapshot.path, 0o600); }
  }
}
function recoverProfileTransaction(): void { if (existsSync(profileTransactionPath())) withProfileLock(recoverProfileTransactionUnlocked); }
function recoverProfileTransactionUnlocked(): void {
  const path = profileTransactionPath(); if (!existsSync(path)) return;
  const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; snapshots?: Array<{ path?: unknown; content?: unknown }> };
  if (value.version !== 1 || !Array.isArray(value.snapshots)) throw new Error("Goah Runner Profile transaction journal is invalid");
  const snapshots = value.snapshots.map((snapshot): ProfileSnapshot => {
    if (typeof snapshot.path !== "string" || snapshot.content !== null && typeof snapshot.content !== "string") throw new Error("Goah Runner Profile transaction journal is invalid");
    return { path: snapshot.path, content: snapshot.content === null ? null : Buffer.from(snapshot.content, "base64") };
  });
  restoreProfileSnapshots(snapshots); rmSync(path, { force: true });
}
function readProfileLockOwner(path: string): { pid: number; token: string } | null {
  try { const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; token?: unknown }; return Number.isInteger(value.pid) && Number(value.pid) > 0 && typeof value.token === "string" ? value as { pid: number; token: string } : null; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
}
function processIsAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }

export function diagnoseConfig(config: GoahConfig): { ok: boolean; checks: DoctorCheck[] } {
  const checks: DoctorCheck[] = [];
  const check = (name: string, fn: () => string): void => {
    try { checks.push({ name, ok: true, detail: fn() }); }
    catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  };
  check("node", () => {
    if (Number(process.versions.node.split(".")[0]) < 24) throw new Error(`Node ${process.versions.node} is unsupported; require >=24`);
    return process.versions.node;
  });
  check("root", () => {
    const root = configRoot(config);
    accessSync(root, constants.R_OK | constants.W_OK);
    return `${root} (runner-owned local execution)`;
  });
  check("state", () => {
    const existing = nearestExisting(config.stateDir);
    accessSync(existing, constants.W_OK);
    const database = join(config.stateDir, "ledger.sqlite");
    if (!existsSync(database)) return `${config.stateDir} (will create)`;
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version > SQLITE_SCHEMA_VERSION) throw new Error(`ledger schema ${version} is newer than supported schema ${SQLITE_SCHEMA_VERSION}`);
      if(version>0&&version<SQLITE_SCHEMA_VERSION)throw new Error(`ledger schema ${version} predates runtime schema ${SQLITE_SCHEMA_VERSION}; recreate this development workspace`);
      return `${database} (schema ${version})`;
    }
    finally { db.close(); }
  });
  check("runner", () => {
    if (config.runnerProfiles?.length) {
      for (const profile of config.runnerProfiles) runnerPlugin(profile.runner);
      return config.runnerProfiles.map((profile) => `${profile.id}:${profile.runner}`).join(", ");
    }
    if (!config.runner) throw new Error("no runner is configured");
    accessSync(config.runner.command, constants.X_OK);
    const workerArg = config.runner.args[0];
    if (workerArg && isAbsolute(workerArg)) accessSync(workerArg, constants.R_OK);
    const env = resolveEnvSpec(config.runner.env, { root: configRoot(config) });
    const provider = requiredEnv(env, "GOAH_PI_PROVIDER");
    const modelId = requiredEnv(env, "GOAH_PI_MODEL");
    const model = createPiModel(provider, modelId, env).model;
    return `${provider}/${modelId} context=${model.contextWindow} output=${model.maxTokens}; auth is checked when the wake starts`;
  });
  return { ok: checks.every((item) => item.ok || item.severity === "warning"), checks };
}

export function statusSnapshot(ledger: SqliteLedger): object {
  const events = ledger.events();
  const wakes = ledger.wakes().map((wake) => {
    const turn=wake.turnId?ledger.turn(wake.turnId):null;const turnEvents=turn?ledger.readStream(`turn:${turn.id}`):[];const tokensUsed=turnEvents.reduce((total,event)=>total+assistantTokens(event.data),0);return{...wake,tokensUsed,abnormalReason:turn?.status==="failed"?field(turn.error,"message"):null};
  });
  const goals = ledger.goals().map((goal) => ({ ...goal, evaluation: [...events].reverse().find((event) => event.streamId === `metric:${goal.id}` && event.type === "metric.evaluated")?.data ?? null }));
  const handoffs = events.filter((event) => event.type === "handoff.recorded").slice(-20).map((event) => ({ seq: event.seq, ts: event.ts, agent: event.actor, streamId: event.streamId, handoff: event.data }));
  const modelCapabilitiesByAgent=Object.fromEntries(ledger.threads().flatMap((thread)=>{const turnIds=new Set(ledger.turns(thread.id).map((turn)=>turn.id));const capability=[...events].reverse().find((event)=>event.type==="transcript.started"&&event.streamId.startsWith("turn:")&&turnIds.has(event.streamId.slice("turn:".length)))?.data;return capability?[[thread.agent,capability]]:[];}));const modelCapabilities=modelCapabilitiesByAgent.ceo??[...events].reverse().find((event)=>event.type==="transcript.started")?.data??null;
  return { seq: events.at(-1)?.seq ?? 0, threads: ledger.threads(), turns: ledger.turns().map((turn)=>({...turn,leaseToken:null})), goals, wakes, schedules:ledger.schedules(), modelCapabilities,modelCapabilitiesByAgent, recentHandoffs: handoffs };
}

function defaultModel(provider: string): string {
  if (provider === "faux") return "faux-goah";
  throw new Error(`--model is required for ${provider}; interactive setup discovers models through the selected Runner.`);
}
function legacyRunner(config: GoahConfig): ProcessRunner {
  if (!config.runner) throw new Error("no runner profiles are configured");
  const { env, ...spec } = config.runner;
  return new ProcessRunner({ ...spec, envSpec: env, cwd: configRoot(config) });
}
function requiredEnv(env: Record<string, string>, name: string): string { const value = env[name]; if (!value) throw new Error(`${name} is missing`); return value; }
function nearestExisting(path: string): string { let current = resolve(path); while (!existsSync(current)) { const parent = dirname(current); if (parent === current) break; current = parent; } return current; }
function defaultStateDir(directory: string): string {
  const id = createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 16);
  return join(process.env.GOAH_STATE_HOME ?? join(homedir(), ".goah", "state"), id);
}
function field(value: unknown, key: string): unknown { return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined; }
function assistantTokens(value: unknown): number {
  const message = field(value, "message");
  if (field(message, "role") !== "assistant") return 0;
  const usage = field(message, "usage");
  const total = field(usage, "totalTokens");
  return typeof total === "number" ? total : 0;
}
function resolveCommand(command: string): string { return command === "$NODE" ? process.execPath : command; }
function absolutePath(base: string, value: string): string { return isAbsolute(value) ? value : resolve(base, value); }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
export function configRoot(config: GoahConfig): string { return configRoots.get(config) ?? process.cwd(); }
export { exportThread, listThreads, redactValue, replayThread, showThread, showTurnContext, streamEvents } from "./thread-inspect.js";
export { controlAvailable, controlEndpoint, requestControl, runControlServer, streamControl, type ControlFrame, type ControlRequest } from "./control.js";
export { consoleMetadataPath, consoleSnapshot, organizationTrajectory, readConsoleMetadata, runWebConsole, type ConsoleMetadata, type TrajectoryItem, type TrajectoryPage } from "./web-console.js";
export type { TurnContextSnapshot, ThreadDetail, ThreadExport, ThreadListItem } from "./thread-inspect.js";
export { CONTRACT_VERSION };
