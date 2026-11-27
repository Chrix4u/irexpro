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

### Integration checkpoint — after #823

- #823 merged after seven successful reported CI checks; backlog now on main (`ed5749fd`).
- ACC-01/ACC-03 source comparison: #803 and #805 predate the ownership-bound FILLED entry proof reused by #822. Review requirements recorded in [#803](https://github.com/Chrix4u/irexpro/pull/803#issuecomment-7192471120) and [#805](https://github.com/Chrix4u/irexpro/pull/805#issuecomment-7192471816). Integration and regression validation remain open.
- TEL-01: #821 SQL reviewed statically; runtime verification and tenant-scope review remain open.
- Next: build an independently reviewed integration candidate against main, preserving #822, then validate with synthetic and non-production fixtures. ACC-02 remains unresolved; do not infer missing financial evidence or bypass release gates.

## Detailed module delivery matrix — repository inventory 2026-11-26

All items below are open engineering work unless explicitly supported by a linked passing test and applicable runtime evidence. This is a source-directory inventory, not a claim that the corresponding feature works. Parent workstreams above remain open until their dependent subtasks and acceptance criteria are verified. P0 denotes integrity/security or release blockers; P1 denotes core product delivery; P2 denotes non-blocking polish or conditional platform scope.

### Identity, customer lifecycle and security — auth, users, audit

- [ ] P0 IAM-01: Audit sign-in, registration, verification, reset and appeal API contracts; verify token expiry, refresh rotation/revocation, password hashing, throttling, enumeration resistance and negative tests.
- [ ] P0 IAM-02: Verify user/broker connection ownership at query, service, controller and websocket boundaries; add cross-tenant and unauthorized role regression tests.
- [ ] P1 IAM-03: Verify profile, KYC/identity status (where required), security settings, account recovery and administrative decisions; add schema constraints, API contracts, web/mobile UI states and E2E tests.
- [ ] P0 IAM-04: Verify audit log redaction, actor attribution, correlation IDs, access scope and retention; test that credentials and financial identifiers are not leaked into public logs.
- [ ] P1 IAM-05: Document authentication, recovery, privacy and support workflows; verify user-visible errors and release smoke tests.

### Broker and account management — broker, broker-reconciliation, live-account, admin-live-account

- [ ] P0 BRK-01: Inventory supported broker adapters and capability matrix; test direct OAuth token lifecycle, callback validation, account selection and separate DEMO/LIVE mapping against sandbox fixtures.
- [ ] P0 BRK-02: Verify connection ownership, currency, account-mode, provider identity and precision handling; add fixtures for reconnects and multiple connections without cross-account state leakage.
- [ ] P0 BRK-03: Validate read-only position/order/deal synchronization, pagination, stale snapshots, duplicate provider events, and missing or ambiguous evidence; retain pending states where proof is insufficient.
- [ ] P0 BRK-04: Review administrative account controls and authorization with negative tests; verify that the web/mobile account view accurately reflects the selected connection and actual provider state.
- [ ] P1 BRK-05: Document broker prerequisites, account selection, provider limits, supported features and sandbox verification evidence; no new paid infrastructure or live execution authority implied.

### Order lifecycle and accounting — execution, trading, reconciliation, execution-authority, execution-control, risk

