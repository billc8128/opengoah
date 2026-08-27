import { specialistBinding, type RunRequest } from "goah-ledger-contract";

/** Minimal RunRequest for ProcessRunner tests: trace emits are dropped. */
export function wakeContext(): RunRequest {
  const sourceWake = { id: "test-wake", ...specialistBinding("worker","verifier"), triggerRef: "test", status: "queued" as const, attempt: 0, enqueuedSeq: 0, claimedAt:null,consumedAt:null,turnId:null };
  return {
    agent:"worker",sourceWake,execution:{ id:"test-turn",threadId:"test-thread",source:"system",bindingKind:"specialist",goalId:null,goalRevision:null,specialistRole:"verifier",status:"in_progress",attempt:1,error:null,startedAt:new Date().toISOString(),endedAt:null,leaseUntil:null,leaseToken:null,runnerPid:null },
    turn: { source: { kind: "system", reason: "test" } },
    context: {},
    now: () => new Date().toISOString(),
    emit: () => undefined,
  };
}
