# Sprint 56 Architect Readiness Boundaries

This note records the post-delivery architect review of Sprint 56 / PR #287.
It is intentionally release-truth documentation: it does not change provider
capabilities, execution behavior, risk behavior, or production-LIVE eligibility.

## What PR #287 establishes

- A cTrader Open API adapter implementation exists and is contract/unit tested.
- cTrader, Pepperstone-via-cTrader and IC-Markets-via-cTrader remain BETA.
- Their `productionLiveVerification` status remains `UNVERIFIED`; BETA status
  does not authorize production-LIVE use.
- Demo/live provider endpoints are separated in the cTrader client.
- Provider application authentication, account authentication, heartbeat,
  request correlation, bounded reconnect attempts and provider request-rate
  budgets are implemented in the backend adapter layer.
- Evidence-based DEMO validation is tenant-scoped and cannot set
  `productionLiveVerification`.

## What PR #287 does NOT establish

### End-user cTrader OAuth onboarding

The backend contains cTrader OAuth URL/token primitives, but PR #287 does not add
an end-to-end web/mobile consent initiation and callback journey. The existing
mobile broker screen remains the generic account-id/API-token connection flow.
Therefore Sprint 56 must not be described as complete end-user cTrader OAuth.

Tracked in issue #289: `cTrader: complete server-owned OAuth onboarding for web and mobile`.
Until #289 is completed, cTrader OAuth credentials are suitable only for
controlled/operator integration testing; normal users should not be required to
obtain or paste provider access/refresh tokens as the final production UX.

### Shared mutable adapter connection context

The current `IBrokerAdapter` contract on main is stateful (`setMode`, implicit
current account, parameterless account reads/disconnect). MetaTrader and OANDA
already use this pattern, and the Sprint 56 cTrader adapter follows it. Because
Nest providers are singleton by default, concurrent broker operations require a
platform-level context-isolation hardening rather than a cTrader-only workaround.

Tracked in issue #288: `Security: eliminate shared mutable broker-adapter connection context`.
The fix must make every provider operation target an explicit connection/account
context and add adversarial multi-user concurrency coverage.

## Release interpretation

PR #287 may be evaluated as a **backend BETA/provider-verification slice** only.
It must not be used as evidence that every researched broker is implemented, that
web/mobile cTrader OAuth onboarding is complete, or that any BETA/UNVERIFIED
provider is production-LIVE verified.

Production readiness for cTrader-backed providers additionally requires:

1. approved platform/provider application credentials;
2. completion of #288 and #289;
3. operator-run DEMO verification evidence;
4. provider-specific production-LIVE verification evidence;
5. exact-head repository CI/security gates on the final candidate.

## Correction round 1 (delivered on this branch)

Round 1 closed the 10-point audit of PR #287 (token lifecycle, bounded
in-flight transport, end-to-end web/mobile OAuth flow, adversarial test
batteries, docs). Issue #289's substance (server-owned OAuth onboarding for
web and mobile) was implemented end-to-end in that round.

## Correction round 2 (delivered on this branch — PR #290 review)

The architect's independent code review of PR #290 found four remaining
production-readiness gaps; all four are closed:

1. **Real cTrader transport serialization** — production `send()` now uses a
   bounded single-drain FIFO outbound queue per environment connection
   (never overlapping writes; deterministic overflow; no silent drops; no
   replay on reconnect; payloads never logged).
2. **Replica-safe OAuth authorization state** — the process-local flow Map is
   now the encrypted `broker.broker_oauth_flows` PostgreSQL store with
   PENDING/AUTHORIZED/LINKING/CONSUMED CAS transitions, hard TTLs, and
   cross-instance single-use semantics (authorize on A → complete on B →
   link on A is proven).
3. **Concurrent OAuth refresh protection** — per-connection DB-atomic
   refresh lease + credential-generation CAS across replicas: exactly one
   provider refresh per stale generation, losers adopt the winner's pair,
   no false INVALID, stale responses can never overwrite a newer pair.
4. **Production mobile OAuth callback boundary** — Spotware's authorization
   code now lands on a REGISTERED HTTPS server callback that exchanges it
   server-side and hands the app only a one-time, user-bound, 2-minute
   opaque handoff token via a controlled deep link; the custom scheme never
   carries the provider code, tokens, or secret.

**Issue #289 acceptance evidence (updated):** the server-owned OAuth
onboarding is complete for web AND mobile: authorize (web/mobile channels) →
external consent → server-side code exchange → replica-safe encrypted flow
store → mobile handoff token boundary → account picker → link (LIVE
fail-closed for UNVERIFIED brokers everywhere). Remaining external
dependency: approved Spotware Open API application credentials
(CTRADER_CLIENT_ID/SECRET + registered redirect URIs incl. the mobile HTTPS
callback slots) — an operator/partner action, not a code gap.

