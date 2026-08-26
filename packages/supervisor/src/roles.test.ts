import assert from "node:assert/strict";
import test from "node:test";
import { defaultTurnPrompt } from "./roles.js";

test("default Turn prompts form one source and binding decision table", () => {
  const human = defaultTurnPrompt("ceo", "ceo", { source: { kind: "human" } });
  const goal = defaultTurnPrompt("child", "worker", { source: { kind: "goal", round: 1 }, goalBinding: { goalId: "child", goalRevision: 0 } });
  const verifier = defaultTurnPrompt("verifier", "verifier", { source: { kind: "system", reason: "mail:verify" } });
  assert.match(human, /Respond naturally to the Human/);
  assert.doesNotMatch(human, /Child Goal|durable Mail/);
  assert.throws(() => defaultTurnPrompt("child", "worker", { source: { kind: "system", reason: "mail:m1" } }), /cannot run an unbound system Turn/);
  assert.throws(() => defaultTurnPrompt("child", "worker", { source: { kind: "human" } }), /only the primary Agent/);
  assert.throws(() => defaultTurnPrompt("verifier", "verifier", { source: { kind: "goal", round: 1 }, goalBinding: { goalId: "child", goalRevision: 0 } }), /cannot bind a Goal/);
  assert.match(goal, /assigned Child Goal/);
  assert.doesNotMatch(goal, /not Goal-bound|Respond naturally to the Human/);
  assert.match(verifier, /Verify one Turn/);
  assert.match(verifier, /Goah specialist verifier/);
});
