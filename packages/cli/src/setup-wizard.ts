/** Generic Runner setup. Provider/model semantics remain inside each Runner plugin. */
import { spawn } from "node:child_process";
import { Input, ProcessTerminal, SelectList, Text, TuiAltScreen, type Component, type SelectItem, type SelectListTheme } from "@earendil-works/pi-tui";
import type { JsonValue, RunnerProfile, RunnerSetupInteraction, RunnerSetupTransaction } from "goah-ledger-contract";
import { persistRunnerProfile, readDefaultRunnerProfile } from "./index.js";
import { runnerManifests, runnerPlugin } from "./runner-registry.js";
import { SearchableSelect } from "./searchable-select.js";
import { SecretInput, setInitialValue } from "./secret-input.js";
import { tuiTheme } from "./tui-theme.js";

export interface WizardResult { profile: RunnerProfile | null }
export interface RunnerCommandWizardResult { profile: RunnerProfile; output: string[] }
export type SetupSection = "runner" | "model" | "auth";

export function renderSetupHeader(title: string, description = "", progress?: { current: number; total: number }, surface = "SETUP"): string {
  const meter = progress ? `${"━".repeat(progress.current)}${"─".repeat(Math.max(0, progress.total - progress.current))}  ${progress.current}/${progress.total}` : "";
  return [`${tuiTheme.brand(" GOAH ")}${tuiTheme.rail(` ${surface}${meter ? `  ${meter}` : ""} `)}`, "", `  ${tuiTheme.strong(title)}`, description ? `  ${tuiTheme.muted(description)}` : "", ""].join("\n");
}

const theme: SelectListTheme = {
  selectedPrefix: (text) => `${tuiTheme.accent(">")} ${text}`,
  selectedText: tuiTheme.strong,
  description: tuiTheme.muted,
  scrollInfo: tuiTheme.muted,
  noMatch: tuiTheme.muted,
};

export async function runSetupWizard(current: RunnerProfile | null = readDefaultRunnerProfile()): Promise<WizardResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("goah setup requires an interactive terminal; use `goah init --provider ID --model ID` for non-interactive setup.");
  return runTui(current);
}

async function runTui(current: RunnerProfile | null): Promise<WizardResult> {
  return withTuiInteraction(async (interaction) => {
    while (true) {
      let transaction: RunnerSetupTransaction | undefined;
      try {
        const manifests = runnerManifests();
        const runner = await interaction.select({ title: "Choose a runner", description: "A runner owns execution, models, and authentication.", progress: { current: 1, total: 5 }, choices: manifests.map((item) => ({ value: item.id, label: item.name, description: item.description })) });
        if (!runner) return { profile: null };
        const configurator = runnerPlugin(runner).configurator;
        const currentConfig = current?.runner === runner ? current.config : null;
        transaction = await configurator.beginSetup?.(currentConfig);
        const config = await configurator.setup(currentConfig, interaction);
        if (config === null) { await transaction?.rollback(); return { profile: null }; }
        const summary = configurator.summarize?.(config) ?? summarize(config);
        const confirmation = await interaction.select({ title: "Review", description: summary.map((item) => `${item.label.padEnd(12)} ${item.value}`).join("\n "), progress: { current: 5, total: 5 }, choices: [{ value: "save", label: "Save and continue" }, { value: "back", label: "Back" }, { value: "cancel", label: "Cancel without saving" }] });
        if (confirmation === "back") { await transaction?.rollback(); continue; }
        if (confirmation === "save") await transaction?.commit(); else await transaction?.rollback();
        return { profile: confirmation === "save" ? { id: current?.id ?? "default", runner, config } : null };
      } catch (error) {
        await transaction?.rollback();
        const choice = await interaction.select({ title: "Setup failed", description: error instanceof Error ? error.message : String(error), choices: [{ value: "retry", label: "Try again" }, { value: "cancel", label: "Cancel without saving" }] });
        if (choice !== "retry") return { profile: null };
      }
    }
  });
}

async function withTuiInteraction<T>(flow: (interaction: RunnerSetupInteraction) => Promise<T>, surface = "SETUP"): Promise<T> {
  const tui = new TuiAltScreen(new ProcessTerminal(), true);
  const header = new Text("");
  let slot: Component | null = null;
  const replace = (component: Component): void => { if (slot) tui.removeChild(slot); slot = component; tui.addChild(component); tui.setFocus(component); tui.requestRender(); };
  const setHeader = (title: string, description = "", progress?: { current: number; total: number }): void => { header.setText(renderSetupHeader(title, description, surface === "SETUP" ? progress : undefined, surface)); };
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
  const promise = flow(interaction);
  tui.start();
  try { return await promise; }
  finally { tui.stop(); process.stdout.write("\x1b[2J\x1b[H"); }
}

/** Run one scoped Runner command with the same searchable/masked TUI primitives as onboarding. */
export async function runRunnerCommandWizard(current: RunnerProfile, command: string, args: string[] = []): Promise<RunnerCommandWizardResult> {
  const plugin = runnerPlugin(current.runner);
  if (!plugin.configurator.runCommand) throw new Error(`${current.runner} does not expose runner commands.`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(command === "model" ? "goah model requires an interactive terminal; use `goah model list` or `goah model use PROVIDER/MODEL`." : "goah auth requires an interactive terminal; use `goah auth status|list|login|logout PROVIDER`.");
  const run = async (interaction: RunnerSetupInteraction): Promise<RunnerCommandWizardResult> => {
    const result = await plugin.configurator.runCommand!(command, args, current.config, interaction);
    return { profile: result.config === undefined ? current : { ...current, config: result.config }, output: result.output };
  };
  return withTuiInteraction(run, command === "model" ? "MODEL" : "AUTH");
}

/** Returning users land on scoped settings instead of replaying onboarding. */
export async function chooseSetupSection(current: RunnerProfile): Promise<SetupSection | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return "runner";
  const summary = runnerPlugin(current.runner).configurator.summarize?.(current.config) ?? summarize(current.config);
  return withTuiInteraction((interaction) => interaction.select({
    title: "Goah settings",
    description: summary.map((item) => `${item.label.padEnd(12)} ${item.value}`).join("\n "),
    choices: [
      { value: "model", label: "Model", description: "Switch provider or model" },
      { value: "auth", label: "Authentication", description: "Add, inspect, or remove credentials" },
      { value: "runner", label: "Runner profile", description: "Re-run complete Runner setup" },
    ],
  }) as Promise<SetupSection | null>, "SETTINGS");
}

export function applyWizardResult(result: WizardResult, configPath: string | null): void {
  if (!result.profile) throw new Error("Setup was cancelled; your existing configuration was not changed.");
  persistRunnerProfile(result.profile, configPath);
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
