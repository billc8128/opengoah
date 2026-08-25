# Goah Architecture

Status: current
Date: 2026-08-25

Goah is a Goal-oriented Agent Harness with a normal interactive CEO surface. The complete Goal operating model, schemas, authority matrix, migration, and acceptance tests are defined in [Goal-bound Agent Operating Model](./proposals/goal-bound-agent-operating-model.md). [ADR 0011](./adr/0011-goal-bound-turns-and-work-record-filesystem.md) records the transition from the previous Wake-first interaction model.

## Product boundary

Goah does not replace an Agent Runner. Runner owns its Agent loop, provider/model registry, credentials, compaction, and local execution. Goah owns durable coordination around it:

```text
Human / TUI
    │
    ▼
CEO Agent
    ├── ordinary Turn ─────────────── response
    └── Goal-bound Turn
          ├── Goal lifecycle
          ├── Work Record revision
          ├── Child Goal organization
          └── compact Goal Handoff
                    │
                    ▼
          Supervisor + Ledger
                    │
                    ▼
                  Runner
```

Ordinary interaction is not weakened Goal execution; it is an unbound surface. Once a Turn acquires a Goal binding, strict Goal invariants apply.

## Layers

### Ledger Kernel

Append-only typed events with global `seq`, per-stream `streamSeq`, atomic append, replay, and future-version refusal. It does not decide Goal or Runner policy.

### Replayable Session

Normalized user, assistant, tool, request, compaction, completion, and interruption events reconstruct what the model saw and did. Open tool calls become explicit `unknown` outcomes after interruption.

### Execution modules

Six current projections are rebuilt from events:

- Goals
- Work Records
- Schedule
- Wakes
- Mailbox
- Actions

Handoff remains an event-level control result rather than a current-state projection.

### Supervisor

The only Ledger writer in the resident process. It validates authority, Goal and Work Record revisions, leases, capabilities, atomic delegation, Action gates, Mail acknowledgement, scheduling, recovery, and Human interaction priority. Human input preempts automatic CEO work; follow-ups steer an active Human Turn through an optional RunnerHandle channel while remaining durable Mail.

Human interaction Mail is decision-level control input. Accepted steering is attached to the active Turn; rejected, timed-out, or abnormal interaction Mail is redelivered through a new fenced Wake without creating a second Mail record.

### Runner

Receives a `RunRequest` containing immutable Turn source, optional Goal binding, bounded context, Runner Profile, trace sink, and role-scoped RPC. It returns ordinary response, Goal Handoff, or abnormal result.

## Core invariants

1. Ledger is the only durable fact authority; projections are disposable.
2. Every Goal-bound Turn updates its Goal Work Record under the current Goal revision.
3. Every Child Agent owns a Child Goal with observation and verification methods.
4. Every Goal Agent can read every Work Record; write authority follows Goal ownership and parent authority.
5. Human authorizes Root purpose and final completion.
6. CEO controls Child Goal decomposition, ownership, verification, and completion.
7. Goal Handoff points to Work Record revision instead of duplicating semantic prose.
8. Human interaction Wakes outrank queued automatic Goal Wakes.
9. External Actions preserve evidence, approval, `unknown`, and query-based reconciliation semantics.
10. Provider/model/auth semantics stay inside each Runner.

## State and continuity

```text
Ledger events     exact facts and global history
Goal projection   current objective, methods, owner, phase, revision
Work Record FS    current semantic understanding plus version timeline
Session events    exact model conversation and tool trace
Handoff           Goal/record revision, outcome, evidence, next motion
```

Legacy narrative Handoffs and `memory.appended` facts remain readable. Schema v9 deterministically seeds Work Records from them. CEO and Child Goal Agents then use Work Record as their sole semantic continuity mechanism.

## Failure model

- A stale Goal or Work Record revision is rejected.
- A Goal Turn without a current-Turn Work Record update is abnormal.
- Abnormal execution does not acknowledge Mail.
- Committed Work Record versions survive later Turn failure.
- Sliding lease expiry fences and terminates stale Runner ownership before recovery.
- An interrupted external side effect becomes `unknown`, never silently retried.
- Delegation and reassignment are idempotent atomic transactions.

## Historical documents

- [`Goah-架构设计-v2.html`](../Goah-%E6%9E%B6%E6%9E%84%E8%AE%BE%E8%AE%A1-v2.html) — previous implemented architecture.
- [`Goah-CEO-Agent-Operating-Layer.html`](../Goah-CEO-Agent-Operating-Layer.html) — previous universal CEO Wake policy.
- [`北辰-harness-设计稿.html`](../%E5%8C%97%E8%BE%B0-harness-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) — historical v0.10 proposal.
