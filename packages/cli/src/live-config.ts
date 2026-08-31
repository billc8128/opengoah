/**
 * Live config mutation: edit goah.config.json in place, then ask the resident
 * daemon to reload (config.reload swaps the runner; spawn-time env resolution
 * applies new values to the next wake).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { requestControl } from "./control.js";
import type { RunnerSetupInteraction } from "goah-ledger-contract";
import { loadConfig, persistRunnerProfile } from "./index.js";
import { runnerPlugin } from "./runner-registry.js";

export interface RunnerDisplay {
  runner: string;
  target: string;
}

export function readRunnerDisplay(configPath: string): RunnerDisplay {
  const config = JSON.parse(readFileSync(resolve(configPath), "utf8")) as {
    runnerProfiles?: Array<{ id: string; runner: string; config: Record<string, unknown> }>;
  };
  const profile =
    config.runnerProfiles?.find((item) => item.id === "default") ?? config.runnerProfiles?.[0];
  if (!profile) return { runner: "legacy", target: "configured" };
  const target =
    typeof profile.config.provider === "string" && typeof profile.config.model === "string"
      ? `${profile.config.provider}/${profile.config.model}`
      : profile.id;
  return { runner: profile.runner, target };
}

/** Switch the model for this workspace and reload the daemon. Returns the reload outcome. */
export async function switchModel(
  configPath: string,
  stateDir: string,
  model: string,
): Promise<string> {
  if (!model.trim()) throw new Error("model id is required");
  const config = loadConfig(configPath);
  const profile =
    config.runnerProfiles?.find((item) => item.id === "default") ?? config.runnerProfiles?.[0];
  if (!profile) throw new Error("no Runner Profile is configured");
  const plugin = runnerPlugin(profile.runner);
  if (!plugin.configurator.runCommand)
    throw new Error(`${profile.runner} does not support model switching`);
  const interaction: RunnerSetupInteraction = {
    select: async () => null,
    input: async () => null,
    notify: () => undefined,
  };
  const result = await plugin.configurator.runCommand(
    "model",
    [model.trim()],
    profile.config,
    interaction,
  );
  if (result.config === undefined)
    throw new Error(`${profile.runner} did not return an updated configuration`);
  persistRunnerProfile({ ...profile, config: result.config }, configPath);
  const outcome = await requestControl(stateDir, {
    op: "config.reload",
    configPath: resolve(configPath),
  }).catch((error: unknown) => ({
    reloaded: false,
    error: error instanceof Error ? error.message : String(error),
  }));
  const reloaded = Boolean((outcome as { reloaded?: boolean }).reloaded);
  return reloaded
    ? result.output.join("\n")
    : `${result.output.join("\n")}; daemon reload failed (${String((outcome as { error?: string }).error ?? "daemon not running")}), it will apply on next start`;
}

/** Reload the daemon config after an external edit (e.g. the setup wizard rewrote it). */
export async function reloadDaemon(stateDir: string, configPath: string): Promise<boolean> {
  const outcome = await requestControl(stateDir, {
    op: "config.reload",
    configPath: resolve(configPath),
  }).catch(() => null);
  return Boolean((outcome as { reloaded?: boolean } | null)?.reloaded);
}
