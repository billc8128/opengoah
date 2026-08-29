# Goah Architecture

Status: current
Date: 2026-08-28

Goah is a Goal-oriented Agent Harness with a normal interactive CEO surface. The complete Goal operating model is defined in [Goal-bound Agent Operating Model](./proposals/goal-bound-agent-operating-model.md). [ADR 0012](./adr/0012-unified-thread-turn-item-runtime.md) defines the unified Thread/Turn/Item runtime; [ADR 0015](./adr/0015-goal-context-and-turn-commitment.md) separates visible Goal context from Turn commitment.

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
        └── optional Goal commitment
              ├── Work Record revision
              ├── Child Goal organization
              └── compact Goal Handoff

Goal ── Wake ──► committed Turn in the owner's Thread

Supervisor + Ledger ──► Runner-owned agent loop
```

Ordinary interaction is not weakened Goal execution. Every CEO Turn can see the active Root Goal, but strict Goal invariants apply only after the Turn acquires an explicit Goal commitment.

## Layers

### Ledger Kernel

Append-only typed events with global `seq`, per-stream `streamSeq`, atomic append, replay, and future-version refusal. It does not decide Goal or Runner policy.

### Replayable Thread, Turn, and Item

A Thread is a durable Goah conversation, not a provider thread. Turns are the sole execution identity. Normalized user, assistant, reasoning, tool, request, compaction, completion, and interruption Items reconstruct what the model saw and did. Open tool calls become explicit `unknown` outcomes after interruption. Assistant prose has exactly one authoritative representation: a completed Assistant Item. Runner completion returns only its `finalMessageId`; `response.committed`, Control output, and Handoff all reference or project that Item.

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

Handoff remains an event-level control result rather than a current-state projection. It never replaces user-readable prose: the Agent writes the Assistant Message, while Handoff carries only outcome and evidence. Each validation creates a monotonically increasing Turn-local `attemptId` and invalidates every older token before it can return accepted, rejected, or fatal. Pi intercepts Handoff with `beforeToolCall`; every Goal-capable Runner session must implement feedback-and-continue. Supervisor returns correctable invariant violations as Tool feedback and reserves hard termination for authority/fencing loss; once revoked, all later tools in that batch are blocked. Runner traces explicitly mark Message `commitState`, so UI never infers protocol state from provider content blocks. A successful commit atomically marks the existing Message committed, records Handoff, acknowledges Mail, and closes the Turn without imposing a working-order policy. Tokens bind attempt, Turn/lease, Goal fence, Message, and Handoff—not a transient Work Record revision; commit injects the final current-Turn record revision.

Every Goal lifecycle mutation has exactly one authoritative `goal.changed` event. The event carries operation, previous revision, complete next snapshot, reason, evidence, authority, and optional source Turn/Wake/idempotency key; the Goal table is rebuilt directly from those same events. Only the projection name is stored in private SQLite metadata; each typed event carries one authoritative snapshot. Raw and Runner events cannot carry projection writes, even when their business data contains fields named `projection` or `snapshot`. Replay validates event type, revision chain, evidence order, authority, causal Turn/Wake binding, and idempotency keys before applying a snapshot.

### Supervisor

The only Ledger writer in the resident process. It validates Turn ownership and terminal state, Goal and Work Record revisions, leases, capabilities, atomic delegation, scheduling, recovery, and Human priority. Human input starts or steers a Turn directly. Mail is the bounded, acknowledged delivery path for explicit asynchronous Agent communication, Human decisions, and Verification/Audit results. Wake is reserved for requested future Goal/system motion and runtime recovery.

Supervisor is a control plane, not the organization's decision maker. It may record facts, enforce ownership/fencing, deliver Mail, admit current Goal context, and recover failed execution. Goal observation and verification run inside Agents with ordinary tools; Core has no metric schema, collector, evaluator, or threshold policy. Supervisor must not decide whether a Goal needs decomposition, whether an Agent's plan remains useful after a Goal revision, or whether a Handoff contains enough organizational motion. Those decisions belong to Agents through context and tools; configurable prompts may advise them without turning that advice into Supervisor rejection logic.

Rejected Goal mutations have no execution side effects. A successful revision or reassignment commits its new fence before the old Turn is interrupted; reassignment also holds a Goal-level termination barrier so the new owner cannot start before the old Runner physically exits. The canonical current Root is the sole non-complete CEO Root returned by Supervisor read models—TUI and Console never infer it from Goal array order.

Supervisor admits one Turn model under stable Thread roles. Exactly the `ceo` Agent has the CEO role and is the only direct user-facing Thread. CEO owns Root Goals and never Child Goals; every Child owner is distinct from its parent owner and every Child Turn starts with a commitment to its owned Child Goal. Verifier/Audit Threads are Wake-triggered and uncommitted. Invalid combinations such as Child+user trigger, Child+uncommitted Wake, CEO+Child commitment, or specialist+Goal commitment are cancelled before a Runner starts. A configured Agent prompt replaces the default for its legal role; commitment adds only the Goal output constraint.

Wake status is scheduling-only: `queued → claimed → consumed`, with `cancelled` as the pending terminal path. Each Wake owns a durable trigger set; every trigger records source (`goal|system`) and `pending|resolved` state. Goal motion carries only `goalId`; queued motion survives Goal revisions, and Turn admission reads the current active Goal and freezes its current `goalRevision`. Coalescing never crosses Goal ids. Human input never creates a Wake. Claiming is blocked while any `user_message` Turn is active. Once the Turn is durably created, Wake records its `turnId` and resolves its triggers.

Turn routing is explicit without classifying Turns. Schema v27 stores canonical Agent role on Thread, reserves the `ceo` role for the `ceo` Agent, stores `user_message|wake` trigger on Turn, and stores an optional immutable Goal commitment fence on Turn. Human replacement atomically commits the optional Root Goal, old Turn terminal, new Turn, and initial Message. A terminal Turn may retain `runnerPid` only as cleanup ownership; the next Runner waits until cleanup releases it, and restart recovery kills any retained process. Wake and Schedule keep a discriminated automatic target of `goal(agent, goalId)` or `specialist(agent, verifier|audit)`; Human input starts or steers a CEO Turn directly and never creates a Wake. Goal-targeted admission freezes the current `goalRevision`. Recovery, Verification, stop, replay, and Wake consumption read Thread role, Turn trigger, commitment, and automatic target rather than reconstructing intent from Agent names. Mail separately stores one `MailRoute`: `goal`, `human_inbox`, `human_request`, or `specialist_inbox`.

Schedule has its own durable lifecycle: `pending → consumed|cancelled|superseded`. Creating the Wake and consuming the Schedule is one transaction. Goal revisions do not invalidate future motion: a due Schedule targets the current Goal. Moving a Goal out of active phase or changing its owner mechanically cancels its queued/claimed Wakes and supersedes its pending Schedules in the same Goal-change transaction.

Mail routing is envelope metadata, never business JSON. Agent-to-Agent Mail requires `goalId`; the route must name a Goal currently owned by the recipient, and a committed Turn receives only Mail routed to that Goal. Active routed Mail may trigger that owner's next committed Turn. Routed Mail for a paused/blocked Goal remains unread without motion until the parent explicitly resumes the Goal. Verification/Audit results remain in the CEO inbox for the next direct interaction and do not create a CEO system Turn. Unknown recipients are rejected, and Agent Mail cannot address Human. Handoff contains only declarative outcome/evidence, while Mail and Schedule effects are explicit Ledger facts. Reassigning an inactive Goal changes ownership and records routed decision Mail atomically, but returns no Wake.

Team read models keep mechanical `motion` separate from declarative `lastOutcome`; neither field drives Supervisor policy.

Recovery is the Supervisor's mechanical fallback, so its deterministic Schedule/Wake references and its read-model reducer live together in the Supervisor package. Any failed or orphaned Turn with a still-current Goal commitment participates in Goal recovery regardless of whether its original trigger was `user_message` or `wake`; trigger provenance never decides responsibility. Child retry exhaustion targets the failed Goal's direct parent owner, not the Root by convention. Specialist failures use a specialist target and appear in the same recovery view. The reducer exposes scheduled, queued, running, recovered, escalated, superseded, or actionable states. Console only renders that backend view.

Each Agent has one execution lane. A terminal Turn revokes Ledger authority immediately, but the lane remains occupied until its Runner process actually exits. No replacement Turn starts before that termination barrier clears.

### Runner

Receives a `RunRequest` containing Turn identity, trigger, visible Goal, optional Goal commitment, bounded context, Runner Profile, trace sink, and role-scoped RPC. It emits normalized Turn Items and runner terminal events. Every successful result has a readable response and may carry a Handoff; Supervisor requires Handoff exactly when the Turn is committed.

## Core invariants

1. Ledger is the only durable fact authority; projections are disposable.
2. Every committed Turn updates its Goal Work Record under the current Goal revision.
3. Every Child Agent owns a Child Goal with observation and verification methods.
4. CEO owns Root Goals only; parent and Child Goals always have distinct owners.
5. Every Child Turn is Goal-bound to a Child Goal currently owned by that Agent.
6. Every Goal Agent can read every Work Record; write authority follows Goal ownership and parent authority.
7. Human authorizes Root purpose and final completion.
8. CEO controls Child Goal decomposition, ownership, verification, and completion through parent authority, not Child ownership.
9. Goal Handoff points to Work Record revision instead of duplicating semantic prose.
10. An in-progress `user_message` Turn prevents new automatic Turns from starting.
11. A single Agent never has overlapping Runner processes, including during preemption.
12. Provider/model/auth and ordinary tool permission semantics stay inside each Runner.

## State and continuity

```text
Ledger events     exact facts and global history
Goal projection   current objective, methods, owner, phase, revision
Work Record FS    current semantic understanding plus version timeline
Thread/Turn Items exact model conversation and tool trace
Handoff           Explicit Agent outcome/evidence plus injected Goal/record revision
```

Legacy narrative Handoffs and `memory.appended` facts remain readable. Schema v9 deterministically seeds Work Records from them. CEO and Child Goal Agents then use Work Record as their sole semantic continuity mechanism.

## Failure model

- A stale Goal or Work Record revision is rejected.
- Every Goal-bound RPC revalidates current phase, owner, revision, Agent Thread, and Turn binding; a Human or parent Goal mutation fences an older active Turn before it can perform more tools.
- A committed Turn without a current-Turn Work Record update is abnormal.
- Failed/interrupted Turns do not consume undelivered asynchronous Mail.
- Reading Mail cancels a pending Wake only when every direct or coalesced trigger on that Wake is a now-resolved Mail; Schedule, Goal, and unread-Mail motion is preserved.
- Committed Work Record versions survive later Turn failure.
- Turn persists the opaque Runner Profile id so sliding-lease recovery can terminate stale Runner ownership after a Supervisor restart.
- Open Tool Calls are repaired to an explicit unknown result when a Turn is interrupted.
- Delegation and reassignment are idempotent atomic transactions.

## Deferred external effects

Goah currently has no Action or Connector aggregate. Runner Tool Calls are the only execution vocabulary. A future optional `ExternalEffect` subsystem is justified only when credentials are withheld from Runner processes and an operation requires durable approval, idempotency, reconciliation, or cross-Turn recovery. It must not become a second representation for ordinary Tool Calls.

## Historical documents

- [`Goah-架构设计-v2.html`](../Goah-%E6%9E%B6%E6%9E%84%E8%AE%BE%E8%AE%A1-v2.html) — previous implemented architecture.
- [`Goah-CEO-Agent-Operating-Layer.html`](../Goah-CEO-Agent-Operating-Layer.html) — previous universal CEO Wake policy.
- [`北辰-harness-设计稿.html`](../%E5%8C%97%E8%BE%B0-harness-%E8%AE%BE%E8%AE%A1%E7%A8%BF.html) — historical v0.10 proposal.
