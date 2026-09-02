# Changelog

## 0.14.1

- Shows an animated Turn activity row from submission through completion so the TUI remains visibly alive before the first model or tool event.
- Adds bounded chunked Runner protocol framing for legitimate large trace messages such as image Tool Results and exact request snapshots, while retaining the 1 MB per-line and 32 MB per-message safety limits.

## 0.14.0

- Replaced semantic Mail levels with Agent-selected `high|normal|low` delivery priority; Supervisor now only applies priority and arrival order mechanically, and SQLite schema v29 intentionally recreates earlier development state.
- Reworked the TUI into a Turn-oriented Ledger presentation with a stable Human composer and a compact organization status read model; reasoning, tools, replies, receipts, and errors no longer collapse into one visual log.
- Made terminal signal cleanup and bundled Pi OAuth loaders explicit, including installed-package regression coverage for OpenAI Codex OAuth.
- Aligned the reference Pi Runner with upstream Pi by composing its native read/bash/edit/write tools directly: `cwd` is no longer a Goah permission boundary, absolute paths and commands inherit host-user access, and isolation is left to custom Runners or deployment wrappers. The single-package build now preserves Pi's Photon image runtime and verifies installed image reads.
- Transcript v2 content-addresses exact request components so repeated model calls remain reconstructable without copying full context; SQLite schema v29 intentionally rejects earlier development state.
- Child completion now requires its owner's current Work Record from a completed Turn and evidence citing that record or matching Handoff; failed daemon starts are reaped, and credential-like TUI input requires explicit confirmation.
- Removed the duplicate Human Mail/request channel: CEO/Human communication now exists only as canonical Thread Messages, while Mail is restricted to Goal, CEO-inbox, and Specialist-inbox Agent routes. Welcome replay includes committed automatic CEO replies.
- Unified all execution under one Turn shape: Thread persists canonical Agent role, Turn persists `user_message|wake` trigger plus optional Goal commitment, active Root context is visible without creating responsibility, and Wake/Schedule retain only automatic Goal/Specialist targets under schema v29; Human Turn replacement is atomic and terminal Turns retain Runner cleanup ownership until release.
- Unified successful Runner results as readable response plus optional Handoff, made Human input direct-only, and made explicit `/goal` start a committed CEO user Turn without an intermediate Wake.
- Made Goal output dual-channel without duplicate authority: every validation attempt invalidates older tokens, Goal Runner feedback is mandatory, normalized completion intent drives UI, Pi fences post-revocation tools, and commit references the existing Message while allowing later Work Record refinement.
- Closed Turn admission under schema v24: removed the duplicate `consumeWake` API, restricted direct Turn creation to CEO Human Turns, fenced current Goal revision/owner/phase transactionally, enforced one Wake per Turn, and added typed Turn/Wake replay reducers.
- Removed the unused Action/Connector aggregate so Runner Tool Calls are the sole execution vocabulary; simplified verification, CLI, TUI, Console, examples, and testkit accordingly.
- Added terminal Schedule states with atomic Wake creation and Goal-revision supersession, plus a per-Agent Runner-exit barrier that prevents replacement Turn overlap.
- Moved projection authority out of business event payloads into private schema-v17 Event metadata; raw facts may now use fields such as `projection` and `snapshot` safely.
- Replaced the scalar Wake trigger abstraction with durable sourced trigger sets, and routed nested Wake/Schedule/TurnItem creation through canonical transaction-safe admission helpers.
- Made admitted Wake trigger snapshots authoritative across Runner requests, recovery sequencing/context, Mail redelivery, and Console recovery state, including coalesced-trigger cases.
- Moved Goal revision fencing out of Wake/Schedule and into Turn admission so Agents receive the latest Goal context and decide how earlier plans apply.
- Defined Supervisor as a mechanical control plane: it supplies durable context and tools while organizational and metric interpretation remains Agent policy.
- Removed Core Metric contracts, collectors, evaluators, samples, and automatic Metric Wakes; Agents now execute arbitrary observation methods with their tools and cite the resulting evidence.
- Replaced legacy Handoff inference with an explicit Agent `outcome + evidence` draft; Supervisor injects trusted Goal and Work Record identity without rewriting intent.
- Removed CEO motion rejection, implicit Child/Verification escalation, revision advice, and the default silence watchdog from Supervisor; Agents now request communication and future motion explicitly.
- Added architectural regression coverage proving all Handoff outcomes are side-effect free and only explicit Mail/Schedule requests create organization effects; updated CLI/Console presentation to the compact outcome/evidence schema.
- Closed the v0.13 control boundary: typed Agent-only Mail routing, direct CEO/Human Thread Messages, effect-free Handoff contracts, Goal-scoped outcome context, recovery Schedule awareness, and separate Team motion/outcome fields.
- Closed Agent execution admission: CEO owns Root Goals, Child Agents run only their distinctly owned Child Goals, and Verifier/Audit retain the only unbound system path.
- Required Goal-routed Agent Mail, scoped delivery by Goal, kept inactive reassignment Mail dormant until resume, and rejected unbound CEO/Child system Wakes before Runner admission.
- Centralized legal prompt selection and recovery reduction in Supervisor, including retry escalation, failed retries, and strict Schedule/Wake identity.
- Persisted schema-v21 `ExecutionBinding` discriminants on Wake, Schedule, and Turn; recovery, Verification, Wake consumption, and stop now use the canonical binding instead of inferring execution from `goalId`, source, or Agent names.
- Replaced optional Wake/Schedule/Mail Goal fields with discriminated execution bindings and Mail routes; nested retry exhaustion now escalates to the direct parent, Specialist recovery is visible, and manual wake/stop accept a Goal binding.
- Rechecked Human admission after Runner barriers, coalesced scheduled motion with queued Goal Wakes, normalized Schedule timestamps, enforced immutable Wake/Mail identity, and delivered atomic verification results through bounded acknowledged Mail.
- Made `commitHandoff` the only successful Goal-Turn terminal path, validated every duplicated Handoff representation against canonical TurnOutput, and preserved non-Mail triggers when acknowledging Mail.
- Closed the remaining fail-closed boundaries for projection replay, Goal provenance/idempotency, stale Goal Turns, ancestor definition fences, and loopback Console Host authorization.
- Unified every Goal lifecycle mutation under the authoritative `goal.changed` event envelope and made the Goal projection directly rebuildable from it.
- Made scheduling Goal-aware, persisted Runner recovery identity, serialized Human admission, fenced organization mutations, and unified terminal Turn presentation across TUI and Console; schema v15 makes `goal.changed` authoritative, validates replay/provenance fail-closed, and intentionally rejects earlier development state.
- Completed the Thread/Turn/Item architecture: Wake is scheduling-only, Turn owns execution and recovery, Human input blocks automatic claims, Goal policies share one completion path, and schema v12 rejects earlier development state.
- Hardened concurrency, idempotency, streaming, verification, and long-running resource boundaries found by adversarial review.

