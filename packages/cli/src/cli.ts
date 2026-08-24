#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { runGoahTui } from "./tui.js";
import { runSetupWizard, applyWizardResult } from "./setup-wizard.js";
import { memoryStream, type JsonValue, type RunnerCommandResult, type RunnerProfile, type RunnerSetupInteraction } from "goah-ledger-contract";
import { controlAvailable, createRuntime, diagnoseConfig, exportSession, listSessions, loadConfig, readConsoleMetadata, readDefaultRunnerProfile, replayWakeSession, requestControl, runControlServer, runWebConsole, showSession, showSessionContext, statusSnapshot, streamControl, streamEvents, SupervisorLock, updateWorkspaceRunnerProfile, writeDefaultConfig, writeDefaultRunnerProfile, type ConsoleMetadata, type ControlFrame, type ControlRequest, type GoahConfig } from "./index.js";
import { runnerPlugin } from "./runner-registry.js";
import { stdioQueue } from "./prompt-queue.js";
import { runUpdate } from "./update.js";
const args = normalizeArgs(process.argv.slice(2));

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const rawCommand = args[0];
  if (["help", "--help", "-h"].includes(rawCommand ?? "")) { printHelp(); return; }
  if (["version", "--version", "-V"].includes(rawCommand ?? "")) { console.log(packageVersion()); return; }
  if (rawCommand === "update") { await runUpdate({ check: flag("--check"), dryRun: flag("--dry-run"), ...(option("--version") ? { target: option("--version")! } : {}) }); return; }
  const typo = rawCommand && !rawCommand.startsWith("-") && !knownCommand(rawCommand) ? closestCommand(rawCommand) : null;
  if (typo && args.length === 1 && !rawCommand!.includes(" ")) throw new Error(`Unknown command "${rawCommand}". Did you mean "goah ${typo}"? Use "goah goal start --objective …" to start a goal explicitly.`);
  const interactive = rawCommand === undefined || rawCommand === "--continue" || Boolean(rawCommand && !rawCommand.startsWith("-") && !knownCommand(rawCommand));
  const command = interactive ? "interactive" : rawCommand!;
  const initialMessage = interactive && rawCommand && rawCommand !== "--continue" ? args.filter((value) => !value.startsWith("--")).join(" ") : null;
  const configPath = option("--config") ?? "goah.config.json";
  if (command === "setup") {
    const result = await runSetupWizard();
    if (!result.profile) { console.log("Setup cancelled; nothing changed."); return; }
    applyWizardResult(result, existsSync(configPath) ? configPath : null);
    console.log(`Profile saved to ~/.goah/profile.json${existsSync(configPath) ? " and this workspace was updated" : " (run \`goah\` in any directory to create a workspace)"}`);
    return;
  }
  if (command === "auth" || command === "model") { await runRunnerCommand(command, args.slice(1), configPath); return; }
  if (command === "runner" && ["list", "setup"].includes(args[1] ?? "list")) { await runRunnerEarly(configPath); return; }
  if (command === "init") {
    const provider = providerOption(option("--provider") ?? "faux");
    writeDefaultConfig(configPath, {
      provider,
      ...(option("--model") ? { model: option("--model")! } : {}),
      ...(option("--api-key-env") ? { apiKeyEnv: option("--api-key-env")! } : {}),
      ...(option("--agent") ? { agent: option("--agent")! } : {}),
      ...(option("--context-window-tokens") ? { contextWindowTokens: numberOption("--context-window-tokens") } : {}),
      ...(option("--max-output-tokens") ? { maxOutputTokensPerTurn: numberOption("--max-output-tokens") } : {}),
      ...(option("--base-url") ? { baseUrl: option("--base-url")! } : {}),
    });
    console.log(JSON.stringify({ created: configPath, provider }, null, 2));
    return;
  }

  const config: GoahConfig = command === "interactive"
    ? (existsSync(configPath) || (await bootstrapWorkspace(configPath), true), loadConfig(configPath))
    : (() => {
      if (!existsSync(configPath)) throw new Error(`no Goah workspace here (missing goah.config.json); run \`goah\` to create one interactively, or \`goah init\` for flag-based setup`);
      return loadConfig(configPath);
    })();
  if (command === "runner") { await runRunnerManagement(config, configPath); return; }
  if (command === "daemon") { await runDaemonCommand(config, configPath); return; }
  if (command === "doctor") {
    const result = diagnoseConfig(config);
    const runnerChecks = await diagnoseRunnerProfiles(config, configPath);
    const checks = [...result.checks, ...runnerChecks];
    const ok = checks.every((item) => item.ok);
    if (flag("--json")) console.log(JSON.stringify({ ok, checks }, null, 2));
    else for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    if (!ok) process.exitCode = 1;
    return;
  }

  if (command === "web") {
    await ensureDaemon(configPath, config.stateDir);
    const metadata = await waitForConsole(config.stateDir);
    if (flag("--open")) openUrl(metadata.url);
    console.log(metadata.url);
    return;
  }

  if (command === "interactive") { await runGoahTui(configPath, config.stateDir, initialMessage); return; }
  if (command !== "start" && await controlAvailable(config.stateDir)) {
    const request = remoteRequest(command);
    if (request) { console.log(JSON.stringify(await requestControl(config.stateDir, request), null, 2)); return; }
  }

  const lock = mutates(command) ? new SupervisorLock(config.stateDir) : null;
  lock?.acquire();
  let runtime: ReturnType<typeof createRuntime> | null = null;
  try {
    runtime = createRuntime(config);
    const { ledger, supervisor } = runtime;
    if (command === "start") {
      const controller = new AbortController();
      const stop = () => controller.abort(); process.on("SIGINT", stop); process.on("SIGTERM", stop);
      await Promise.all([
        run(supervisor, controller.signal),
        runControlServer(supervisor, ledger, config.stateDir, controller.signal, {
          stop: () => controller.abort(),
          reloadRuntime: async (path) => {
            const replacement = createRuntime(loadConfig(path));
            const runner = replacement.supervisor.runner;
            const profiles = loadConfig(path).runnerProfiles;
            replacement.ledger.close();
            return { runner, ...(profiles ? { profiles } : {}) };
          },
        }),
        runWebConsole(supervisor, ledger, config.stateDir, controller.signal, { onListening: ({ url }) => console.log(`Goah Console: ${url}`) }),
      ]);
    } else if (command === "run-once") {
      await supervisor.recover();
      console.log(JSON.stringify({ wake: await supervisor.tick() }, null, 2));
    } else if (command === "wake") {
      const agent = requiredPositional(1, "agent");
      const wake = supervisor.planWake(agent, new Date().toISOString(), option("--reason") ?? "manual wake", "supervisor");
      console.log(JSON.stringify({ wake }, null, 2));
    } else if (command === "status") {
      console.log(JSON.stringify(statusSnapshot(ledger), null, 2));
    } else if (command === "goal-start") {
      console.log(JSON.stringify(supervisor.startGoal(required("--objective"), option("--id") ?? undefined), null, 2));
    } else if (command === "ceo-send") {
      console.log(JSON.stringify(supervisor.sendToCeo({ message: required("--message") }, "decision"), null, 2));
    } else if (command === "ceo-status") {
      console.log(JSON.stringify({
        roots: ledger.goals().filter((goal) => goal.parentId === null && goal.owner === "ceo"),
        team: supervisor.teamList(),
        pendingHuman: ledger.unreadMail("human"),
        recentCeoHandoffs: ledger.eventsSince(0, ["handoff.recorded"]).filter((event) => event.actor === "ceo").slice(-10),
      }, null, 2));
    } else if (command === "ceo-inbox") {
      console.log(JSON.stringify(ledger.unreadMail("human"), null, 2));
    } else if (command === "session") {
      const subcommand = requiredPositional(1, "session command");
      if (subcommand === "list") console.log(JSON.stringify(listSessions(ledger), null, 2));
      else {
        const wakeId = requiredPositional(2, "wake id");
        if (subcommand === "show") console.log(JSON.stringify(showSession(ledger, wakeId), null, 2));
        else if (subcommand === "replay") console.log(JSON.stringify(replayWakeSession(ledger, wakeId), null, 2));
        else if (subcommand === "export") {
          const output = option("--output") ?? `${wakeId}.session.json`;
          writeFileSync(output, `${JSON.stringify(exportSession(ledger, wakeId, { raw: flag("--raw") }), null, 2)}\n`);
          console.log(JSON.stringify({ output, redacted: !flag("--raw") }, null, 2));
        } else throw new Error(`unknown session command: ${subcommand}`);
      }
    } else if (command === "context") {
      if (requiredPositional(1, "context command") !== "show") throw new Error("unknown context command");
      console.log(JSON.stringify(showSessionContext(ledger, requiredPositional(2, "wake id")), null, 2));
    } else if (command === "events") {
      console.log(JSON.stringify(streamEvents(ledger, required("--stream"), option("--from") ? numberOption("--from") : 1), null, 2));
    } else if (command === "memory") {
      const tail = option("--tail") ? numberOption("--tail") : 50;
      const notes = ledger.readStream(memoryStream(requiredPositional(1, "agent"))).filter((event) => event.type === "memory.appended").slice(-tail);
      console.log(JSON.stringify(notes.map((event) => ({ seq: event.seq, ts: event.ts, note: (event.data as { note?: unknown }).note ?? null, wakeId: (event.data as { wakeId?: unknown }).wakeId ?? null })), null, 2));
    } else if (command === "goal-list") console.log(JSON.stringify(ledger.goals(), null, 2));
    else if (command === "goal-show") {
      const goal = ledger.goal(requiredPositional(1, "goal id"));
      if (!goal) throw new Error("goal not found");
      console.log(JSON.stringify({ goal }, null, 2));
    }
    else if (command === "goal-create") {
      const id = required("--id"); const owner = required("--owner"); const objective = required("--objective");
      const parentId = option("--parent");
      const goal = { id, parentId, objective, observationMethod: option("--observation-method"), owner, phase: "active" as const, revision: 0 };
      supervisor.createGoal(goal, option("--actor") ?? "human");
      const wake = flag("--wake-now") ? supervisor.planWake(owner, new Date().toISOString(), `goal:${id}`, "supervisor") : null;
      console.log(JSON.stringify({ goal, wake }, null, 2));
    } else if (command === "goal-update") {
      const objective = option("--objective"); const observationMethod = option("--observation-method"); const owner = option("--owner");
      const goal = supervisor.updateGoal(requiredPositional(1, "goal id"), { ...(objective ? { objective } : {}), ...(observationMethod ? { observationMethod } : {}), ...(owner ? { owner } : {}) }, option("--actor") ?? "human");
      console.log(JSON.stringify({ goal }, null, 2));
    } else if (["goal-pause", "goal-resume", "goal-complete"].includes(command)) {
      const id = requiredPositional(1, "goal id");
      const goal = command === "goal-complete"
        ? supervisor.completeGoal({ goalId: id, revision: ledger.goal(id)?.revision ?? -1, reason: required("--reason"), evidence: evidence() }, option("--actor") ?? "human")
        : supervisor.transitionGoal(id, command === "goal-pause" ? "paused" : "active", option("--actor") ?? "human");
      console.log(JSON.stringify({ goal }, null, 2));
    } else if (command === "action-list") console.log(JSON.stringify(ledger.actions(), null, 2));
    else if (command === "approve" || command === "ceo-approve") console.log(JSON.stringify(await supervisor.approveAction(requiredPositional(1, "action id"), option("--actor") ?? "human", required("--reason"), evidence()), null, 2));
    else if (command === "reject") console.log(JSON.stringify(supervisor.rejectAction(requiredPositional(1, "action id"), option("--actor") ?? "human", required("--reason"), evidence()), null, 2));
    else if (command === "dashboard") { const path = option("--output") ?? join(config.stateDir, "status.html"); writeFileSync(path, (await import("goah-supervisor")).renderDashboard(ledger)); console.log(path); }
    else throw new Error(`unknown command: ${command}`);
  } finally {
    runtime?.ledger.close();
    lock?.release();
  }
}

