import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type {
  JsonValue,
  RunnerCommandResult,
  RunnerConfigurator,
  RunnerDiagnostic,
  RunnerSetupInteraction,
} from "goah-ledger-contract";
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
  authMode?: "oauth" | "stored-key" | "environment" | "local" | "unconfigured";
}

export function piRunnerConfigurator(): RunnerConfigurator {
  return {
    describe: () => ({
      id: "pi",
      name: "Pi",
      description: "Direct multi-provider model runner",
      commands: [
        { name: "model", description: "List or switch provider/model" },
        { name: "auth", description: "Inspect, login, or logout provider credentials" },
      ],
    }),
    beginSetup: beginPiSetup,
    setup: setupPi,
    doctor: doctorPi,
    summarize: summarizePi,
    runCommand: runPiCommand,
  };
}

async function beginPiSetup(current: JsonValue | null, interaction: RunnerSetupInteraction) {
  const before = current ? piConfig(current) : null;
  const authFile = before?.authFile ?? defaultAuthFile();
  const baseline = await readFile(authFile).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
  const stagingDirectory = await mkdtemp(join(tmpdir(), "goah-auth-stage-"));
  const stagingAuthFile = join(stagingDirectory, "auth.json");
  if (baseline) await writeFile(stagingAuthFile, baseline, { mode: 0o600 });
  let config: JsonValue | null;
  try {
    config = await setupPi(current, interaction, "full", stagingAuthFile);
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  let state: "open" | "committed" | "rolled_back" = "open";
  let committed: Buffer | null = null;
  return {
    config,
    commit: async () => {
      if (state === "committed")
        return config && typeof config === "object" && !Array.isArray(config)
          ? ({ ...config, authFile } as unknown as JsonValue)
          : config;
      if (state === "rolled_back")
        throw new Error("Runner setup transaction was already rolled back");
      const staged = await readFile(stagingAuthFile).catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
      );
      try {
        await new JsonCredentialStore(authFile).replaceFileIfUnchanged(baseline, staged);
        committed = staged;
        state = "committed";
      } catch (error) {
        state = "rolled_back";
        await rm(stagingDirectory, { recursive: true, force: true });
        throw error;
      }
      await rm(stagingDirectory, { recursive: true, force: true });
      return config && typeof config === "object" && !Array.isArray(config)
        ? ({ ...config, authFile } as unknown as JsonValue)
        : config;
    },
    rollback: async () => {
      if (state === "rolled_back") return;
      if (state === "committed")
        await new JsonCredentialStore(authFile).replaceFileIfUnchanged(committed, baseline);
      state = "rolled_back";
      await rm(stagingDirectory, { recursive: true, force: true });
    },
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
    steering: true,
    envSpec: workerEnvironment(config),
    prepareRuntime: async () => {
      const resolved = resolveEnvSpec(privateEnv, { root });
      const configured = createPiModel(config.provider, config.model, resolved);
      const auth = await configured.models.getAuth(config.provider);
      if (
        !auth &&
        config.provider !== "faux" &&
        !["ollama", "lm-studio", "llama.cpp"].includes(config.provider)
      )
        throw new Error(
          `No credentials for ${config.provider}. Run \`goah auth login ${config.provider}\` or configure ${config.apiKeyEnv ?? defaultApiKeyEnv(config.provider)}.`,
        );
      return { ...(auth?.auth ?? {}) } as unknown as JsonValue;
    },
  });
}

