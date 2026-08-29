# ADR 0015: Goal context and Turn commitment

Status: accepted
Date: 2026-08-28

## Context

ADR 0012 unified execution around Thread, Turn, and Item, but the persisted runtime still classified every Turn as Human, Goal, or Specialist. `source`, `bindingKind`, optional Goal fields, and `specialistRole` consequently mixed four independent facts: what triggered a Turn, which Agent role owns it, which Goal is visible to the Agent, and whether this Turn has accepted strict Goal execution responsibility.

That model made an ordinary CEO Turn unable to see the active Root Goal unless it first became Goal-bound, while the same binding mutation also changed completion policy, RPC authority, recovery routing, prompt selection, and presentation. It retained two apparent Turn modes over one Runner loop.

## Decision

### One Turn model

Every execution is one Turn. A Turn records only its trigger and an optional immutable Goal commitment:

```ts
interface TurnSnapshot {
  id: string;
  threadId: string;
  triggerKind: "user_message" | "wake";
  goalId: string | null;
  goalRevision: number | null;
  status: "in_progress" | "completed" | "failed" | "interrupted";
}
```

`goalId` and `goalRevision` are a commitment fence, not a Turn type. A direct user Turn starts without a commitment. `create_goal`, `work_on_goal`, or a direct Human Root resume may atomically commit that open Turn. A Goal-targeted Wake starts its Turn already committed. A commitment cannot be removed or switched to another Goal.

### Stable Agent role

Agent role belongs to Thread:

```ts
interface ThreadSnapshot {
  id: string;
  agent: string;
  role: "ceo" | "child" | "verifier" | "audit";
  parentThreadId: string | null;
}
```

CEO is the sole direct user-facing role. Child Threads may run only with a commitment to a currently owned Child Goal. Verifier and Audit Threads run only without Goal commitment. The configured Agent Profile must match the persisted Thread role.

### Visible Goal is not commitment

Runner input separates advisory context from authority:

```ts
interface TurnContext {
  trigger: { kind: "user_message" } | { kind: "wake"; reasons: string[] };
  activeGoal: GoalSnapshot | null;
  goalCommitment: GoalCommitment | null;
}
```

Every CEO Turn receives the current active Root Goal when one exists. Child Turns receive their owned Child Goal. Specialists receive no active Goal. Merely seeing a Goal does not require a Work Record update or Handoff and does not grant Goal mutation authority.

### Automatic targets remain typed

Wake and Schedule retain a discriminated automatic target: Goal or Specialist. Human input never becomes a Wake; it starts or steers a CEO Turn directly. The automatic target is consumed during Turn admission and is not copied into a Turn classification.

### One canonical Assistant Item

Every successful Runner result references the readable Assistant Item already emitted into the Turn transcript and may contain a Handoff:

```ts
type RunnerCandidateResult =
  | { outcome: "completed"; finalMessageId: string; handoff?: TurnOutput }
  | { outcome: "abnormal"; reason: string };
```

Runner does not submit response prose a second time. Supervisor requires `finalMessageId` to reference a completed readable Assistant Item in the same Turn and atomically writes `response.committed` before closing the Turn. Handoff validation binds the same Item identity; Supervisor requires Handoff exactly when the persisted Turn has a Goal commitment. Work Record and Handoff validation remain unchanged in strength.

## Consequences

- User priority derives from `triggerKind`, while recovery responsibility derives from Goal commitment.
- Root Human authority derives from a direct user-triggered CEO Turn, not a Human Turn class.
- Prompt selection is role-first. Goal protocol is an additive commitment constraint.
- Goal queries can see the active Goal without accidentally entering Goal execution.
- Child Agents remain Goal-only and Specialists remain unbound without creating separate Turn kinds.
- Wake, Schedule, Mail, Work Record, Goal revision fencing, Handoff validation, leases, recovery, and one-Agent execution lanes remain in force.
- Development schema v27 is rebuilt rather than migrated; it makes the persisted Thread role canonical, reserves `ceo` bidirectionally for the canonical CEO Agent, admits Human replacement as one transaction, and retains terminal Runner cleanup ownership until release.

## Superseded decisions

This ADR supersedes:

- ADR 0011 and ADR 0012 fields that model `source` as `human | goal | system`;
- ADR 0012 and architecture schema v24 `ExecutionBinding` copied onto Turn;
- Human Mail/Wake as an alternate CEO interaction path;
- Runner result variants that treat response and Handoff as different successful Turn outcomes, or duplicate Assistant prose outside its canonical Turn Item.

It does not supersede the Goal hierarchy, Child ownership, observation and verification methods, Work Record requirement for committed execution, Human Root authority, or Handoff validation.
