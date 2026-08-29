import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerSetupInteraction } from "goah-ledger-contract";
import { JsonCredentialStore } from "./credential-store.js";
import { createPiProcessRunner, piConfig, piEnvironment, piRunnerConfigurator } from "./configurator.js";
import { createPiModel } from "./model-provider.js";

test("Pi configurator owns provider, model, and auth choices", async () => {
  const choices = ["openai", "gpt-5.5", "later"];
  const interaction: RunnerSetupInteraction = {
    select: async () => choices.shift() ?? null,
    input: async () => null,
    notify: () => undefined,
  };
  const config = await piRunnerConfigurator().setup(null, interaction) as { provider: string; model: string };
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-5.5");
});

test("model command uses a scoped picker without replaying authentication for the current provider", async () => {
  const previous=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY="test-openai-key";const authFile=join(mkdtempSync(join(tmpdir(),"goah-model-env-auth-")),"auth.json");
  const interaction: RunnerSetupInteraction = {
    select: async ({ title, choices }) => title.includes("provider") ? "openai" : title.includes("model") ? choices.find((choice) => choice.value === "gpt-5.5")!.value : null,
    input: async () => null,
    notify: () => undefined,
  };
  try{const result = await piRunnerConfigurator().runCommand!("model", [], { provider: "openai", model: "gpt-5.4",authFile, authMode: "environment", apiKeyEnv: "OPENAI_API_KEY" }, interaction);const config=result.config as {provider:string;model:string;authFile:string;authMode:string;apiKeyEnv:string};assert.deepEqual({provider:config.provider,model:config.model,authFile:config.authFile,authMode:config.authMode,apiKeyEnv:config.apiKeyEnv},{provider:"openai",model:"gpt-5.5",authFile,authMode:"environment",apiKeyEnv:"OPENAI_API_KEY"});}
  finally{if(previous===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=previous;}
});

test("model picker preserves a custom credential store and never launches authentication", async () => {
  const directory = mkdtempSync(join(tmpdir(), "goah-model-auth-store-")); const authFile = join(directory, "custom-auth.json");
  await new JsonCredentialStore(authFile).modify("openai", async () => ({ type: "api_key", key: "existing-key" }));
  const interaction: RunnerSetupInteraction = {
    select: async ({ title, choices }) => {
      if (title === "Choose a provider") return "openai";
      if (title === "Choose a model") return choices.find((choice) => choice.value === "gpt-5.5")!.value;
      throw new Error(`unexpected authentication prompt: ${title}`);
    },
    input: async ({ title }) => { throw new Error(`unexpected input: ${title}`); },
    notify: () => undefined,
  };
  const result = await piRunnerConfigurator().runCommand!("model", [], { provider: "faux", model: "faux-goah", authFile, authMode: "local" }, interaction);
  assert.deepEqual(result.config, { provider: "openai", model: "gpt-5.5", thinking: "medium", authFile, authMode: "stored-key" });
});

test("switching to a provider without credentials requires authentication before saving",async()=>{const directory=mkdtempSync(join(tmpdir(),"goah-model-requires-auth-"));const authFile=join(directory,"auth.json");const interaction:RunnerSetupInteraction={select:async({title,choices})=>{if(title==="Choose a provider")return"cloudflare-workers-ai";if(title==="Choose a model")return choices[0]!.value;if(title==="Authentication")return"key";return null;},input:async({secret})=>secret?"cloudflare-test-key":null,notify:()=>undefined};const result=await piRunnerConfigurator().runCommand!("model",[],{provider:"faux",model:"faux-goah",authFile,authMode:"local"},interaction);assert.equal((result.config as {provider:string}).provider,"cloudflare-workers-ai");assert.equal((result.config as {authMode:string}).authMode,"stored-key");assert.deepEqual(await new JsonCredentialStore(authFile).read("cloudflare-workers-ai"),{type:"api_key",key:"cloudflare-test-key"});});

test("model switch rejects an environment reference that is not actually set",async()=>{const directory=mkdtempSync(join(tmpdir(),"goah-model-missing-env-"));const authFile=join(directory,"auth.json");delete process.env.GOAH_TEST_MISSING_API_KEY;const interaction:RunnerSetupInteraction={select:async({title,choices})=>{if(title==="Choose a provider")return"openai";if(title==="Choose a model")return choices.find((choice)=>choice.value==="gpt-5.5")!.value;if(title==="Authentication")return"env";return null;},input:async({title})=>title==="Environment variable"?"GOAH_TEST_MISSING_API_KEY":null,notify:()=>undefined};await assert.rejects(piRunnerConfigurator().runCommand!("model",[],{provider:"faux",model:"faux-goah",authFile,authMode:"local"},interaction),/is not set/);});

test("auth login command supports API keys without running model setup", async () => {
  const previous = process.env.GOAH_STATE_HOME;
  const state = mkdtempSync(join(tmpdir(), "goah-command-auth-"));
  process.env.GOAH_STATE_HOME = state;
  try {
    const interaction: RunnerSetupInteraction = {
      select: async ({ title }) => title === "Authentication" ? "key" : null,
      input: async ({ secret }) => secret ? "command-test-key" : null,
      notify: () => undefined,
    };
    const result = await piRunnerConfigurator().runCommand!("auth", ["login", "zai"], { provider: "zai", model: "glm-5.3", authMode: "unconfigured" }, interaction);
    assert.equal((result.config as { authMode: string }).authMode, "stored-key");
    assert.deepEqual(await new JsonCredentialStore(join(state, "auth.json")).read("zai"), { type: "api_key", key: "command-test-key" });
  } finally {
    if (previous === undefined) delete process.env.GOAH_STATE_HOME; else process.env.GOAH_STATE_HOME = previous;
  }
});

test("scoped auth refuses a concurrent update to the same provider", async () => {
  const directory = mkdtempSync(join(tmpdir(), "goah-auth-provider-cas-")); const authFile = join(directory, "auth.json"); const store = new JsonCredentialStore(authFile);
  await store.modify("zai", async () => ({ type: "api_key", key: "old" }));
  const inputReady = Promise.withResolvers<void>(); const releaseInput = Promise.withResolvers<void>();
  const command = piRunnerConfigurator().runCommand!("auth", ["login", "zai"], { provider: "zai", model: "glm", authFile }, { select: async () => "key", input: async () => { inputReady.resolve(); await releaseInput.promise; return "command"; }, notify: () => undefined });
  await inputReady.promise; await store.modify("zai", async () => ({ type: "api_key", key: "concurrent" })); releaseInput.resolve();
  await assert.rejects(command, /changed in another process/);
  assert.equal((await store.read("zai") as { key: string }).key, "concurrent");
});

test("explicit model use accepts faux and custom provider ids", async () => {
  const directory=mkdtempSync(join(tmpdir(),"goah-explicit-model-auth-"));const authFile=join(directory,"auth.json");await new JsonCredentialStore(authFile).modify("team-gateway",async()=>({type:"api_key",key:"gateway-key"}));
  const interaction: RunnerSetupInteraction = { select: async () => null, input: async () => null, notify: () => undefined };
  const faux = await piRunnerConfigurator().runCommand!("model", ["use", "faux/faux-goah"], { provider: "team-gateway", model: "fast-v1", baseUrl: "https://models.example.test/v1", api: "openai-responses",authFile,authMode:"stored-key" }, interaction);
  assert.equal((faux.config as { provider: string }).provider, "faux");
  assert.equal((faux.config as { baseUrl?: string }).baseUrl, undefined);
  const custom = await piRunnerConfigurator().runCommand!("model", ["use", "team-gateway/fast-v2"], { provider: "team-gateway", model: "fast-v1", baseUrl: "https://models.example.test/v1", api: "openai-responses",authFile,authMode:"stored-key" }, interaction);
  assert.deepEqual(custom.config, { provider: "team-gateway", model: "fast-v2", baseUrl: "https://models.example.test/v1", api: "openai-responses",authFile,authMode:"stored-key" });
  await assert.rejects(piRunnerConfigurator().runCommand!("model", ["use", "other-gateway/model"], { provider: "team-gateway", model: "fast-v1", baseUrl: "https://models.example.test/v1",authFile }, interaction), /Unknown provider/);
});

test("logout updates stored auth state and is honest about environment auth", async () => {
  const previous = process.env.GOAH_STATE_HOME;
  const state = mkdtempSync(join(tmpdir(), "goah-command-logout-")); process.env.GOAH_STATE_HOME = state;
  try {
    const store = new JsonCredentialStore(join(state, "auth.json"));
    await store.modify("zai", async () => ({ type: "api_key", key: "private" }));
    await store.modify("openai", async () => ({ type: "api_key", key: "openai-private" }));
    await store.modify("retired-gateway", async () => ({ type: "api_key", key: "gateway-private" }));
    const interaction: RunnerSetupInteraction = { select: async () => null, input: async () => null, notify: () => undefined };
    const stored = await piRunnerConfigurator().runCommand!("auth", ["logout", "zai"], { provider: "zai", model: "glm", authMode: "stored-key" }, interaction);
    assert.equal((stored.config as { authMode: string }).authMode, "unconfigured");
    assert.equal(await store.read("zai"), undefined);
    const env = await piRunnerConfigurator().runCommand!("auth", ["logout", "zai"], { provider: "zai", model: "glm", authMode: "environment", apiKeyEnv: "ZAI_API_KEY" }, interaction);
    assert.equal(env.config, undefined);
    assert.match(env.output[0]!, /unset it in your shell/);
    const switched = await piRunnerConfigurator().runCommand!("model", ["use", "openai/gpt-5.5"], { provider: "faux", model: "faux-goah", authMode: "local" }, interaction);
    assert.equal((switched.config as { authMode: string }).authMode, "stored-key");
    const listed = await piRunnerConfigurator().runCommand!("auth", ["list"], { provider: "zai", model: "glm", authMode: "unconfigured" }, interaction);
    assert.match(listed.output.join("\n"), /retired-gateway/);
    await piRunnerConfigurator().runCommand!("auth", ["logout", "retired-gateway"], { provider: "zai", model: "glm", authMode: "unconfigured" }, interaction);
    assert.equal(await store.read("retired-gateway"), undefined);
  } finally { if (previous === undefined) delete process.env.GOAH_STATE_HOME; else process.env.GOAH_STATE_HOME = previous; }
});

test("non-current providers do not offer an unpersistable environment reference", async () => {
  let authChoices: string[] = [];
  const interaction: RunnerSetupInteraction = {
    select: async ({ title, choices }) => { if (title === "Authentication") { authChoices = choices.map((choice) => choice.value); return "back"; } return null; },
    input: async () => null,
    notify: () => undefined,
  };
  await piRunnerConfigurator().runCommand!("auth", ["login", "openai"], { provider: "zai", model: "glm" }, interaction);
  assert.equal(authChoices.includes("env"), false);
  await assert.rejects(piRunnerConfigurator().runCommand!("auth", ["login", "typo-provider"], { provider: "zai", model: "glm" }, interaction), /Unknown provider/);
});

test("auth status is scoped to the requested provider", async () => {
  const interaction: RunnerSetupInteraction = { select: async () => null, input: async () => null, notify: () => undefined };
  const result = await piRunnerConfigurator().runCommand!("auth", ["status", "zai"], { provider: "zai", model: "glm", authMode: "unconfigured" }, interaction);
  assert.equal(result.output.length, 1);
  assert.match(result.output[0]!, /zai/);
});

test("faux remains a local provider in authentication flows", async () => {
  const interaction: RunnerSetupInteraction = { select: async () => null, input: async () => null, notify: () => undefined };
  const login = await piRunnerConfigurator().runCommand!("auth", ["login", "faux"], { provider: "faux", model: "faux-goah", authMode: "local" }, interaction);
  assert.match(login.output[0]!, /does not require authentication/);
  const logout = await piRunnerConfigurator().runCommand!("auth", ["logout", "faux"], { provider: "faux", model: "faux-goah", authMode: "local" }, interaction);
  assert.equal(logout.config, undefined);
  assert.match(logout.output[0]!, /does not use stored credentials/);
});

test("legacy pasted credentials are removed from environment-variable config without being echoed", () => {
  const config = piConfig({ provider: "zai", model: "glm", apiKeyEnv: "secret-value-ZAI_API_KEY" });
  assert.equal(config.apiKeyEnv, undefined);
  const serialized = JSON.stringify(piEnvironment(config));
  assert.doesNotMatch(serialized, /secret-value/);
  assert.match(serialized, /ZAI_API_KEY/);
});

test("setup stores a pasted API key privately through a masked interaction", async () => {
  const previous = process.env.GOAH_STATE_HOME;
  const state = mkdtempSync(join(tmpdir(), "goah-setup-auth-"));
  process.env.GOAH_STATE_HOME = state;
  let secretPrompt = false;
  try {
    const interaction: RunnerSetupInteraction = {
      select: async ({ title, choices }) => title.includes("provider") ? "zai" : title.includes("model") ? choices[0]!.value : title === "Authentication" ? "key" : null,
      input: async ({ secret }) => { secretPrompt = Boolean(secret); return secret ? "private-test-key" : null; },
      notify: () => undefined,
    };
    const config = await piRunnerConfigurator().setup(null, interaction) as { authMode: string; apiKeyEnv?: string };
    assert.equal(secretPrompt, true);
    assert.equal(config.authMode, "stored-key");
    assert.equal(config.apiKeyEnv, undefined);
    const stored = await new JsonCredentialStore(join(state, "auth.json")).read("zai") as { type: string; key?: string };
    assert.deepEqual(stored, { type: "api_key", key: "private-test-key" });
  } finally {
    if (previous === undefined) delete process.env.GOAH_STATE_HOME; else process.env.GOAH_STATE_HOME = previous;
  }
});

test("setup transaction rolls credential changes back on cancel", async () => {
  const previous = process.env.GOAH_STATE_HOME; const state = mkdtempSync(join(tmpdir(), "goah-setup-rollback-")); process.env.GOAH_STATE_HOME = state;
  try {
    const interaction: RunnerSetupInteraction = {
      select: async ({ title, choices }) => title.includes("provider") ? "zai" : title.includes("model") ? choices[0]!.value : title === "Authentication" ? "key" : null,
      input: async ({ secret }) => secret ? "temporary-key" : null,
      notify: () => undefined,
    };
    const configurator = piRunnerConfigurator(); const transaction = await configurator.beginSetup!(null, interaction);
    assert.equal((transaction.config as { authMode: string }).authMode, "stored-key");
    assert.equal(await new JsonCredentialStore(join(state, "auth.json")).read("zai"), undefined);
    await transaction.rollback();
    assert.equal(await new JsonCredentialStore(join(state, "auth.json")).read("zai"), undefined);
    const committed = await configurator.beginSetup!(null, interaction);
    const committedConfig = await committed.commit();
    assert.equal((committedConfig as { authFile: string }).authFile, join(state, "auth.json"));
    assert.equal((await new JsonCredentialStore(join(state, "auth.json")).read("zai") as { key: string }).key, "temporary-key");
    await committed.rollback();
    assert.equal(await new JsonCredentialStore(join(state, "auth.json")).read("zai"), undefined);
  } finally { if (previous === undefined) delete process.env.GOAH_STATE_HOME; else process.env.GOAH_STATE_HOME = previous; }
});

test("setup transaction refuses to overwrite concurrent credential changes", async () => {
  const previous = process.env.GOAH_STATE_HOME; const state = mkdtempSync(join(tmpdir(), "goah-setup-conflict-")); process.env.GOAH_STATE_HOME = state;
  try {
    const interaction: RunnerSetupInteraction = {
      select: async ({ title, choices }) => title.includes("provider") ? "zai" : title.includes("model") ? choices[0]!.value : title === "Authentication" ? "key" : null,
      input: async ({ secret }) => secret ? "staged-key" : null,
      notify: () => undefined,
    };
    const transaction = await piRunnerConfigurator().beginSetup!(null, interaction);
    const realStore = new JsonCredentialStore(join(state, "auth.json")); await realStore.modify("openai", async () => ({ type: "api_key", key: "concurrent-key" }));
    await assert.rejects(transaction.commit(), /changed in another process/);
    assert.equal((await realStore.read("openai") as { key: string }).key, "concurrent-key");
    assert.equal(await realStore.read("zai"), undefined);
  } finally { if (previous === undefined) delete process.env.GOAH_STATE_HOME; else process.env.GOAH_STATE_HOME = previous; }
});

test("Pi ProcessRunner keeps the full credential store outside the worker environment", () => {
  const runner = createPiProcessRunner({ provider: "openai", model: "gpt-5.5", apiKeyEnv: "PRIVATE_OPENAI_KEY" }, process.cwd());
  assert.equal(runner.options.envSpec?.GOAH_PI_AUTH_FILE, "");
  assert.equal(runner.options.envSpec?.OPENAI_API_KEY, undefined);
  assert.equal(typeof runner.options.prepareRuntime, "function");
});

test("Pi doctor reports the Bash sandbox backend", async () => {
  const checks = await piRunnerConfigurator().doctor({ provider: "faux", model: "faux-goah", authMode: "local" });
  assert.match(checks.find((check) => check.name === "bash-sandbox")!.detail, /sandbox-exec|bubblewrap|unavailable/);
});

test("Pi custom endpoints are runner-local overlays", () => {
  const configured = createPiModel("team-gateway", "fast-model", { GOAH_PI_BASE_URL: "https://models.example.test/v1", GOAH_PI_API: "openai-responses", GOAH_PI_CONTEXT_WINDOW_TOKENS: "64000", GOAH_PI_AUTH_FILE: "" });
  assert.equal(configured.model.provider, "team-gateway");
  assert.equal(configured.model.contextWindow, 64_000);
});

test("credential store persists only in its private file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "goah-auth-"));
  const path = join(directory, "auth.json");
  const store = new JsonCredentialStore(path);
  await store.modify("openai-codex", async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }));
  assert.deepEqual(await store.list(), [{ providerId: "openai-codex", type: "oauth" }]);
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  await store.delete("openai-codex");
  assert.deepEqual(await store.list(), []);
});