async function setupPi(
  current: JsonValue | null,
  interaction: RunnerSetupInteraction,
  scope: "full" | "model" = "full",
  setupAuthFile = defaultAuthFile(),
): Promise<JsonValue | null> {
  const legacyCredential = Boolean(
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    typeof current.apiKeyEnv === "string" &&
    !isShellIdentifier(current.apiKeyEnv),
  );
  const before = current ? piConfig(current) : null;
  const providers = [
    ...providerCatalog(),
    {
      id: "custom",
      name: "Custom endpoint",
      modelCount: 0,
      oauth: false,
      apiKey: true,
      local: false,
    },
    { id: "faux", name: "Offline demo", modelCount: 1, oauth: false, apiKey: false, local: true },
  ];
  const provider = await interaction.select({
    title: "Choose a provider",
    description: "Search by company, provider ID, or capability.",
    progress: { current: 2, total: 5 },
    choices: providers.map((entry) => ({
      value: entry.id,
      label: entry.name,
      description: `${entry.id}${entry.oauth ? " · OAuth" : ""}${entry.local ? " · local" : ` · ${entry.modelCount} models`}`,
    })),
  });
  if (!provider) return null;
  const providerId =
    provider === "custom"
      ? await interaction.input({
          title: "Custom provider",
          description: "A stable ID used only inside this Runner Profile.",
          prompt: "Provider ID",
          initial: before?.provider ?? "custom",
          progress: { current: 2, total: 5 },
        })
      : provider;
  if (!providerId) return null;
  const catalog = ["ollama", "lm-studio", "llama.cpp"].includes(providerId)
    ? await discoverLocalModels(providerId)
    : modelCatalog(providerId);
  const selected = catalog.length
    ? await interaction.select({
        title: "Choose a model",
        description: `${providerId} · search by model name or ID.`,
        progress: { current: 3, total: 5 },
        choices: [
          ...catalog.map((model) => ({
            value: model.id,
            label: model.name,
            description: `${model.id} · ${Math.round(model.contextWindow / 1000)}k${model.reasoning ? " · reasoning" : ""}`,
          })),
          { value: "__custom__", label: "Custom model…" },
          { value: "__back__", label: "Back to providers" },
        ],
      })
    : "__custom__";
  if (!selected) return null;
  if (selected === "__back__") return setupPi(current, interaction, scope, setupAuthFile);
  const model =
    selected === "__custom__"
      ? await interaction.input({
          title: "Model ID",
          description: `Enter the model identifier accepted by ${providerId}.`,
          prompt: "Model",
          progress: { current: 3, total: 5 },
          ...(before?.provider === providerId ? { initial: before.model } : {}),
        })
      : selected;
  if (!model) return null;
  const config: PiRunnerConfig =
    scope === "model" && before?.provider === providerId
      ? { ...before, model, authFile: before.authFile ?? setupAuthFile }
      : {
          provider: providerId,
          model,
          thinking: before?.thinking ?? (providerId === "faux" ? "off" : "medium"),
          authFile: scope === "full" ? setupAuthFile : (before?.authFile ?? setupAuthFile),
          authMode:
            providerId === "faux" || ["ollama", "lm-studio", "llama.cpp"].includes(providerId)
              ? "local"
              : "unconfigured",
        };

  const descriptor = providers.find((entry) => entry.id === provider)!;
  if (!descriptor.local && provider !== "faux") {
    if (scope === "model") {
      const authenticated = await requireAuthentication(
        config,
        descriptor,
        interaction,
        legacyCredential,
      );
      if (authenticated === "back") return setupPi(current, interaction, scope, setupAuthFile);
      Object.assign(config, authenticated);
    } else {
      const auth = await configureAuthentication(
        providerId,
        descriptor,
        config.authFile!,
        interaction,
        legacyCredential,
      );
      if (auth === "back") return setupPi(current, interaction, scope, setupAuthFile);
      Object.assign(config, auth);
    }
  }

  if (["ollama", "lm-studio", "llama.cpp"].includes(provider)) {
    const baseUrl = await interaction.input({
      title: "Local endpoint",
      prompt: "OpenAI-compatible base URL",
      initial: localBaseUrl(provider),
      progress: { current: 4, total: 5 },
    });
    if (baseUrl) config.baseUrl = baseUrl;
    config.contextWindowTokens = positive(
      await interaction.input({
        title: "Context window",
        prompt: "Tokens",
        initial: "128000",
        progress: { current: 4, total: 5 },
      }),
      128_000,
    );
    config.maxOutputTokens = positive(
      await interaction.input({
        title: "Max output",
        prompt: "Tokens",
        initial: "16384",
        progress: { current: 4, total: 5 },
      }),
      16_384,
    );
  }
  if (provider === "custom") {
    const baseUrl = await interaction.input({
      title: "Custom endpoint",
      prompt: "Base URL",
      progress: { current: 4, total: 5 },
    });
    if (!baseUrl) return null;
    config.baseUrl = baseUrl;
    const api = await interaction.select({
      title: "Wire API",
      progress: { current: 4, total: 5 },
      choices: [
        { value: "openai-completions", label: "OpenAI Chat Completions" },
        { value: "openai-responses", label: "OpenAI Responses" },
        { value: "anthropic-messages", label: "Anthropic Messages" },
      ],
    });
    if (!api) return null;
    config.api = api as NonNullable<PiRunnerConfig["api"]>;
    config.contextWindowTokens = positive(
      await interaction.input({
        title: "Context window",
        prompt: "Tokens",
        initial: "128000",
        progress: { current: 4, total: 5 },
      }),
      128_000,
    );
    config.maxOutputTokens = positive(
      await interaction.input({
        title: "Max output",
        prompt: "Tokens",
        initial: "16384",
        progress: { current: 4, total: 5 },
      }),
      16_384,
    );
  }
  return config as unknown as JsonValue;
}

