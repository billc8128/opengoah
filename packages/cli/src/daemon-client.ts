import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { controlAvailable, requestControl } from "./control.js";
import { installedVersion } from "./update.js";

export interface EnsureDaemonOptions {
  entryPath?: string;
  startupTimeoutMs?: number;
  cwd?: string;
}
export async function ensureDaemon(
  configPath: string,
  stateDir: string,
  options: EnsureDaemonOptions = {},
): Promise<void> {
  if (await controlAvailable(stateDir)) {
    const version = await requestControl(stateDir, { op: "daemon.version" }).catch(() => null);
    if (version === installedVersion()) return;
    await requestControl(stateDir, { op: "daemon.stop" }).catch(() => undefined);
    const deadline = Date.now() + 5_000;
    while ((await controlAvailable(stateDir)) && Date.now() < deadline) await delay(50);
    if (await controlAvailable(stateDir))
      throw new Error("Existing Goah Supervisor did not stop; refusing to start a second daemon");
  }
  mkdirSync(stateDir, { recursive: true });
  const log = openSync(join(stateDir, "daemon.log"), "a");
  let child: ChildProcess;
  try {
    child = spawn(
      process.execPath,
      [options.entryPath ?? process.argv[1]!, "start", "--config", resolve(configPath)],
      {
        cwd: options.cwd ?? process.cwd(),
        detached: true,
        stdio: ["ignore", log, log],
        env: process.env,
      },
    );
  } finally {
    closeSync(log);
  }
  let spawnError: Error | null = null;
  child.once("error", (error) => {
    spawnError = error;
  });
  const deadline = Date.now() + (options.startupTimeoutMs ?? 10_000);
  try {
    while (Date.now() < deadline) {
      if (await controlAvailable(stateDir)) {
        child.unref();
        return;
      }
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(
          `Goah Supervisor exited during startup (${child.exitCode ?? child.signalCode})`,
        );
      await delay(100);
    }
    throw new Error(
      "Goah Supervisor did not start; run `goah doctor` and inspect the configured provider credentials",
    );
  } catch (error) {
    await terminateStartedDaemon(child);
    throw error;
  }
}

export async function terminateStartedDaemon(child: ChildProcess, graceMs = 500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  signalChild(child, "SIGTERM");
  const close = new Promise<boolean>((resolveClose) =>
    child.once("close", () => resolveClose(true)),
  );
  const closed = await Promise.race([close, delay(graceMs).then(() => false)]);
  if (!closed && child.exitCode === null && child.signalCode === null) {
    signalChild(child, "SIGKILL");
    await Promise.race([close, delay(graceMs)]);
  }
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}
function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