async function run(supervisor: ReturnType<typeof createRuntime>["supervisor"], signal: AbortSignal): Promise<void> {
  const { runSupervisorDaemon } = await import("goah-supervisor");
  await runSupervisorDaemon(supervisor, { signal });
}

async function waitForConsole(stateDir: string): Promise<ConsoleMetadata> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const metadata = readConsoleMetadata(stateDir);
    if (metadata) return metadata;
    const { promise: tick, resolve: resolveWait } = Promise.withResolvers<void>();
    setTimeout(resolveWait, 100);
    await tick;
  }
  throw new Error("Goah Console did not start; restart the resident Supervisor");
}
async function ensureDaemon(configPath: string, stateDir: string): Promise<void> {
  if (await controlAvailable(stateDir)) return;
  mkdirSync(stateDir, { recursive: true });
  const log = openSync(join(stateDir, "daemon.log"), "a");
  const child = spawn(process.execPath, [process.argv[1]!, "start", "--config", resolve(configPath)], { cwd: process.cwd(), detached: true, stdio: ["ignore", log, log], env: process.env });
  closeSync(log);
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await controlAvailable(stateDir)) return;
    const { promise: tick, resolve: resolveWait } = Promise.withResolvers<void>();
    setTimeout(resolveWait, 100);
    await tick;
  }
  throw new Error("Goah Supervisor did not start; run `goah doctor` and inspect the configured provider credentials");
}