- [ ] P0 EXE-02: Audit order/trade state transitions, idempotency keys, transactional uniqueness, partial fills, cancellation and broker response normalization with synthetic events.
- [ ] P0 EXE-03: Integrate ACC-01/03 without losing #822 proof; verify duplicate/mismatched identity rejection and exact economic comparisons in both recovery paths. Re-run targeted and PostgreSQL concurrency tests.
- [ ] P0 EXE-04: Verify fee, swap, realized/unrealized P&L, lot/volume and currency conventions across database, API, web and mobile using authoritative fixture totals.
- [ ] P0 EXE-05: Verify start/stop, session isolation, operator authority, exposure and fail-closed invariants using simulated broker fixtures; no expansion of approved real-money authority.
- [ ] P0 EXE-06: Audit uncertain-order recovery, stale market snapshots, retries, disconnect and process restart; confirm no duplicate submissions or fabricated provider identifiers.
- [ ] P0 EXE-07: Validate API order/history/portfolio pagination, consistent lifecycle labels and reconciliation warnings; test missing and partial evidence across web/mobile clients.
- [ ] P0 EXE-08: Verify risk-policy boundaries, configuration validation, concurrency and auditability with non-production tests; document rollback and fail-safe behavior.
- [ ] P0 EXE-09: Verify migration and rollback compatibility, ledger evidence integrity and release gates; require authorized post-release checks before declaring settlement complete.

### Market data, events and realtime — market-data, realtime, events, metrics, notifications

- [ ] P1 DAT-01: Inventory streaming/REST sources, market clocks, instrument mapping, timeframes and timestamp conventions; test delayed, duplicate, incomplete and out-of-order samples.
- [ ] P1 DAT-02: Audit storage retention, deduplication, indexing, provider reconnect and backfill coverage; verify freshness indicators and explicit unavailable-data state.
- [ ] P1 DAT-03: Validate event/websocket authentication, subscription isolation, reconnect replay and rate limiting; test consistent dashboard updates and visible stale-state warnings.
- [ ] P1 DAT-04: Audit notification delivery, preferences, authorization, retries, idempotency and failure reporting; add API/client and background-delivery tests without production sends.
- [ ] P1 DAT-05: Verify health and metrics endpoints, bounded labels, monitoring thresholds and sensitive-data redaction; document data source status and recovery.

### AI research — ai, ai-engine-client, strategy, services/ai-engine

- [ ] P1 ML-01: Inventory model artifacts, features, data lineage, registry and strategy versions; validate data provenance and feature-time boundaries.
- [ ] P1 ML-02: Verify API-to-engine schema, timeout, version mismatch and unavailable-model handling using deterministic non-production fixtures.
- [ ] P1 ML-03: Review existing research branches and independent expert observations; preserve attribution and distinguish exploratory from qualified evidence.
- [ ] P1 ML-04: Evaluate historical candidate models offline using chronological holdouts, transaction costs, calibration, drawdown and uncertainty; report failed as well as successful candidates.
- [ ] P1 ML-05: Assess path telemetry completeness before evaluating profit-retention hypotheses; do not infer intratrade peaks from closed statements.
- [ ] P1 ML-06: Verify research reproducibility, deterministic seeds where applicable, dependency locks, artifact integrity, model provenance and reviewable reports.
- [ ] P1 ML-07: Review existing promotion governance and rollback evidence; keep new research separate from authorized execution. Verify no accidental model activation from CI.

### Billing, subscriptions and global configuration — payments, subscriptions, performance-billing, performance-fees, global-config

- [ ] P0 PAY-01: Audit monetary types, currency conversion boundaries, subscription state, fee calculations and exact ledger totals using synthetic fixtures.
- [ ] P0 PAY-02: Verify provider callback signature, replay prevention, duplicate handling, authorization, idempotent reversal/refund and failure states in sandbox.
- [ ] P1 PAY-03: Review billing invoices, payment history, subscription plans and status across API/web/mobile/admin; never show a pending or failed payment as settled.
- [ ] P1 PAY-04: Validate global configuration schemas, restricted edit permissions, versioning, auditability and rollback; test configuration defaults and environment separation.
- [ ] P1 PAY-05: Document provider setup, fees, payout limitations, reconciliation and customer-support flows; retain sensitive configuration outside GitHub.

### Web portal — apps/web

