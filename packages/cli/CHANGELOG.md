# Changelog

## Unreleased

- Restores a compact full-width background band for Human messages so prompts remain visually distinct from Goah replies without adding vertical padding.

## 0.13.8

- Rebuilt the full-screen transcript around terminal-native Turn ledgers: Human prompts, bounded thinking, grouped tool timelines, Assistant replies, and receipts retain separate visual roles, with `Ctrl+O` toggling activity detail.
- Replaced mutable runtime copy beneath the transcript with one organization status line (`GOAL`, current `MODEL`, active `CHILD` Agents, and earliest `WAKE`) and one stable `› Message Goah…` composer.
- Restores terminal mouse, keyboard, cursor, and alternate-screen state on `SIGTERM` and `SIGHUP` as well as normal exits.
- Statically registers Pi OAuth flows so the self-contained npm package includes OpenAI Codex login and refresh modules; the installed-package smoke test now loads the OAuth flow before cancelling it.

## 0.13.7

- Reaps detached daemon processes when startup fails and shares one startup implementation between CLI and TUI.
- Warns before persisting credential-like interactive messages, refuses them non-interactively, and shares one redaction fallback across TUI errors and thread exports.
- Inspects Transcript v2 request references by materializing their content-addressed components.
- Removed pending-Human mailbox UI and restores committed Assistant Messages from automatic CEO Turns in the welcome conversation.

## 0.13.6

- The Pi Runner now uses upstream Pi's native read/bash/edit/write tools. `cwd` is a working context rather than a Goah permission boundary, so absolute paths and commands inherit host-user access; isolation belongs to custom Runners or deployment wrappers.
- The self-contained npm bundle now ships and verifies Pi's Photon image runtime, including installs performed with lifecycle scripts disabled.

## 0.13.5

- Streamed text and thinking now use bounded in-memory snapshots instead of durable per-token events; 50,000 deltas produce one Reasoning Item and no Ledger delta rows.

## 0.13.4

- Goal Agents now treat each Wake as a sustained work session, continue through immediately actionable work, and reserve Handoff for a genuine wait, blocker, exhausted frontier, or completion review boundary.
- Runner completion, Handoff validation, Ledger commit, and Control output now reference one canonical Assistant Item by `finalMessageId`; tool-only Handoffs no longer erase an earlier readable reply, and consecutive duplicate terminal errors render once.

## 0.13.3

- Added terminal-protocol-safe Ctrl+C handling: clear a draft, interrupt an active Turn, press again to exit, or exit immediately when idle; Ctrl+D now exits an idle prompt.
- Stopped replaying orphan Human messages from failed or interrupted Turns when the TUI opens; complete conversations remain resumable from the Ledger.
- Replaced the oversized welcome mark with the selected compact horizontal lockup: the official orbital Logo renders in Kitty-compatible terminals, with a faithful Braille mark on unsupported alternate screens.

## 0.13.2

- Replaced the ambiguous block-art welcome mark with a compact terminal orbital glyph, improved secondary-text contrast, and added a shared slash-command registry that drives autocomplete, help, parsing, argument prompts, and a six-row keyboard menu.
- Reduced single-line Human messages to one compact highlighted row instead of adding full blank rows above and below.

## 0.13.1

- Published `@goah/cli` as one fully self-contained bundle: the tarball carries zero registry dependencies, so consumer installs execute no third-party lifecycle scripts and can no longer fail on broken upstream postinstalls (for example protobufjs on machines with a partially extracted global prefix). Each pack bundles from a pristine snapshot of the tsc output and restores it afterwards, ships the TypeScript declarations for every public subpath, all spawned worker entries, Goah's Apache license, and generated third-party license notices.
- Kept provider construction and credential storage behind the Pi Runner boundary instead of exposing third-party SDK types through the public `runner-pi` subpath.
- Made rejected Goal revisions and reassignments side-effect free, while successful reassignment fences the old Turn and waits for its Runner to exit before the new owner starts.
- Added one canonical current Root read model for TUI and Console, and bounded local control-protocol requests to 1 MB.
- Documented install-failure recovery in the README: clearing leftover global state, refreshing the npm cache, and the `--ignore-scripts` last resort.

- One Stream Coordinator now owns `/goal`, steering rollover, reconnect fencing, and transient transcript cleanup; rejected candidates preserve the active Turn while accepted replacement clears superseded text/thinking and closes orphaned running-tool rows.
- TUI reconnect follows `user_message` Turns, provisional messages use commit state without completion-type inference, and `/goal` starts a directly committed CEO Turn.
- Goal responses containing Handoff stay provisional in TUI until `response.committed`; failed drafts disappear from the main transcript while remaining durable in Turn history.
- Removed `silencePolicy`; organizational waiting and follow-up are Agent decisions expressed with Handoff, Mail, and Schedule tools.
- Updated terminal and welcome Handoff presentation to the declarative outcome/evidence contract.
- Updated status and Console read models for typed Mail routes, recovery Schedules, and separate Team motion/outcome.
- Console recovery warnings now consume a backend Goal-aware recovery view instead of reconstructing lifecycle state in the browser.
- Console now consumes Supervisor's canonical retry/escalation reducer, including superseded failures and CEO escalation, without matching free-form Schedule reasons.
- Low-level Goal commands now enforce CEO-owned Roots and require `--parent` for non-CEO Goals; lifecycle authority defaults to the parent owner.
- `goah wake` accepts `--goal`, and Console types expose schema-v21 execution bindings and Mail-route discriminants.