**Issue #288 note:** at round 2 it remained open by design (shared mutable
adapter connection context — architect-owned). Round 3 (below) closes its
substance via the #291 connection-scoped factory contract.

cTrader, Pepperstone-via-cTrader and IC-Markets-via-cTrader remain **BETA**
with `productionLiveVerification = UNVERIFIED`; no fail-closed gate was
weakened. Production-LIVE eligibility still requires items 1–5 above.

## Correction round 3 (delivered on this branch — post-round-2 integration corrections)

The architect's post-round-2 review identified eight integration corrections
against the connection-scoped factory/session architecture developed in
#291/#288; all eight are closed (commits `085d35f` + `31f7b23` after
`ba10983`):

1. **Connection-scoped mutable adapter contexts** (findings 1 + 2 + 7) — the
   #291 `BrokerAdapterRegistry` factory/session contract is adopted as the
   ONE mechanism (no competing singleton/factory): metadata-only roots,
   per-`BrokerConnection.id` sessions, ephemeral credential-test adapters,
   alias→canonical resolution sharing the factory/infrastructure (never the
   adapter object), and all four fail-closed factory protections retained.
   This closes the SUBSTANCE of issue #288.
2. **SPOT event correlation** (finding 3) — waiters match
   `ctidTraderAccountId` + symbolId + complete quote; adversarial
   two-account same-environment proof.
3. **Account-session leases** (finding 4) — refcounted ownership per
   adapter context; disconnecting one connection never removes a session
   another requires.
4. **Credential-test lifecycle** (finding 5) — finally-safe disposal on
   success and partial failures without invalidating persisted connections'
   sessions.
5. **Broker alias identity validation** (finding 6) — centralized
   normalization/matching policy on the discovered `brokerTitleShort`;
   fail-closed brand/alias mismatch at adapter connect AND OAuth link;
   generic `ctrader` stays agnostic; no fabricated provider mappings.
6. **BrokerService races** (finding 8) — provider teardown strictly after
   the guarded disconnect transition (lost race = zero side effects);
   suspension release/audit/event only when the guarded transition actually
   won (unguarded status write removed).

Issue #288's substance (shared mutable adapter connection context) is
closed by item 1; the issue itself stays with the architect to re-review
and reconcile with the #291 branch (the contract ported here is byte-level
#291 semantics with the cTrader factory wired that #291 deferred).

cTrader, Pepperstone-via-cTrader and IC-Markets-via-cTrader remain **BETA**
with `productionLiveVerification = UNVERIFIED`; no production-LIVE
fail-closed gate was weakened in any round.

## Correction round 4 (delivered on this branch — execution certainty, OAuth concurrency finalization, transport-generation fencing, provider-identity hardening)

Baseline: round-3 head `64aaa96` (architecture preserved intact — no
competing mechanism introduced). Findings closed:

1. **Stale OAuth refresh invalidation (finding 1)** — terminal INVALID
   writes are generation/lease-guarded (`markRefreshRejected` conditional
   UPDATE on id + `credential_generation = observed` + own-lease-or-free).
   A stale owner whose lease expired and whose generation was taken over
   (N+1 persisted) can never poison the newer usable pair and never emits a
   false refresh-failed audit against it; it converges onto the newer pair.
   Genuine current-owner rejection: exactly one INVALID write for exactly
   that generation, lease released atomically, one sanitized audit.
   Adversarial proofs: expired-lease/takeover/late-rejection (A),
   takeover + persistence failure (B), genuine owner (C), 20-concurrent
   no-takeover (D), live-lease stale owner (E), unreclaimed-lease dead pair
   (F) + PostgreSQL integration re-proofs.
2. **LINKING exactly-once (finding 2)** — the stale-LINKING reclaim window
   (`LINKING_STALE_MS`) is REMOVED. Once AUTHORIZED → LINKING, no second
   request may reclaim the flow (any age, any replica). A paused linker
   (mid-`createConnection`) can never be overtaken; a different-account
   takeover is rejected with zero side effects; exactly one
   BrokerConnection, one linked audit, one flow consumer, no
   account-selection mutation. A crashed linker's flow recovers by EXPIRY
   (user restarts OAuth) — never by speculative replay.
3. **cTrader transport write failure semantics (finding 3)** — explicit
   outbound-write certainty: `NOT_WRITTEN` (queue-overflow, not-open,
   queued-at-failure), `WRITE_ATTEMPTED_OUTCOME_UNKNOWN` (the frame whose
   synchronous send threw — never replayed), `WRITTEN_AWAITING_RESPONSE`.
   A synchronous write failure notifies the client IMMEDIATELY
   (`onWriteFailure`), marks the transport generation unhealthy, clears
   (and REPORTS) the unwritten queue, and reconnects with a NEW transport
   generation. Frame contents/tokens never appear in logs.