- [ ] P1 UI-01: Inventory all routes (landing, login/register, verification/recovery, dashboard, AI, market, trading, portfolio, strategy lab, onboarding, live account, payments, profile, security, settings); verify route/auth and API contract coverage.
- [ ] P1 UI-02: Standardize responsive shell, compact navigation groups, accessible typography, clean cards, spacing, consistent loading/empty/error states and keyboard support.
- [ ] P1 UI-03: Verify charts, timeframes, pan/zoom, quote timestamps, scanning/session status and distinction between broker-confirmed data and predictions; test responsive layouts.
- [ ] P0 UI-04: Verify order history, realized versus unrealized P&L, position/account currency, fees, pending status and reconciliation warnings against shared deterministic fixtures.
- [ ] P1 UI-05: Verify account settings, broker selection, onboarding, authentication, security and billing flows with role-based browser E2E.
- [ ] P1 UI-06: Run browser E2E across supported viewports, accessibility and performance checks; document screenshots, build artifact and deployment smoke-test evidence.

### Admin portal — apps/admin, admin-system

- [ ] P0 ADM-02: Inventory admin routes and API endpoints; enforce operator role and permission boundaries, including deny-by-default and audit tests.
- [ ] P1 ADM-03: Verify customer, broker status, subscription/payment, configuration, incident and reconciliation read views against API fixtures.
- [ ] P1 ADM-04: Standardize accessible desktop/mobile layouts, search, pagination, filter states, error handling and safe confirmation flows.
- [ ] P0 ADM-05: Verify privileged action attribution, redaction, safe exports and separation of administrative versus customer credentials; run admin E2E and release smoke tests.

### Native mobile — apps/mobile

- [ ] P1 MOB-02: Inventory React Native/Expo screens and shared API client contracts; verify Android/iOS feature coverage and document unsupported functions.
- [ ] P0 MOB-03: Test secure token storage, logout/revocation, tenant/account switching, network recovery and sensitive-data handling.
- [ ] P1 MOB-04: Refine compact native screens: clear cards, readable metrics, bottom navigation, safe-area handling, accessibility and useful empty/loading states.
- [ ] P1 MOB-05: Verify dashboard, trading/history, broker/account, notification and settings flows using mocked API and on-device testing; clearly indicate stale or offline data.
- [ ] P1 MOB-06: Verify mobile-ci and mobile-apk workflows, environment config, signed release artifacts, installation, upgrade and rollback on supported test devices; distinguish Android build from iOS distribution readiness.

### Desktop and connectors — services/mt5-connector

- [ ] P1 DESK-02: Confirm the existing Windows connector scope; do not claim a separate native desktop trading app exists without source evidence.
- [ ] P1 DESK-03: Audit local connector authentication, secure configuration, connection status, errors, recovery, logging and supported operating systems using simulated connections.
- [ ] P1 DESK-04: Verify Windows packaging/signing, installation, upgrade and uninstall in test environments; document that always-on hosting requirements are distinct from direct broker OAuth.
- [ ] P2 DESK-05: Clarify native desktop client versus optional connector scope before introducing a separate application or additional infrastructure.

### Shared client, database and delivery

- [ ] P0 SHARED-01: Verify packages/api-client and packages/types against backend DTOs, error contracts, money/precision conventions, account-mode and pagination; add compatibility tests across consumers.
- [ ] P0 DB-02: Inventory PostgreSQL schema/migrations, foreign keys, uniqueness and ownership constraints; test upgrade from supported releases, concurrent transactions and backup/restore with synthetic data.
- [ ] P0 DB-03: Review migration safety, least-privilege credentials, recovery and retention; confirm restored database integrity and record release/rollback rehearsal evidence.
- [ ] P0 REL-01: Inventory CI triggers and required checks for API, engine, web, admin, mobile, connector, database and security; ensure targeted regressions actually execute on affected paths.
- [ ] P0 REL-02: Audit GitHub Actions pinning, checkout credentials, permissions, dependency locks, SBOMs, artifact provenance and publication controls; do not weaken gates to make builds pass.
- [ ] P0 REL-03: Verify versioned release artifact manifest, checksums, migration compatibility, staging rehearsal, operator review and deployment guard before any runtime change.
- [ ] P0 REL-04: Inventory authorized VPS runtime directories and rollback references read-only; preserve uncommitted work in the correct repository after secret review, and remove obsolete artifacts only after explicit safety verification.
- [ ] P1 REL-05: Verify service health, runtime commit identity, logs/alerts, backup checks, rollback and non-trading smoke tests; document actual verification evidence.
- [ ] P1 QA-02: Maintain a module-by-module acceptance matrix with test IDs, PR/commit, artifact digest, environment, runtime evidence and open blockers. Mark source implementation, CI and deployment separately.
- [ ] P1 DOC-02: Maintain architecture, installation, operator runbooks, API documentation, customer help, accessibility and incident recovery; update checkpoint before ending each active work session.

