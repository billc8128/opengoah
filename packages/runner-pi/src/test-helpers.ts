import type { RunRequest } from "goah-ledger-contract";

/** Minimal RunRequest for ProcessRunner tests: trace emits are dropped. */
export function wakeContext(): RunRequest {
  return {
    wake: { id: "test-wake", agent: "worker", triggerRef: "test", status: "queued", leaseUntil: null, attempt: 0, startedAt: null, endedAt: null, enqueuedSeq: 0, leaseToken: null, runnerPid: null },
    turn: { source: { kind: "system", reason: "test" } },
    context: {},
    now: () => new Date().toISOString(),
    emit: () => undefined,
  };
}