async function configureAuthentication(
  provider: string,
  descriptor: { oauth: boolean; apiKey: boolean },
  authFile: string,
  interaction: RunnerSetupInteraction,
  legacyCredential: boolean,
  allowLater = true,
  allowEnvironment = true,
): Promise<Partial<PiRunnerConfig> | "back"> {
  const store = new JsonCredentialStore(authFile);
  const existing = await store.read(provider);
  const choices = [
    ...(existing
      ? [
          {
            value: "existing",
            label: "Use saved credentials",
            description: existing.type === "oauth" ? "OAuth session" : "Stored API key",
          },
        ]
      : []),
    ...(descriptor.oauth
      ? [
          {
            value: "oauth",
            label: "Sign in with OAuth",
            description: "Opens the provider login flow",
          },
        ]
      : []),
    ...(descriptor.apiKey
      ? [
          {
            value: "key",
            label: "Paste an API key",
            description: "Stored privately and masked while typing",
          },
        ]
      : []),
    ...(allowEnvironment
      ? [
          {
            value: "env",
            label: "Use an environment variable",
            description: `Default: ${defaultApiKeyEnv(provider)}`,
          },
        ]
      : []),
    ...(allowLater
      ? [
          {
            value: "later",
            label: "Configure later",
            description: "Save now; runs will remain blocked",
          },
        ]
      : []),
    { value: "back", label: "Back to providers" },
  ];
  const description = legacyCredential
    ? "A pasted key was found in the old environment-variable field. It will be removed from config; rotate that key, then authenticate again here."
    : "Choose how this runner should authenticate. Secrets never enter goah.config.json.";
  const choice = await interaction.select({
    title: "Authentication",
    description,
    progress: { current: 4, total: 5 },
    choices,
  });
  if (!choice || choice === "back") return "back";
  if (choice === "existing")
    return { authMode: existing?.type === "oauth" ? "oauth" : "stored-key" };
  if (choice === "oauth") {
    await oauthLogin(provider, authFile, interaction);
    return { authMode: "oauth" };
  }
  if (choice === "key") {
    const key = await interaction.input({
      title: "API key",
      description: "The value is masked and saved only in the Runner credential store.",
      prompt: "Paste key",
      secret: true,
      progress: { current: 4, total: 5 },
    });
    if (!key) return "back";
    await store.modify(provider, async () => ({ type: "api_key", key }));
    return { authMode: "stored-key" };
  }
  if (choice === "env") {
    const name = await interaction.input({
      title: "Environment variable",
      description: "Enter a variable name, not the key itself.",
      prompt: "Variable",
      initial: defaultApiKeyEnv(provider),
      progress: { current: 4, total: 5 },
    });
    if (!name) return "back";
    if (!isShellIdentifier(name))
      throw new Error(
        "Environment variable names use letters, numbers, and underscores, and cannot contain an API key. Choose “Paste an API key” for a secret value.",
      );
    return { authMode: "environment", apiKeyEnv: name };
  }
  return { authMode: "unconfigured" };
}

async function requireAuthentication(
  config: PiRunnerConfig,
  descriptor: { oauth: boolean; apiKey: boolean; local?: boolean },
  interaction: RunnerSetupInteraction,
  legacyCredential = false,
): Promise<PiRunnerConfig | "back"> {
  if (
    descriptor.local ||
    config.provider === "faux" ||
    ["ollama", "lm-studio", "llama.cpp"].includes(config.provider)
  ) {
    const local = { ...config, authMode: "local" as const };
    delete local.apiKeyEnv;
    return local;
  }
  const authFile = config.authFile ?? defaultAuthFile();
  const stored = await new JsonCredentialStore(authFile).read(config.provider);
  if (stored) {
    const saved = {
      ...config,
      authFile,
      authMode: stored.type === "oauth" ? ("oauth" as const) : ("stored-key" as const),
    };
    delete saved.apiKeyEnv;
    return saved;
  }
  if (environmentAuthenticationAvailable(config))
    return {
      ...config,
      authFile,
      authMode: "environment",
      apiKeyEnv: config.apiKeyEnv ?? defaultApiKeyEnv(config.provider),
    };
  const auth = await configureAuthentication(
    config.provider,
    descriptor,
    authFile,
    interaction,
    legacyCredential,
    false,
    true,
  );
  if (auth === "back") return "back";
  const next: PiRunnerConfig = { ...config, ...auth, authFile };
  if (auth.authMode !== "environment") delete next.apiKeyEnv;
  if (next.authMode === "environment" && !environmentAuthenticationAvailable(next))
    throw new Error(
      `Environment variable ${next.apiKeyEnv ?? defaultApiKeyEnv(next.provider)} is not set. Set it first or choose “Paste an API key”.`,
    );
  return next;
}

