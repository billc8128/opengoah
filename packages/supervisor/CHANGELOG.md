# Changelog

## Unreleased

- Uses typed Mail routes, reserves Human requests for CEO, commits effect-free Handoffs, scopes outcome context by Goal, and separates Team motion/outcome.
- Child Agents now admit only owned Child Goal Turns, CEO admits only Human/owned Root Goal Turns, and unbound system execution is reserved for Verifier/Audit specialists.
- Profile validation enforces one primary identity: exactly the `ceo` Agent has the CEO role.
- Agent Mail requires an owned Goal route, delivery is scoped to the bound Goal, and inactive routed Mail remains dormant until resume.
- Goal lifecycle invalidation is centralized in the Ledger; Supervisor no longer carries separate pause/completion Wake suppression paths, and Team motion ignores stale Goal Wakes.
- Added one Turn prompt decision table and one canonical recovery reducer alongside Supervisor retry/escalation conventions; CLI no longer reconstructs either policy.

- Turn source and Human authority now derive from pending durable Wake triggers rather than the Wake's original display trigger.
- Recovery context/retry sequencing and Mail redelivery now use admitted trigger snapshots, including triggers coalesced under another Wake.
- Goal revisions no longer invalidate queued Wake/Schedule motion; Supervisor binds the current active revision only when creating the Turn.
- Removed Metric registration, collection, evaluation, and automatic owner wakes from Supervisor.
- Removed legacy blocker/material Handoff inference; Supervisor commits the Agent's explicit outcome and evidence.
- Removed organization-motion validation, outcome-driven CEO wakes, prescriptive ancestor revision warnings, and the system-silence policy.
- Removed Action/Connector dispatch, added per-Agent Runner termination barriers, and made stale due Schedules terminal instead of daemon-blocking.
- Human admission now rechecks the Thread after a termination barrier, and atomic verification results use bounded acknowledged Mail shared by Human and Wake Turns, with child findings escalated to CEO.
- Goal mutations fence active older Turns, every Goal-bound RPC rechecks its binding, and definition staleness ignores phase-only events across the full ancestor chain.
- Supplies reason, evidence, authority, source Turn/Wake, and idempotency provenance to the unified Goal change protocol.
- Serialized Human admission, made multi-Goal scheduling target-safe, made Runner cleanup failure non-blocking, and restored kill-before-recovery through persisted Runner Profile routing.
- Unified Human and Goal work on one Turn executor and RPC path with Human-priority scheduling, same-Turn provider retry, canonical Transcript terminals, Turn recovery, and identical Goal completion policy.
- Rejected steering now rolls into a fresh Turn without duplicating completed input; daemon polling releases abort listeners; connector and metric output is bounded.
- Separated ordinary Human Turns from Goal-bound execution, added dynamic Human-authorized Goal binding, strict Work Record fences, verifiable Child Goals, transparent shared record context, and compact Goal Handoffs.

## 0.6.0

- Replaced the per-agent heartbeat and per-goal progress watchdogs with one system-silence tripwire (`silence` option, default 12h/ceo, `null` disables); any ledger event resets the clock and the tripwire mails a decision-level confirmation request at most once per silence window.

## 0.5.0

- Added filesystem-first CEO onboarding, observation/revision Active Context, completion evidence, and stale-child gated-action barriers.

## 0.4.0

- Added revisioned Goal update and lifecycle transition APIs.

## 0.3.0

- Added deterministic Markdown Active Context composition with evidence source sequences.
- Repairs interrupted Turn transcript tool calls as unknown before scheduling recovery.
- Metric policy is registered independently of Goal.

## 0.2.0

- Removed workspace/Git lifecycle management and monetary budget policy from the supervisor; abnormal recovery preserves control state only.
- Added sliding wake-lease renewal while a runner process is alive.

## 0.1.0

- Scheduler, daemon, metrics, watchdog, action gate, verification plane, multi-agent contexts, and dashboard.