- Removed Action approval commands and Console surfaces; snapshots now expose the closed Schedule lifecycle instead.
- Local Console rejects non-canonical Host headers before setting its auth cookie; generic goal-update no longer bypasses atomic ownership reassignment.
- Console organization views now consume the authoritative `goal.changed` operation envelope.
- Drained terminal Turn events exactly once, exposed Handoffs consistently, separated Console thinking from assistant prose, restored assistant history, and removed Referer-based local API authorization.
- Updated control, TUI, Thread inspection, Console, doctor, and exports for Turn-owned execution; fixed duplicate answers, cross-Agent welcome history, and fencing-token redaction.
- Preserved final responses after internal assistant messages, filtered failed pending input from history, and reported model capabilities per Agent.

## 0.11.5

- Separated hidden thinking, assistant prose, and tool activity in the TUI; tool calls now update a compact execution row instead of blending into the conversation.

## 0.11.4

- Display provider failures instead of the misleading “worker exited without a response” fallback and keep Goal state solely in the live fixed bar.

## 0.11.3

- Normalized ANSI output in setup rendering tests so the redesigned TUI passes identically with and without terminal color.

## 0.11.2

- Replaced the log-like TUI with a full-screen branded conversation surface, Markdown output, bordered editor, compact Goal state, restrained progress feedback, and the maintained `@earendil-works/pi-tui` runtime.

## 0.11.1

- Automatically replaces a stale resident daemon after self-update and reduces worker stack traces to actionable error summaries.

## 0.11.0

- Ordinary chat no longer starts a Goal, `/goal` creates or revises explicitly, `/records` and `/history` expose shared timelines, and default output hides internal narration and raw tool arguments.

## 0.10.2

- Added visible fuzzy search to long Runner setup selectors instead of relying on the non-functional “type to filter” hint.
- Added staged setup headers, masked secret input, meaningful confirmation summaries, compact first-run empty state, safe `/model` routing, and credential-safe error rendering.

## 0.10.1

- Added installation-aware `goah update` so global and `~/.goah-tool`-style prefix installs can update themselves safely.

## 0.10.0

- Added generic Runner Profile setup/management, Runner-owned auth/model commands, daemon lifecycle commands, human-readable doctor output, safe onboarding recovery, and complete TUI prompt routing/stream feedback.
- New workspaces no longer embed a global Pi provider environment in generic Goah configuration; legacy Pi runner configs migrate in memory to a default Runner Profile.

## 0.9.2

- Wizard text prompts render inside the TUI header; the raw stdout prompt was erased by differential rendering.


## 0.9.1

- Setup wizard uses arrow-key SelectList navigation with per-scene headers; piped fallback unchanged.

## 0.9.0

- Spawn-time credential resolution (`env:NAME` + `.env` chain), `config.reload` hot runner swap, `goah setup` TUI wizard, `/model` and `/setup` TUI commands, and a fixed-slot welcome panel from a read-only ledger snapshot.

## 0.8.0

- Bare `goah` works from any directory: global profile (`~/.goah/profile.json`) with inline first-use onboarding and automatic workspace config materialization; non-interactive commands fail with an actionable message.

## 0.7.0

- Config gains `silencePolicy`; loading strips removed `heartbeatPolicies`/`progressPolicies` keys and `goah init` writes the explicit 12h silence default.

## 0.5.0

- Added the interactive `goah` CEO shell and resident Supervisor local control socket for live goal revisions and observation confirmation.

## 0.4.0

- Added `goal-show`, `goal-update`, `goal-pause`, `goal-resume`, and `goal-complete`.
- Thread listings expose their stored format version.

## 0.3.1

- Added `thread list/show/replay/export`, `context show`, and stream-scoped `events` commands.
- Thread export defaults to structural redaction and read-only inspection no longer requires provider credentials.

## 0.3.0

- Goal creation no longer invents a mandatory metric contract.
- Status reads wake streams and optional metric evaluations from the v0.3 ledger.
- Bundles the five internal source modules and exposes their APIs through `@goah/cli/*`; releases now use one npm publish.

## 0.2.0

- Removed the workspace field and Git requirement; the config directory is now the runner's implicit local root.

## 0.1.0

- Versioned configuration, daemon singleton, status, doctor, goals, approvals, dashboard, and recovery commands.
