# Changelog

## Unreleased

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
