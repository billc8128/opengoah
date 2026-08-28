# Goah Goal-bound Agent Operating Model

Status: v1.2 accepted and implemented
Version: 1.2
Date: 2026-08-28

This document defines the implemented architecture for making Goah feel like a normal interactive Agent without weakening its long-running, goal-oriented operating model.

This model supersedes the interaction and continuity model in [Goah CEO Agent Operating Layer](./ceo-agent-operating-layer.md). [ADR 0011](../adr/0011-goal-bound-turns-and-work-record-filesystem.md) records the exact decisions changed while earlier ADRs remain historical records.

## 1. Decision summary

Goah has one Thread/Turn/Item runtime with an optional Goal commitment:

1. **Visible Goal context** — every CEO Turn may see the active Root Goal without being assigned to advance it.
2. **Goal commitment** — a Turn explicitly committed to a Goal enters Goah's strict operating protocol: durable Work Record update, observation and verification methods, evidence, Goal Handoff, scheduling, and CEO-managed child Agents.

The distinction is mechanical. Trigger, stable Agent role, visible Goal, and Goal commitment are separate facts:

```ts
interface Turn {
  id: string;
  threadId: string;
  triggerKind: "user_message" | "wake";
  goalId: string | null;
  goalRevision: number | null;
  status: "in_progress" | "completed" | "failed" | "interrupted";
}
```

A direct user Turn may acquire a Goal commitment when CEO translates durable Human intent into a successful Goal tool call. The trigger remains `user_message`; authority provenance is never rewritten as model initiative. Human, Goal, and Child work all use this same Turn agent loop.

## 2. Architectural invariants

### G1 — Durable Work Record

Every Turn with a Goal commitment must create a new version of its Goal's Work Record before it can finish normally. The update records current understanding, observations, completed work, decisions, blockers, and next steps, with references to Ledger evidence.

### G2 — Goal-owned Agents

Every non-CEO operational Agent owns a Child Goal. Goah does not provide a generic task-only `spawn_agent` primitive. Delegation creates the Child Goal, observation method, verification method, Work Record, ownership, message, and initial Wake atomically.

### G3 — Transparent shared context

Every Goal Agent can discover, read, search, inspect history for, diff, and cite every Goal Work Record in the organization. Write authority is narrower than read authority.

### G4 — Ledger authority

The append-only Ledger remains the only durable fact source. Work Record FS is an event-sourced execution module over the Ledger, not a second database or an untracked filesystem.

### G5 — Human root authority

Human intent authorizes Root Goal creation and material revision. CEO may translate that intent into tool calls but cannot manufacture Human authority. Human retains authority over Root purpose and final completion.

### G6 — Goal verification

Every delegated Child Goal has an observation method and a verification method. A Child Agent may propose completion; CEO verifies the proposal and controls the Child Goal lifecycle. Root completion remains Human-controlled.

## 3. Inheritance and changes from the previous architecture

This model evolves two implemented references:

- [Goah architecture v2](../../Goah-%E6%9E%B6%E6%9E%84%E8%AE%BE%E8%AE%A1-v2.html), which defines the Ledger, execution modules, replayable Thread, Wake/Lease lifecycle, Runner boundary, and failure semantics;
- [Goah CEO Agent Operating Layer v0.4](./ceo-agent-operating-layer.md), which defines CEO as the Human-facing identity, Goal-owned organization, observation methods, atomic delegation, motion validation, and Human root authority.

The change is not a move from a Goal-oriented system to a task-oriented Agent. It makes ordinary interaction an unbound surface while preserving the strict Goal operating layer.

### 3.1 What is inherited

