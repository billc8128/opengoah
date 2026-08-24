/**
 * `goah setup` — interactive TUI wizard (pi-style first-time-setup, omp-style scenes).
 *
 * Scenes: provider → model → key env (provider-dependent) → confirm. Writes the
 * global profile (~/.goah/profile.json) and, for a workspace bootstrap, the
 * local goah.config.json. Falls back to line-queue prompts when stdin/stdout
 * are not a TTY, so onboarding also works over pipes and in CI.
 */
import { TUI, Text, Input, ProcessTerminal, type Component } from "@mariozechner/pi-tui";
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

/** Interactive or piped setup wizard. Returns the options that were persisted. */
export async function runSetupWizard(existing: InitOptions | null): Promise<WizardResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return runPipedWizard();
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const view = new Text("");
  const input = new Input();
  const { promise: done, resolve: resolveDone } = Promise.withResolvers<WizardResult>();
  tui.addChild(view);
  tui.addChild(input);
  tui.setFocus(input);
  let answerLine: ((value: string) => void) | null = null;
  input.onSubmit = (line) => { input.setValue(""); const deliver = answerLine; answerLine = null; deliver?.(line.trim()); };
  const ask = (prompt: string): Promise<string> => {
    const { promise, resolve: answer } = Promise.withResolvers<string>();
    answerLine = answer;
    view.setText(prompt);
    tui.requestRender();
    return promise;
  };
  const choose = (prompt: string, options: string[], descriptions: string[]): Promise<number> => {
    const numbered = [prompt, "", ...options.map((option, index) => `${index + 1}. ${option}  —  ${descriptions[index] ?? ""}`), "", `enter a number 1-${options.length}: `].join("\n");
    return (async () => {
      while (true) {
        const answer = await ask(numbered);
        const parsed = Number(answer);
        if (Number.isInteger(parsed) && parsed >= 1 && parsed <= options.length) return parsed - 1;
      }
    })();
  };
  void (async () => {
    try {
      const providerIndex = await choose("Choose a provider", PROVIDERS.map((entry) => entry.label), PROVIDERS.map((entry) => entry.description));
      const provider = PROVIDERS[providerIndex]!.value;
      const known = KNOWN_MODELS[provider] ?? [];
      let model = "";
      if (known.length > 0) {
        const modelIndex = await choose(`Choose a ${provider} model (or type its id at the next prompt)`, [...known, "other…"], []);
        model = modelIndex < known.length ? known[modelIndex]! : await ask("model id: ");
      } else {
        model = await ask("model id: ");
      }
      if (!model) throw new Error("model is required");
      const options: InitOptions = { provider, model };
      if (provider !== "faux") {
        const destination = provider === "anthropic" ? "ANTHROPIC_API_KEY" : provider === "openai" ? "OPENAI_API_KEY" : "ARK_API_KEY";
        const apiKeyEnv = await ask(`environment variable holding the API key (default ${destination}): `);
        options.apiKeyEnv = apiKeyEnv && /^[A-Z_][A-Z0-9_]*$/.test(apiKeyEnv) ? apiKeyEnv : destination;
      }
      if (provider === "ark-coding") {
        const contextWindowTokens = Number(await ask("context window tokens (e.g. 256000): "));
        const maxOutputTokensPerTurn = Number(await ask("max output tokens per turn (e.g. 32000): "));
        if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0 || !Number.isInteger(maxOutputTokensPerTurn) || maxOutputTokensPerTurn <= 0) throw new Error("ark-coding requires integer context-window and max-output tokens");
        options.contextWindowTokens = contextWindowTokens;
        options.maxOutputTokensPerTurn = maxOutputTokensPerTurn;
      }
      view.setText([`Profile summary`, "", `  provider: ${provider}`, `  model: ${model}`, ...(options.apiKeyEnv ? [`  key env: ${options.apiKeyEnv}`] : []), ...(options.contextWindowTokens ? [`  context: ${options.contextWindowTokens}`, `  output: ${options.maxOutputTokensPerTurn}`] : []), "", "Saving…"].join("\n"));
      tui.requestRender();
      resolveDone({ options });
    } catch (error) {
      view.setText(`! ${error instanceof Error ? error.message : String(error)}`);
      tui.requestRender();
      resolveDone({ options: {} });
    }
  })();
  tui.start();
  const result = await done;
  tui.stop();
  return result;
}

/** Non-TTY fallback: sequential numbered prompts through the shared line queue in cli.ts semantics. */
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
