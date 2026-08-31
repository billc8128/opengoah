# Goah concepts

A one-screen orientation. Definitions below are distilled from [`docs/architecture.md`](./architecture.md) and the ADRs; the normative wording lives there.

## One Goal cycle

```text
                    Human
                      │  a user message starts or steers a Turn directly
                      ▼  (never creates a Wake or Mail)
  ┌───────────────────────────────────────────────────────────────┐
  │ Goal                                                          │
  │  └─▶ Schedule (future motion, pending)                        │
  │         └─ due ─▶ Wake (queued → claimed → consumed)          │
  │                   └─ claimed ─▶ committed Turn                │
  │                        in the owner Agent's Thread            │
  │                                │                              │
  │                                ▼                              │
  │                         Runner agent loop                     │
  │                                │                              │
  │                                ▼                              │
  │             Work Record update + Goal Handoff (terminal)      │
  │                                │                              │
  └────────────────────────────────┼──────────────────────────────┘
                                   ▼
            append-only event Ledger — the only durable fact authority
```

A successful committed Turn may schedule the next observation, producing another Schedule → Wake → Turn cycle; Handoff closes a Turn at a real control boundary.

## Vocabulary

- **Ledger** — the append-only typed event store with a global sequence; the sole durable fact authority, and every projection is disposable and rebuildable by replay.
- **Thread** — a durable Goah conversation belonging to one Agent (not a provider thread); it holds that Agent's Turns and Items.
- **Turn** — the sole unit of execution: one Runner run with lease, fencing, transcript, retry, and terminal state, started by a Human message or a Wake.
- **Item** — a normalized record inside a Turn (user/assistant/reasoning message, tool call or result, request snapshot, compaction fact) that reconstructs exactly what the model saw and did.
- **Goal** — a durable objective with owner, phase, revision, and textual observation and verification methods; CEO owns Root Goals and Child Agents own Child Goals.
- **Wake** — the queued request that starts one Goal Turn (`queued → claimed → consumed`); it is the only way automatic Goal motion begins.
- **Schedule** — the durable record of requested future Goal motion (`pending → consumed | cancelled | superseded`); a due Schedule atomically creates exactly one Wake.
- **Work Record** — one versioned semantic document per Goal in the event-sourced filesystem; every committed Turn must update it under the current Goal revision.
- **Handoff** — the declarative terminal control result of a committed Turn, carrying outcome plus evidence that points at a Work Record revision instead of duplicating prose.
- **Mail** — the bounded, acknowledged Agent-only asynchronous delivery path (Goal, CEO-inbox, or Specialist-inbox routes) for Agent-to-Agent communication and verification/audit findings; Human conversation uses canonical Thread Messages and never Mail or Wake.
- **CEO / Child / Verifier / Audit** — the canonical Thread roles: CEO is the only user-facing Agent and owns Root Goals only; each Child Agent owns a Child Goal and executes it; Verifier and Audit are Wake-triggered specialist Threads that check transcripts and deliver findings by Mail.

Deeper detail: [`docs/architecture.md`](./architecture.md), decisions in [`docs/adr/`](./adr/), and the Goal operating model in [`docs/proposals/goal-bound-agent-operating-model.md`](./proposals/goal-bound-agent-operating-model.md).
