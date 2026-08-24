# ADR 0010: Event-sourced working memory for cross-wake continuity

Status: accepted
Date: 2026-08-22

Superseded in part by ADR 0011: Goal semantic continuity now lives in Work Record; legacy memory remains readable.

## Context

Each Wake runs an independent Session, and the structured Handoff is the only first-class carrier of cross-wake operational knowledge. That boundary is deliberate (bounded, auditable, projection-derived), but it is lossy in a specific way: procedural knowledge ("this repository's tests fake-fail under a mocked clock"), working hypotheses, and abandoned approaches with their rejection reasons do not fit `observations/results/nextSteps` naturally and are usually dropped. Consequences are repeated cold-start exploration and a real oscillation risk — Wake N abandons approach A, Wake N+2 tries it again because only the summary survived.

We considered four architectures for continuity:

1. **Provider-side session resume** (`previous_response_id`-style chaining). The continuity state lives on the provider's servers. Rejected: the assembled model-visible context is produced by their request-time pipeline (truncation, summarization, encrypted reasoning items), so `request.prepared` can record only our deltas plus a pointer — an audit story built on values we do not own. Stored state is mutable under their retention policy (commonly ~30 days), which is shorter than Goal horizons, and the semantics are provider-specific.
2. **Mirroring provider session state into our storage.** Rejected as an audit mechanism: the mirror is second-hand evidence with no fidelity contract, unreadable encrypted regions, and no guarantee that the retrieved rendering equals the model-visible context at call time. Periodic fetches remain acceptable disaster-hygiene backups, but they cannot restore the audit guarantee.
3. **Transcript as the source of truth.** Rejected: an append-only transcript is an untyped ledger. Deriving current state requires parsing tool calls and trusting prose; compaction destroys evidence unless an uncompacted archive is kept (which is the ledger again); multi-agent shared facts have no single-writer arbitration or global ordering; and invariants (revision barriers, idempotency gates) cannot live inside messages — a message can inform, only a state machine can prevent.
4. **Resume-as-replay of our own transcript.** Acceptable, but once the replayed history must be canonicalized, bounded, and auditable, it converges to representing the injected tail as typed facts — which is this ADR.

## Decision

- Every agent owns a `memory:{agent}` event stream. A role-scoped `memory.append` RPC appends `memory.appended` facts (`{ note, wakeId }`) through the existing lease/capability validation path; the RPC request is also traced into the Wake stream as `rpc.memory.append`.
- `composeActiveContext` injects a bounded Working-memory tail: the newest notes within a character budget (`SupervisorOptions.memoryTailChars`, default 12,000). Selection is a pure function of events (`selectWorkingMemory`), so replay stays deterministic.
- The memory stream is never compacted. Only the injected tail is bounded; everything not injected remains queryable ledger evidence, and every injected note carries `[event:seq]` provenance.
- Working memory is advisory. Authoritative state still comes from projections, and gates (revision barriers, idempotency constraints, capability checks) still enforce at write time. A stale or poisoned note's blast radius is bounded by the tail.
- The Handoff keeps its role as the structured milestone record; memory is the agent's durable working state, not a second goal model. Notes are inspectable with `goah memory AGENT [--tail N]`.

## Consequences

Agents gain continuity (procedural knowledge, hypotheses, rejected approaches) without sacrificing the four ledger guarantees: the model-visible context value is born under our control, "what was not injected" is derivable from the retained stream, world changes are enforced by gates rather than trusted to prompts, and the tail can be dropped and rebuilt from events at any time. The evaluator of a decision along this axis can apply four questions: does the state live as a value we hold or a pointer we follow; is forgetting recorded as our fact or someone's black box; are world changes enforced or merely announced; and can the state be rebuilt from the ledger. Provider session resume answers those questions the wrong way; event-sourced working memory answers all four correctly.
