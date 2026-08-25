# Goah Architecture

Status: current
Date: 2026-08-25

Goah is a Goal-oriented Agent Harness with a normal interactive CEO surface. The complete Goal operating model is defined in [Goal-bound Agent Operating Model](./proposals/goal-bound-agent-operating-model.md). [ADR 0012](./adr/0012-unified-thread-turn-item-runtime.md) defines the unified Thread/Turn/Item runtime; [ADR 0011](./adr/0011-goal-bound-turns-and-work-record-filesystem.md) defines Goal binding and Work Records.

## Product boundary

Goah does not replace an Agent Runner. Runner owns its Agent loop, provider/model registry, credentials, compaction, and local execution. Goah owns durable coordination around it:

```text
Human / TUI
    │ turn.start / turn.steer / turn.interrupt
    ▼
CEO Thread
    └── Turn
        ├── user / reasoning / assistant Items
        ├── tool call / result Items
        └── optional Goal binding
              ├── Work Record revision
              ├── Child Goal organization
              └── compact Goal Handoff

Goal ── Wake ──► Goal-bound Turn in the owner's Thread

Supervisor + Ledger ──► Runner-owned agent loop
```

Ordinary interaction is not weakened Goal execution; it is an unbound surface. Once a Turn acquires a Goal binding, strict Goal invariants apply.

## Layers

### Ledger Kernel

Append-only typed events with global `seq`, per-stream `streamSeq`, atomic append, replay, and future-version refusal. It does not decide Goal or Runner policy.

### Replayable Thread, Turn, and Item

A Thread is a durable Goah conversation, not a provider thread. Turns are the sole execution identity. Normalized user, assistant, reasoning, tool, request, compaction, completion, and interruption Items reconstruct what the model saw and did. Open tool calls become explicit `unknown` outcomes after interruption.

### Execution modules

Current projections are rebuilt from events:

- Threads
- Turns
- Turn Items
- Goals
- Work Records
- Schedule
- Wakes
- Mailbox
- Actions

Handoff remains an event-level control result rather than a current-state projection.

### Supervisor

The only Ledger writer in the resident process. It validates Turn ownership and terminal state, Goal and Work Record revisions, leases, capabilities, atomic delegation, Action gates, scheduling, recovery, and Human priority. Human input starts or steers a Turn directly. Mail is reserved for asynchronous Agent communication and Human decisions. Wake is reserved for future Goal/system motion.

Wake status is scheduling-only: `queued → claimed → consumed`, with `cancelled` as the pending terminal path. Claiming is blocked while any Human Turn is active. Once the Turn is durably created, Wake records its `turnId` and no longer participates in execution.

### Runner

Receives a `RunRequest` containing Turn identity, source, optional Goal binding, bounded context, Runner Profile, trace sink, and role-scoped RPC. It emits normalized Turn Items and runner terminal events. Supervisor validates policy and commits the Turn terminal status.

## Core invariants

1. Ledger is the only durable fact authority; projections are disposable.
2. Every Goal-bound Turn updates its Goal Work Record under the current Goal revision.
3. Every Child Agent owns a Child Goal with observation and verification methods.
4. Every Goal Agent can read every Work Record; write authority follows Goal ownership and parent authority.
5. Human authorizes Root purpose and final completion.
6. CEO controls Child Goal decomposition, ownership, verification, and completion.
7. Goal Handoff points to Work Record revision instead of duplicating semantic prose.
8. An in-progress Human Turn prevents new automatic Goal Turns from starting.
9. External Actions preserve evidence, approval, `unknown`, and query-based reconciliation semantics.
10. Provider/model/auth semantics stay inside each Runner.

## State and continuity

```text
Ledger events     exact facts and global history
Goal projection   current objective, methods, owner, phase, revision
Work Record FS    current semantic understanding plus version timeline
Thread/Turn Items exact model conversation and tool trace
Handoff           Goal/record revision, outcome, evidence, next motion
```

Legacy narrative Handoffs and `memory.appended` facts remain readable. Schema v9 deterministically seeds Work Records from them. CEO and Child Goal Agents then use Work Record as their sole semantic continuity mechanism.

## Failure model

- A stale Goal or Work Record revision is rejected.
- A Goal Turn without a current-Turn Work Record update is abnormal.
- Failed/interrupted Turns do not consume undelivered asynchronous Mail.
- Committed Work Record versions survive later Turn failure.
- Sliding lease expiry fences and terminates stale Runner ownership before recovery.
- An interrupted external side effect becomes `unknown`, never silently retried.
- Delegation and reassignment are idempotent atomic transactions.

## Historical documents

- [`Goah-架构设计-v2.html`](../Goah-%E6%9E%B6%E6%9E%84%E8%AE%BE%E8%AE%A1-v2.html) — previous implemented architecture.
- [`Goah-CEO-Agent-Operating-Layer.html`](../Goah-CEO-Agent-Operating-Layer.html) — previous universal CEO Wake policy.
- [`北辰-harness-设计稿.html`](../%E5%8C%97%E8%BE%B0-harness-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) — historical v0.10 proposal.
