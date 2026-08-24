/** Generic Runner setup. Provider/model semantics remain inside each Runner plugin. */
import { spawn } from "node:child_process";
import { Input, ProcessTerminal, SelectList, Text, TUI, type Component, type SelectItem, type SelectListTheme } from "@mariozechner/pi-tui";
import type { JsonValue, RunnerProfile, RunnerSetupInteraction } from "goah-ledger-contract";
import { readDefaultRunnerProfile, updateWorkspaceRunnerProfile, writeDefaultRunnerProfile } from "./index.js";
import { stdioQueue } from "./prompt-queue.js";
import { runnerManifests, runnerPlugin } from "./runner-registry.js";

export interface WizardResult { profile: RunnerProfile | null }

const theme: SelectListTheme = {
  selectedPrefix: (text) => `\x1b[36m❯\x1b[0m ${text}`,
  selectedText: (text) => `\x1b[1m${text}\x1b[22m`,
  description: (text) => `\x1b[2m${text}\x1b[22m`,
  scrollInfo: (text) => `\x1b[2m${text}\x1b[22m`,
  noMatch: (text) => `\x1b[2m${text}\x1b[22m`,
};

export async function runSetupWizard(current: RunnerProfile | null = readDefaultRunnerProfile()): Promise<WizardResult> {
  return process.stdin.isTTY && process.stdout.isTTY ? runTui(current) : runPiped(current);
}

async function runTui(current: RunnerProfile | null): Promise<WizardResult> {
  const tui = new TUI(new ProcessTerminal());
  const header = new Text("");
  let slot: Component | null = null;
  const replace = (component: Component): void => { if (slot) tui.removeChild(slot); slot = component; tui.addChild(component); tui.setFocus(component); tui.requestRender(); };
  const setHeader = (title: string, description = ""): void => { header.setText(["", `\x1b[1m Goah setup — ${title}\x1b[22m`, description ? `\x1b[2m ${description}\x1b[22m` : "", ""].join("\n")); };
  const interaction: RunnerSetupInteraction = {
    select: ({ title, description, choices }) => new Promise((resolve) => {
      setHeader(title, description);
      const list = new SelectList(choices as SelectItem[], 10, theme);
      list.onSelect = (item) => resolve(item.value);
      list.onCancel = () => resolve(null);
      replace(list);
    }),
    input: ({ title, description, prompt, initial }) => new Promise((resolve) => {
      setHeader(title, `${description ?? ""}\n ${prompt}`.trim());
      const input = new Input();
      if (initial) input.setValue(initial);
      input.onSubmit = (line) => resolve(line.trim());
      input.onEscape = () => resolve(null);
      replace(input);
    }),
    notify: (message) => { setHeader("Authentication", message); tui.requestRender(); },
    openUrl,
  };

  tui.addChild(header);
  const { promise, resolve } = Promise.withResolvers<WizardResult>();
  void (async () => {
    while (true) {
      try {
        const manifests = runnerManifests();
        const runner = await interaction.select({ title: "Runner", description: "The Runner owns its model, provider, authentication, and execution semantics.", choices: manifests.map((item) => ({ value: item.id, label: item.name, description: item.description })) });
        if (!runner) { resolve({ profile: null }); return; }
        const config = await runnerPlugin(runner).configurator.setup(current?.runner === runner ? current.config : null, interaction);
        if (config === null) { resolve({ profile: null }); return; }
        const confirmation = await interaction.select({ title: "Confirm", description: `${runner} runner\n ${summarize(config)}`, choices: [{ value: "save", label: "Save runner profile" }, { value: "cancel", label: "Cancel" }] });
        resolve({ profile: confirmation === "save" ? { id: current?.id ?? "default", runner, config } : null });
        return;
      } catch (error) {
        const choice = await interaction.select({ title: "Setup failed", description: error instanceof Error ? error.message : String(error), choices: [{ value: "retry", label: "Try again" }, { value: "cancel", label: "Cancel without saving" }] });
        if (choice !== "retry") { resolve({ profile: null }); return; }
      }
    }
  })();
  tui.start();
  const result = await promise;
  tui.stop();
  return result;
}

async function runPiped(current: RunnerProfile | null): Promise<WizardResult> {
  const ask = stdioQueue();
  const interaction: RunnerSetupInteraction = {
    select: async ({ title, choices }) => {
      const answer = Number(await ask(`${title}: ${choices.map((choice, index) => `${index + 1}) ${choice.label}`).join("  ")} — select: `));
      return choices[answer - 1]?.value ?? null;
    },
    input: async ({ prompt, initial }) => (await ask(`${prompt}${initial ? ` (${initial})` : ""}: `)) || initial || null,
    notify: (message) => process.stdout.write(`${message}\n`),
  };
  try {
    const manifests = runnerManifests();
    const runner = await interaction.select({ title: "Runner", choices: manifests.map((item) => ({ value: item.id, label: item.name })) });
    if (!runner) return { profile: null };
    const config = await runnerPlugin(runner).configurator.setup(current?.runner === runner ? current.config : null, interaction);
    return { profile: config === null ? null : { id: current?.id ?? "default", runner, config } };
  } finally { ask.close(); }
}

export function applyWizardResult(result: WizardResult, configPath: string | null): void {
  if (!result.profile) throw new Error("Setup was cancelled; your existing configuration was not changed.");
  writeDefaultRunnerProfile(result.profile);
  if (configPath) updateWorkspaceRunnerProfile(configPath, result.profile);
}

function summarize(config: JsonValue): string {
  if (!config || typeof config !== "object" || Array.isArray(config)) return String(config);
  return Object.entries(config).filter(([key]) => !/key|token|secret|password/i.test(key)).map(([key, value]) => `${key}: ${String(value)}`).join("\n ");
}
function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}