| Previous design | Inherited decision | Why it remains |
|---|---|---|
| Append-only Ledger plus rebuildable projections | Ledger remains the only durable fact source | Global order, replay, audit, and transaction boundaries are foundational guarantees |
| Replayable normalized Turn transcripts | Runner messages, tool calls/results, requests, compaction, and interruption remain normalized events | Goah must own the context and recovery record rather than depend on provider session state |
| CEO as the sole normal Human-facing Agent | Human still interacts through CEO instead of coordinating Child Agents directly | One accountable interface hides organization mechanics without hiding their records |
| Goal-driven organization | Every Child Agent still owns a Child Goal | Goah coordinates durable outcomes, not disposable task workers |
| Observation method | Goal execution still defines how current reality is inspected | Separately reconstructed Turns must not silently change their source of truth |
| Human root authority | Human still authorizes Root purpose and final completion | CEO may operationalize intent but cannot acquire authority by writing prose |
| Atomic delegation and reassignment | Child Goal, ownership, communication, and Work Record commit together; active Goals also commit the new owner's Wake, while inactive Goals remain dormant until resume | A partially created organization is not recoverable or trustworthy, and inactive Goals must not schedule impossible work |
| Sliding lease, fencing, and kill-before-recovery | Turn owns Runner execution; Wake only schedules a future Goal Turn | Process failure and duplicate ownership remain control-plane problems without making Wake an execution identity |
| Normalized Tool Call trace | Calls, results, and interrupted unknown outcomes remain Turn Items | Goah preserves inspectable execution without a duplicate Action aggregate |
| Runner-owned execution and configuration | Provider/model registry, authentication, compaction, and local execution remain inside each Runner | Different Runners have different execution and provider semantics |
| Revisioned Goal lifecycle | Goal changes remain CAS-protected and phases remain mechanically validated | Stale Agents must not overwrite current purpose or lifecycle state |
| Model-judged organization, mechanically enforced transitions | CEO chooses decomposition; Supervisor validates authority and atomicity | Open-ended judgment belongs to the model, durable invariants do not |

### 3.2 What changes

| Previous design | New design | Why it changes |
|---|---|---|
| Normal Human input implicitly starts or operates a Root Goal | Human input begins as an ordinary unbound Turn; a successful Goal tool call adds a Goal binding | Greetings, questions, and bounded work must not trigger organization onboarding |
| Message origin and Goal work are treated as one execution category | `triggerKind`, Thread role, visible Goal, and Goal commitment are independent facts | A Human can directly express a Goal without losing Human provenance, while read-only Goal questions remain ordinary Turns |
| Every CEO Wake runs the full orient/diagnose/organize/ensure-motion loop | The operating policy is injected only after Goal commitment | CEO should behave like a normal Agent outside Goal operation |
| Every runner completion requires narrative Handoff | Ordinary Turns return a normal response; Goal-bound Turns require compact Goal Handoff | Handoff is a Goal execution boundary, not a universal conversation protocol |
| Handoff prose, latest handoff, and `memory.appended` jointly carry cross-Wake semantic continuity | One versioned Work Record per Goal carries semantic continuity; Handoff points to its revision | Three overlapping semantic stores make freshness and authority ambiguous |
| Goal has one `observationMethod` covering progress and completion | Goal separates `observationMethod` from `verificationMethod` | Inspecting progress and proving completion are different contracts |
| Child context is primarily bounded from owned Goal, Mail, prior Handoff, memory, and selected organization facts | Every Goal Agent sees a shared Work Record index and can read every full record and history | Multi-agent coordination requires transparent, discoverable organizational knowledge |
| Root Goal onboarding takes priority whenever no observation method exists | Onboarding runs only after a Root Goal is actually created and bound | Setup and ordinary conversation must not be blocked by Goal operationalization |
| A Work Record-like history is spread across Ledger events, handoffs, and notes | Work Record FS becomes a first-class event-sourced execution module | Agents need a stable file-like current view plus an inspectable timeline and diff |
| Goal continuation is inferred from active organization/Wake lifecycle | GoalDriver emits a normal Wake-triggered Turn with an initial Goal commitment fence | Work Record and completion requirements need a mechanically identifiable scope |

### 3.3 Why the change is necessary

The previous architecture optimized the first interaction for the hardest case: a long-running Root Goal that requires operationalization, decomposition, evidence, and repeated Wakes. That made the strict protocol reliable, but it also made ordinary interaction behave like organizational work. A greeting or short question could trigger filesystem inspection, Ledger search, team diagnosis, observation-method drafting, Human requests, and mandatory Handoff.

The new model moves the strict boundary without weakening it:

```text
previous
Human message → Goal organization protocol

new
Human message → ordinary CEO Turn
                    │
                    └─ explicit Goal tool success → Goal commitment protocol
```

This produces four benefits:

1. **Natural interaction** — CEO can answer and work normally when no durable Goal is intended.
2. **Explicit authority** — Human provenance, Goal binding, and automatic continuation are separate auditable facts.
3. **Stronger Goal continuity** — Work Record replaces overlapping Handoff and memory prose with one versioned organizational record.
4. **More transparent Multi-agent work** — every Goal Agent can inspect the same organizational knowledge while write authority remains controlled.

