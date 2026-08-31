import assert from "node:assert/strict";
import test from "node:test";
import {
  specialistAutomaticTarget,
  type RunRequest,
  type Runner,
  type RunnerCandidateResult,
  type WakeSnapshot,
} from "goah-ledger-contract";
import { RunnerRouter, Supervisor } from "./index.js";

const wake: WakeSnapshot = {
  id: "w",
  ...specialistAutomaticTarget("worker", "verifier"),
  triggerRef: "test",
  status: "consumed",
  attempt: 1,
  enqueuedSeq: 1,
  claimedAt: null,
  consumedAt: null,
  turnId: "turn",
};

function taggedRunner(tag: string): Runner {
  return {
    isolation: "process",
    prepare: () => ({
      pid: null,
      begin: () => undefined,
      result: Promise.resolve({ outcome: "abnormal", reason: tag } satisfies RunnerCandidateResult),
      terminate: async () => undefined,
    }),
    terminateProcess: async () => undefined,
  };
}

test("RunnerRouter selects by opaque Runner Profile without knowing provider or model", async () => {
  const router = new RunnerRouter(
    new Map([
      ["ceo", taggedRunner("ceo-runner")],
      ["worker", taggedRunner("worker-runner")],
    ]),
  );
  const request = {
    agent: wake.agent,
    sourceWake: wake,
    execution: {
      id: "turn",
      threadId: "thread",
      triggerKind: "wake",
      goalId: null,
      goalRevision: null,
      status: "in_progress",
      attempt: 1,
      error: null,
      startedAt: "2026-08-18T00:00:00.000Z",
      endedAt: null,
      leaseUntil: null,
      leaseToken: null,
      runnerPid: null,
    },
    turn: { trigger: { kind: "wake", reasons: ["test"] }, activeGoal: null, goalCommitment: null },
    context: { runnerProfile: { id: "worker", runner: "anything", config: { opaque: true } } },
    now: () => "",
    emit: () => undefined,
  } satisfies RunRequest;
  const handle = router.prepare(request);
  handle.begin();
  assert.deepEqual(await handle.result, { outcome: "abnormal", reason: "worker-runner" });
});

test("RunnerRouter resolves persisted Runner Profile ownership after restart", async () => {
  let terminated = 0;
  const runner: Runner = {
    ...taggedRunner("worker"),
    terminateProcess: async (pid) => {
      assert.equal(pid, 42);
      terminated += 1;
    },
  };
  const router = new RunnerRouter(new Map([["worker", runner]]));
  await router.terminateProcess(42, "worker");
  assert.equal(terminated, 1);
});

test("Supervisor configuration has exactly one primary CEO identity", () => {
  const ledger = { threads: () => [] } as never;
  const runner = taggedRunner("unused");
  const clock = { now: () => new Date() };
  assert.throws(
    () => new Supervisor(ledger, runner, clock, { profiles: [{ agent: "ceo", role: "child" }] }),
    /exactly the ceo Agent/,
  );
  assert.throws(
    () => new Supervisor(ledger, runner, clock, { profiles: [{ agent: "other", role: "ceo" }] }),
    /exactly the ceo Agent/,
  );
});
