# goah

**Goal-Oriented Agent Harness** — a long-running, goal-oriented agentic system.

Agents handle tasks. goah holds the goal.

[![CI](https://github.com/billc8128/opengoah/actions/workflows/ci.yml/badge.svg)](https://github.com/billc8128/opengoah/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
![Status](https://img.shields.io/badge/status-experimental-orange.svg)

## Why

Coding agents are good at bounded tasks: you give one a prompt, it works, it stops. Give one a goal measured in weeks — "keep this repo healthy", "grow revenue to $X/day" — and everything between runs is on you: remembering the goal, scheduling the next run, checking what the agent actually did, recovering when it crashes mid-flight.

goah is the harness around the agent that owns exactly that layer:

- **The ledger is the agent.** Agent processes are short-lived: hydrate → work → response or Goal Handoff → exit. Everything durable lives in an append-only event ledger; every table is a projection that can be rebuilt from events. Crash recovery is replay, not heuristics.
- **The Thread is resumable.** A Thread contains durable Turns and Items. Each Turn transcript records user/assistant messages, tools, compaction, and the exact prepared model request. Runner/provider sessions are never the fact authority.
- **Every execution is inspectable.** Turns retain normalized Tool Calls and results, while Goal work must update its durable Work Record before handoff.
- **Execution stays local and inspectable.** The runner owns local files, bash, and Git under the directory containing `goah.config.json`. GOAH records process failure and recovery context; coding skills decide how to branch, commit, merge, or preserve partial Git work.
- **Lease ownership is bounded, runner policy is not prescribed.** A live Runner execution renews its fenced Turn lease; Wake only schedules future Goal motion. Token, cost, timeout, and compaction policy belong to each Runner.

goah does not replace your agent runner (pi, or any runner that implements the `Runner` interface). It sits above it.

## Status

**Experimental.** Contracts are `0.11.0` / `experimental`. SQLite schema changes are version checked; development workspaces may be recreated before 1.0.

Implemented and tested today:

- Stream-aware append-only SQLite event kernel with durable Thread, Turn, Item, Goal, Work Record, Schedule, Wake, and Mailbox projections
- Versioned Turn transcript vocabulary with future-version refusal, exact request snapshots, normalized user/assistant/tool events, compaction replacements, and interrupted-tool `unknown` repair
- Deterministic Active Context composition: structured projections render to short Markdown, and the exact model-visible value is retained by `request.prepared`
- FIFO Wake scheduling with per-agent claim exclusion; Schedule has durable terminal states and atomically creates one Wake
- Runner-owned local execution: non-software goals need no Git, while coding agents can use ordinary Git and worktree commands through their skills
- Real runner subprocess boundary with sliding lease renewal, process-group termination, per-Agent exit barriers, optional runner-specific timeout, and stale-event rejection
- Ordinary Human Turns return normal responses; Goal-bound Turns require a current Work Record revision and compact Goal Handoff
- Goal Mail is acknowledged atomically with its successful Handoff; ordinary Human conversation never uses Mail or Wake
- Injected clocks, schema v18 fail-closed authoritative Goal changes, durable Wake trigger sets, revision-neutral Goal scheduling, and Turn-owned revision fencing, with indexed bounded queries and a public ledger conformance suite; earlier development schemas are intentionally rejected
- Optional mechanical metric evaluation (missing/stale/sustain/guardrails), a total-silence tripwire, trigger coalescing, and FTS5 fact search; Goal itself has no required metric or target
- Official Pi 0.84.2 worker binding with `read`, `write`, `edit`, and `bash` for every Agent plus model-view-only mid-turn compaction
- Durable textual Goal observation methods with root human confirmation, atomic child assignment, revision invalidation, replay, and evidence-backed completion
- Interactive `goah` CEO shell over a resident Supervisor local control socket, including live goal revisions while Supervisor remains the only SQLite writer
- Event-sourced Work Record filesystem: one versioned semantic document per Goal, organization-wide reads, ownership-checked CAS updates, history, diff, search, and deterministic migration from legacy Handoff/memory
- CEO sole-entry interaction with explicit Human-authorized Goal binding, filesystem-first Goal onboarding, ledger-derived team roster, atomic delegation/reassignment, motion validation, concurrent Goal-owning Agents, and a read-only team dashboard
- Transcript verifier plus global audit interfaces, atomic Mail delivery of findings to Agents/CEO, and precision/risk-weighted-recall evaluation
- Repo-guardian reference application, systemd/launchd templates, and an accelerated 30-day replay/continuity soak
- Bidirectional fenced RPC with role capabilities, executable CEO/verifier/audit prompts, versioned configuration, and singleton CLI controls

Operational acceptance evidence **not yet produced**:

- Real 7/14-day wall-clock soak evidence, a public sanitized long-run ledger, calibrated production verifier labels, and explicitly authorized small-money operation

The completed real-model fault canary is documented in [`docs/canary/2026-08-19-ark-v0.3.1.md`](./docs/canary/2026-08-19-ark-v0.3.1.md): four wakes, one deliberate mid-tool SIGKILL, automatic retry, replay/Inspector verification, and two production findings fixed from the recorded evidence.

## Website

The product site lives in [`apps/web`](./apps/web) as a Next.js, TypeScript, Tailwind CSS, and shadcn-structured application.

```bash
npm run web:dev
npm run web:build
```

## Quick start

Requires Node.js >= 24 (uses `node:sqlite`).

```bash
git clone https://github.com/billc8128/opengoah.git
cd goah
npm install
npm test          # contract, replay, Runner routing, organization, scheduling, recovery, and audit tests
npm run example   # one full cycle: Goal → Wake → Turn → Work Record + Handoff
npm run example:guardian
npm run test:soak
```

Initialize and operate a configured supervisor:

```bash
npm install --global @goah/cli
goah setup
goah doctor
goah "Launch a profitable store"
# Reattach later:
goah --continue
```

After the first install, update in place without remembering how npm was prefixed:

```bash
goah update --check
goah update
```

`goah update` preserves global npm installs and custom-prefix installs such as `~/.goah-tool`. It never invokes `sudo`; permission failures are reported with the exact npm command. Use `--dry-run` to inspect the command or `--version X.Y.Z` to install an explicit version.

The global CLI is the default product path: after installation, `goah` works from any directory and initializes that directory as its local workspace. For TypeScript library integration instead, install `@goah/cli` in the project and use its documented subpath exports.

The normal product flow is an ordinary CEO interaction. Greetings, questions, and bounded work do not create a Goal. Durable Human intent may be translated by CEO into `create_goal`, or created explicitly with `/goal`; from that point the Turn follows strict Goal, Work Record, observation, verification, and Handoff policy. Lower-level Goal controls remain available for inspection, extensions, and Human root authority:

```bash
goah goal-create --id first-goal --owner worker --objective "Complete the first verified handoff" --observation-method "Inspect a fresh evidence-backed handoff" --wake-now
goah goal-show first-goal
goah goal-update first-goal --objective "Updated objective" --observation-method "Inspect evidence for the updated objective"
goah goal-pause first-goal
goah goal-resume first-goal
goah goal-complete first-goal --reason "observation passed" --evidence <seq>
goah status
```

`goah` starts the resident Supervisor when necessary and attaches the interactive CEO. `/model` opens the scoped model picker; `/login` and `/logout` manage credentials without replaying onboarding; `/setup` opens returning-user settings with `model`, `auth`, and `runner` sections. Unknown slash commands fail locally and never wake the CEO. `/goal ...` revises the active root and invalidates its old observation method; `/observe ...` confirms the replacement through human authority. `goah start` remains the explicit daemon command and `goah wake <agent>` queues a manual wake. `goah daemon status|logs|restart|stop` manages the resident process.

Goah Core knows only Runner Profiles. Each Runner owns its provider/model/auth semantics. OAuth credentials stay in the Runner credential store; only the selected Turn's scoped credential crosses the private worker pipe, never Agent context or the Ledger.

Inspect and export the replayable Thread ledger without requiring provider credentials:

```bash
goah thread list
goah thread show <thread-id>
goah thread replay <thread-id>
goah context show <turn-id>
goah events --stream wake:<wake-id> [--from 1]
goah thread export <thread-id> --output thread.json
```

`thread show` returns its Turns and Items. Export is redacted by default; `--raw` is an explicit local-only escape hatch and may contain sensitive prompts and tool results.

Runner Profiles allow different Agents to use different execution backends or Pi targets:

```bash
goah runner setup fast
goah runner profile assign worker fast
goah runner status
```

Ark is not a built-in special case. If needed later, configure it as a Pi custom endpoint rather than extending Goah Core.

## How it works

```
            ┌──────────────────────────── supervisor (only resident process) ───────────────────────────┐
            │                                                                                           │
  Human ────┼──────────────────────▶ Human Turn ─────────┬─▶ normal response                         │
            │                                            └─▶ optional Goal binding                   │
  Goal ─────┼─▶ Wake queued ─▶ claimed ─▶ Goal Turn ───────▶ Work Record + Handoff                    │
            │       │                     │ lease / PID / fencing / retry / recovery                   │
            │       │ dedupe trigger      ▼                                                            │
            │       └──────────────▶ Wake consumed (`turnId`)                                          │
            │                                                                                           │
            └───────────────────────────────────────────────────────────────────────────────────────────┘
                                                                   ▼
                                            stream-aware event kernel (source of truth)
                                            Thread/Turn facts + execution-module projections
```

One Goal Wake, step by step:

1. A due pending `schedule` atomically becomes `consumed` while creating one queued `wake`; stale Goal bindings become `superseded`.
2. Claiming it creates one Goal-bound Turn in the owner Agent's Thread. Human input starts or steers a Turn directly and never creates Wake or Mail.
3. Turn owns Runner lease, fencing, PID, transcript, retry, interruption, and terminal state. `sourceWake` is provenance only.
4. The Goal Turn receives Goal/Work Record context and runs the same Runner agent loop as a Human Turn.
5. A Goal Turn must update its Work Record and emit a compact Handoff Item before completion.
6. Future scheduling creates another Wake and therefore another Turn. Mail remains asynchronous communication only.
7. Invalid execution fails the Turn; interrupted open Tool Calls receive explicit unknown results. A replacement Turn waits until the old Runner process exits. Committed Work Record history survives.

Goah does not currently define a second Action state machine. Ordinary Tool Calls and permissions belong to the Runner. A future optional ExternalEffect layer requires isolated credentials and a concrete need for durable approval or reconciliation.

## Distribution and source modules

Goah publishes one npm package: `@goah/cli`. The internal workspaces remain separate in source, but are bundled into that tarball, so one logical release produces one package version and one npm notification. Framework consumers use subpath exports such as `@goah/cli/kernel`, `@goah/cli/transcript`, `@goah/cli/sqlite`, and `@goah/cli/supervisor`.

| Source workspace | Public import | What it is |
|---|---|---|
| `ledger-contract` | `@goah/cli/kernel`, `/transcript`, `/execution`, `/metrics` | Generic event kernel, normalized Turn transcript vocabulary/replay, execution contracts, and optional metric policy. |
| `ledger-sqlite` | `@goah/cli/sqlite` | Single-writer SQLite ledger and rebuildable standard projections. |
| `supervisor` | `@goah/cli/supervisor` | Scheduler, wake lifecycle, Runner exit barriers, Active Context, and Goal coordination. |
| `runner-pi` | `@goah/cli/runner-pi` | Pi adapter, process runner, normalized transcript events, exact request snapshots, local tools, and compaction. |
| `testkit` | `@goah/cli/testkit` | Simulated clock, faux worker, conformance suite, and fault injection. |
| `cli` | `@goah/cli` | Configuration, singleton daemon, status/doctor, goals, and dashboard. |

## Security model

Read this before pointing goah at anything real.

Mechanically enforced today:

- Runner code executes in child processes with bounded, per-request credentials and never receives a ledger connection. Read/write/edit reject Goah state paths, and Bash runs inside a platform sandbox that masks credential/control state; unsupported platforms fail the Bash tool closed. Control state defaults to `~/.goah/state`.
- The events table is append-only (enforced by SQLite triggers); invalid Wake and Schedule transitions are rejected by typed APIs and database constraints.
- `request.prepared` records model-visible behavior but excludes provider API keys, authorization headers, abort handles, and transport-private objects.
- Recovery Active Context includes only the failed Turn reason, interruption/compaction markers, and tool calls with unknown outcomes; raw deltas and request snapshots remain in the ledger for explicit inspection.
- Mail survives failed Turns, and interrupted Tool Calls are repaired to visible unknown results.

Not guaranteed, by design honesty:

- goah does not make the model's judgment correct. It records reasons and evidence; it cannot verify they are good reasons.
- goah does not defend against prompt injection inside the agent's own context.
- The Pi Runner is trusted local code, but Bash is constrained to workspace writes, read-only toolchain roots, and explicit Goah-state denial. Unsupported sandbox backends fail closed.

## Architecture status

| Milestone | Scope |
|---|---|
| v2 ledger kernel | ✅ stream-aware event schema, private projection metadata, required/ignorable events, SQLite schema v18, transaction fault injection |
| resumable Thread + Turn transcript | ✅ durable Thread/Turn/Item projections, normalized Pi messages/tools/requests, compaction facts, replay and interrupted-tool repair |
| Active Context | ✅ deterministic Markdown composition with evidence source sequences |
| execution modules | ✅ Goal/Wake/Schedule/Mailbox/Handoff contracts are layered above the generic kernel; Schedule has a closed lifecycle and Action is deliberately deferred |
| 2 — narrow closed loop | ✅ repo-guardian implementation complete; real unattended 14-day run still operational evidence |
| 3 — verification layer | ✅ verifier/global-audit interfaces, blind-first isolation and evaluation implemented; production calibration dataset remains operational work |
| 4 — multi-agent | ✅ interactive CEO, durable observation methods, ledger-derived roster, atomic delegation/reassignment, revision barriers, concurrent child agents, mailbox and dashboard |

## Design

The current architecture source is [`docs/architecture.md`](./docs/architecture.md), with the complete Goal model in [`docs/proposals/goal-bound-agent-operating-model.md`](./docs/proposals/goal-bound-agent-operating-model.md); [ADR 0011](./docs/adr/0011-goal-bound-turns-and-work-record-filesystem.md) records the transition. [`Goah-架构设计-v2.html`](./Goah-架构设计-v2.html), [`Goah-CEO-Agent-Operating-Layer.html`](./Goah-CEO-Agent-Operating-Layer.html), and [`北辰-harness-设计稿.html`](./北辰-harness-设计稿.html) are preserved as historical designs. Decisions are recorded as ADRs in [`docs/adr/`](./docs/adr/).

The user-facing organization layer is documented in [`Goah-CEO-Agent-Operating-Layer.html`](./Goah-CEO-Agent-Operating-Layer.html), with the reviewable Markdown source in [`docs/proposals/ceo-agent-operating-layer.md`](./docs/proposals/ceo-agent-operating-layer.md). Milestones A–C and E are implemented: CEO is the interactive normal entry, every Agent receives the Pi coding baseline, Goal observation methods persist across wakes, team state is derived from Ledger facts, and delegation/reassignment is atomic. The deterministic multi-Agent canary is covered by the test suite; a long-running real-model canary remains operational validation.

## Contributing

The contracts are experimental and moving; issues and discussion are more useful than large PRs right now. Everything runs offline — `npm test` is the whole setup. If you change ledger semantics, add a fault-injection case proving the transaction boundary holds.

## License

[Apache-2.0](./LICENSE)
