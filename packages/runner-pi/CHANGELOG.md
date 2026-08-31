# Changelog

## 0.14.0

- Mail tools expose optional `high|normal|low` delivery priority instead of semantic message levels, and the Verifier worker selects priority in its structured report.
- Registers Pi's static OAuth flow loaders so standalone Goah bundles include subscription login and token refresh modules.
- Emits content-addressed Transcript v2 request components and references them from each prepared provider request.
- Removed `request_human`; CEO writes questions directly in its Assistant Message and `mail.send` remains Agent-only.
- Replaced Goah's custom path-scoped file tools and Bash sandbox with upstream Pi `createCodingTools`; the reference Runner now inherits host-user access exactly as Pi does.
- Pi now assigns one stable ID from assistant message start through completion and strips cumulative provider `partial` payloads before sending minimal live deltas over the process boundary.
- Goal Turn and tool prompts now distinguish checkpoints from terminal Handoff: Work Record and Schedule do not end work, and `progress` requires meaningful work plus an exhausted current frontier.
- Model switching now requires resolvable credentials for the selected provider, reuses saved or present environment authentication, and opens the scoped OAuth/API-key/environment flow before saving an otherwise unusable target.
- Pi now receives active Goal context independently from Goal commitment and returns one successful shape containing canonical `finalMessageId` plus optional Handoff; tool-only Handoff reuses the prior readable Assistant Item instead of overwriting it with an empty response.
- Pi uses `beforeToolCall` to validate Handoff with Supervisor; blocked drafts become model-visible Tool errors, fatal revocation fences later batch tools, and mandatory PiRunnerSession feedback carries correctable issues. Every adapter emits normalized provisional Handoff message metadata.
- Removed next-wake effects from Handoff and added typed Agent-only Mail routing; future motion uses schedule_wake.

- Bounded Runner protocol line size and converted in-process session initialization failures into abnormal terminal results.
- Process workers receive the admitted Wake trigger snapshot instead of inferring execution cause from the Wake's display trigger.
- Handoff tool now requires explicit outcome and evidence; Goal and Work Record identity are injected by Supervisor.
- Runner results are candidate outcomes; Supervisor alone commits Transcript terminal state. Thinking deltas now materialize as durable reasoning Items, and stderr capture is bounded.
- Pi now returns normal responses for unbound Turns and exposes Goal/Work Record tools; Goal Turns update their record before compact Handoff.
- Pi workers accept legacy daemon requests without Turn metadata during an in-place update.
- Empty assistant failures preserve the provider error instead of collapsing to a missing-response error.
- Pi requires `goalId` for Agent Mail and appends output protocol only after Supervisor admits a legal Human, Goal, or specialist execution class.

## 0.5.0

- Every Agent now receives Pi `read`, `write`, `edit`, and `bash`; organization RPC tools remain role-scoped.

## 0.4.0

- New Transcript streams declare format version 1 in `transcript.started`.

## 0.3.1

- Request snapshots use an explicit behavior allowlist and exclude API keys, authorization data, signals, and transport-private objects.

## 0.3.0

- Normalizes Pi lifecycle, message, delta, and tool events into the Goah Transcript vocabulary.
- Captures the exact prepared request and replayable compaction replacement metadata.

## 0.2.0

- Process runners accept a local `cwd`; Pi file, bash, and Git work execute directly under that root.
- Removed core token/handoff limits; optional timeout and Pi compaction remain runner-owned policy.

## 0.1.0

- Process protocol, official Pi 0.84.2 worker, structured handoff, local runner tools, limits, and compaction.