### 3.4 What this proposal deliberately does not change

This proposal does not introduce generic task Sub-agents, relax Child Goal observation or verification, remove Goal Handoff, make Work Records optional for Goal work, replace the Ledger with documents, or move organization authority into the Runner. The UX becomes less intrusive outside Goals; Goal-bound execution becomes more explicit and more constrained.

## 4. Goals and non-goals

### Goals

- Make `goah` usable for ordinary conversation and bounded coding work.
- Preserve long-running Goal execution across processes, Wakes, restarts, and Agent ownership changes.
- Preserve replay, recovery, leases, tool-call repair, and revision fences.
- Give Goal Agents a shared, versioned semantic memory with an inspectable timeline.
- Keep organization creation and motion model-judged but mechanically safe.
- Make the UI quiet by default while retaining complete local auditability.

### Non-goals

- Treat every Human message as a Goal.
- Implement Git object, index, branch, merge, or commit semantics for Work Records.
- Introduce task-only Sub-agents.
- Duplicate Goal state or raw tool results inside Work Records.
- Inject every Work Record in full into every model request.
- Move provider or model configuration into Goah Core; those remain Runner-owned.
- Replace the append-only Ledger with documents or model-authored prose.

## 5. System shape

```text
Human / TUI
    │ turn.start / turn.steer / turn.interrupt
    ▼
CEO Agent Thread
    └── Turn + Items
          ├── user-message trigger ──────── normal response
          └── optional Goal commitment
          │
          ├── Goal Service
          ├── Work Record FS
          ├── Goal Driver
          ├── delegation / Child Goals
          └── Goal Handoff
                  │
                  ▼
          Supervisor + Ledger
                  │
                  ▼
              Runner Profile
                  │
                  ▼
        one Runner-owned Agent loop,
        provider/model registry and auth
```

CEO is the only normal Human-facing Agent. It is a capable ordinary Agent first and gains organization behavior through Goal tools. Child Agents exist only inside the Goal operating layer.

## 6. Interaction and Turn binding

### 6.1 Ordinary direct user Turn

An ordinary message creates a Turn directly, without Mail, Wake, or Goal commitment. It still receives the active Root Goal as advisory context:

```ts
{
  triggerKind: "user_message",
  goalId: null,
  goalRevision: null,
  status: "in_progress"
}
```

It may use ordinary Runner tools such as `read`, `write`, `edit`, and `bash`. It does not require:

- a Root Goal;
- organization inspection;
- an observation method;
- a Work Record update;
- a Goal Handoff;
- a next Wake.

Reading Goal status or Work Records does not bind the Turn.

### 6.2 Human expresses Goal intent

Human may express a Goal in natural language:

```text
Finish the authentication redesign, including tests and release validation,
and keep working until it is complete.
```

CEO translates the request into `create_goal`. Runtime accepts the call only when the open Turn contains direct Human authority. On success it:

1. creates the Root Goal;
2. creates its initial Work Record;
3. commits the new Goal and revision to the current Turn;
4. enables the Goal tool and completion policy for the rest of the Turn;
5. requires a Work Record update and Goal Handoff before normal completion;
6. allows GoalDriver to continue after the Turn becomes idle.

The trigger remains `user_message`. Goal commitment is additive and does not rewrite provenance.

### 6.3 Explicit `/goal`

`/goal OBJECTIVE` is the direct Human control path. Supervisor creates the Root Goal under Human authority and starts a CEO Turn already carrying its Goal commitment, without an intermediate Wake. Natural language and `/goal` converge on the same Goal Service contract.

### 6.4 Work on an existing Goal

The following operations attach an existing Goal to the current Turn:

- `resume_goal`
- `work_on_goal`
- a GoalDriver continuation
- initial or resumed Child Goal execution

Read-only operations do not attach it:

- `get_goal`
- `list_goals`
- `work_record_read`
- `work_record_history`
- `work_record_search`

This permits a Human to ask for Goal status without being forced into a progress cycle.

### 6.5 GoalDriver Turn

GoalDriver may start a continuation only when:

- the Goal is active and armed;
- the Agent is idle;
- no Human input has priority;
- the Goal revision still matches;
- the Goal has remaining execution capacity;
- the previous committed Turn recorded its Work Record and Handoff.

GoalDriver creates a normal committed Turn:

```ts
{
  triggerKind: "wake",
  goalId,
  goalRevision,
  status: "in_progress"
}
```