4. **Transport generation fencing (finding 4)** — monotonic
   `transportGeneration` per `attachTransport`; every callback captures its
   generation and operates only while current; the transport also
   socket-identity-fences its own listeners. An old socket's
   message/close/error/late-open events can never affect the current
   generation (state, pending requests, waiters, heartbeat, reconnect
   schedule, outbound queue). Ten adversarial transport proofs.
5. **Provider-dispatch certainty (findings 5-6)** —
   `ProviderDispatchCertainty`
   (DEFINITELY_NOT_SENT / SENT_RESPONSE_RECEIVED /
   MAY_HAVE_REACHED_PROVIDER) on every state-changing failure crossing the
   execution boundary (PLACE, CLOSE_POSITION, CANCEL_ORDER, MODIFY/AMEND,
   CLOSE_ALL) for MetaTrader, OANDA, cTrader and paper. Automatic retry is
   allowed ONLY for DEFINITELY_NOT_SENT; everything else — including
   UNCLASSIFIED errors — becomes RECONCILIATION_PENDING immediately. No
   provider deduplication is assumed (cTrader clientOrderId/label/comment
   are NOT broker-side exactly-once evidence). Read-only operations keep
   their retry policy.
6. **Reconciliation resolves uncertain writes (finding 7)** — uncertain
   writes converge through the Round-3 connection-scoped adapter by
   provider READ (never resubmission). Fixed a real convergence defect the
   adversarial test exposed: the resolution path called the status-only
   `resolveReconciliation(FILLED|PARTIALLY_FILLED)` which OrderService
   rejects by design — the fill-bearing authority is now `applyFill`
   (atomic, transitions the pending state itself) plus a guarded
   `resolveReconciliationFillState` for fill-equal convergence (never
   inventing economic facts). Concurrent resolution remains CAS-guarded:
   exactly one authoritative convergence.
7. **Versioned canonical provider-identity model (finding 8)** — substring
   matching replaced by an explicit reviewed catalog
   (`PROVIDER_IDENTITY_MODEL_VERSION = 1`): 'pepperstone-ctrader' → family
   PEPPERSTONE, acceptable normalized titles ['pepperstone'];
   'icmarkets-ctrader' → IC_MARKETS, ['icmarkets']; uncataloged aliases →
   exact-token equality; unreviewed variants ("Pepperstone (UK)",
   "IC Markets (AU)") fail CLOSED until cataloged with discovery evidence.
8. **Persisted server-derived provider identity (finding 9)** —
   `broker.broker_connections.provider_broker_identity`
   (migration 1753900000000): sanitized normalized identity from 2149
   discovery, set by the SERVER at OAuth link through an internal channel
   (the public DTO can never submit or overwrite it); NULL = unknown.
   Kept internal (no response-DTO exposure — no product need).
9. **Identity-scoped production-LIVE verification (finding 10)** —
   evidence modeled per (technology, identity, environment, evidence ref,
   verified timestamp). A connection gains LIVE eligibility ONLY from
   VERIFIED evidence EXACTLY matching its server-derived identity; unknown
   identity fails closed; technology-level (generic ctrader) evidence
   authorizes nothing by itself — one broker's verification can never
   authorize another. THIS ROUND: `ctrader`, `pepperstone-ctrader`,
   `icmarkets-ctrader` all remain BETA /
   `productionLiveVerification = UNVERIFIED` — the identity gate is
   redundantly fail-closed today.
10. **CI truth** — GitHub Actions produced ZERO runs on the round-3 head
    `64aaa96`; the exact-head CI/security matrix has NOT executed for this
    branch. See the repository CI status for the round-4 head.

No production-LIVE gate, execution safety gate, or Round-3
adapter/session isolation was weakened; no AI/signal/risk/leverage/
position-size/SL-TP/profit-sharing/funding behavior was modified.

## Correction round 5 (delivered on this branch — unified execution authority)

