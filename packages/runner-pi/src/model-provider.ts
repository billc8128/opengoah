import { homedir } from "node:os";
import { join } from "node:path";
import { createModels, createProvider, defaultProviderAuthContext, envApiKeyAuth, fauxProvider, type Api, type Model, type MutableModels } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { builtinModels, builtinProviders, getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { JsonCredentialStore } from "./credential-store.js";

export const LOCAL_PROVIDERS = ["ollama", "lm-studio", "llama.cpp"] as const;
export type LocalProvider = typeof LOCAL_PROVIDERS[number];

export interface ProviderSummary { id: string; name: string; modelCount: number; oauth: boolean; apiKey: boolean; local: boolean }
export interface ModelSummary { provider: string; id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean }
export interface ConfiguredPiModel { models: MutableModels; model: Model<Api>; faux?: ReturnType<typeof fauxProvider> }

export function defaultAuthFile(): string {
  return process.env.GOAH_PI_AUTH_FILE ?? join(process.env.GOAH_STATE_HOME ?? join(homedir(), ".goah"), "auth.json");
}

export function providerCatalog(): ProviderSummary[] {
  const rows = builtinProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    modelCount: provider.getModels().length,
    oauth: provider.auth.oauth !== undefined,
    apiKey: provider.auth.apiKey !== undefined,
    local: false,
  }));
  for (const id of LOCAL_PROVIDERS) rows.push({ id, name: localName(id), modelCount: 0, oauth: false, apiKey: false, local: true });
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

export function modelCatalog(provider?: string): ModelSummary[] {
  if (provider && isLocalProvider(provider)) return [];
  const providers = provider ? [provider] : getBuiltinProviders();
  return providers.flatMap((providerId) => getBuiltinModels(providerId as Parameters<typeof getBuiltinModels>[0]).map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
  })));
}

export function createPiModel(provider: string, modelId: string, env: NodeJS.ProcessEnv = process.env): ConfiguredPiModel {
  if (provider === "faux") {
    const models = createModels();
    const faux = fauxProvider({ provider, models: [{ id: modelId, contextWindow: 128_000, maxTokens: 32_000 }] });
    models.setProvider(faux.provider);
    return { models, model: faux.getModel() as Model<Api>, faux };
  }

  const ambient = defaultProviderAuthContext();
  const models = builtinModels({ credentials: new JsonCredentialStore(env.GOAH_PI_AUTH_FILE ?? defaultAuthFile()), authContext: { env: async (name) => env[name] ?? ambient.env(name), fileExists: ambient.fileExists } });
  if (isLocalProvider(provider)) models.setProvider(localProvider(provider, modelId, env));
  else if (!models.getProvider(provider) && env.GOAH_PI_BASE_URL) models.setProvider(customProvider(provider, modelId, env));
  const model = models.getModel(provider, modelId);
  if (!model) throw new Error(`Model not found: ${provider}/${modelId}`);
  const baseUrl = env.GOAH_PI_BASE_URL;
  return { models, model: baseUrl ? { ...model, baseUrl } as Model<Api> : model };
}

function customProvider(provider: string, modelId: string, env: NodeJS.ProcessEnv) {
  const api = env.GOAH_PI_API ?? "openai-completions";
  const baseUrl = env.GOAH_PI_BASE_URL!;
  const model: Model<Api> = {
    id: modelId, name: modelId, api, provider, baseUrl,
    reasoning: env.GOAH_PI_REASONING === "true", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: positive(env.GOAH_PI_CONTEXT_WINDOW_TOKENS, 128_000), maxTokens: positive(env.GOAH_PI_MAX_OUTPUT_TOKENS, 16_384),
  };
  const stream = api === "anthropic-messages" ? anthropicMessagesApi() : api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi();
  return createProvider({ id: provider, name: provider, baseUrl, auth: { apiKey: envApiKeyAuth(`${provider} API key`, ["GOAH_PI_API_KEY"]) }, models: [model], api: stream });
}

export async function resolvedApiKey(models: MutableModels, provider: string): Promise<string | undefined> {
  return (await models.getAuth(provider))?.auth.apiKey;
}

function localProvider(provider: LocalProvider, modelId: string, env: NodeJS.ProcessEnv) {
  const baseUrl = env.GOAH_PI_BASE_URL ?? localBaseUrl(provider);
  const model: Model<"openai-completions"> = {
    id: modelId, name: modelId, api: "openai-completions", provider, baseUrl,
    reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: positive(env.GOAH_PI_CONTEXT_WINDOW_TOKENS, 128_000),
    maxTokens: positive(env.GOAH_PI_MAX_OUTPUT_TOKENS, 16_384),
  };
  return createProvider({
    id: provider, name: localName(provider), baseUrl,
    auth: { apiKey: { name: `${localName(provider)} local`, check: async () => ({ type: "api_key", source: "local" }), resolve: async () => ({ auth: {}, source: "local" }) } },
    models: [model], api: openAICompletionsApi(),
  });
}

function localBaseUrl(provider: LocalProvider): string {
  if (provider === "ollama") return process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
  if (provider === "lm-studio") return process.env.LM_STUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1";
  return process.env.LLAMA_CPP_BASE_URL ?? "http://127.0.0.1:8080/v1";
}
function localName(provider: LocalProvider): string { return provider === "ollama" ? "Ollama" : provider === "lm-studio" ? "LM Studio" : "llama.cpp"; }
function isLocalProvider(value: string): value is LocalProvider { return (LOCAL_PROVIDERS as readonly string[]).includes(value); }
function positive(value: string | undefined, fallback: number): number { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