Human steering always has priority over automatic continuation.

GoalDriver does not run a second execution protocol. It creates a committed Turn in the owner Agent's Thread. Provider retry remains inside that Turn and never creates a Wake or another Turn.

## 7. Goal model

```ts
type GoalPhase = "active" | "paused" | "blocked" | "complete";

interface GoalSnapshot {
  id: string;
  parentId: string | null;
  objective: string;
  observationMethod: string | null;
  verificationMethod: string | null;
  owner: string;
  phase: GoalPhase;
  revision: number;
}
```

### 7.1 Observation and verification

- `observationMethod` defines how an Agent obtains current facts and judges progress.
- `verificationMethod` defines the evidence required to support a completion claim.

A new Root Goal may temporarily have null methods while CEO inspects the environment and proposes them for Human confirmation. A Child Goal must have both methods at creation.

### 7.2 Mutation request

Callers submit an expected revision and requested change; Goal Service builds the next snapshot:

```ts
interface UpdateGoalRequest {
  goalId: string;
  expectedRevision: number;
  changes: {
    objective?: string;
    observationMethod?: string | null;
    verificationMethod?: string | null;
    phase?: GoalPhase;
  };
  reason: string;
  evidence: number[];
}
```

The caller does not assign the next revision. Goal Service validates authority and transitions; Ledger assigns durable order.

### 7.3 Goal change event

```ts
interface GoalChangedData {
  version: 1;
  projection: "goals";
  operation:
    | "create"
    | "revise"
    | "pause"
    | "resume"
    | "block"
    | "complete"
    | "reassign";
  snapshot: GoalSnapshot;
  previousRevision: number | null;
  reason: string;
  evidence: number[];
  authority:
    | { kind: "human" }
    | { kind: "parent_goal"; goalId: string; goalRevision: number }
    | { kind: "system"; reason: string };
  sourceTurnId?: string;
  sourceWakeId?: string;
  idempotencyKey?: string;
}
```

The Event envelope records the authenticated actor. `authority` records why that actor may perform the mutation; optional `sourceTurnId`, `sourceWakeId`, and `idempotencyKey` fields record provenance without changing semantic idempotency. `goal.changed` also carries `projection: "goals"`, so the same authoritative fact rebuilds the current Goal table.

### 7.4 Authority

| Operation | Root Goal | Child Goal |
|---|---|---|
| create | Human intent, optionally translated by CEO | Parent owner through atomic delegation |
| revise purpose | Human | CEO/parent owner |
| confirm methods | Human | CEO/parent owner |
| pause/resume | Human | CEO/parent owner |
| propose completion | CEO | Child owner |
| final completion | Human | CEO/parent owner after verification |
| reassign owner | Human or authorized CEO policy | CEO/parent owner |

## 8. Goal-owned Multi-agent

### 8.1 No task-only Sub-agent

Goah does not expose:

```ts
spawn_agent({ task: string })
```

It exposes atomic Goal delegation:

```ts
interface DelegateGoalRequest {
  id: string;
  parentGoalId: string;
  expectedParentRevision: number;
  child: {
    id?: string;
    objective: string;
    observationMethod: string;
    verificationMethod: string;
    owner: string;
  };
  brief: JsonValue;
  reason: string;
  evidence: number[];
}
```

### 8.2 Atomic delegation

One transaction commits:

1. `delegation.created`;
2. Child Goal revision zero;
3. Child Work Record revision zero;
4. decision Mail to the Child owner;
5. initial queued Wake.

Failure rolls back every effect. Reusing the delegation id with a different payload fails. Reusing the same id and payload returns the committed result.

### 8.3 Child Agent contract

Every Child Agent must:

1. read the current Child Goal and Work Record;
2. inspect the shared Work Record index;
3. follow the observation method;
4. make concrete progress;
5. gather evidence under the verification method;
6. update the Child Work Record;
7. submit progress, waiting, blocker, or completion proposal to CEO.

Child Agent cannot redefine the Goal, change its methods, create an unowned Agent, or complete the Child Goal itself.

### 8.4 CEO contract

CEO owns decomposition and organization:

- create, revise, pause, resume, reassign, or complete Child Goals;
- review Work Record changes across the organization;
- validate completion proposals against current verification methods;
- repair active Child Goals without a Wake, schedule, wait, or escalated blocker;
- consolidate Child results into the Root Work Record;
- request Human decisions and Root completion.

## 9. Work Record Filesystem

