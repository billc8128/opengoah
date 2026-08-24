import type { JsonValue, Runner, RunnerConfigurator, RunnerManifest } from "goah-ledger-contract";
import { createPiProcessRunner, piRunnerConfigurator } from "goah-runner-pi";

export interface RunnerPlugin {
  configurator: RunnerConfigurator;
  create(config: JsonValue, root: string): Runner;
}

const plugins = new Map<string, RunnerPlugin>([
  ["pi", { configurator: piRunnerConfigurator(), create: createPiProcessRunner }],
]);

export function runnerPlugin(id: string): RunnerPlugin {
  const plugin = plugins.get(id);
  if (!plugin) throw new Error(`Runner is not installed: ${id}`);
  return plugin;
}

export function runnerManifests(): RunnerManifest[] { return [...plugins.values()].map((plugin) => plugin.configurator.describe()); }
