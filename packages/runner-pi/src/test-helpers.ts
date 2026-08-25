import type { RunRequest } from "goah-ledger-contract";

/** Minimal RunRequest for ProcessRunner tests: trace emits are dropped. */
export function wakeContext(): RunRequest {
  const sourceWake = { id: "test-wake", agent: "worker", triggerRef: "test", status: "queued" as const, leaseUntil: null, attempt: 0, startedAt: null, endedAt: null, enqueuedSeq: 0, leaseToken: null, runnerPid: null };
  return {
    agent:"worker",sourceWake,execution:{ id:"test-turn",threadId:"test-thread",source:"system",goalId:null,goalRevision:null,status:"in_progress",error:null,startedAt:new Date().toISOString(),endedAt:null,leaseUntil:null,leaseToken:null,runnerPid:null },
    turn: { source: { kind: "system", reason: "test" } },
    context: {},
    now: () => new Date().toISOString(),
    emit: () => undefined,
  };
}