### 9.1 Identity and namespace

Each Goal has exactly one Work Record:

```text
virtual path: /goals/<goal-id>.md
event stream: work-record:<goal-id>
```

The path is derived and is not separately mutable. Organization and Agent indexes are derived views, not separately authored truth.

### 9.2 Document contents

The Work Record is Markdown with a stable recommended structure:

```markdown
# Current State

# Observations

# Work Completed

# Decisions

# Blockers

# Next Steps
```

The document is semantic Agent state. Supervisor validates authority, revision, evidence existence, and non-empty change; CEO or a verifier judges whether the content is useful and truthful.

### 9.3 Snapshot schema

```ts
interface WorkRecordSnapshot {
  goalId: string;
  recordRevision: number;
  goalRevision: number;
  content: string;
  updatedBy: string;
  updatedInTurn: string;
  sourceWakeId: string | null;
  updatedAt: string;
  reason: string;
  evidence: number[];
  lastEventSeq: number;
}
```

### 9.4 Agent update request

```ts
interface UpdateWorkRecordRequest {
  expectedRevision: number;
  content: string;
  reason: string;
  evidence: number[];
}
```

Agent does not provide `goalId`, actor, Turn, Wake, time, next revision, or event sequence. Supervisor derives them from the authenticated Turn commitment.

### 9.5 Event schema

```ts
interface WorkRecordUpdatedData {
  version: 1;
  goalId: string;
  recordRevision: number;
  previousRevision: number | null;
  goalRevision: number;
  turnId: string;
  wakeId: string | null;
  content: string;
  reason: string;
  evidence: number[];
}
```

The Event envelope supplies `seq`, `streamSeq`, `ts`, `actor`, and fixed type `work_record.updated`.

The complete document snapshot is stored once in the immutable event. History and diff are derived from successive events.

### 9.6 Projection schema

```sql
CREATE TABLE work_records (
  goal_id TEXT PRIMARY KEY REFERENCES goals(id),
  record_revision INTEGER NOT NULL CHECK(record_revision >= 0),
  goal_revision INTEGER NOT NULL CHECK(goal_revision >= 0),
  content TEXT NOT NULL CHECK(length(trim(content)) > 0),
  updated_by TEXT NOT NULL,
  updated_in_turn TEXT NOT NULL,
  source_wake_id TEXT,
  updated_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) > 0),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  last_event_seq INTEGER NOT NULL REFERENCES events(seq)
) STRICT;
```

The projection is a rebuildable current-file view. It is committed in the same transaction as its source event.

### 9.7 Write authority

| Field | Source |
|---|---|
| `goalId` | current Goal commitment, injected by Supervisor |
| `recordRevision` | Work Record Service, current + 1 |
| `goalRevision` | current Goal projection |
| `content` | authorized Agent request |
| `updatedBy` | authenticated Agent identity |
| `updatedInTurn` | current Turn id |
| `sourceWakeId` | current Wake id when present |
| `updatedAt` | Supervisor clock |
| `reason` | authorized Agent request |
| `evidence` | Agent request, existence checked by Ledger |
| `lastEventSeq` | committed Event seq |

Goal owner may update its Work Record. Parent owner/CEO may append management and review updates. Other Agents have read-only access. Reassignment transfers owner write authority after the new Goal revision commits.

### 9.8 Shared read surface

Every Goal Agent receives tools equivalent to:

```text
work_record_list
work_record_read
work_record_history
work_record_diff
work_record_search
work_record_update
```

Read operations are organization-wide. Update is capability- and ownership-checked.

## 10. Work Record and Ledger boundary

Ledger and Work Record are complementary:

| Ledger owns | Work Record owns |
|---|---|
| exact Goal changes | current semantic understanding |
| exact tool calls and results | observations derived from evidence |
| messages and model requests | decisions and rejected approaches |
| Turn lease, retry and recovery facts | completed work summary |
| Tool Call state and results | blockers and next steps |
| immutable global order | versioned human/Agent-readable document |

Work Record references facts by Ledger sequence. It does not copy Goal objective, owner, phase, or raw tool output as authoritative fields. UI may render those facts alongside the document.

The apparent duplication between an immutable Work Record event and the `work_records` table is intentional event/projection duplication: events are authority; the table is disposable and replayable.

## 11. Committed Turn completion

At Turn start Supervisor records:

```ts
interface GoalCommitmentFence {
  goalId: string;
  goalRevision: number;
  workRecordRevisionAtStart: number;
}
```

