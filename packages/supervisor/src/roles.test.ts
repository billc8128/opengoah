import assert from "node:assert/strict";
import test from "node:test";
import { defaultTurnPrompt } from "./roles.js";

test("default Turn prompts separate role from Goal commitment", () => {
  const activeGoal={id:"root",parentId:null,objective:"work",observationMethod:null,verificationMethod:null,owner:"ceo",phase:"active" as const,revision:0};
  const childGoal={...activeGoal,id:"child",parentId:"root",owner:"worker",observationMethod:"observe",verificationMethod:"verify"};
  const human = defaultTurnPrompt("ceo", "ceo", { trigger: { kind: "user_message" },activeGoal,goalCommitment:null });
  const goal = defaultTurnPrompt("child", "worker", { trigger: { kind: "wake",reasons:["goal"] },activeGoal:childGoal,goalCommitment: { goalId: "child", goalRevision: 0 } });
  const verifier = defaultTurnPrompt("verifier", "verifier", { trigger: { kind: "wake",reasons:["mail:verify"] },activeGoal:null,goalCommitment:null });
  assert.match(human, /Respond naturally to the Human/);
  assert.doesNotMatch(human, /Child Goal|durable Mail/);
  assert.throws(() => defaultTurnPrompt("child", "worker", { trigger: { kind: "wake",reasons:["mail:m1"] },activeGoal:childGoal,goalCommitment:null }), /require a Goal commitment/);
  assert.throws(() => defaultTurnPrompt("verifier", "verifier", { trigger: { kind: "wake",reasons:["goal"] },activeGoal:childGoal,goalCommitment: { goalId: "child", goalRevision: 0 } }), /cannot commit to a Goal/);
  assert.match(goal, /assigned Child Goal/);
  assert.doesNotMatch(goal, /not Goal-bound|Respond naturally to the Human/);
  assert.match(verifier, /Verify one Turn/);
  assert.match(verifier, /Goah specialist verifier/);
});