### Checkpoint — source update after #825

- #824 merged (`a4f83b209`), recording compatibility review.
- #825 merged (`47f60698`) after eleven reported successful checks (full API lint audit skipped). ACC-02 verifier now requires an explicit broker connection and applies a shared UTC window to both queries. Actual settlement discrepancies remain unresolved; no production record was changed.
- #821 synthetic PostgreSQL test passed on an earlier candidate; current draft requires fresh CI following explicit checkout credential-privacy correction (`ae7abc5c`). Do not represent the corrected revision as passing until results are available.
- Next actionable: verify #821 CI and review its synthetic fixture/SQL, then proceed to ACC-01/03 compatibility integration on current main. Account-specific runtime checks require an authorized connection and appropriate read-only access.
- Scope audit: eight top-level application/service/package directories identified; native mobile and Windows connector source exist, standalone desktop application not verified.
- Repository is currently public. Keep backlog sanitized; do not publish private evidence or change repository visibility without explicit review of access, CI and cost implications.

### Latest active-session checkpoint

- #821 current head `69e13e12`: synthetic PostgreSQL, tracked source scan and dependency checks reported success; required CI and CodeQL still pending after the container digest was pinned. No runtime diagnostic executed.
- #827 current head `e268f56b`: added aggregate-only economic mismatch classification and synthetic regression coverage; CI running. Exact matching, ambiguity refusal and reconciliation status remain unchanged.
- Resume: verify #821, #826 and #827 at their latest heads; merge only after required CI and review gates pass. Then perform ACC-02 authorized read-only verification or proceed with ACC-01/03 independent integration review if that access is blocked. No deployment or financial mutation occurred.

### Checkpoint — accounting and diagnostic integration

- #826 merged (`23a54514`): 91-task module delivery matrix on main after seven successful checks.
- #821 merged (`ee8d6479`): all eight checks passed, including synthetic PostgreSQL regression and security checks.
- #827 merged (`392d745c`): eleven executed checks passed; optional full API lint skipped. Aggregate single-field diagnostics are not settlement proof.
- GitHub compare against `392d745c` verified that the #803 and #805 head commits are already ancestors of main (43 and 18 commits behind, zero ahead). Main contains the fill-evidence entity, hardening migration and newer verified-position-reference helper. Do not re-merge the stale branch heads simply because their original PRs remain open. ACC-01/03 acceptance tests and deployment verification remain outstanding; ancestry alone is not full correctness proof.
- #828 extends the synthetic diagnostic fixture to closed trades with complete, partial, absent and audit-only path evidence and pending settlement; CI required before merge.
- Read-only staging quiescence guard passed at this checkpoint. This is a time-specific prerequisite result, not release approval or proof of historical reconciliation; recheck immediately before any authorized release.
- Resume: verify #828 CI, review actual main integration and ledger regression results, then authorized read-only account-scoped reconciliation and release review. No production records or trading controls changed.

### Checkpoint — statement ingestion and identity tests

