# ADR 0004: Domain policy stays outside the core

- Status: accepted; organization-role scope amended below
- Date: 2026-08-19
- Amended: 2026-08-31

This ADR's decision — *domain* policy such as budgets, currencies, and spend windows stays
outside the core — stands unchanged. The amendment below records one scope drift discovered
while aligning documentation with the implementation.

## Amendment (2026-08-31): the organization role system is core policy for now

This ADR assumed organizational policy also lives outside the kernel. In reality the
CEO/Child/Verifier/Audit role system is deliberately built in: the Supervisor branches on the
literal `ceo` Agent in several admission and routing paths, schema v28 reserves the `ceo`
Thread role, and SQLite CHECK constraints bind `agent='ceo'` to `role='ceo'` and gate CEO
inbox routing. That is an intentional 0.x simplification for the one organization shape Goah
runs today, not an oversight: generalizing roles is deferred until a second organization
shape exists as a concrete requirement. Until then, treat the role system as core policy this
ADR does not cover; the decision text below is unchanged history.

## Decision

Goals do not contain a monetary budget contract. The core does not define currencies, spend limits, day/month accounting windows, or action payload amount fields. These concepts belong to connector packages, policy extensions, or downstream applications.

The action state machine remains generic: reason, evidence, approval gate, dispatch, unknown, reconciliation, confirmed, and failed. Extensions can enforce finance, advertising, procurement, quota, or compliance policy before approval without changing the ledger contract.

Connector manifests likewise do not predefine account, environment, currency, or amount constraints. They declare only idempotency/query/retry behavior and whether an action is reversible, gated, or irreversible. Connector implementations and policy extensions own payload validation.

Per-wake token, cost, timeout, and handoff-reserve policy are also outside the core request/result contract. A runner adapter may implement them when appropriate.

SQLite schema v5 removes the legacy `goals.budget` projection column. Migration reads old goals and preserves every non-budget field without rewriting event history.