function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}


function remoteRequest(command: string): ControlRequest | null {
  if (command === "status") return { op: "status" };
  if (command === "goal-start") return { op: "goal.start", objective: required("--objective"), ...(option("--id") ? { id: option("--id")! } : {}) };
  if (command === "goal-update") return { op: "goal.update", id: requiredPositional(1, "goal id"), ...(option("--objective") ? { objective: option("--objective")! } : {}), ...(option("--observation-method") ? { observationMethod: option("--observation-method")! } : {}), ...(option("--owner") ? { owner: option("--owner")! } : {}) };
  if (command === "goal-pause" || command === "goal-resume") return { op: "goal.transition", id: requiredPositional(1, "goal id"), phase: command === "goal-pause" ? "paused" : "active" };
  if (command === "goal-complete") return { op: "goal.complete", id: requiredPositional(1, "goal id"), reason: required("--reason"), evidence: evidence() };
  if (command === "ceo-send") return { op: "ceo.send", message: required("--message") };
  if (command === "ceo-status") return { op: "ceo.status" };
  if (command === "ceo-inbox") return { op: "ceo.inbox" };
  if (command === "approve" || command === "ceo-approve") return { op: "action.approve", id: requiredPositional(1, "action id"), reason: required("--reason"), evidence: evidence() };
  if (command === "reject") return { op: "action.reject", id: requiredPositional(1, "action id"), reason: required("--reason"), evidence: evidence() };
  return null;
}