Normal completion requires:

1. Goal and revision still match the fence;
2. at least one `work_record.updated` event exists for this Turn;
3. the resulting Work Record revision is newer than the starting revision;
4. the update actor is authorized;
5. every cited evidence sequence exists;
6. a valid Goal Handoff points to the resulting record revision.

Failure produces a policy violation rather than a successful committed Turn. Uncommitted CEO interactions and Verifier/Audit specialist Turns skip this gate; Child Agents can only start with a Goal commitment.

## 12. Goal Handoff

Detailed narrative lives in Work Record. Goal Handoff is a compact Turn Item and control-plane fact:

```ts
interface GoalHandoff {
  goalId: string;
  goalRevision: number;
  recordRevision: number;
  outcome:
    | "progress"
    | "waiting"
    | "blocked"
    | "completion_proposed";
  evidence: number[];
}
```

Agent writes readable Assistant Messages and supplies `outcome` plus evidence. Before the Handoff tool executes, Supervisor validates the draft: correctable issues become Tool feedback so the live Agent can repair them, while authority/fencing changes revoke the old Turn. A successful validation returns a one-use token; commit references the existing Message, injects Goal/record revisions, and records Handoff without requiring a fixed Message/Tool/Handoff order. Asynchronous Mail and future scheduling remain separate tool operations.

Uncommitted CEO interactions and Verifier/Audit specialist Turns return a normal assistant response and do not create Goal Handoff. A direct user interaction that acquires a Goal commitment follows the readable-response plus Handoff protocol. Every Child Turn starts committed.

## 13. Context construction

A Goal Agent receives a bounded organizational view:

```markdown
# Goal Tree

# Shared Work Record Index
- /goals/root.md · r12 · ceo · active
- /goals/auth.md · r4 · auth-agent · active
- /goals/release.md · r7 · release-agent · blocked

# Your Goal

# Observation Method

# Verification Method

# Your Work Record

# Parent Work Record

# Relevant Recent Record Changes

# Incoming Decisions

# Wake Trigger
```

Transparency means every record is discoverable and readable, not that every full document is automatically injected. Default request context contains:

- the full organization index;
- the current Goal record;
- the parent record;
- bounded relevant recent changes;
- explicit paths for every other record.

Agent can read any full record or history on demand. No semantic organization state is hidden exclusively inside Supervisor prompts.

## 14. Memory and Handoff consolidation

The current design has three possible semantic carriers: Handoff prose, `memory.appended`, and Work Record. The target model removes ambiguity:

- Goal semantic continuity lives in Work Record;
- Goal Handoff points to a Work Record revision;
- raw execution history remains in Turn transcript/Ledger events;
- Goal Agents no longer write separate free-form `memory.appended` facts;
- legacy memory and Handoffs remain readable and seed migrated Work Records;
- future non-Goal personal/thread memory is a separate concern.

## 15. Runner boundary

Goah Core knows Runner Profiles, not global provider semantics. Each Runner continues to own:

- its Agent loop;
- provider and model registry;
- authentication and credential resolution;
- provider-specific capabilities;
- compaction and request policy;
- local execution behavior.

Goah supplies Turn context, Goal tools, Work Record tools, organization tools, and normalized event capture through the Runner contract. Ark remains optional and is not a Core special case.

## 16. Failure and concurrency semantics

- Work Record update uses revision CAS; stale writers must reread.
- Goal revision changes invalidate a stale Goal commitment fence.
- A committed Turn cannot finish on another Agent's Work Record update.
- Human input preempts pending automatic Goal continuation.
- An abnormal committed Turn retains every committed Work Record version but does not produce a successful Handoff or acknowledge Mail.
- Delegation and reassignment remain idempotent transactions.
- A completed Goal admits no new automatic Wake.
- Interrupted Tool Calls retain explicit unknown results in the Turn trace.
- Lease fencing and kill-before-recovery remain unchanged.

## 17. User experience

### Ordinary interaction

```text
> 你好

你好，有什么想一起处理的？
```

No organization scan, Goal creation, Work Record, or Handoff is shown or required.

### Goal creation

```text
> 持续把登录系统改造完成，包括测试和发布验证

Goal created: 登录系统改造
I’ll inspect the current implementation and define how progress and completion will be verified.
```

### Default rendering

Show:

- final assistant responses;
- concise tool progress;
- Goal creation and lifecycle changes;
- Child Goal creation and terminal results;
- Human decisions required.

