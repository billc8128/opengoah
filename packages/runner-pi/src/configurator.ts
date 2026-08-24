import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { JsonValue, RunnerCommandResult, RunnerConfigurator, RunnerDiagnostic, RunnerSetupInteraction } from "goah-ledger-contract";
import { ProcessRunner, piWorkerPath, resolveEnvSpec } from "./index.js";
import { JsonCredentialStore } from "./credential-store.js";
import { createPiModel, defaultAuthFile, modelCatalog, providerCatalog } from "./model-provider.js";

export interface PiRunnerConfig {
  provider: string;
  model: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  apiKeyEnv?: string;
  baseUrl?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  authFile?: string;
  fauxHandoff?: JsonValue;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages";
}

export function piRunnerConfigurator(): RunnerConfigurator {
  return {
    describe: () => ({ id: "pi", name: "Pi", description: "Direct multi-provider model runner", commands: [{ name: "model", description: "List or switch provider/model" }, { name: "auth", description: "Inspect, login, or logout provider credentials" }] }),
    setup: setupPi,
    doctor: doctorPi,
    runCommand: runPiCommand,
  };
}

export function createPiProcessRunner(configValue: JsonValue, root: string): ProcessRunner {
  const config = piConfig(configValue);
  createPiModel(config.provider, config.model, piEnvironment(config));
  const privateEnv = piEnvironment(config);
  return new ProcessRunner({
    command: process.execPath,
    args: [piWorkerPath()],
    cwd: root,
    envSpec: workerEnvironment(config),
    prepareRuntime: async () => {
      const resolved = resolveEnvSpec(privateEnv, { root });
      const configured = createPiModel(config.provider, config.model, resolved);
      const auth = await configured.models.getAuth(config.provider);
      if (!auth && config.provider !== "faux" && !["ollama", "lm-studio", "llama.cpp"].includes(config.provider)) throw new Error(`No credentials for ${config.provider}. Run \`goah auth login ${config.provider}\` or configure ${config.apiKeyEnv ?? defaultApiKeyEnv(config.provider)}.`);
      return (auth?.auth ?? {}) as unknown as JsonValue;
    },
  });
}

async function setupPi(current: JsonValue | null, interaction: RunnerSetupInteraction): Promise<JsonValue | null> {
  const before = current ? piConfig(current) : null;
  const providers = [...providerCatalog(), { id: "custom", name: "Custom endpoint", modelCount: 0, oauth: false, apiKey: true, local: false }, { id: "faux", name: "Offline demo", modelCount: 1, oauth: false, apiKey: false, local: true }];
  const provider = await interaction.select({ title: "Pi provider", description: "Type to filter. Authentication and models are owned by the Pi runner.", choices: providers.map((entry) => ({ value: entry.id, label: entry.name, description: `${entry.id}${entry.oauth ? " · OAuth" : ""}${entry.local ? " · local" : ` · ${entry.modelCount} models`}` })) });
  if (!provider) return null;
  const providerId = provider === "custom" ? await interaction.input({ title: "Custom provider", prompt: "Provider ID", initial: before?.provider ?? "custom" }) : provider;
  if (!providerId) return null;
  const catalog = ["ollama", "lm-studio", "llama.cpp"].includes(providerId) ? await discoverLocalModels(providerId) : modelCatalog(providerId);
  const selected = catalog.length ? await interaction.select({ title: "Pi model", description: `${provider} · type to filter`, choices: [...catalog.map((model) => ({ value: model.id, label: model.name, description: `${model.id} · ${Math.round(model.contextWindow / 1000)}k${model.reasoning ? " · reasoning" : ""}` })), { value: "__custom__", label: "Custom model…" }] }) : "__custom__";
  if (!selected) return null;
  const model = selected === "__custom__" ? await interaction.input({ title: "Pi model", prompt: "Model ID", ...(before?.provider === provider ? { initial: before.model } : {}) }) : selected;
  if (!model) return null;
  const config: PiRunnerConfig = { provider: providerId, model, thinking: before?.thinking ?? (providerId === "faux" ? "off" : "medium"), authFile: defaultAuthFile() };

  const descriptor = providers.find((entry) => entry.id === provider)!;
  if (descriptor.oauth) {
    const auth = await interaction.select({ title: "Authentication", description: "Stored OAuth is preferred; API keys may remain in environment variables.", choices: [{ value: "existing", label: "Use existing credentials" }, { value: "login", label: "Sign in with OAuth" }, { value: "env", label: "Use API key environment variable" }] });
    if (!auth) return null;
    if (auth === "login") await oauthLogin(provider, config.authFile!, interaction);
    if (auth === "env") { const value = await interaction.input({ title: "API key", description: "Only the variable name is stored.", prompt: "Environment variable", initial: defaultApiKeyEnv(provider) }); if (value) config.apiKeyEnv = value; }
  } else if (!descriptor.local && provider !== "faux") {
    const value = await interaction.input({ title: "API key", description: "Only the variable name is stored.", prompt: "Environment variable", initial: defaultApiKeyEnv(provider) }); if (value) config.apiKeyEnv = value;
  }

  if (["ollama", "lm-studio", "llama.cpp"].includes(provider)) {
    const baseUrl = await interaction.input({ title: "Local endpoint", prompt: "OpenAI-compatible base URL", initial: localBaseUrl(provider) }); if (baseUrl) config.baseUrl = baseUrl;
    config.contextWindowTokens = positive(await interaction.input({ title: "Context window", prompt: "Tokens", initial: "128000" }), 128_000);
    config.maxOutputTokens = positive(await interaction.input({ title: "Max output", prompt: "Tokens", initial: "16384" }), 16_384);
  }
  if (provider === "custom") {
    const baseUrl = await interaction.input({ title: "Custom endpoint", prompt: "Base URL" }); if (!baseUrl) return null; config.baseUrl = baseUrl;
    const api = await interaction.select({ title: "Wire API", choices: [{ value: "openai-completions", label: "OpenAI Chat Completions" }, { value: "openai-responses", label: "OpenAI Responses" }, { value: "anthropic-messages", label: "Anthropic Messages" }] });
    if (!api) return null; config.api = api as NonNullable<PiRunnerConfig["api"]>;
    config.contextWindowTokens = positive(await interaction.input({ title: "Context window", prompt: "Tokens", initial: "128000" }), 128_000);
    config.maxOutputTokens = positive(await interaction.input({ title: "Max output", prompt: "Tokens", initial: "16384" }), 16_384);
  }
  return config as unknown as JsonValue;
}

