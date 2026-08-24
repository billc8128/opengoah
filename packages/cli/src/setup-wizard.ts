/**
 * `goah setup` — interactive TUI wizard.
 *
 * Scenes render with pi-tui components on one screen: a persistent header and
 * a swap slot that alternates between SelectList (arrow-key selection,
 * omp/pi-style) and Input (free text). Non-TTY invocations fall back to the
 * piped line-queue prompt so onboarding also works over pipes and in CI.
 */
import { TUI, Text, Input, SelectList, ProcessTerminal, type Component, type SelectItem, type SelectListTheme } from "@mariozechner/pi-tui";
import { writeDefaultProfile, writeDefaultConfig, type InitOptions, type PiProvider } from "./index.js";
import { stdioQueue } from "./prompt-queue.js";

interface WizardResult { options: InitOptions }

const PROVIDERS: Array<{ value: PiProvider; label: string; description: string }> = [
  { value: "anthropic", label: "anthropic", description: "Claude models via ANTHROPIC_API_KEY" },
  { value: "openai", label: "openai", description: "OpenAI models via OPENAI_API_KEY" },
  { value: "ark-coding", label: "ark-coding", description: "Volcano Ark coding plans (explicit context/output limits)" },
  { value: "faux", label: "faux", description: "Offline simulated runner for smoke tests" },
];

const KNOWN_MODELS: Partial<Record<PiProvider, string[]>> = {
  anthropic: ["claude-sonnet-4-6", "claude-opus-4-6", "claude-haiku-4-5"],
};

const CUSTOM = "__custom__";

const listTheme: SelectListTheme = {
  selectedPrefix: (text) => `\x1b[36m❯\x1b[0m ${text}`,
  selectedText: (text) => `\x1b[1m${text}\x1b[22m`,
  description: (text) => `\x1b[2m${text}\x1b[22m`,
  scrollInfo: (text) => `\x1b[2m${text}\x1b[22m`,
  noMatch: (text) => `\x1b[2m${text}\x1b[22m`,
};

