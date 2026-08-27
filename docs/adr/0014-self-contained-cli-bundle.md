# ADR 0014: Publish @goah/cli as a self-contained bundle

Status: accepted

## Context

ADR 0007 collapsed six packages into one distribution but kept external Pi dependencies (`@earendil-works/pi-*` and their transitive closure) as ordinary registry dependencies resolved at consumer install time. That closure includes packages with lifecycle scripts — notably `@google/genai` (preinstall) and `protobufjs` (postinstall) — which npm executes on every consumer machine.

A real incident showed this is a failure class we do not control: on a machine whose global prefix held a partially extracted `protobufjs` directory from an earlier interrupted install, `npm install --global @goah/cli` aborted because the declared postinstall referenced files that were not on disk. The scripts in question only print version warnings; nothing functional was lost, yet the entire install failed with a stack trace a user cannot act on.

The CLI's runtime closure is pure JavaScript across all supported providers, storage uses builtin `node:sqlite`, and no dependency script performs functional work.

## Decision

Pack time now bundles the CLI into a single self-contained output:

- `scripts/prepare-single-package.mjs` snapshots the pristine tsc output, runs esbuild over all public subpath entries plus the spawned worker entries (`pi-worker`, `verification-worker`, `faux-runner-worker`), bundles every public TypeScript declaration graph, copies Console assets, generates `dist/THIRD-PARTY-NOTICES.md` from the exact bundled dependency closure, and swaps the bundle in. Cleanup restores the snapshot afterwards; startup and failure paths also recover an interrupted pack.
- Only node builtins stay external; CJS dependencies receive a `createRequire` banner so runtime `require()` of builtins keeps working in ESM output.
- The published manifest ships zero `dependencies`, and no bundled dependencies remain.
- The tarball includes Goah's Apache-2.0 license. Missing third-party license metadata or text fails the pack instead of producing an incomplete notice.
- `scripts/pack-smoke.mjs` packs twice and validates the second tarball — the one a publish would ship: it asserts a dependency-free manifest, no `node_modules/` paths, resolvable declarations, worker entries, Console assets, complete license notices, normal and `--ignore-scripts` installs, and a full goal-to-handoff run.

External Pi dependencies are no longer registry dependencies of the published package (supersedes that sentence of ADR 0007).

## Consequences

- No third-party lifecycle script ever runs on a consumer machine; whole classes of environment-dependent install failures disappear.
- Install failures caused by damaged local state are recoverable with documented steps, including a validated `--ignore-scripts` fallback since the CLI needs no install scripts at all.
- The tarball grows to include previously external dependencies.
- Workspace boundaries and TypeScript project references remain intact for development; bundling exists only in the release path.
- ADR 0007's single-publish model stands; its "external Pi dependencies" clause is superseded.
