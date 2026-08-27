# Changelog

## Unreleased

- Inactive reassignment results may contain no Wake because paused/blocked Goals cannot schedule execution.
- Added discriminated `ExecutionBinding`, `ScheduleBinding`, `TurnBinding`, and `MailRoute` contracts plus constructors; removed optional and inferred execution routing.

- Contract 0.13 adds typed Mail Goal routing, removes all Handoff effect fields, and splits Team motion from lastOutcome.

- Contract 0.12 makes Wake and Schedule revision-neutral while Turn admission owns the exact Goal revision fence.
- Removed the framework Metric vocabulary; arbitrary observations are Agent Tool Results and ordinary Ledger evidence.
- Split Agent Handoff drafts from committed Goal Handoffs and require explicit outcome/evidence.
- Contract 0.11 adds durable sourced Wake triggers and transaction-safe trigger inspection.
- Runner admission carries the authoritative Wake trigger snapshot, and Ledgers expose per-Agent trigger history for redelivery decisions.
- Contract 0.10 removes Action/Connector types, adds the closed Schedule lifecycle, and separates Goal event data from private projection metadata.
- Contract 0.9 defines the authoritative `GoalChangedData` envelope and Goal mutation provenance.
- Replaced Wake-owned execution with Turn attempt/lease/PID/fencing, scheduling-only Wake states, `TurnOutput`, `RunnerCandidateResult`, and Action Turn provenance.
- Added Turn source/Goal binding, ordinary Runner responses, Goal verification methods, Work Record contracts, compact Goal Handoffs, and shared-record capabilities.
- Transcript assistant messages retain provider stop reasons and error messages.

## 0.6.0

- Ledger contract gained `latestEvent()` for an O(1) global-recency query.

## 0.5.0

- Added textual Goal observation methods, evidence-backed completion, and child Goal revision capabilities.

## 0.4.0

- Added the closed Goal phase lifecycle and transition assertion.
- Added Transcript format v1, legacy upgrade, corruption/unsupported errors, and the event `ignorable` marker.

## 0.3.0

- Replaced the wake-specific event envelope with generic `streamId` / `streamSeq` events.
- Added normalized Transcript event types, replay, request snapshots, and interrupted-transcript repair.
- Split kernel, execution, Transcript, and optional metric contracts into source modules.
- Removed mandatory Goal metric and target fields.

## 0.2.0

- Removed the preassigned workspace path from `RunRequest`; local execution is owned by the runner.
- Removed monetary goal budgets and the `budget.read` capability; domain policy is extension-owned.
- Removed `RunLimits` and mandatory token usage from the public runner contract.

## 0.1.0

- Experimental ledger, runner, load, handoff, metric, budget, and connector contracts.