- #829 lint found formatting errors in the new test fixture; corrected in `f1c41b6`. PostgreSQL concurrency and four existing exit/protection regression checks passed on the preceding candidate; latest CI must pass before merge.
- #830 introduces strict direct ingestion of the supported USD UTC Deals CSV, validating exact total, timestamps, positive prices/lot sizes and section boundaries. Tests use synthetic values only; normalized CSV compatibility retained. No provider calls, settlement writes or runtime deployment.
- Next: verify #829 and #830 required CI and merge only after review. Continue ACC-01/03 acceptance and ACC-02 authorized read-only review; if runtime evidence remains inaccessible, work on independent platform acceptance tasks. Do not treat diagnostic matches as settlement authority.

### Checkpoint — direct statement ingestion and independent mobile work

- #830 merged (`59fa6087`) after eleven executed CI checks passed (full lint audit skipped). Native USD UTC Deals CSV input now validates the supported layout and exact net total; historical verification remains outstanding.
- #829 functional tests passed on `f1c41b6`; final lint annotation corrected in `b3a86f50`. Latest checkpoint overlap with #830 resolved in `2ce3488c`. Verify latest required CI and mergeability, not earlier check status.
- MOB-04/05: #831 implements a compact dashboard and explicit unavailable/checking/conflicting readiness display, discards superseded refresh responses and adds pure presentation tests. Current candidate `210d9fb7`; mobile CI and physical device verification remain outstanding. No server trading authorization changed.
- Resume: verify #829/#831 latest CI, account for unresolved historical reconciliation, then continue independent mobile/web acceptance and release review. No deployment performed.

### Checkpoint — verified accounting tests and mobile acceptance

- #829 merged (`82ec173f`) after 15 executed CI checks passed, including API tests/build and PostgreSQL concurrency; full API lint audit skipped. ACC-01 source contract regression verified, historical settlement/runtime validation remains open.
- #831 merged (`87a58926`) after nine CI checks passed, including native mobile typecheck/bundle and installable Android preview APK ([CI run](https://github.com/Chrix4u/irexpro/actions/runs/45842396552)). MOB-04/05 dashboard presentation correction verified in CI; physical-device verification remains open. APK is a preview build, not a store-certified release.
- #832 shared dialog accessibility candidate: scrollable content, bounded height, wrapping action buttons, busy-state semantics and reduced-motion support. Mobile CI pending. Test on small Android/iOS screens, landscape and enlarged system text; verify long details scroll, buttons remain reachable, busy dialogs cannot be dismissed, and reduced motion disables transition. Do not mark on-device acceptance complete without evidence.
- Resume: verify #832 latest CI; continue MOB-04/05 and MOB-03 acceptance. Historical statement reconciliation and release authorization remain outstanding; no financial record or trading authority changes, and no VPS deployment in this session.

### Reconciliation recovery checkpoint — 2026-11-26

- [ ] P0 ACC-06: Review #841 complete-history retrieval. CI passed; verify inclusive time bounds with authorized non-mutating DEMO provider evidence before any runtime use. Incomplete/ambiguous history must remain unproven.
- [ ] P0 ACC-07: Review #842 per-run diagnostic counts. Confirm reason taxonomy, selected-candidate accounting, no change in proof or execution authority, and regression results.
- [ ] P0 ADMIN-02: Integrate scoped read-only latest-run diagnostics in Admin Live Operations; verify authorization, connection isolation, invalid metadata, legacy/missing runs, and independent panel failure handling.
- [ ] P0 ADMIN-03: Design operator-triggered read-only broker-versus-statement comparison; distinguish financial evidence from settlement authorization, ensure explicit account scope, private evidence handling, and bounded execution. Do not trigger the existing execution-capable worker from the diagnostic UI.
- [ ] P0 OPS-04: Review a separate evidence-based maintenance-lock design for current exposure versus historical journal drift, without weakening existing release checks; require independent review and guarded staging validation.
- [ ] P0 ACC-08: Verify authenticated DEMO reconciliation outcomes and the dashboard with the deployed exact revision before marking the incident resolved.