async function doctorPi(value: JsonValue, context?: { root: string }): Promise<RunnerDiagnostic[]> {
  const config = piConfig(value);
  const env = resolveEnvSpec(piEnvironment(config), { root: context?.root ?? process.cwd() });
  const configured = createPiModel(config.provider, config.model, env);
  const auth = config.provider === "faux" || ["ollama", "lm-studio", "llama.cpp"].includes(config.provider) ? { source: "local" } : await configured.models.getAuth(config.provider);
  return [
    { ok: true, name: "model", detail: `${config.provider}/${config.model} · context ${configured.model.contextWindow} · output ${configured.model.maxTokens}` },
    { ok: Boolean(auth), name: "auth", detail: auth?.source ?? `No credentials for ${config.provider}; use runner auth login or configure ${config.apiKeyEnv ?? defaultApiKeyEnv(config.provider)}` },
  ];
}

async function runPiCommand(command: string, args: string[], value: JsonValue, interaction: RunnerSetupInteraction): Promise<RunnerCommandResult> {
  const config = piConfig(value);
  if (command === "model") {
    if (!args.length || args[0] === "list") {
      const provider = args[1] ?? config.provider;
      return { output: modelCatalog(provider).map((model) => `${provider}/${model.id}`) };
    }
    const target = args[0]!;
    const slash = target.indexOf("/");
    const provider = slash > 0 && providerCatalog().some((entry) => entry.id === target.slice(0, slash)) ? target.slice(0, slash) : config.provider;
    const model = provider === config.provider && slash < 0 ? target : target.slice(slash + 1);
    createPiModel(provider, model, piEnvironment({ ...config, provider, model }));
    return { config: { ...config, provider, model } as unknown as JsonValue, output: [`Pi target changed to ${provider}/${model}`] };
  }
  if (command === "auth") {
    const action = args[0] ?? "status";
    const provider = args[1] ?? config.provider;
    const store = new JsonCredentialStore(config.authFile ?? defaultAuthFile());
    if (action === "status" || action === "list") {
      const saved = new Set((await store.list()).map((item) => item.providerId));
      const rows = providerCatalog().filter((item) => action === "list" || saved.has(item.id)).map((item) => `${saved.has(item.id) ? "✓" : "·"} ${item.id}${item.oauth ? " · OAuth" : ""}`);
      return { output: rows.length ? rows : ["No stored OAuth credentials."] };
    }
    if (action === "login") { await oauthLogin(provider, config.authFile ?? defaultAuthFile(), interaction); return { output: [`Signed in to ${provider}`] }; }
    if (action === "logout") { await store.delete(provider); return { output: [`Signed out of ${provider}`] }; }
    throw new Error(`Unknown Pi auth command: ${action}`);
  }
  throw new Error(`Unknown Pi runner command: ${command}`);
}

async function oauthLogin(providerId: string, authFile: string, interaction: RunnerSetupInteraction): Promise<void> {
  const models = builtinModels({ credentials: new JsonCredentialStore(authFile) });
  const provider = models.getProvider(providerId);
  if (!provider?.auth.oauth) throw new Error(`${providerId} does not provide OAuth login.`);
  await models.login(providerId, "oauth", {
    prompt: (prompt) => authPrompt(prompt, interaction),
    notify: (event) => authEvent(event, interaction),
  });
}

