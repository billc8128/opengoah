# Changelog

## 0.13.1

- Published `@goah/cli` as one fully self-contained bundle: the tarball carries zero registry dependencies, so consumer installs execute no third-party lifecycle scripts and can no longer fail on broken upstream postinstalls (for example protobufjs on machines with a partially extracted global prefix). Each pack bundles from a pristine snapshot of the tsc output and restores it afterwards, ships the TypeScript declarations for every public subpath, all spawned worker entries, Goah's Apache license, and generated third-party license notices.
- Kept provider construction and credential storage behind the Pi Runner boundary instead of exposing third-party SDK types through the public `runner-pi` subpath.
- Made rejected Goal revisions and reassignments side-effect free, while successful reassignment fences the old Turn and waits for its Runner to exit before the new owner starts.
- Added one canonical current Root read model for TUI and Console, and bounded local control-protocol requests to 1 MB.
- Documented install-failure recovery in the README: clearing leftover global state, refreshing the npm cache, and the `--ignore-scripts` last resort.

## Unreleased

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