## 0.11.5

- Keep Pi reasoning blocks out of user-visible assistant responses, render only text deltas as Markdown, and show tool calls as separate in-place execution rows with concise targets and status.

## 0.11.4

- Preserve provider `stopReason`/`errorMessage` for empty assistant responses, render quota errors honestly, and remove duplicate Goal state from the welcome transcript.

## 0.11.3

- Made TUI snapshot assertions deterministic in ANSI-enabled CI environments; includes the 0.11.2 terminal redesign.

## 0.11.2

- Rebuilt the terminal UI around a fixed brand rail, compact Goal-aware welcome, Markdown conversation rendering, bottom composer, scrollable alternate-screen viewport, quiet tool states, and maintained Pi TUI package.

## 0.11.1

- Added compatibility for a pre-0.11 resident daemon spawning the updated Pi worker, automatic daemon version detection/restart on the next CLI launch, and concise runtime error rendering instead of raw stacks.

## 0.11.0

- Ordinary CEO interaction no longer creates a Root Goal or requires Handoff; durable Human intent can bind the open Turn through Goal tools.
- Added versioned shared Work Records, separate Goal observation/verification methods, strict Goal-owned delegation, compact revision Handoffs, legacy memory migration, and quiet default CLI output.

## 0.10.2

- Provider and model setup lists now use a visible fuzzy-search field across names, IDs, and descriptions, with live result counts, query-aware empty states, and two-stage Escape behavior (clear, then cancel).
- Reworked setup into an explicit five-step flow with progress, back/retry paths, concise review output, masked API-key entry, private key storage, and validation that prevents pasted secrets from becoming environment-variable names.
- Setup now clears its screen before the CEO TUI starts; fresh workspaces omit empty placeholder sections, `/model` opens configuration instead of waking the CEO, and runtime errors hide internal wake IDs and credential-shaped values.

