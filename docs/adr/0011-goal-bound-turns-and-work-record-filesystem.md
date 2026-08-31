# ADR 0011: Goal-bound Turns and the Work Record filesystem

Status: accepted; interaction transport superseded by ADR 0012 and Turn binding terminology superseded by ADR 0015
Date: 2026-08-25

## Context

Goah's original interactive CEO path treated the first Human message as a Root Goal and required every Runner completion to produce a structured Handoff. That made long-running organization behavior mechanically consistent, but it also applied Goal onboarding, environment inspection, team diagnosis, Human requests, and Handoff policy to greetings, questions, and bounded work.

Goal continuity was also spread across three semantic carriers: narrative Handoffs, `memory.appended` notes, and reconstructed Active Context. They were all durable, but no single file-like view answered what an Agent currently believed, how that view changed, or which version another Agent had read.

The product still requires the original core properties:

- Goal-driven Multi-agent organization rather than task-only workers;
- observation and verification of every Child Goal;
- transparent cross-Agent context;
- append-only audit, replay, leases, recovery, and evidence-backed Actions;
- Human authority over Root purpose and completion.

## Decision

### Ordinary and Goal-bound Turns

Turn source and Goal binding are independent facts. A Human message begins unbound. Greetings, questions, Goal status reads, and bounded work may return a normal assistant response without creating a Goal, Work Record version, or Handoff.

A successful `create_goal` or `work_on_goal` call attaches `{ goalId, goalRevision }` to the open Human Turn without changing its Human provenance. GoalDriver creates explicitly Goal-bound continuation Turns. Goal-bound Turns must finish through the strict Goal protocol.

Human input owns the CEO foreground. ADR 0012 supersedes the original Mail/Wake transport from this paragraph: Human input now starts or steers a durable Turn directly, retry remains inside that Turn, and interruption addresses the Turn id. The invariant remains that an in-progress Human Turn prevents automatic Goal continuation from taking the foreground.

### Work Record filesystem

Each Goal owns one virtual Markdown document at `/goals/<goal-id>.md`. The document is stored as immutable `work_record.created` and `work_record.updated` events. The `work_records` SQLite table is a rebuildable current-file projection.

Every Goal-bound Turn must create a newer Work Record revision authored in that Turn and under the current Goal revision. Updates use revision CAS and cite existing Ledger evidence. Every Goal Agent may list, read, search, inspect history for, and diff every Work Record. Goal owner and parent owner write authority is enforced mechanically.

The Ledger remains the only durable fact source. Work Record contains semantic understanding and references exact facts by event sequence; it does not replace Goal, Wake, Action, Thread, Turn, or evidence state.

### Goal model and Multi-agent

Goal adds a distinct `verificationMethod` alongside `observationMethod`:

- observation defines how current reality is inspected;
- verification defines what evidence proves completion.

Every Child Agent owns a Child Goal. There is no generic task-only Agent primitive. Atomic delegation commits Child Goal, observation method, verification method, initial Work Record, decision Mail, and initial Wake together. Child Agent proposes completion; CEO verifies and completes the Child Goal. Human retains Root completion authority.

Implementation note (2026-08-31): schema v29 represents that delegation brief as normal-priority Mail. Priority is delivery metadata rather than a semantic message category.

### Handoff and memory

Goal Handoff no longer duplicates observations, completed work, and next steps. It records only:

- Goal id and revision;
- Work Record revision;
- outcome;
- evidence.

Legacy narrative Handoffs remain readable. Goal Agents no longer receive `memory.append`; Work Record is their semantic continuity mechanism. Legacy Goal memory remains readable and is deterministically incorporated into the initial Work Record during schema v8 to v9 migration. Verifier and audit roles may retain independent memory where it does not compete with Goal state.

### Runner boundary

Provider/model registry, authentication, local execution, request policy, and compaction remain Runner-owned. Goah passes Turn source, optional Goal binding, context, tools, and normalized events through the Runner contract.

## Superseded decisions

This ADR supersedes only the following scopes:

- ADR 0001 decision 6: mandatory Handoff applies to Goal-bound execution, not ordinary Human Turns.
- ADR 0005's statement that every Runner exit without Handoff is abnormal: an ordinary Turn may exit with a normal assistant response.
- ADR 0009's default interaction behavior: the interactive CEO no longer creates a Root Goal merely because no Root exists.
- ADR 0010's Goal continuity carrier: Work Record replaces new Goal-owned `memory.appended` notes and narrative Handoff summaries.
- CEO Agent Operating Layer v0.4 sections that require every CEO Wake to execute the full organization loop regardless of Goal binding.

All other Ledger, Thread/Turn, Goal lifecycle, observation, authority, delegation, Action, Wake, lease, failure, and Runner decisions remain in force.

## Consequences

- `goah` behaves like a normal Agent until durable Goal intent is explicitly accepted.
- Human provenance and Goal execution scope are separately auditable.
- Goal work has a stronger completion gate than before because a valid Handoff alone is insufficient without a current-Turn Work Record revision.
- Cross-Agent semantic context has one current view and one inspectable version timeline.
- Child creation becomes stricter because observation and verification methods are both mandatory.
- Old events remain readable; migration appends new Work Record facts rather than rewriting history.
- UI may hide internal Wakes, raw RPC, assistant narration, and Ledger sequences by default because explicit status, records, history, and debug surfaces retain audit access.

## Rejected alternatives

### Keep implicit Goal creation and only shorten the prompt

Rejected because the runtime would still be unable to distinguish ordinary conversation from work that requires Work Record and Handoff invariants.

### Add a top-level `chat | goal` mode selected before every message

Rejected because message provenance and Goal scope are independent. A Human Turn can become Goal-bound through a tool call, and a Human may inspect Goal state without entering Goal work.

### Use a real Git repository for Work Records

Rejected because Goah needs the timeline properties, not Git's object, index, branch, merge, and workspace semantics. Event plus projection provides revision history, CAS, replay, diff, and shared reads without coupling non-code Goals to Git.

### Keep Handoff, memory, and Work Record as peers

Rejected because three model-authored semantic stores create ambiguous freshness and authority. Handoff is now a control pointer; Work Record is Goal semantic state; Ledger contains exact facts.