Issues #292–#303, #312–#317, #330–#332, #361 on the exact round-5 prompt.
Starting HEAD 06ea2a8d (round-4 final). Commits:
2d40874 (ExactDecimal #313), bc58d69 (authority schema wave),
674fbf3 (contract seam), cc5a0bb (session authority + OAuth durable
linking + authority UX), 78bb351 (frontend contract alignment),
8c1b157 (final dispatch boundary + risk correctness + trade CAS +
exposure accounting), plus the docs commit.

- **#295** TradingSession is the execution target: executionMode +
  authorityGeneration persisted (migration 1754000000000 with one-ACTIVE
  partial unique + FK preflight that FAILS on duplicates/orphans); start
  binds the exact connection (typed conflict, audited switch); risk +
  execution use session.brokerConnectionId only (findActiveConnectionForUser
  removed from NEW-exposure paths); final boundary reloads the SAME id.
- **#298** modes durable; PAPER_ONLY routes NEW exposure to paper only
  (never inferred from accountType); SEMI_AUTO one-time confirmations
  (partial unique one-PENDING-per-signal; consumed CAS at the boundary;
  endpoints GET /execution/confirmations/pending + POST :id/confirm);
  FULL_AUTO only with full current authority; mode change = audited
  generation bump invalidating grants/confirmations.
- **#301** RiskGrant: durable, immutable, short-TTL, single-use, bound to
  exact order digest + all authority facts; issuance one-per-signal;
  execution accepts only the opaque handle; consume is atomic at dispatch.
- **#300/#299** authority generation + kill-switch/control revisions bound
  into grants and re-checked at the boundary; suspension/KYC reversal bump
  the generation (grant mismatch → blocked NEW exposure; risk-reducing ops
  remain).
- **#294** identity-scoped LIVE verification re-checked at the final
  boundary (fail-closed on unknown identity / missing evidence /
  downgrade); enableLiveTrading recheck path preserved from round 4.
- **#297/#312** broker_account_snapshots versioned (unique
  connection+generation) — schema + entity landed; writer wiring is the
  follow-up integration point (grant carries snapshot generation fields).
- **#296** fail-closed risk engine: no :SKIPPED; RISK_ENGINE_QUERY_FAILED
  rejections; malformed values fail closed.
- **#313** ExactDecimal everywhere in risk math; boundary tests: 80/80
  (exact equality, next/previous quantum, negatives, large values verified
  vs Python arbitrary precision, malformed fail-closed).
- **#317** daily loss vs session openingBalance; drawdown vs monotonic CAS
  peakEquity.
- **#316** maxTradeRiskPercent (risk-at-stop, conservative divUp) +
  maxLeverageAllowed (effective order leverage = notional/equity) enforced.
- **#331** MARKET SL/TP geometry via risk-order-geometry service (fresh
  connection-scoped quote reference; BUY ask / SELL bid; fail-closed on
  malformed/stale); LIMIT/STOP semantics preserved.
- **#330** regime propagation + LOW_LIQUIDITY rejection + unknown-regime
  fail-closed.
- **#302** durable signal identity (userId, signalId) + digest conflict
  detection + freshness/skew; strategy supplies the binding.
- **#314** RECONCILIATION_PENDING retains exposure reservation;
  DEFINITELY_NOT_SENT releases once; ambiguous CLOSE retains until proven.
- **#315** trade lifecycle CAS (OPEN→RECONCILIATION_PENDING, OPEN→CLOSED)
  with reload-preserve (late UNKNOWN never regresses reconciled truth).
- **#303** operation classes; kill switch blocks NEW/INCREASE only.
- **#332** logical-account-key idempotent OAuth linking + durable outbox;
  cTrader aliases canonicalize; adopt-on-retry; 20-way races covered.
- **#361** the final dispatch boundary itself (see §14.8 of
  09-broker-integration-architecture.md).
- **#292/#293** Web/Mobile/Admin truthfulness: six-label taxonomy
  (LIVE-capable / Production LIVE Verified / Production LIVE Unverified /
  Ineligible / DEMO only / execution disabled); liveTradingEnabled demoted
  to compatibility mirror; session mode selector + confirmation inbox with
  server-consumed authority only.

Validation at the final head: API full suite 214 suites (212 passed + 2
pg-gated), 3183 tests (3176 passed + 7 pg-gated); tsc 0; nest build OK;
lint 0 errors / 132 warnings; web production build OK + tsc exactly 1
pre-existing e2e TS2339 + jest 69/69; mobile tsc 0 + jest 72/72 +
account-security 124/124 + release-config valid + Android/iOS Metro
exports OK; types 21/21 + api-client contracts 15/15; secret scan 1039
blobs 0 secrets + self-test; tracked artifacts 1042 paths; checkout
credential privacy 19 steps; release-audit install-safety OK. PostgreSQL
is unavailable in this sandbox (no docker/sudo) — the 8 jest-pg
integration specs (incl. 20-way session/confirmation/link races)
typecheck locally and execute in CI only.

HONEST LIMITS: (1) snapshot-version WRITER wiring (provider refresh into
broker_account_snapshots at the pre-trade boundary) is schema-complete but
not yet wired into the broker refresh path — the grant/verification fields
exist and the boundary enforces presence once wired; (2) PG races await a
PostgreSQL-capable CI runner execution; (3) cTrader/Pepperstone/IC Markets
remain BETA / productionLiveVerification = UNVERIFIED — external provider
evidence (Spotware approval, production credentials, registered redirect
URIs/mobile callbacks, DEMO + LIVE verification) is still required.