## 0.10.1

- Added `goah update`, with `--check`, `--dry-run`, and explicit `--version`; it detects global npm versus custom-prefix installations, refuses to mutate source checkouts, and verifies the installed version after npm completes.

## 0.10.0

- Replaced model/provider fields in Goah Core with opaque Runner Profiles and a generic `RunnerConfigurator`; `RunnerRouter` selects a Runner per Agent without understanding its provider or model.
- Pi Runner now owns the complete Pi provider/model registry, OAuth and API-key configuration, local-model discovery, custom OpenAI/Anthropic-compatible endpoints, model switching, and Runner-specific diagnostics. The Ark special case was removed.
- Added `goah runner`, `goah auth`, `goah model`, and `goah daemon status|logs|restart|stop`; `doctor` is human-readable by default with `--json` for automation.
- Fixed swallowed TUI prompts, wired approvals/help, rendered assistant deltas and tool completion, queued follow-up messages, and restored a compact Ledger-derived conversation recap on attach.
- Incomplete onboarding state now resumes setup; cancel never overwrites the existing profile, workspace updates are atomic, and command typos no longer become model prompts.
- Provider credentials remain outside worker environments and are resolved into per-wake private runtime material that never enters Agent context or the Ledger.

## 0.9.2

- Fixed wizard text prompts: the prompt line now renders inside the TUI header instead of a raw stdout write that the differential renderer erased, leaving the Model/API-key scenes visibly waiting with no question.


## 0.9.1

- `goah setup` scenes now use arrow-key SelectList navigation (↑/↓ + Enter, Esc cancels) with a persistent header per scene, matching the pi/omp selection pattern; number-typing remains only in the non-TTY fallback.

## 0.9.0

- The control protocol gains `config.reload`: the daemon hot-swaps its runner (refused while a wake is leased/running), so TUI-driven config changes take effect immediately. `action.reject` also gained its missing protocol branch.
- `goah setup` runs a TUI wizard (provider → model → key env → summary; piped fallback for non-TTY) writing `~/.goah/profile.json`; first-run `goah` enters it automatically.
- TUI gains `/model ID` (write config + hot reload) and `/setup` (re-enter the wizard, reload daemon), matching the pi/omp/hermes baseline of in-session provider/model commands that take effect without restart.
- The TUI opens with a fixed-slot welcome panel: read-only ledger snapshot (root goal, agents, recent handoffs) with zero daemon dependency; a missing ledger renders placeholders so the layout never shifts.

## 0.8.0

- Bare `goah` now works from any directory: missing workspace config falls back to the global profile (`~/.goah/profile.json`, credentials stored as `env:NAME` references), runs first-use onboarding inline on a fresh machine, and materializes the directory's `goah.config.json` automatically. Non-interactive commands without a config fail with an actionable message.
- The interactive shell is now a full-screen TUI (`@mariozechner/pi-tui`): streaming CEO wake transcript (tool calls, assistant messages, handoffs, blockers), bounded to the last 500 lines, with `/goal`, `/observe`, `/status`, `/approve`, `/reject`, and `/quit`. Non-TTY invocations (pipes, CI) fall back to one-shot streaming output.
- Fixed a Node 26 readline/promises race in onboarding where piped multi-line input left the second prompt unsettled; prompts now use an explicit line queue.