/** Interactive or piped setup wizard. Returns the options that were chosen. */
export async function runSetupWizard(): Promise<WizardResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return runPipedWizard();

  const tui = new TUI(new ProcessTerminal());
  const header = new Text("");
  let slot: Component | null = null;
  const { promise: done, resolve: resolveDone } = Promise.withResolvers<WizardResult>();

  const setHeader = (title: string, subtitle: string): void => {
    header.setText(["", `\x1b[1m Goah setup — ${title}\x1b[22m`, `\x1b[2m ${subtitle}\x1b[22m`, ""].join("\n"));
  };
  const setSlot = (component: Component): void => {
    if (slot) tui.removeChild(slot);
    slot = component;
    tui.addChild(component);
    tui.setFocus(component);
    tui.requestRender();
  };
  /** Arrow-key selection; resolves the chosen value, or null when cancelled. */
  const pick = (title: string, subtitle: string, items: SelectItem[]): Promise<string | null> => {
    setHeader(title, subtitle);
    const list = new SelectList(items, 8, listTheme);
    const { promise, resolve } = Promise.withResolvers<string | null>();
    list.onSelect = (item) => resolve(item.value);
    list.onCancel = () => resolve(null);
    setSlot(list);
    return promise;
  };
  /** Free-text entry on one Input line; the prompt lives in the header so the TUI owns every glyph on screen. */
  const askText = (title: string, subtitle: string, prompt: string): Promise<string> => {
    setHeader(title, `${subtitle}\n ${prompt}`);
    const input = new Input();
    const { promise, resolve } = Promise.withResolvers<string>();
    let answerLine: ((value: string) => void) | null = resolve;
    input.onSubmit = (line) => { input.setValue(""); const deliver = answerLine; answerLine = null; deliver?.(line.trim()); };
    setSlot(input);
    return promise;
  };

  tui.addChild(header);
  void (async () => {
    let options: InitOptions = {};
    try {
      const providerValue = await pick("Provider", "↑/↓ to move, Enter to select, Esc to cancel", PROVIDERS.map((entry) => ({ value: entry.value, label: entry.label, description: entry.description })));
      if (!providerValue) { resolveDone({ options }); return; }
      const provider = providerValue as PiProvider;
      options = { provider };

      const known = KNOWN_MODELS[provider] ?? [];
      let model = "";
      if (known.length > 0) {
        const modelValue = await pick("Model", `Provider: ${provider}`, [...known.map((id) => ({ value: id, label: id })), { value: CUSTOM, label: "custom…", description: "type the model id yourself" }]);
        if (!modelValue) { resolveDone({ options }); return; }
        model = modelValue === CUSTOM ? await askText("Model", `Provider: ${provider}`, "model id:") : modelValue;
      } else {
        model = await askText("Model", `Provider: ${provider}`, "model id:");
      }
      if (!model) { resolveDone({ options }); return; }
      options = { ...options, model };

      if (provider !== "faux") {
        const destination = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : "ARK_API_KEY";
        const apiKeyEnv = await askText("API key", "Goah stores the variable NAME only — never the secret", `env var holding the key (Enter = ${destination}):`);
        options = { ...options, apiKeyEnv: apiKeyEnv && /^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv) ? apiKeyEnv : destination };
      }

      if (provider === "ark-coding") {
        const contextWindowTokens = Number(await askText("Context window", "Ark's model-list API does not publish limits; enter the published value", "context window tokens (e.g. 256000):"));
        const maxOutputTokensPerTurn = Number(await askText("Max output", "per-turn output cap", "max output tokens per turn (e.g. 32000):"));
        if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0 || !Number.isInteger(maxOutputTokensPerTurn) || maxOutputTokensPerTurn <= 0) throw new Error("ark-coding requires integer context-window and max-output tokens");
        options = { ...options, contextWindowTokens, maxOutputTokensPerTurn };
      }

      const summary = ["", `  provider  ${options.provider}`, `  model     ${options.model}`, ...(options.apiKeyEnv ? [`  key env   ${options.apiKeyEnv}`] : []), ...(options.contextWindowTokens ? [`  context   ${options.contextWindowTokens}`, `  output    ${options.maxOutputTokensPerTurn}`] : [])].join("\n");
      const confirmation = await pick("Confirm", `${summary}`, [{ value: "save", label: "Save profile" }, { value: "cancel", label: "Cancel" }]);
      if (confirmation !== "save") options = {};
    } catch (error) {
      setHeader("Error", error instanceof Error ? error.message : String(error));
    }
    resolveDone({ options });
  })();
  tui.start();
  const result = await done;
  tui.stop();
  return result;
}

/** Non-TTY fallback: sequential numbered prompts through the shared line queue. */
async function runPipedWizard(): Promise<WizardResult> {
  const ask = stdioQueue();
  try {
    const providerIndex = await ask(`${PROVIDERS.map((entry, index) => `${index + 1}) ${entry.label}`).join("  ")} — pick 1-${PROVIDERS.length}: `);
    const provider = PROVIDERS[Math.max(0, Math.min(PROVIDERS.length - 1, Number(providerIndex) - 1))]!.value;
    const model = await ask("model id: ");
    if (!model) return { options: {} };
    const options: InitOptions = { provider, model };
    if (provider !== "faux") {
      const destination = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : "ARK_API_KEY";
      const apiKeyEnv = await ask(`API key environment variable (default ${destination}): `);
      options.apiKeyEnv = apiKeyEnv && /^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv) ? apiKeyEnv : destination;
    }
    if (provider === "ark-coding") {
      const contextWindowTokens = Number(await ask("context window tokens: "));
      const maxOutputTokensPerTurn = Number(await ask("max output tokens per turn: "));
      if (Number.isInteger(contextWindowTokens) && contextWindowTokens > 0 && Number.isInteger(maxOutputTokensPerTurn) && maxOutputTokensPerTurn > 0) {
        options.contextWindowTokens = contextWindowTokens;
        options.maxOutputTokensPerTurn = maxOutputTokensPerTurn;
      }
    }
    return { options };
  } finally { ask.close(); }
}

/** Persist the wizard result and (optionally) materialize this directory's workspace config. */
export function applyWizardResult(result: WizardResult, configPath: string | null): void {
  if (!result.options.provider) throw new Error("setup was cancelled; no profile written");
  writeDefaultProfile(result.options);
  if (configPath) writeDefaultConfig(configPath, result.options);
}