function environmentAuthenticationAvailable(config: PiRunnerConfig): boolean {
  const key = config.api ? "GOAH_PI_API_KEY" : defaultApiKeyEnv(config.provider);
  try {
    return Boolean(resolveEnvSpec(piEnvironment(config), { root: process.cwd() })[key]);
  } catch {
    return false;
  }
}

async function doctorPi(value: JsonValue, context?: { root: string }): Promise<RunnerDiagnostic[]> {
  const config = piConfig(value);
  const env = resolveEnvSpec(piEnvironment(config), { root: context?.root ?? process.cwd() });
  const configured = createPiModel(config.provider, config.model, env);
  const auth =
    config.provider === "faux" || ["ollama", "lm-studio", "llama.cpp"].includes(config.provider)
      ? { source: "local" }
      : await configured.models.getAuth(config.provider);
  return [
    {
      ok: true,
      name: "model",
      detail: `${config.provider}/${config.model} · context ${configured.model.contextWindow} · output ${configured.model.maxTokens}`,
    },
    {
      ok: Boolean(auth),
      name: "auth",
      detail:
        auth?.source ??
        `No credentials for ${config.provider}; use runner auth login or configure ${config.apiKeyEnv ?? defaultApiKeyEnv(config.provider)}`,
    },
    { ok: true, name: "tool-access", detail: "Pi native tools · host user permissions" },
  ];
}

function summarizePi(value: JsonValue): Array<{ label: string; value: string }> {
  const config = piConfig(value);
  const auth =
    config.authMode === "environment"
      ? `Environment · ${config.apiKeyEnv ?? defaultApiKeyEnv(config.provider)}`
      : config.authMode === "local"
        ? "Local · no credentials"
        : "Managed separately · use auth status";
  return [
    { label: "Runner", value: "Pi" },
    { label: "Provider", value: config.provider },
    { label: "Model", value: config.model },
    { label: "Thinking", value: config.thinking ?? "off" },
    { label: "Authentication", value: auth },
    { label: "Tool access", value: "Pi native · host user permissions" },
    ...(config.baseUrl ? [{ label: "Endpoint", value: config.baseUrl }] : []),
  ];
}

