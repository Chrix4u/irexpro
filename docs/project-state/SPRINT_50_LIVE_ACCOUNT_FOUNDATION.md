# Sprint 50 — Live Account Foundation

> Branch: `feat/live-account-foundation` (from `main` @ `7ac0e35`)
> Scope: Live Account vertical slice #1 — broker account / authorization /
> credential foundation + emergency control plane (Directive §10, §11, §14,
> §15, §16, §28, §48).

## What this sprint delivers

### 1. Broker authorization state machine (Directive §15)

The live-account activation gate was previously two booleans
(`demoValidated` / `liveTradingEnabled`) — and `demoValidated` was **never
set anywhere in the API**, making the DEMO-before-LIVE invariant unreachable
in practice.

Now:

- `broker.broker_connections.authorization_status` — 12-state explicit
  server-side state machine:
  `NOT_CONNECTED, CONNECTING, CONNECTED, VERIFYING, AUTHORIZATION_REQUIRED,
  AUTHORIZED, READY, ACTIVE, SUSPENDED, REVOKED, ERROR, DISCONNECTED`
- Transitions validated by `BrokerAuthorizationStateMachine` (pure,
  centralized, exhaustive table). Arbitrary mutation is impossible; DB CHECK
  constraints back the enum.
- **Only `ACTIVE` is executable** — `isExecutable()` fails closed on
  null/unknown states.
- **Atomic against concurrent writers (architect correction A4):** every
  authorization transition is a CONDITIONAL UPDATE
  (`WHERE authorization_status = <validated state>` + affected-rows check,
  same pattern as the order domain). A stale revoke/suspend/disconnect can
  never overwrite the winning authoritative state — it surfaces as a
  ConflictException. Proven against a real PostgreSQL store in
  `broker-authorization.pg-integration.spec.ts` (revoke-vs-enable-live,
  disconnect-vs-enable-live, healthCheck-suspend-vs-revoke, duplicate
  revokes, stale-writer-vs-terminal-state).
- `ACTIVE` is reachable ONLY through the explicit `enable-live-trading`
  endpoint (LIVE accounts, registry LIVE support, prior validated DEMO, user
  action).
- A successful **DEMO handshake now completes demo validation**
  (`CONNECTING → AUTHORIZED` + `demoValidated=true` dual-write), fixing the
  unreachable gate.
- Legacy booleans dual-written for backward compatibility; the state machine
  is authoritative.
- New endpoints: `POST :id/revoke-authorization` (→ REVOKED, fail-closes
  liveTradingEnabled), plus state-machine-aware connect/disconnect/health.

### 2. Credential lifecycle (Directive §14) — AUTHORITATIVE (architect correction A3)

- `credential_status`: `CREATED → VERIFIED → ROTATED / REVOKED / EXPIRED /
  INVALID`.
- Auth-class connect failures mark credentials `INVALID`.
- New endpoint `POST :id/rotate-credentials` — validates the NEW credential
  set against the provider BEFORE replacing ciphertext; on failure the old
  set is kept. No plaintext ever persisted or returned.
- **`BrokerCredentialLifecycle.isUsable()` gates EVERY decrypt/consume path:**
  `connectBroker`, `healthCheck`, `getOhlcvForConnection`,
  `getClosedTradesForConnection`, `getRequiredMargin` (previously fully
  unguarded — now also requires CONNECTED status), and the market-intelligence
  snapshot read. `INVALID / EXPIRED / REVOKED / missing / unknown` states
  fail closed BEFORE decryption — the provider adapter is never contacted
  (unit-proven with adapter-not-invoked assertions for every path). Plaintext
  remains ephemeral and is zeroed after use.

### 3. Broker provider registry + capability model (Directive §L/§M/§N/§AF/§AU)

- `GET /api/v1/broker/registry` — the single server-authoritative broker
  catalog (web/admin/mobile must render it; no client-side lists).
- Capability model (`BrokerCapability`, 24 capabilities) + connection routes
  (`BrokerConnectionRoute`) per broker — no fake per-platform broker entries.
- **Status honesty:** a catalog entry without a registered runtime adapter
  can never be reported `SUPPORTED` (runtime downgrade, tested).
- `createConnection` now gates environment support through the registry
  (paper-broker LIVE is rejected by design — environment isolation).
- Catalog: metatrader5 (SUPPORTED), paper-broker (SUPPORTED, DEMO-only),
  oanda (NOT_STARTED), ctrader (PARTNER_APPROVAL_REQUIRED).
- `docs/brokers/provider-matrix.md` — evidence-based matrix + research
  checklist (Directive §AC/§BD).

### 4. Emergency control plane (Directive §28)

- New module `execution-control` + `platform.execution_controls` table.
- Scopes: GLOBAL / PROVIDER / USER / BROKER_CONNECTION, cascade
  precedence, **fail closed** on unreadable store.