Next: finish CI/review of diagnostics and UI, then the read-only statement comparison slice. Runtime and account-specific verification remain open. No financial records or release safeguards were modified by this checkpoint.

### Reconciliation incident execution checkpoint — 2026-11-26

- ACC-07 and ADMIN-02: #842/#843 merged and deployed as part of `b70ba5bb` ([successful guarded deployment](https://github.com/Chrix4u/irexpro/actions/runs/45906916326)). Operator confirmed that the diagnostics panel renders and reports recovery failures. Authenticated settlement acceptance remains open.
- ADMIN-03: #844/#845 merged and deployed; browser-only statement arithmetic works in operator UAT. This is not broker-versus-ledger comparison or settlement evidence; account-scoped comparison remains outstanding.
- ACC-08: Operator UAT showed generic local-economic proof rejection and historical recovery exceptions. #847 splits these into precise local-premise and exception-stage codes without altering settlement predicates. Initial stage-only candidate CI passed; latest expanded candidate requires fresh CI, guarded deployment and operator verification. No private statement rows or account IDs are included here.
- Next: use the specific failure category to obtain authorized, account-scoped source evidence; establish root cause, test an independently reviewed remedy against synthetic regression cases, and verify unresolved counts and financial invariants. Do not infer a settlement from an arithmetic match or bulk-clear warnings. ACC-06 remains gated by provider contract validation. Do not deploy another diagnostic slice merely to accumulate features.

### Closure integrity and reporting checkpoint — 2026-11-27

- #849 test/docs regression merged and deployed in `b9b3d296`; #851 recorded-close presentation merged at `2f59fc74`, guarded release pending at checkpoint.
- Reporting candidate: closed history retains all rows, but financial aggregates and outcome counts require the same complete settlement cohort (gross P&L, commission, swap, exit price and currency). Unknown all-incomplete aggregate remains null. Existing gross outcome filters and gross profit-factor convention are unchanged. Added mocked-query regression and disposable PostgreSQL test; fresh CI and guarded release review required. No financial writes or trading control changes.
- P0 ACC-09: independently review #850 snapshot validation across shared reader consumers, especially close/SL/TP paths; distinguish uncertain provider position status from proven terminal closure. Do not treat absence alone as full close evidence.
- P0 ACC-10: authorized account-scoped close provenance review; correlate opening/closing native IDs, dispatch audit and provider execution time, distinguish local observation versus broker execution; produce historical correction proposal for independent accounting review. Actual records remain unverified. No raw private IDs in public repository.
- P0 ACC-11: prove complete lifecycle with synthetic and authorized DEMO evidence; verify no duplicate fills, no artificial warning clearance, no missing fees treated as zero, accurate timestamps and broker history agreement. Do not certify LIVE from CI alone.
- Resume: verify reporting CI, review #850 independently, and obtain original internal audit evidence for the premature closure incident. Do not widen timestamp tolerances as a substitute for proof.


### Consolidated reconciliation candidate — 2026-11-27

- Integrate the source changes from #850, #852–#856 into a single review candidate based on main. Reporting changes retain the stacked #852–#854 implementation; adapter changes were checked against unchanged main file blobs; #855/#856 contain their CI formatting corrections.
- Individual reporting browser checks and prior #850/#852 CI passed; #855/#856 rerun and integrated CI remain pending. Require whole-candidate API build, tests, PostgreSQL integration, browser checks, review and guarded deployment before release.
- ACC-02/ACC-04 remain open. No historical records have been corrected by this integration. Native broker evidence, close-time provenance, historical deal completeness (#841/#848), and protective-order causality remain outstanding. Do not replay uncertain orders or change LIVE authorization.
- Next: review integrated CI, address failures, validate authorized read-only broker evidence and release prerequisites. No deployment or runtime mutation from this candidate.
