/**
 * Live config mutation: edit goah.config.json in place, then ask the resident
 * daemon to reload (config.reload swaps the runner; spawn-time env resolution
 * applies new values to the next wake).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { requestControl } from "./control.js";

interface RunnerEnv { GOAH_PI_PROVIDER?: string; GOAH_PI_MODEL?: string; [key: string]: string | undefined }

export function readRunnerEnv(configPath: string): RunnerEnv {
  const config = JSON.parse(readFileSync(resolve(configPath), "utf8")) as { runner?: { env?: RunnerEnv } };
  return config.runner?.env ?? {};
}

function writeRunnerEnv(configPath: string, env: RunnerEnv): void {
  const config = JSON.parse(readFileSync(resolve(configPath), "utf8")) as { runner: { env?: RunnerEnv } };
  config.runner.env = env;
  writeFileSync(resolve(configPath), `${JSON.stringify(config, null, 2)}\n`);
}

/** Switch the model for this workspace and reload the daemon. Returns the reload outcome. */
export async function switchModel(configPath: string, stateDir: string, model: string): Promise<string> {
  const env = readRunnerEnv(configPath);
  if (!model.trim()) throw new Error("model id is required");
  writeRunnerEnv(configPath, { ...env, GOAH_PI_MODEL: model.trim() });
  const outcome = await requestControl(stateDir, { op: "config.reload", configPath: resolve(configPath) }).catch((error: unknown) => ({ reloaded: false, error: error instanceof Error ? error.message : String(error) }));
  const reloaded = Boolean((outcome as { reloaded?: boolean }).reloaded);
  return reloaded ? `model switched to ${model.trim()} — applies to the next wake` : `model written to ${resolve(configPath)}; daemon reload failed (${String((outcome as { error?: string }).error ?? "daemon not running")}), it will pick up on next start`;
}

/** Reload the daemon config after an external edit (e.g. the setup wizard rewrote it). */
export async function reloadDaemon(stateDir: string, configPath: string): Promise<boolean> {
  const outcome = await requestControl(stateDir, { op: "config.reload", configPath: resolve(configPath) }).catch(() => null);
  return Boolean((outcome as { reloaded?: boolean } | null)?.reloaded);
}