Hide by default:

- Wake ids;
- raw RPC JSON;
- internal continuation prompts;
- full Work Record content;
- Ledger sequences;
- internal reasoning and protocol chatter.

`/status`, `/records`, `/history`, and `/debug` expose increasing levels of detail.

## 18. Migration

This development release has no external users, so schema v25 does not migrate earlier development schemas. Development workspaces are recreated. Thread persists Agent role; Turn persists `user_message|wake` trigger plus optional Goal commitment; Wake and Schedule retain only Goal or Specialist automatic targets. Mail uses a discriminated Goal, Human-inbox, Human-request, or Specialist-inbox route. Turn admission freezes the current active Goal revision, and automatic Turns can start only from a claimed Wake.

## 19. Implementation sequence

### Phase A — unified runtime

- add durable Thread, Turn, and Turn Item projections;
- move lease, fencing, cancellation, retry, and recovery to Turn;
- start direct user Turns without Wake and keep provider retry inside the Turn;
- make Wake create future automatic Turns and reserve Mail for asynchronous communication.

### Phase B — Goal and Work Record contracts

- add verification method;
- add Work Record service, events, projection, replay, history, diff, and search;
- add ownership and CAS validation.

### Phase C — Goal-bound completion gate

- capture Goal commitment fence;
- require current-Turn Work Record update;
- replace narrative Handoff with revision reference;
- keep Mail and scheduling atomic at completion.

### Phase D — Goal-owned Multi-agent

- extend atomic delegation with verification method and initial Work Record;
- prohibit task-only Agent creation;
- update Child and CEO policies;
- enforce completion proposal and CEO verification.

### Phase E — transparent context and UI

- inject shared Work Record index and relevant records;
- add record browsing commands;
- suppress internal protocol noise in the default TUI;
- expose complete audit detail through explicit commands.
- rebuild and subscribe to complete Thread/Turn/Item history by stable ids.

### Phase F — migration and documentation

- migrate existing incomplete Goals;
- add the superseding ADR;
- update contracts and operations documentation;
- publish the implemented architecture as `docs/architecture.md` and a rendered v3 document;
- mark v2 and CEO Operating Layer v0.4 historical.

## 20. Acceptance tests

### Ordinary interaction

- `你好` creates no Goal, Wake organization scan, Work Record, or Goal Handoff.
- A bounded ordinary task can use Runner tools and return a normal response.
- Reading Goal status does not bind the Turn.

### Human Goal intent

- Natural-language durable intent can produce a Human-authorized Goal tool call.
- `/goal` and natural-language creation converge on the same Goal contract.
- Successful creation binds the current Turn without changing its Human source.

### Work Record

- Root and Child Goal creation produce revision-zero records.
- committed Turn without a current-Turn update is rejected.
- An ordinary Turn has no update requirement.
- Stale record revision fails CAS.
- Projection rebuild produces identical current documents.
- History and diff expose the complete record timeline.
- Every cited evidence sequence must exist.

### Multi-agent

- Delegation without observation or verification method rolls back completely.
- Delegation atomically creates Child Goal, Work Record, Mail, and Wake.
- Child Agent cannot exist without a Child Goal.
- Child Agent cannot complete its own Goal; it submits a proposal.
- CEO cannot complete a Child Goal without verification evidence.
- Reassignment transfers Work Record write authority.

### Transparency

- Every Goal Agent can list and read every Goal Work Record.
- Non-owner Agent cannot overwrite another record.
- Context contains the complete shared index and current Goal record.
- Agent can retrieve an omitted full sibling record on demand.

### Scheduling and recovery

- Human input preempts automatic continuation.
- GoalDriver starts only from active, matching, completed prior state.
- Abnormal Turn retains committed record history but does not acknowledge Mail.
- Restart/replay reconstructs Goals, Work Records, pending Mail, and next motion identically.

## 21. Documentation transition

This Markdown document is the current Goal operating-model source. [ADR 0011](../adr/0011-goal-bound-turns-and-work-record-filesystem.md) names the superseded clauses in ADR 0001, 0005, 0009, and 0010. [Goah architecture v2](../../Goah-%E6%9E%B6%E6%9E%84%E8%AE%BE%E8%AE%A1-v2.html) and CEO Agent Operating Layer v0.4 are retained as historical implemented designs. A rendered v3 document is presentation work, not an architectural dependency.
