# Changelog

## Unreleased

- Updated control, TUI, Thread inspection, Console, doctor, and exports for Turn-owned execution; fixed duplicate answers, cross-Agent welcome history, and fencing-token redaction.

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
