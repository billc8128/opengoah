# ADR 0013: Runtime lifecycle closure

Status: accepted
Date: 2026-08-26

## Context

The unified Turn runtime left four mismatched boundaries: Schedule had no terminal lifecycle, a terminal Turn could precede actual Runner exit, projection metadata occupied ordinary event payload names, and Action duplicated Tool Call behavior without a real credential boundary.

## Decision

1. Schedule is a durable state machine: `pending → consumed|cancelled|superseded`. Wake creation and Schedule consumption are one Ledger transaction. Goal changes supersede pending schedules bound to older revisions.
2. Logical Turn termination and physical Runner exit are distinct. Every Agent has one execution lane, and replacement Turns wait for the prior Runner termination barrier.
3. Projection name is private Event-table metadata. A typed event carries exactly one snapshot in `EventRecord.data`; raw business events cannot set the private projection name.
4. Action, audit-advice, approval, and Connector contracts are removed. Runner Tool Calls remain the sole current execution vocabulary. External effects may return later only as an optional subsystem backed by isolated credentials and real reconciliation requirements.

## Consequences

- Stale persisted work reaches a terminal state instead of poisoning daemon progress.
- Preemption revokes Ledger authority immediately without allowing overlapping local processes.
- Replay authority is structurally separate from business payload naming.
- The core runtime is smaller: User Message → Turn → Tool Call/Result → optional Goal Work Record/Handoff.
- Existing development workspaces use schema v16 and are recreated rather than migrated.