test("credential store serializes read-modify-write across instances", async () => {
  const directory = mkdtempSync(join(tmpdir(), "goah-auth-lock-")); const path = join(directory, "auth.json");
  const first = new JsonCredentialStore(path); const second = new JsonCredentialStore(path);
  await Promise.all([
    first.modify("one", async () => { await new Promise((resolve) => setTimeout(resolve, 50)); return { type: "api_key", key: "first" }; }),
    second.modify("two", async () => ({ type: "api_key", key: "second" })),
  ]);
  assert.equal((await first.read("one") as { key: string }).key, "first");
  assert.equal((await first.read("two") as { key: string }).key, "second");
});

test("credential store reclaims only a lock owned by a dead process", async () => {
  const directory = mkdtempSync(join(tmpdir(), "goah-auth-stale-lock-")); const path = join(directory, "auth.json"); const lock = `${path}.lock`;
  mkdirSync(lock); writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: 999_999_999, token: "dead" }));
  const store = new JsonCredentialStore(path);
  await store.modify("openai", async () => ({ type: "api_key", key: "recovered" }));
  assert.equal((await store.read("openai") as { key: string }).key, "recovered");
});

test("credential store does not overwrite malformed data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "goah-auth-malformed-")); const path = join(directory, "auth.json"); writeFileSync(path, "not-json");
  const store = new JsonCredentialStore(path);
  await assert.rejects(store.modify("one", async () => ({ type: "api_key", key: "new" })), /JSON/);
  assert.equal(readFileSync(path, "utf8"), "not-json");
});
