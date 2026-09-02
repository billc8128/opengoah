import assert from "node:assert/strict";
import test from "node:test";
import { renderSetupHeader } from "./setup-wizard.js";
import { GOAH_TERMINAL_MARK, renderWelcome, type WelcomeSnapshot } from "./welcome.js";
import { stripAnsi } from "./tui-theme.js";

test("setup header shows an explicit step and concise task title", () => {
  const rendered = stripAnsi(
    renderSetupHeader("Choose a provider", "Search by name or ID.", { current: 2, total: 5 }),
  );
  assert.match(rendered, /GOAH\s+SETUP/);
  assert.match(rendered, /2\/5/);
  assert.match(rendered, /Choose a provider/);
});

test("scoped configuration surfaces have distinct identities", () => {
  assert.match(
    stripAnsi(renderSetupHeader("Choose a model", "", undefined, "MODEL")),
    /GOAH\s+MODEL/,
  );
  assert.doesNotMatch(
    stripAnsi(renderSetupHeader("Choose a model", "", undefined, "MODEL")),
    /SETUP|\d\/\d/,
  );
  assert.match(
    stripAnsi(renderSetupHeader("Authentication", "", undefined, "AUTH")),
    /GOAH\s+AUTH/,
  );
});

test("fresh-workspace welcome is compact and has no placeholder rows", () => {
  const snapshot: WelcomeSnapshot = {
    root: null,
    team: [],
    handoffs: [],
    turns: [],
    runner: "pi",
    target: "zai/glm",
  };
  const rendered = renderWelcome(snapshot, false).join("\n");
  assert.match(rendered, /Chat normally · \/goal for durable work · \/help/);
  assert.equal(GOAH_TERMINAL_MARK.length, 6);
  assert.match(GOAH_TERMINAL_MARK.join("\n"), /⣾|⣿/);
  assert.match(stripAnsi(rendered), /zai\/glm\s+· pi/);
  assert.doesNotMatch(rendered, /Agents:|Recent work:|Conversation:|  ·/);
});

test("active Goal state lives only in the fixed Goal bar, not the welcome transcript", () => {
  const snapshot: WelcomeSnapshot = {
    root: { id: "g", objective: "Do not duplicate me", phase: "active" },
    team: [],
    handoffs: [],
    turns: [],
    runner: "pi",
    target: "zai/glm",
  };
  assert.doesNotMatch(
    stripAnsi(renderWelcome(snapshot, true).join("\n")),
    /Do not duplicate me|ACTIVE GOAL/,
  );
});