async function authPrompt(prompt: AuthPrompt, interaction: RunnerSetupInteraction): Promise<string> {
  if (prompt.type === "select") {
    const answer = await interaction.select({ title: "Authentication", description: prompt.message, choices: prompt.options.map((option) => ({ value: option.id, label: option.label, ...(option.description ? { description: option.description } : {}) })) });
    if (!answer) throw new Error("Authentication cancelled.");
    return answer;
  }
  const answer = await interaction.input({ title: "Authentication", prompt: prompt.message, ...(prompt.placeholder ? { initial: prompt.placeholder } : {}) });
  if (answer === null) throw new Error("Authentication cancelled.");
  return answer;
}
function authEvent(event: AuthEvent, interaction: RunnerSetupInteraction): void {
  if (event.type === "auth_url") { interaction.notify(`${event.instructions ?? "Complete sign-in in your browser."}\n${event.url}`); interaction.openUrl?.(event.url); }
  else if (event.type === "device_code") { interaction.notify(`Open ${event.verificationUri} and enter ${event.userCode}`); interaction.openUrl?.(event.verificationUri); }
  else interaction.notify(event.message);
}

export function piConfig(value: JsonValue): PiRunnerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pi runner configuration is missing.");
  const config = value as unknown as Partial<PiRunnerConfig>;
  if (!config.provider || !config.model) throw new Error("Pi runner requires provider and model. Run `goah runner setup`.");
  return config as PiRunnerConfig;
}
export function piEnvironment(config: PiRunnerConfig): Record<string, string> {
  const env: Record<string, string> = { GOAH_PI_PROVIDER: config.provider, GOAH_PI_MODEL: config.model, GOAH_PI_AUTH_FILE: config.authFile ?? defaultAuthFile() };
  if (config.provider === "faux") env.GOAH_PI_FAUX_HANDOFF = JSON.stringify(config.fauxHandoff ?? { observations: ["faux runner completed"], results: [], nextSteps: [] });
  if (config.provider !== "faux" && !["ollama", "lm-studio", "llama.cpp"].includes(config.provider)) {
    const key = config.api ? "GOAH_PI_API_KEY" : defaultApiKeyEnv(config.provider);
    env[key] = `env?:${config.apiKeyEnv ?? defaultApiKeyEnv(config.provider)}`;
  }
  if (config.baseUrl) env.GOAH_PI_BASE_URL = config.baseUrl;
  if (config.api) env.GOAH_PI_API = config.api;
  if (config.contextWindowTokens) env.GOAH_PI_CONTEXT_WINDOW_TOKENS = String(config.contextWindowTokens);
  if (config.maxOutputTokens) env.GOAH_PI_MAX_OUTPUT_TOKENS = String(config.maxOutputTokens);
  return env;
}
function workerEnvironment(config: PiRunnerConfig): Record<string, string> {
  const env = piEnvironment(config);
  for (const key of Object.keys(env)) if (key.endsWith("API_KEY") || env[key]?.startsWith("env?:") || env[key]?.startsWith("env:")) delete env[key];
  env.GOAH_PI_AUTH_FILE = "";
  return env;
}
function defaultApiKeyEnv(provider: string): string { const map: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GEMINI_API_KEY", openrouter: "OPENROUTER_API_KEY", xai: "XAI_API_KEY", groq: "GROQ_API_KEY", mistral: "MISTRAL_API_KEY", deepseek: "DEEPSEEK_API_KEY", nvidia: "NVIDIA_API_KEY", "github-copilot": "COPILOT_GITHUB_TOKEN", "kimi-coding": "KIMI_API_KEY" }; return map[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`; }
function localBaseUrl(provider: string): string { return provider === "ollama" ? "http://127.0.0.1:11434/v1" : provider === "lm-studio" ? "http://127.0.0.1:1234/v1" : "http://127.0.0.1:8080/v1"; }
function positive(value: string | null, fallback: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
async function discoverLocalModels(provider: string): Promise<ReturnType<typeof modelCatalog>> {
  const base = localBaseUrl(provider);
  const url = provider === "ollama" ? `${base.replace(/\/v1\/?$/, "")}/api/tags` : `${base.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return [];
    const body = await response.json() as { models?: Array<{ name?: string }>; data?: Array<{ id?: string }> };
    const ids = provider === "ollama" ? (body.models ?? []).map((item) => item.name) : (body.data ?? []).map((item) => item.id);
    return ids.filter((id): id is string => Boolean(id)).map((id) => ({ provider, id, name: id, contextWindow: 128_000, maxTokens: 16_384, reasoning: false }));
  } catch { return []; }
}
