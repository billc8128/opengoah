import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RunnerSetupInteraction } from "goah-ledger-contract";
import { JsonCredentialStore } from "./credential-store.js";
import { createPiProcessRunner, piRunnerConfigurator } from "./configurator.js";
import { createPiModel } from "./model-provider.js";

test("Pi configurator owns provider, model, and auth choices", async () => {
  const choices = ["openai", "gpt-5.5", "existing"];
  const interaction: RunnerSetupInteraction = {
    select: async () => choices.shift() ?? null,
    input: async () => null,
    notify: () => undefined,
  };
  const config = await piRunnerConfigurator().setup(null, interaction) as { provider: string; model: string };
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "gpt-5.5");
});

test("Pi ProcessRunner keeps the full credential store outside the worker environment", () => {
  const runner = createPiProcessRunner({ provider: "openai", model: "gpt-5.5", apiKeyEnv: "PRIVATE_OPENAI_KEY" }, process.cwd());
  assert.equal(runner.options.envSpec?.GOAH_PI_AUTH_FILE, "");
  assert.equal(runner.options.envSpec?.OPENAI_API_KEY, undefined);
  assert.equal(typeof runner.options.prepareRuntime, "function");
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
