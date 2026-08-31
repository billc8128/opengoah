# Changelog

## 0.14.0

- Schema v29 renames Mail `level` to Agent-selected `priority` and constrains it to `low|normal|high`; earlier development schemas are intentionally recreated.
- Schema v28 adopts Transcript v2 request components and requires a current owner-written Work Record plus matching evidence before Child Goal completion.
- Schema v28 removes Human mailbox routes and constrains Mail to Agent-only Goal, CEO-inbox, and Specialist-inbox delivery.
- Schema v27 atomically admits Human Turn replacement, retains terminal Runner cleanup ownership until explicit release, persists canonical Thread role, reserves the unique CEO identity, and keeps Human input free of Wake representation.
- Schema v24 makes Wake-to-Turn linkage unique, restricts new direct Turns to CEO Human interactions, validates the current Goal fence at atomic Wake admission, and replays Turn/Wake state through typed transition reducers.
- Goal completion atomically marks an existing readable Assistant Item committed, records the exact Handoff, acknowledges Mail, and closes the Turn; replay validates the fact set without an adjacency requirement.
- Schema v19 stores typed Mail Goal routes and exposes Goal-scoped latest Handoff queries.
- Goal phase and owner transitions mechanically supersede pending Schedules while definition revisions preserve them.
- Goal phase and owner transitions now cancel queued/claimed Goal Wakes in the same transaction as Schedule supersession.
- Reassigning a paused or blocked Goal atomically records routed Mail without a Wake; parent and Child Goals cannot share an owner.
- Schema v21 persists Turn bindings alongside Wake/Schedule binding and Mail-route discriminants; earlier development databases are intentionally recreated.
- Wake admission validates active Goal ownership, Wake consumption validates the full execution binding, and mailbox CHECK constraints preserve Goal/CEO/Specialist Agent routing during replay.

- Schema v18 removes Goal revision fences from Wake and Schedule so queued motion adopts the current revision at Turn admission.
- Schema v17 adds replayable WakeTrigger state, derives Wake identity through canonical admission, and resolves triggers atomically on consume/cancel.
- Schema v16 removes Action projection storage, adds terminal Schedule state, atomically consumes Schedules with their Wakes, and stores projection metadata outside event business payloads.
- Canonicalized Schedule timestamps, coalesced due schedules with queued Goal Wakes, rejected conflicting Wake ids, and kept one snapshot authority per projection event.
- Mail creation is now immutable and idempotent, supports atomic batches, and Handoff Schedules use the same provenance and UTC normalization as direct scheduling.
- Goal-bound Turns can complete only through a current-record Goal Handoff; Item/Mail/Schedule representations must match TurnOutput, and Mail acknowledgement cancels only all-Mail Wakes.
- Schema v15 replaces `goal.put` lifecycle facts with one authoritative, projection-driving `goal.changed` event for every Goal operation; raw/Runner events cannot drive projections, replay validates the complete causal chain, and idempotent operations return their original snapshots.
- Schema v12 makes Turn the sole execution owner, reduces Wake to scheduling state, requires Turn provenance for Actions, and rejects all earlier development schemas.
- Wake-to-Turn creation rechecks Human priority transactionally; direct terminal writes are forbidden; Goal completion retries are idempotent; ordinary source-Wake responses acknowledge Mail atomically.
- Added schema v9 with event-sourced Work Records, history/diff/search, verification methods, Human interaction commits, legacy Handoff/memory seeding, and Human Wake priority.

## 0.6.0

- Added the O(1) `latestEvent()` query.

## 0.5.0

- Added SQLite schema v8 observation methods, migration/replay support, atomic method delegation, and current-revision completion evidence.

## 0.4.0

- Schema v7 persists `EventRecord.ignorable` and adds SQL Goal phase checks/transitions.
- Migrates schema v6 without rewriting event identity or payload history.

## 0.3.0

- Added SQLite schema v6 with global and per-stream event order.
- Migrates schema versions 1 through 5 while preserving event sequence identities.
- Removed Goal metric/target columns and kept standard execution projections transactionally coupled to events.

## 0.2.0

- Schema v5 removes the legacy goal budget column while preserving old goal projections during migration.

## 0.1.0

- SQLite schema v3, WAL, FTS5, explicit migrations, projections, fencing, budgets, and conformance.
