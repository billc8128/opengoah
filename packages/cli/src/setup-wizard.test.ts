import assert from "node:assert/strict";
import test from "node:test";
import { renderSetupHeader } from "./setup-wizard.js";
import { renderWelcome, type WelcomeSnapshot } from "./welcome.js";

test("setup header shows an explicit step and concise task title", () => {
  const rendered = renderSetupHeader("Choose a provider", "Search by name or ID.", { current: 2, total: 5 });
  assert.match(rendered, /GOAH\s+SETUP/);
  assert.match(rendered, /2\/5/);
  assert.match(rendered, /Choose a provider/);
});

test("fresh-workspace welcome is compact and has no placeholder rows", () => {
  const snapshot: WelcomeSnapshot = { root: null, team: [], handoffs: [], conversation: [], runner: "pi", target: "zai/glm" };
  const rendered = renderWelcome(snapshot, false).join("\n");
  assert.match(rendered, /Chat normally, or use \/goal/);
  assert.doesNotMatch(rendered, /Agents:|Recent work:|Conversation:|  ·/);
});