async function runPiCommand(
  command: string,
  args: string[],
  value: JsonValue,
  interaction: RunnerSetupInteraction,
): Promise<RunnerCommandResult> {
  const config = piConfig(value);
  if (command === "model") {
    if (!args.length) {
      const selected = await setupPi(
        value,
        interaction,
        "model",
        config.authFile ?? defaultAuthFile(),
      );
      return selected === null
        ? { output: ["No change."] }
        : {
            config: selected,
            output: [
              `Pi target changed to ${piConfig(selected).provider}/${piConfig(selected).model}`,
            ],
          };
    }
    if (args[0] === "list") {
      const provider = args[1] ?? config.provider;
      if (provider === "faux")
        return { output: [`faux/${config.provider === "faux" ? config.model : "faux-goah"}`] };
      if (
        provider === config.provider &&
        config.baseUrl &&
        !providerCatalog().some((entry) => entry.id === provider)
      )
        return { output: [`${provider}/${config.model}`] };
      const models = ["ollama", "lm-studio", "llama.cpp"].includes(provider)
        ? await discoverLocalModels(provider)
        : modelCatalog(provider);
      return { output: models.map((model) => `${provider}/${model.id}`) };
    }
    const explicitProvider = args[0] === "use";
    const target = explicitProvider ? args[1] : args[0];
    if (!target) throw new Error("usage: goah model use PROVIDER/MODEL");
    const slash = target.indexOf("/");
    if (explicitProvider && slash <= 0) throw new Error("usage: goah model use PROVIDER/MODEL");
    const provider = explicitProvider
      ? target.slice(0, slash)
      : slash > 0 && providerCatalog().some((entry) => entry.id === target.slice(0, slash))
        ? target.slice(0, slash)
        : config.provider;
    const model =
      explicitProvider || provider !== config.provider || slash >= 0
        ? target.slice(slash + 1)
        : target;
    const knownProvider =
      provider === "faux" || providerCatalog().some((entry) => entry.id === provider);
    if (provider !== config.provider && !knownProvider)
      throw new Error(
        `Unknown provider: ${provider}. Use \`goah model\` to configure a custom endpoint.`,
      );
    const existing =
      provider === config.provider ||
      provider === "faux" ||
      ["ollama", "lm-studio", "llama.cpp"].includes(provider)
        ? undefined
        : await new JsonCredentialStore(config.authFile ?? defaultAuthFile()).read(provider);
    const next: PiRunnerConfig =
      provider === config.provider
        ? { ...config, model }
        : {
            provider,
            model,
            thinking: config.thinking ?? (provider === "faux" ? "off" : "medium"),
            authFile: config.authFile ?? defaultAuthFile(),
            authMode:
              provider === "faux" || ["ollama", "lm-studio", "llama.cpp"].includes(provider)
                ? "local"
                : existing?.type === "oauth"
                  ? "oauth"
                  : existing
                    ? "stored-key"
                    : "unconfigured",
          };
    createPiModel(provider, model, piEnvironment(next));
    const descriptor = providerCatalog().find((entry) => entry.id === provider) ?? {
      id: provider,
      name: provider,
      oauth: false,
      apiKey: true,
      local: false,
      modelCount: 0,
    };
    const authenticated = await requireAuthentication(next, descriptor, interaction);
    if (authenticated === "back") return { output: ["No change."] };
    return {
      config: authenticated as unknown as JsonValue,
      output: [`Pi target changed to ${provider}/${model}`],
    };
  }
  if (command === "auth") {
    const authFile = config.authFile ?? defaultAuthFile();
    const store = new JsonCredentialStore(authFile);
    const catalog = providerCatalog();
    if (!catalog.some((entry) => entry.id === config.provider))
      catalog.unshift({
        id: config.provider,
        name: config.provider === "faux" ? "Offline demo" : config.provider,
        oauth: false,
        apiKey: config.provider !== "faux",
        local: config.provider === "faux",
        modelCount: config.provider === "faux" ? 1 : 0,
      });
    const storedProviders = await store.list();
    for (const stored of storedProviders)
      if (!catalog.some((entry) => entry.id === stored.providerId))
        catalog.push({
          id: stored.providerId,
          name: stored.providerId,
          oauth: stored.type === "oauth",
          apiKey: stored.type === "api_key",
          local: false,
          modelCount: 0,
        });
    let action = args[0];
    if (!action)
      action =
        (await interaction.select({
          title: "Authentication",
          description: "Credentials are stored by the Pi Runner, outside workspace config.",
          choices: [
            {
              value: "login",
              label: "Add or sign in",
              description: "OAuth, API key, or environment variable",
            },
            {
              value: "logout",
              label: "Sign out or remove",
              description: "Remove stored credentials",
            },
            { value: "status", label: "View status", description: "Inspect configured providers" },
          ],
        })) ?? "cancel";
    if (action === "cancel") return { output: ["No change."] };
    if (action === "add") action = "login";
    if (action === "remove") action = "logout";
    let provider = args[1];
    if (!provider && (action === "login" || action === "logout")) {
      const saved = new Set(storedProviders.map((item) => item.providerId));
      const choices = catalog
        .filter((entry) => (action === "login" ? !entry.local : saved.has(entry.id)))
        .map((entry) => ({
          value: entry.id,
          label: entry.name,
          description: `${entry.id}${saved.has(entry.id) ? " · signed in" : entry.oauth ? " · OAuth available" : " · API key"}`,
        }));
      if (!choices.length) return { output: ["No stored credentials."] };
      provider =
        (await interaction.select({
          title: action === "login" ? "Sign in to a provider" : "Sign out of a provider",
          choices,
        })) ?? undefined;
      if (!provider) return { output: ["No change."] };
    }
    provider ??= config.provider;
    const descriptor = catalog.find((item) => item.id === provider);
    if (!descriptor) throw new Error(`Unknown provider: ${provider}`);
    if (action === "status" || action === "list") {
      const saved = new Set(storedProviders.map((item) => item.providerId));
      const rows = catalog
        .filter((item) => action === "list" || item.id === provider)
        .map(
          (item) =>
            `${saved.has(item.id) || (item.id === config.provider && config.authMode === "environment") ? "✓" : "·"} ${item.id}${item.id === config.provider && config.authMode === "environment" ? ` · env:${config.apiKeyEnv ?? defaultApiKeyEnv(item.id)}` : item.oauth ? " · OAuth available" : ""}`,
        );
      return { output: rows.length ? rows : ["No configured credentials."] };
    }
    if (action === "login") {
      if (descriptor.local)
        return { output: [`${provider} is local and does not require authentication.`] };
      const auth = await stagedProviderMutation(authFile, provider, (staged) =>
        configureAuthentication(
          provider,
          descriptor,
          staged,
          interaction,
          false,
          false,
          provider === config.provider,
        ),
      );
      if (auth === "back") return { output: ["No change."] };
      return {
        ...(provider === config.provider
          ? {
              config: {
                ...config,
                ...auth,
                ...(auth.authMode === "environment" ? {} : { apiKeyEnv: undefined }),
              } as unknown as JsonValue,
            }
          : {}),
        output: [`Authentication configured for ${provider}`],
      };
    }
    if (action === "logout") {
      if (descriptor.local)
        return { output: [`${provider} is local and does not use stored credentials.`] };
      const storedCredential = await store.read(provider);
      if (!storedCredential && provider === config.provider && config.authMode === "environment")
        return {
          output: [
            `${provider} uses ${config.apiKeyEnv ?? defaultApiKeyEnv(provider)} from your environment; unset it in your shell to sign out.`,
          ],
        };
      await stagedProviderMutation(authFile, provider, async (staged) => {
        await new JsonCredentialStore(staged).delete(provider);
      });
      return {
        ...(provider === config.provider && config.authMode !== "environment"
          ? {
              config: {
                ...config,
                authMode: "unconfigured",
                apiKeyEnv: undefined,
              } as unknown as JsonValue,
            }
          : {}),
        output: [
          `Removed stored credentials for ${provider}. Environment variables, if set, remain available to the provider.`,
        ],
      };
    }
    throw new Error(`Unknown Pi auth command: ${action}`);
  }
  throw new Error(`Unknown Pi runner command: ${command}`);
}