function printHelp(): void {
  console.log(`goah ["OBJECTIVE"] | goah --continue
goah setup
goah update [--check] [--dry-run] [--version VERSION]
goah runner list|setup|status|doctor|profile
goah auth list|status|login PROVIDER|logout PROVIDER
goah model list [PROVIDER]
goah init [--provider ID] [--model ID]
goah doctor
goah daemon status|logs|restart|stop
goah web [--open]
goah goal start --objective TEXT [--id ID]
goah ceo send --message TEXT
goah ceo status | ceo inbox
goah ceo approve ACTION_ID --reason TEXT --evidence SEQ[,SEQ]
goah goal-create --id ID --owner AGENT --objective TEXT [--observation-method TEXT] [--wake-now]
goah goal-show ID | goal-list
goah goal-update ID [--objective TEXT] [--observation-method TEXT] [--owner AGENT] [--actor ACTOR]
goah goal-pause|goal-resume ID [--actor ACTOR]
goah goal-complete ID --reason TEXT --evidence SEQ[,SEQ] [--actor ACTOR]
goah wake AGENT [--reason TEXT]
goah run-once
goah session list
goah session show|replay|export WAKE_ID [--output FILE] [--raw]
goah context show WAKE_ID
goah events --stream STREAM_ID [--from N]
goah memory AGENT [--tail N]
goah start | web [--open] | status | goal-list | action-list | approve | reject | dashboard
Runner file and Git operations execute locally under the directory containing goah.config.json.`);
}
function option(name: string): string | null { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? null : null; }
function flag(name: string): boolean { return args.includes(name); }
function required(name: string): string { const value = option(name); if (!value) throw new Error(`${name} is required`); return value; }
function numberOption(name: string): number { const value = Number(required(name)); if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`); return value; }
function requiredPositional(index: number, label: string): string {
  const positional: string[] = [];
  const flags = new Set(["--wake-now", "--raw"]);
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    const value = args[cursor]!;
    if (!value.startsWith("--")) { positional.push(value); continue; }
    if (!flags.has(value)) cursor += 1;
  }
  const value = positional[index];
  if (!value) throw new Error(`${label} is required`);
  return value;
}
function evidence(): number[] { return required("--evidence").split(",").map(Number); }
function providerOption(value: string): string {
  return value.trim();
}
function mutates(command: string): boolean { return ["start", "run-once", "wake", "goal-start", "ceo-send", "ceo-approve", "goal-create", "goal-update", "goal-pause", "goal-resume", "goal-complete", "approve", "reject"].includes(command); }
function normalizeArgs(values: string[]): string[] {
  if ((values[0] === "goal" || values[0] === "ceo") && values[1] && !values[1].startsWith("--")) return [`${values[0]}-${values[1]}`, ...values.slice(2)];
  return values;
}
function knownCommand(value: string): boolean { return ["setup", "help", "version", "update", "runner", "daemon", "auth", "model", "init", "doctor", "web", "start", "run-once", "wake", "status", "session", "context", "events", "memory", "goal-list", "goal-show", "goal-create", "goal-update", "goal-pause", "goal-resume", "goal-complete", "goal-start", "ceo-send", "ceo-status", "ceo-inbox", "ceo-approve", "action-list", "approve", "reject", "dashboard"].includes(value); }
function asRecord(value: JsonValue): Record<string, JsonValue> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object"); return value; }
function firstRecord(value: JsonValue | undefined): Record<string, JsonValue> | null { return Array.isArray(value) && value[0] && typeof value[0] === "object" && !Array.isArray(value[0]) ? value[0] : null; }
function messageText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => item && typeof item === "object" && !Array.isArray(item) && item.type === "text" && typeof item.text === "string" ? item.text : "").filter(Boolean).join("\n");
}

/** Interactive entry bootstrap: first-use setup wizard (or stored profile), then materialize this directory's workspace config. */
async function bootstrapWorkspace(configPath: string): Promise<void> {
  let profile = readDefaultRunnerProfile();
  if (!profile) {
    console.log(profile ? "Your Goah setup is incomplete — resuming setup now." : "No Goah profile found — running first-use setup.");
    const result = await runSetupWizard();
    if (!result.profile) throw new Error("Setup cancelled; no workspace was created.");
    applyWizardResult(result, null);
    profile = result.profile;
  }
  updateWorkspaceRunnerProfile(configPath, profile);
  console.log(`Created ${resolve(configPath)} — this directory is now a Goah workspace.`);
}

async function runRunnerCommand(command: string, commandArgs: string[], configPath: string): Promise<void> {
  const workspace = existsSync(configPath) ? loadConfig(configPath) : null;
  const profile = workspace?.runnerProfiles?.find((item) => item.id === "default") ?? workspace?.runnerProfiles?.[0] ?? readDefaultRunnerProfile();
  if (!profile) throw new Error("No Runner Profile is configured; run `goah setup` first.");
  const plugin = runnerPlugin(profile.runner);
  if (!plugin.configurator.runCommand) throw new Error(`${profile.runner} does not expose runner commands.`);
  const interaction = stdioInteraction();
  let result: RunnerCommandResult;
  try { result = await plugin.configurator.runCommand(command, commandArgs, profile.config, interaction); }
  finally { interaction.close(); }
  for (const line of result.output) console.log(line);
  if (result.config !== undefined) {
    const updated: RunnerProfile = { ...profile, config: result.config };
    writeDefaultRunnerProfile(updated);
    if (workspace) updateWorkspaceRunnerProfile(configPath, updated);
  }
}

async function runRunnerEarly(configPath: string): Promise<void> {
  const action = args[1] ?? "list";
  if (action === "list") { for (const manifest of (await import("./runner-registry.js")).runnerManifests()) console.log(`${manifest.id.padEnd(16)} ${manifest.description}`); return; }
  const profileId = args[2] ?? "default";
  if (!existsSync(configPath) && profileId !== "default") throw new Error("Named Runner Profiles require a Goah workspace.");
  const current = existsSync(configPath) ? loadConfig(configPath).runnerProfiles?.find((item) => item.id === profileId) ?? null : readDefaultRunnerProfile();
  const result = await runSetupWizard(current);
  if (!result.profile) { console.log("Runner setup cancelled; nothing changed."); return; }
  const profile = { ...result.profile, id: profileId };
  if (profileId === "default") writeDefaultRunnerProfile(profile);
  if (existsSync(configPath)) updateWorkspaceRunnerProfile(configPath, profile);
  console.log(`Saved Runner Profile ${profile.id} (${profile.runner}).`);
}

async function runRunnerManagement(config: GoahConfig, configPath: string): Promise<void> {
  const action = args[1] ?? "status";
  if (action === "status") {
    for (const profile of config.runnerProfiles ?? []) {
      const checks = await runnerPlugin(profile.runner).configurator.doctor(profile.config, { root: process.cwd() });
      console.log(`${profile.id} · ${profile.runner}`);
      for (const check of checks) console.log(`  ${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    }
    return;
  }
  if (action === "doctor") {
    const checks = await diagnoseRunnerProfiles(config, configPath);
    for (const check of checks) console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }
  if (action === "profile") {
    const subcommand = args[2] ?? "list";
    if (subcommand === "list") {
      for (const profile of config.runnerProfiles ?? []) {
        const agents = (config.profiles ?? []).filter((agent) => agent.runnerProfile === profile.id).map((agent) => agent.agent);
        console.log(`${profile.id.padEnd(18)} ${profile.runner.padEnd(12)} agents=${agents.join(",") || "none"}`);
      }
      return;
    }
    if (subcommand === "assign") {
      const agent = args[3]; const profileId = args[4];
      if (!agent || !profileId) throw new Error("usage: goah runner profile assign AGENT PROFILE");
      if (!config.runnerProfiles?.some((profile) => profile.id === profileId)) throw new Error(`Runner Profile not found: ${profileId}`);
      const raw = JSON.parse(readFileSync(resolve(configPath), "utf8")) as GoahConfig;
      const target = raw.profiles?.find((profile) => profile.agent === agent);
      if (!target) throw new Error(`Agent profile not found: ${agent}`);
      target.runnerProfile = profileId;
      writeFileSync(resolve(configPath), `${JSON.stringify(raw, null, 2)}\n`);
      console.log(`${agent} now uses Runner Profile ${profileId}.`);
      return;
    }
    throw new Error(`Unknown runner profile command: ${subcommand}`);
  }
  throw new Error(`Unknown runner command: ${action}`);
}

