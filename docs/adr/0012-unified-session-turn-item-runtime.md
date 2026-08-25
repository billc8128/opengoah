# ADR 0012: Unified Session, Turn, and Item runtime

Status: accepted
Date: 2026-08-25

## Context

Goah already distinguishes ordinary and Goal-bound Turns, but the implemented Human path still uses Mail as the request identity, Wake as the execution identity, and one Wake stream as the Session boundary. Retry, cancellation, steering, and reconnection consequently infer the Human request by correlating Mail and Wake records.

That conflicts with the product surface used by established coding agents and with Goah's own Turn vocabulary. It also creates two apparent execution systems even though ordinary work, Goal continuation, and Child Agent work all run the same Runner-owned agent loop.

## Decision

### Session, Turn, and Item

Goah owns a durable conversation model:

```text
Session
└── Turn
    ├── user_message
    ├── reasoning
    ├── assistant_message
    ├── tool_call
    ├── tool_result
    ├── plan
    └── handoff
```

A Session is a Goah-owned transcript container, not a provider thread. A Turn is the sole execution identity. Items are immutable or lifecycle-updated facts inside a Turn.

Turn source and Goal binding remain independent:

```ts
interface Turn {
  id: string;
  sessionId: string;
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

Wake is only a durable schedule for future Goal or system motion. Claiming a Wake creates one Turn and links `wake.turnId` to it. Human input starts a Turn directly.

Mail is only asynchronous Agent-to-Agent or Agent/Human decision communication. Ordinary Human conversation, steering, retry, cancellation, and transcript history do not use Mail.

### Ownership and recovery

Turn owns Runner lease, fencing token, process identity, terminal status, cancellation, and recovery. Wake no longer owns Runner execution state.

`turn.interrupt(turnId)` is the sole cancellation operation. It aborts the Runner and retry backoff and writes `interrupted`. `session.resume(sessionId)` rebuilds full Turns and Items and subscribes to any `in_progress` Turn.

### Goal policy

Goal remains durable intent spanning multiple Turns. Work Record remains the sole current semantic view for a Goal. Goal-bound Turn completion still requires a current-revision Work Record update and compact Goal Handoff. Ordinary Turns skip that gate.

## Inherited decisions

- append-only Ledger authority and rebuildable projections;
- Goal hierarchy, revision CAS, phases, observation, and verification;
- every operational Child Agent owns a Child Goal;
- transparent organization-wide Work Record reads;
- Human Root purpose and final-completion authority;
- CEO Child decomposition and completion authority;
- atomic delegation, reassignment, Action approval, and reconciliation;
- Runner-owned provider/model/auth, compaction, and local execution;
- process isolation, fencing, and kill-before-recovery.

## Superseded decisions

- ADR 0005 and ADR 0006 scopes that place execution lease and Session identity on Wake;
- ADR 0006 consequence that one Wake is one Session stream;
- ADR 0008 Session format v1 shape, replaced by Session/Turn/Item format v2;
- ADR 0011's Human interaction Mail, interaction Wake, and Mail-redelivery design;
- the response/Handoff/abnormal RunnerResult union as the Turn completion authority;
- any UI or control protocol that infers a Human request from Wake or Mail order.

## Consequences

- Goal and Turn remain separate entities but not separate execution systems.
- Human conversation behaves like a normal resumable coding-agent thread.
- Goal-specific invariants become a completion policy on a bound Turn.
- Wake and Mail have smaller, non-overlapping responsibilities.
- exact execution history lives in Session/Turn/Item events; Goal semantic continuity remains in Work Record.
- existing pre-v2 local data is not migrated. Development workspaces may be recreated before use.

