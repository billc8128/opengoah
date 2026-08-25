/** Generic Runner setup. Provider/model semantics remain inside each Runner plugin. */
import { spawn } from "node:child_process";
import { Input, ProcessTerminal, SelectList, Text, TuiAltScreen, type Component, type SelectItem, type SelectListTheme } from "@earendil-works/pi-tui";
import type { JsonValue, RunnerProfile, RunnerSetupInteraction } from "goah-ledger-contract";
import { readDefaultRunnerProfile, updateWorkspaceRunnerProfile, writeDefaultRunnerProfile } from "./index.js";
import { stdioQueue } from "./prompt-queue.js";
import { runnerManifests, runnerPlugin } from "./runner-registry.js";
import { SearchableSelect } from "./searchable-select.js";
import { SecretInput, setInitialValue } from "./secret-input.js";
import { tuiTheme } from "./tui-theme.js";

export interface WizardResult { profile: RunnerProfile | null }

export function renderSetupHeader(title: string, description = "", progress?: { current: number; total: number }): string {
  const meter = progress ? `${"━".repeat(progress.current)}${"─".repeat(Math.max(0, progress.total - progress.current))}  ${progress.current}/${progress.total}` : "";
  return [`${tuiTheme.brand(" GOAH ")}${tuiTheme.rail(` SETUP${meter ? `  ${meter}` : ""} `)}`, "", `  ${tuiTheme.strong(title)}`, description ? `  ${tuiTheme.muted(description)}` : "", ""].join("\n");
}

const theme: SelectListTheme = {
  selectedPrefix: (text) => `${tuiTheme.accent(">")} ${text}`,
  selectedText: tuiTheme.strong,
  description: tuiTheme.muted,
  scrollInfo: tuiTheme.muted,
  noMatch: tuiTheme.muted,
};

export async function runSetupWizard(current: RunnerProfile | null = readDefaultRunnerProfile()): Promise<WizardResult> {
  return process.stdin.isTTY && process.stdout.isTTY ? runTui(current) : runPiped(current);
}

async function runTui(current: RunnerProfile | null): Promise<WizardResult> {
  const tui = new TuiAltScreen(new ProcessTerminal(), true);
  const header = new Text("");
  let slot: Component | null = null;
  const replace = (component: Component): void => { if (slot) tui.removeChild(slot); slot = component; tui.addChild(component); tui.setFocus(component); tui.requestRender(); };
  const setHeader = (title: string, description = "", progress?: { current: number; total: number }): void => { header.setText(renderSetupHeader(title, description, progress)); };
  const interaction: RunnerSetupInteraction = {
    select: ({ title, description, choices, progress }) => new Promise((resolve) => {
      setHeader(title, description, progress);
      const list = choices.length >= 8
        ? new SearchableSelect(choices as SelectItem[], 9, theme, { searchLabel: `Search ${title.toLowerCase()}`, emptyLabel: `No matching ${title.toLowerCase()}` })
        : new SelectList(choices as SelectItem[], 10, theme);
      list.onSelect = (item) => resolve(item.value);
      list.onCancel = () => resolve(null);
      replace(list);
    }),
    input: ({ title, description, prompt, initial, secret, progress }) => new Promise((resolve) => {
      setHeader(title, `${description ?? ""}\n ${prompt}`.trim(), progress);
      const input = secret ? new SecretInput() : new Input();
      if (initial) setInitialValue(input, initial);
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
        const runner = await interaction.select({ title: "Choose a runner", description: "A runner owns execution, models, and authentication.", progress: { current: 1, total: 5 }, choices: manifests.map((item) => ({ value: item.id, label: item.name, description: item.description })) });
        if (!runner) { resolve({ profile: null }); return; }
        const config = await runnerPlugin(runner).configurator.setup(current?.runner === runner ? current.config : null, interaction);
        if (config === null) { resolve({ profile: null }); return; }
        const summary = runnerPlugin(runner).configurator.summarize?.(config) ?? summarize(config);
        const confirmation = await interaction.select({ title: "Review", description: summary.map((item) => `${item.label.padEnd(12)} ${item.value}`).join("\n "), progress: { current: 5, total: 5 }, choices: [{ value: "save", label: "Save and continue" }, { value: "back", label: "Back" }, { value: "cancel", label: "Cancel without saving" }] });
        if (confirmation === "back") continue;
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
  process.stdout.write("\x1b[2J\x1b[H");
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

function summarize(config: JsonValue): Array<{ label: string; value: string }> {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [{ label: "Configuration", value: String(config) }];
  return Object.entries(config).filter(([key]) => !/key|token|secret|password|authFile/i.test(key)).map(([label, value]) => ({ label, value: String(value) }));
}
function openUrl(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore" }).unref();
}
