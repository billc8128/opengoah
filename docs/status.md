# Status

The full capability checklist behind the README status summary.

## Implemented and tested today

- Stream-aware append-only SQLite event kernel with durable Thread, Turn, Item, Goal, Work Record, Schedule, Wake, and Mailbox projections
- Versioned Turn transcript vocabulary with future-version refusal, content-addressed exact request snapshots, normalized user/assistant/tool events, compaction replacements, and interrupted-tool `unknown` repair
- Deterministic Active Context composition: structured projections render to short Markdown; immutable request components are stored once and each `request.prepared` references their hashes
- FIFO Wake scheduling with per-agent claim exclusion; Schedule has durable terminal states and atomically creates one Wake
- Runner-owned local execution: non-software goals need no Git, while coding agents can use ordinary Git and worktree commands through their skills
- Real runner subprocess boundary with sliding lease renewal, process-group termination, per-Agent exit barriers, optional runner-specific timeout, and stale-event rejection
- Every Turn uses one Runner loop; visible Goal context stays advisory until a Turn acquires a Goal commitment, which requires a readable response, current Work Record revision, and compact Goal Handoff
- Goal Mail is acknowledged atomically with its successful Handoff; ordinary Human conversation never uses Mail or Wake
- Injected clocks, schema v28 persisted canonical Thread roles and Runner cleanup ownership, atomic Human Turn admission, unified Turn triggers/commitments, content-addressed request capture, automatic targets and Mail routing, one canonical Wake-to-Turn transition, durable Wake trigger sets, revision-neutral Goal scheduling, and Turn-owned revision fencing, with indexed bounded queries and a public ledger conformance suite; earlier development schemas are intentionally rejected
- Textual observation and verification methods executed by Agents with ordinary tools, plus trigger coalescing and FTS5 fact search
- Official Pi 0.84.2 worker binding with `read`, `write`, `edit`, and `bash` for every Agent plus model-view-only mid-turn compaction
- Durable textual Goal observation methods with root human confirmation, atomic child assignment, revision invalidation, replay, and evidence-backed completion
- Interactive `goah` CEO shell over a resident Supervisor local control socket, including live goal revisions while Supervisor remains the only SQLite writer
- Event-sourced Work Record filesystem: one versioned semantic document per Goal, organization-wide reads, ownership-checked CAS updates, history, diff, search, and deterministic migration from legacy Handoff/memory
- CEO sole-entry interaction with explicit Human-authorized Goal commitment, filesystem-first Goal onboarding, ledger-derived team roster, atomic delegation/reassignment, motion validation, concurrent Goal-owning Agents, and a read-only team dashboard
- Transcript verifier plus global audit interfaces, atomic Mail delivery of findings to Agents/CEO, and precision/risk-weighted-recall evaluation
- Repo-guardian reference application, systemd/launchd templates, and an accelerated 30-day replay/continuity soak
- Bidirectional fenced RPC with role capabilities, executable CEO/verifier/audit prompts, versioned configuration, and singleton CLI controls

## Operational acceptance evidence not yet produced

- Real 7/14-day wall-clock soak evidence, a public sanitized long-run ledger, calibrated production verifier labels, and explicitly authorized small-money operation
- Runner isolation: the default Pi Runner inherits the launching operating-system user's full filesystem, process, and network authority (`cwd` is a working context, not a permission boundary), which does not yet match the long-running-autonomy-plus-authorized-small-money goal. Until a fenced execution story exists, isolation remains a deployment-layer responsibility (sandbox, container, VM, or restricted account)

## Fault canary

The completed real-model fault canary is documented in [`docs/canary/2026-08-19-ark-v0.3.1.md`](./canary/2026-08-19-ark-v0.3.1.md): four wakes, one deliberate mid-tool SIGKILL, automatic retry, replay/Inspector verification, and two production findings fixed from the recorded evidence.