## 0.7.0

- Replaced the per-agent heartbeat and per-goal progress watchdogs with one mechanical floor: a system-silence tripwire. When no ledger event of any kind appears within `silencePolicy.maxSilentMs` (default 12h), the supervisor mails `notify` (default `ceo`) a decision-level confirmation request; any event from anyone resets the clock, so the cadence is at most one confirmation per silence window. Stall response policy is the CEO's business, not the supervisor's. Remove `heartbeatPolicies`/`progressPolicies` from existing configs (loading now strips them); set `"silencePolicy": null` to disable the tripwire.
- Ledger contract gained `latestEvent()` for an O(1) global-recency query, covered by the conformance suite.

## 0.6.0

- Added event-sourced working memory: every Agent owns a `memory:{agent}` stream of `memory.appended` facts appended through the role-scoped `memory.append` RPC, injected into future Active Contexts as a bounded advisory tail with `[event:seq]` provenance. The stream is never compacted, handoff remains the structured milestone record, and `goah memory AGENT [--tail N]` inspects notes (ADR 0010).
- Bash commands run with a process-group timeout: default `GOAH_PI_BASH_TIMEOUT_MS` (120s), per-call `timeoutMs` capped at 10 minutes.
- Added interactive console chat, approvals, and shared control streaming.

## 0.5.0


- Added durable textual Goal observation methods with SQLite schema v8 migration, root human confirmation, atomic child delegation, revision invalidation, replay, and evidence-backed completion.
- Added filesystem-first CEO onboarding policy and Active Context sections for observation methods and revision barriers.
- Added a resident Supervisor local control socket and interactive `goah` shell, including live goal revisions and observation confirmation while the daemon owns SQLite.

## 0.4.0

- Added the CEO Agent Operating Layer as the sole normal user entry: `goal start`, `ceo send/status/inbox/approve`, automatic CEO wakes, and a built-in operating policy.
- Added ledger-derived team rosters and role-filtered Pi tools for atomic delegation, reassignment, child lifecycle control, and human decision requests.
- Delegation now commits its event, child Goal, decision mail, and queued Wake in one SQLite transaction; reassignment is idempotent and suppresses stale owner motion.
- Added CEO motion validation, child material/blocker/exhaustion triggers, root-completion descendant checks, recovery injection, and a deterministic two-child organization canary.
- Added revisioned Goal show/update/pause/resume/complete commands and mechanical phase transitions.
- Added Transcript format v1, an in-memory v0 upgrader, future-version refusal, and required-vs-ignorable unknown event semantics.
- SQLite schema v7 persists the event `ignorable` marker and enforces Goal phases in SQL.

## 0.3.1

- Added read-only Thread list/show/replay and Turn context/events inspection and redacted audit exports.
- Request snapshots now use a behavior-only allowlist and never persist provider credentials or abort handles.
- Recovery Active Context now selects only actionable failure facts instead of expanding raw deltas and request snapshots.

## 0.3.0

- Split the generic ledger kernel from standard execution modules.
- Added global and per-stream event ordering, normalized replayable Transcript events, exact request snapshots, interrupted-tool repair, and deterministic Active Context Markdown.
- Removed mandatory Goal metrics and targets; metric contracts are now optional registrations.
- Added SQLite schema v6 migrations and Goah architecture design v2.
- Consolidated npm delivery into one `@goah/cli` tarball with public framework subpath exports.

## 0.1.0 — 2026-08-19

- Initial experimental GOAH contracts and SQLite schema v3.
- Durable wake/action/mail/audit semantics, process isolation, Pi worker, compaction, metrics, budgets, verification, multi-agent daemon, dashboard, and repo-guardian example.
- Bidirectional role-scoped RPC, executable CEO/verifier roles, generic CLI/configuration, singleton daemon controls, and workspace-ref recovery.