async function diagnoseRunnerProfiles(config: GoahConfig, configPath = "goah.config.json"): Promise<Array<{ ok: boolean; name: string; detail: string }>> {
  const checks: Array<{ ok: boolean; name: string; detail: string }> = [];
  for (const profile of config.runnerProfiles ?? []) {
    try {
      for (const check of await runnerPlugin(profile.runner).configurator.doctor(profile.config, { root: resolve(configPath, "..") })) checks.push({ ...check, name: `runner:${profile.id}:${check.name}` });
    } catch (error) { checks.push({ ok: false, name: `runner:${profile.id}`, detail: error instanceof Error ? error.message : String(error) }); }
  }
  return checks;
}

async function runDaemonCommand(config: GoahConfig, configPath: string): Promise<void> {
  const action = args[1] ?? "status";
  if (action === "status") {
    const running = await controlAvailable(config.stateDir);
    const metadata = readConsoleMetadata(config.stateDir);
    console.log(running ? `running${metadata ? ` · pid ${metadata.pid} · ${metadata.url}` : ""}` : "stopped");
    return;
  }
  if (action === "logs") {
    const path = join(config.stateDir, "daemon.log");
    if (!existsSync(path)) { console.log(`No daemon log at ${path}`); return; }
    console.log(readFileSync(path, "utf8").split("\n").slice(-100).join("\n"));
    return;
  }
  if (action === "stop" || action === "restart") {
    if (await controlAvailable(config.stateDir)) await requestControl(config.stateDir, { op: "daemon.stop" });
    const deadline = Date.now() + 5_000;
    while (await controlAvailable(config.stateDir) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    if (action === "stop") { console.log("Goah daemon stopped."); return; }
    await ensureDaemon(configPath, config.stateDir);
    console.log("Goah daemon restarted.");
    return;
  }
  throw new Error(`Unknown daemon command: ${action}`);
}

function stdioInteraction(): RunnerSetupInteraction & { close(): void } {
  const ask = stdioQueue();
  return {
    select: async ({ title, choices }) => { const answer = Number(await ask(`${title}: ${choices.map((choice, index) => `${index + 1}) ${choice.label}`).join("  ")} — select: `)); return choices[answer - 1]?.value ?? null; },
    input: async ({ prompt, initial }) => (await ask(`${prompt}${initial ? ` (${initial})` : ""}: `)) || initial || null,
    notify: (message) => console.log(message),
    openUrl,
    close: ask.close,
  };
}

function packageVersion(): string { return (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version; }
function closestCommand(value: string): string | null {
  let best: { command: string; distance: number } | null = null;
  for (const command of ["setup", "help", "auth", "model", "doctor", "web", "start", "status", "session", "context", "events", "memory", "goal", "ceo", "approve", "reject", "dashboard"]) {
    const distance = editDistance(value, command);
    if (!best || distance < best.distance) best = { command, distance };
  }
  return best && best.distance <= 2 ? best.command : null;
}
function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let previous = row[0]!; row[0] = i;
    for (let j = 1; j <= right.length; j += 1) { const saved = row[j]!; row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (left[i - 1] === right[j - 1] ? 0 : 1)); previous = saved; }
  }
  return row[right.length]!;
}
