import assert from "node:assert/strict";
import test from "node:test";
import type { RunRequest, Runner, RunnerResult, WakeSnapshot } from "goah-ledger-contract";
import { RunnerRouter } from "./index.js";

const wake: WakeSnapshot = { id: "w", agent: "ceo", triggerRef: "test", status: "running", leaseUntil: null, attempt: 1, startedAt: null, endedAt: null, enqueuedSeq: 1, leaseToken: null, runnerPid: null };

function taggedRunner(tag: string): Runner {
  return {
    isolation: "process",
    prepare: () => ({ pid: null, begin: () => undefined, result: Promise.resolve({ outcome: "abnormal", reason: tag } satisfies RunnerResult), terminate: async () => undefined }),
    terminateProcess: async () => undefined,
  };
}

test("RunnerRouter selects by opaque Runner Profile without knowing provider or model", async () => {
  const router = new RunnerRouter(new Map([["ceo", taggedRunner("ceo-runner")], ["worker", taggedRunner("worker-runner")]]));
  const request = { agent:wake.agent,sourceWake:wake,execution:{ id:wake.id,threadId:"thread",source:"system",goalId:null,goalRevision:null,status:"in_progress",error:null,startedAt:"2026-08-18T00:00:00.000Z",endedAt:null,leaseUntil:wake.leaseUntil,leaseToken:wake.leaseToken,runnerPid:null }, turn: { source: { kind: "system", reason: "test" } }, context: { runnerProfile: { id: "worker", runner: "anything", config: { opaque: true } } }, now: () => "", emit: () => undefined } satisfies RunRequest;
  const handle = router.prepare(request);
  handle.begin();
  assert.deepEqual(await handle.result, { outcome: "abnormal", reason: "worker-runner" });
});