async function stagedProviderMutation<T>(
  path: string,
  provider: string,
  operation: (stagedPath: string) => Promise<T>,
): Promise<T> {
  const real = new JsonCredentialStore(path);
  const before = await real.read(provider);
  const directory = await mkdtemp(join(tmpdir(), "goah-auth-command-"));
  const stagedPath = join(directory, "auth.json");
  const raw = await readFile(path).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (raw) await writeFile(stagedPath, raw, { mode: 0o600 });
  try {
    const value = await operation(stagedPath);
    const after = await new JsonCredentialStore(stagedPath).read(provider);
    if (JSON.stringify(before) !== JSON.stringify(after))
      await real.replaceProviderIfUnchanged(provider, before, after);
    return value;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function oauthLogin(
  providerId: string,
  authFile: string,
  interaction: RunnerSetupInteraction,
): Promise<void> {
  const models = builtinModels({ credentials: new JsonCredentialStore(authFile) });
  const provider = models.getProvider(providerId);
  if (!provider?.auth.oauth) throw new Error(`${providerId} does not provide OAuth login.`);
  await models.login(providerId, "oauth", {
    prompt: (prompt) => authPrompt(prompt, interaction),
    notify: (event) => authEvent(event, interaction),
  });
}

async function authPrompt(
  prompt: AuthPrompt,
  interaction: RunnerSetupInteraction,
): Promise<string> {
  if (prompt.type === "select") {
    const answer = await interaction.select({
      title: "Authentication",
      description: prompt.message,
      choices: prompt.options.map((option) => ({
        value: option.id,
        label: option.label,
        ...(option.description ? { description: option.description } : {}),
      })),
    });
    if (!answer) throw new Error("Authentication cancelled.");
    return answer;
  }
  const answer = await interaction.input({
    title: "Authentication",
    prompt: prompt.message,
    ...(prompt.placeholder ? { initial: prompt.placeholder } : {}),
  });
  if (answer === null) throw new Error("Authentication cancelled.");
  return answer;
}
function authEvent(event: AuthEvent, interaction: RunnerSetupInteraction): void {
  if (event.type === "auth_url") {
    interaction.notify(
      `${event.instructions ?? "Complete sign-in in your browser."}\n${event.url}`,
    );
    interaction.openUrl?.(event.url);
  } else if (event.type === "device_code") {
    interaction.notify(`Open ${event.verificationUri} and enter ${event.userCode}`);
    interaction.openUrl?.(event.verificationUri);
  } else interaction.notify(event.message);
}

export function piConfig(value: JsonValue): PiRunnerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Pi runner configuration is missing.");
  const config = { ...(value as unknown as Partial<PiRunnerConfig>) };
  if (!config.provider || !config.model)
    throw new Error("Pi runner requires provider and model. Run `goah runner setup`.");
  if (config.apiKeyEnv && !isShellIdentifier(config.apiKeyEnv)) delete config.apiKeyEnv;
  if (!config.authMode)
    config.authMode = ["faux", "ollama", "lm-studio", "llama.cpp"].includes(config.provider)
      ? "local"
      : config.apiKeyEnv
        ? "environment"
        : "unconfigured";
  return config as PiRunnerConfig;
}
export function piEnvironment(config: PiRunnerConfig): Record<string, string> {
  const env: Record<string, string> = {
    GOAH_PI_PROVIDER: config.provider,
    GOAH_PI_MODEL: config.model,
    GOAH_PI_AUTH_FILE: config.authFile ?? defaultAuthFile(),
  };
  if (config.provider === "faux")
    env.GOAH_PI_FAUX_HANDOFF = JSON.stringify(config.fauxHandoff ?? { outcome: "progress" });
  if (
    config.provider !== "faux" &&
    !["ollama", "lm-studio", "llama.cpp"].includes(config.provider)
  ) {
    const key = config.api ? "GOAH_PI_API_KEY" : defaultApiKeyEnv(config.provider);
    env[key] = `env?:${config.apiKeyEnv ?? defaultApiKeyEnv(config.provider)}`;
  }
  if (config.baseUrl) env.GOAH_PI_BASE_URL = config.baseUrl;
  if (config.api) env.GOAH_PI_API = config.api;
  if (config.contextWindowTokens)
    env.GOAH_PI_CONTEXT_WINDOW_TOKENS = String(config.contextWindowTokens);
  if (config.maxOutputTokens) env.GOAH_PI_MAX_OUTPUT_TOKENS = String(config.maxOutputTokens);
  return env;
}
function workerEnvironment(config: PiRunnerConfig): Record<string, string> {
  const env = piEnvironment(config);
  for (const key of Object.keys(env))
    if (key.endsWith("API_KEY") || env[key]?.startsWith("env?:") || env[key]?.startsWith("env:"))
      delete env[key];
  env.GOAH_PI_AUTH_FILE = "";
  return env;
}
function defaultApiKeyEnv(provider: string): string {
  const map: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    xai: "XAI_API_KEY",
    groq: "GROQ_API_KEY",
    mistral: "MISTRAL_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    nvidia: "NVIDIA_API_KEY",
    "github-copilot": "COPILOT_GITHUB_TOKEN",
    "kimi-coding": "KIMI_API_KEY",
  };
  return map[provider] ?? `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}
function isShellIdentifier(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}
function localBaseUrl(provider: string): string {
  return provider === "ollama"
    ? "http://127.0.0.1:11434/v1"
    : provider === "lm-studio"
      ? "http://127.0.0.1:1234/v1"
      : "http://127.0.0.1:8080/v1";
}
function positive(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
async function discoverLocalModels(provider: string): Promise<ReturnType<typeof modelCatalog>> {
  const base = localBaseUrl(provider);
  const url =
    provider === "ollama"
      ? `${base.replace(/\/v1\/?$/, "")}/api/tags`
      : `${base.replace(/\/$/, "")}/models`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return [];
    const body = (await response.json()) as {
      models?: Array<{ name?: string }>;
      data?: Array<{ id?: string }>;
    };
    const ids =
      provider === "ollama"
        ? (body.models ?? []).map((item) => item.name)
        : (body.data ?? []).map((item) => item.id);
    return ids
      .filter((id): id is string => Boolean(id))
      .map((id) => ({
        provider,
        id,
        name: id,
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: false,
      }));
  } catch {
    return [];
  }
}
