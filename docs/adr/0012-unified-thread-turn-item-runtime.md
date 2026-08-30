# ADR 0012: Unified Thread, Turn, and Item runtime

Status: accepted; Turn source/binding fields superseded by ADR 0015
Date: 2026-08-25

ADR 0015 retains this ADR's unified execution identity while replacing `source` plus discriminated Turn binding with `triggerKind`, Thread role, visible Goal context, and optional Goal commitment.

## Context

Goah already distinguishes ordinary and Goal-bound Turns, but the implemented Human path still uses Mail as the request identity, Wake as the execution identity, and one Wake stream as the Thread boundary. Retry, cancellation, steering, and reconnection consequently infer the Human request by correlating Mail and Wake records.

That conflicts with the product surface used by established coding agents and with Goah's own Turn vocabulary. It also creates two apparent execution systems even though ordinary work, Goal continuation, and Child Agent work all run the same Runner-owned agent loop.

## Decision

### Thread, Turn, and Item

Goah owns a durable conversation model:

```text
Thread
└── Turn
    ├── user_message
    ├── reasoning
    ├── assistant_message
    ├── tool_call
    ├── tool_result
    ├── plan
    └── handoff
```

A Thread is a Goah-owned conversation container, not a provider thread. A Turn is the sole execution identity. Items are immutable or lifecycle-updated facts inside a Turn.

The current product model maintains exactly one durable Thread per Agent. Child Agent Threads reference the CEO Thread as parent. New product-level thread creation/archival is deliberately outside this schema version.

Turn source and Goal binding remain independent:

```ts
interface Turn {
  id: string;
  threadId: string;
  source: "human" | "goal" | "system";
  goalId: string | null;
  goalRevision: number | null;
  status: "in_progress" | "completed" | "failed" | "interrupted";
}
```

An ordinary Human Turn starts unbound. A successful Human-authorized Goal tool may bind the open Turn. GoalDriver and Child continuation create Turns with `source="goal"` and an initial Goal binding.

### One execution system

All Human, Goal, CEO, and Child Agent work uses the same Turn agent loop. There is no `Interaction`, `RunAttempt`, or `GoalRun` aggregate.

Provider retry remains inside the same Turn and is represented by `turn.retry_started`, `turn.retry_finished`, and runner telemetry events. Retry does not create a Wake or a second Turn.

### Wake and Mail

Wake is only a durable schedule for future Goal or system motion. Its state machine is `queued → claimed → consumed`, with `cancelled` for pending work that is suppressed. Goal Wakes and Schedules carry the exact Goal revision they target; one Agent may own several Goals without cross-Goal coalescing or cancellation. Claiming a Wake creates one matching Turn and links `wake.turnId` to it. Human input starts a Turn directly, and any in-progress Human Turn blocks automatic Wake claims globally.

Mail is only asynchronous Agent-to-Agent communication. CEO/Human questions and answers, steering, retry, cancellation, and transcript history use canonical Thread Messages and never Mail.

### Ownership and recovery

Turn owns Runner lease, fencing token, process identity, opaque Runner Profile identity, terminal status, cancellation, and recovery. Wake no longer owns Runner execution state.

`turn.interrupt(turnId)` is the sole cancellation operation. It revokes the Turn lease, records unknown outcomes for open tools, writes `interrupted`, and terminates the Runner. `goah --continue` rebuilds the CEO Thread and subscribes to its `in_progress` Human Turn.

### Goal policy

Goal remains durable intent spanning multiple Turns. Work Record remains the sole current semantic view for a Goal. Goal-bound Turn completion still requires a current-revision Work Record update and compact Goal Handoff. Ordinary Turns skip that gate.

`goal.changed` is the single authoritative Goal lifecycle fact for create, revise, pause, resume, block, complete, and reassign. It atomically carries the before/after revision, reason, evidence, authority, and source provenance while driving the rebuildable Goal projection. Delegation and reassignment may retain workflow events, but those events do not independently define Goal state.

## Inherited decisions

- append-only Ledger authority and rebuildable projections;
- Goal hierarchy, revision CAS, phases, observation, and verification;
- every operational Child Agent owns a Child Goal;
- transparent organization-wide Work Record reads;
- Human Root purpose and final-completion authority;
- CEO Child decomposition and completion authority;
- atomic delegation and reassignment;
- Runner-owned provider/model/auth, compaction, and local execution;
- process isolation, fencing, and kill-before-recovery.

## Superseded decisions

- ADR 0005 and ADR 0006 scopes that place execution lease and the legacy replay identity on Wake;
- ADR 0006 consequence that one Wake is one legacy Transcript stream;
- ADR 0008 legacy Wake-scoped replay identity, replaced by Thread model v1 plus per-Turn transcript format v1;
- ADR 0011's Human interaction Mail, interaction Wake, and Mail-redelivery design;
- the response/Handoff/abnormal Runner candidate result as the Turn completion authority;
- any UI or control protocol that infers a Human request from Wake or Mail order.

## Consequences

- Goal and Turn remain separate entities but not separate execution systems.
- Human conversation behaves like a normal resumable coding-agent thread.
- Goal-specific invariants become a completion policy on a bound Turn.
- Wake and Mail have smaller, non-overlapping responsibilities.
- exact execution history lives in Thread/Turn/Item events; Goal semantic continuity remains in Work Record.
- existing pre-v2 local data is not migrated. Development workspaces may be recreated before use.