- **ALL FOUR SCOPES genuinely enforced in the Risk pipeline (architect
  correction A1):** the early Step 1a-pre check covers GLOBAL/USER
  (fail-fast, before connection discovery), and a second gate after the
  authoritative broker connection is discovered (Step 1c-pre) evaluates the
  COMPLETE context — user + provider + broker connection — so PROVIDER and
  BROKER_CONNECTION controls produce the structured
  `EXECUTION_CONTROL_ACTIVE` RiskViolation + audit trail, not just the
  downstream dispatch rejection.
- **Expire-and-reactivate lifecycle (architect correction A2):** a persisted
  `status` column (ACTIVE/EXPIRED) + PARTIAL unique index over ACTIVE rows —
  reactivation at the same (scope, scopeKey) after expiry always succeeds
  deterministically (prior row flipped to EXPIRED, retained as a record);
  concurrent activations resolve to exactly one winner (23505 → 409). See
  `docs/brokers/execution-control-plane.md`.
- Admin API (RBAC + audit + realtime event):
  `GET /execution-control/status`, `POST /execution-control/activate`,
  `DELETE /execution-control/:id`.
- Runbook: `docs/brokers/execution-control-plane.md` (includes in-flight
  request boundary documentation).

### 5. LIVE authorization gate in the risk pipeline (Directive §16)

Risk Step 1c: when the user's active connection is a LIVE account, execution
requires `authorizationStatus === ACTIVE`. DEMO/PAPER behavior is unchanged
(they were never live-execution paths). Unknown states fail closed.

### 6. Security hardening

- **WebSocket gateway CORS wildcard removed** — the realtime gateway now uses
  the same fail-closed `parseCorsOrigins` allowlist as the HTTP API
  (`CORS_ORIGINS`). Previously `origin: '*'` let any origin open a socket.
- New realtime events: `broker.connection.authorization_changed`,
  `execution.control.changed` (safe payloads only).

### 7. Shared types (Directive §AU)

`@irexpro/types`: `BrokerAuthorizationStatus`, `BrokerCredentialStatus`,
new `BrokerConnectionView` fields, and the `./broker-registry` subpath
(`BrokerRegistryCatalog`, `BrokerRegistryEntry`, capabilities, routes,
statuses) consumed identically by web/admin/mobile.

## Migrations

1. `1753400000000-AddBrokerAuthorizationStateMachine` — adds
   `authorization_status` (12-state CHECK), `credential_status` (6-state
   CHECK), `authorized_at`, `authorization_revoked_at`; conservative
   fail-closed backfill from legacy booleans (most privileged state first).
2. `1753500000000-CreateExecutionControls` — `platform.execution_controls`
   with scope CHECK constraints, one-active-per-scope unique index
   (NULL-safe via COALESCE), expiry index.
3. `1753550000000-ExecutionControlLifecycleStatus` (architect correction A2)
   — adds the lifecycle `status` column (ACTIVE/EXPIRED + CHECK), backfills
   expired rows to EXPIRED, and replaces the unique index with a PARTIAL one
   over ACTIVE rows only (forward- and rollback-safe).

## Test evidence

- New suites: `broker-authorization-state-machine.spec.ts`,
  `broker-authorization-lifecycle.spec.ts`,
  `broker-provider-registry.spec.ts`, `execution-control.spec.ts`.
- Correction-round additions: four-scope control-gate coverage in
  `risk.service.spec.ts` (all scopes + fail-closed + full-context
  assertions), A3 credential-lifecycle adapter-not-invoked matrices in
  `broker-authorization-lifecycle.spec.ts`, A4 conditional-transition
  coverage, and two real-PostgreSQL integration specs
  (`execution-control.pg-integration.spec.ts`,
  `broker-authorization.pg-integration.spec.ts`) that run in CI's
  risk-concurrency workflow (re-activation determinism, concurrent
  activation single-winner, four-scope enforcement, concurrent
  authorization-transition races, stale-writer-vs-terminal-state).
- Full API unit suite: **150 suites / 1684 tests passing**.
- Lint: 0 errors (122 pre-existing warnings in untouched legacy specs).
- `pnpm api:build`: clean.

## Known limitations / next steps

- Web/admin UI for the new endpoints (revoke, rotate, registry catalog,
  control-plane panel) is delivered in later vertical slices of this stack
  (PRs #191/#201 and their descendants).
- cTrader/OANDA adapters: OANDA is BETA (adapter + contract-tested, live
  verification pending — see PR #204); cTrader remains blocked on partner
  approval (see provider matrix).
- AI-engine live mode remains separately gated (out of scope for this slice).
- Trading-session start (`startSession`) is not itself gated by the emergency
  control plane — the control plane gates signal validation and dispatch
  (Risk pipeline + orchestrator), which is the execution boundary; documented
  here for honesty.
- Orchestration/reconciliation credential guards are enforced in the
  descendant PRs (#162/#170) which own that code.
