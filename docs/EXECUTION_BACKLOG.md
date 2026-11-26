# iRexPro execution backlog

Public-safe engineering checkpoint. Do not commit broker statements, customer information, credentials, account identifiers, exact financial exposure, production logs or sensitive operational evidence. Keep private verification evidence in authorized storage.

## Execution contract

- Work on one independently reviewable vertical slice at a time, then immediately pick the next unblocked task within the active session.
- GitHub is the source of truth. Use review branches, CI, test evidence and versioned artifacts; deploy only verified runtime artifacts after required operator and quiescence checks.
- Never infer settlement, fabricate provider IDs, bypass risk or authorization controls, or mark an item complete without evidence.
- Separate research, paper/DEMO testing, and production or LIVE changes. No automatic promotion or execution authorization from this backlog.
- At each checkpoint record commit/PR, tests, remaining blockers, next task and runtime verification status. Do not publish private diagnostics.

## P0 — Broker accounting and execution integrity

- [ ] ACC-01 Review merged #822 identity correction against existing reconciliation and partial-fill contracts; verify unique durable entry identity, opposite side, native position, account scope, exact decimals and ambiguity refusal.
- [ ] ACC-02 Diagnose closed-trade statement discrepancies using authorized read-only comparison of economic fields and timestamp precision; classify price, quantity, identity, time or P&L mismatch; record sanitized findings. Do not rewrite ledger from statement alone.
- [ ] ACC-03 Review #803 and #805 for overlap with #822; integrate only compatible evidence-backed corrections after independent review; cover idempotency, partial fills, reconnect, duplicate/out-of-order events, crash recovery and cross-account isolation.
- [ ] ACC-04 Reconcile outstanding orders only with authentic provider evidence; unresolved/ambiguous evidence remains pending. Prove settlement totals, fees, swaps and realized P&L across API/database/UI.
- [ ] ACC-05 Test migrations on representative non-production PostgreSQL, rollback and recovery; require CI, operator review, deployment guard and post-release reconciliation checks.
- [ ] TEL-01 Review #821 read-only diagnostic; validate closure/path evidence coverage in authorized non-production environment; distinguish missing telemetry from missing settlement. Add regression fixtures, including partial/absent paths and native ID mismatch.
- [ ] EXEC-01 Review order lifecycle, retries, timeouts, duplicate prevention, provider disconnect and stale quotes. Validate independent DEMO/LIVE session isolation without expanding execution authority.

## P1 — Research and model governance

- [ ] RES-01 Review stacked #810/#818 and CI-only #819 against current main; identify duplicate tests, rebase safely, document gate semantics and counterfactuals without changing live admission.
- [ ] RES-02 Review #811/#812/#813 expert observation provenance, offline evaluation, integration and leakage prevention. Verify reproducible chronological splits, costs and uncertainty.
- [ ] RES-03 Build offline evaluation datasets from authorized historical evidence: entry decisions, exit paths, realized P&L, fees, maximum favorable/adverse excursion, missingness. Hold out independent time windows.
- [ ] RES-04 Compare session and position profit-protection hypotheses offline against unchanged baseline, including missed winners, loss tails, transaction costs, drawdown and sample uncertainty. Do not activate unvalidated policy.
- [ ] RES-05 Review model registry, versions, data quality, promotion tests, drift detection, rollback and operator-visible provenance.

## P1 — Platform modules

- [ ] BRO-01 Audit direct broker OAuth, account selection, refresh/revocation, broker capabilities, precision, health and reconnect; test sandbox contracts and credential isolation. Review optional connectors separately against infrastructure cost and support constraints.
- [ ] API-01 Audit authentication, RBAC, tenant isolation, request schemas, idempotency, rate limiting, audit logs, API pagination, error semantics and contract tests.
- [ ] DB-01 Audit migrations, transaction invariants, indexes, backup/restore, retention and account-scoped queries; test representative concurrent workflows.
- [ ] WEB-01 Review responsive trading dashboard, broker connection state, accessible charts, recent activity, clear order/position states and consistent equity/P&L display. Validate with API fixtures and browser E2E; do not display simulated values as actual.
- [ ] WEB-02 Review account/settings, risk configuration display, confirmation flows, session state, error recovery, keyboard navigation, contrast and mobile layouts.
- [ ] MOB-01 Inventory existing native Android/iOS clients and supported scope. Implement or repair approved screens using secure token storage, typed APIs, accessible navigation, compact cards, reliable reconnect and store-ready builds; test on device before release.
- [ ] DESK-01 Inventory desktop client and supported broker integrations; verify packaging, update signing, session security, telemetry and explicit supported-platform boundaries.
- [ ] BILL-01 Audit subscriptions/performance-fee accounting, currency display, payout provider integration and authorization; test duplicate notifications, reversals and ledger invariants in sandbox.
- [ ] ADMIN-01 Review operator dashboards, access controls, audit trails, support workflows, privacy, incident runbooks and rollback procedures.

## P1 — Delivery and production readiness

- [ ] OPS-01 Review #809 GitHub-first runtime consolidation pilot; inventory builds/releases and preserve uncommitted work before cleanup. Never remove active or rollback artifacts.
- [ ] OPS-02 Validate CI required checks, secret scanning, dependency lock integrity, SBOM, static analysis, build reproducibility, migrations and automated smoke tests.
- [ ] OPS-03 Verify immutable versioned artifacts, staging rehearsal, backup/rollback, guarded release approval, runtime revision and health checks; retain minimal runtime-only VPS footprint.
- [ ] SEC-01 Review authorization boundaries, encryption, token redaction, dependency remediation, audit retention and least privilege.
- [ ] QA-01 Maintain regression matrix across backend, database, web, mobile and desktop as applicable; include accessibility, load, fault injection and recovery.
- [ ] DOC-01 Maintain architecture, setup, support guides, data dictionary, operational runbooks, release notes and this checkpoint.

## Checkpoint — 2026-11-26

- Source baseline: main merge commit dd9fe50e41e1af79bab88a72aad90e84b84a42bb; #822 merged and required CI succeeded. Runtime deployment and reconciliation completion are not established by merge status.
- #821 is a draft with successful reported CI checks; diagnostic runtime evidence remains outstanding.
- #803/#805/#809/#810/#811/#812/#813/#818/#819 remain review candidates, not deployed changes.
- Current active task: ACC-02, then ACC-01/ACC-03 and TEL-01; proceed with independent documentation, tests and review while runtime work is blocked.
- Completion gate: exact evidence-based reconciliation, passing tests, appropriate authorization and verified runtime state. No production changes from this documentation.
