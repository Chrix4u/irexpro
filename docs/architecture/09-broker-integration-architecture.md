# 09 — Broker Integration Architecture

## iRexPro — Broker Adapter Design and Multi-Broker Strategy

---

## 1. Purpose

This document defines the broker integration architecture for iRexPro, including the Broker Adapter Interface, the adapter pattern implementation, credential security, supported operations, and the roadmap for adding future brokers.

---

## 2. Core Design Principle

iRexPro must never be tightly coupled to any single broker's API. The broker integration layer is designed as a **pluggable adapter architecture** — each broker is an interchangeable implementation of a common interface.

This means:
- The Risk Engine and Execution Engine interact only with the Broker Adapter Interface
- Swapping or adding a broker requires only a new adapter class
- No broker-specific logic leaks into core business logic

---

## 3. Broker Adapter Interface

The following TypeScript interface must be implemented by every broker adapter:

```typescript
interface IBrokerAdapter {
  readonly brokerId: string;
  readonly brokerName: string;

  // Connection lifecycle
  connect(credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionResult>;
  disconnect(): Promise<void>;
  testConnection(credentials: DecryptedBrokerCredentials): Promise<BrokerConnectionTestResult>;
  isConnected(): boolean;

  // Account state
  getAccountInfo(): Promise<BrokerAccountInfo>;
  getAccountBalance(): Promise<BrokerBalance>;
  getOpenPositions(): Promise<BrokerPosition[]>;
  getPositionById(externalOrderId: string): Promise<BrokerPosition | null>;

  // Market data
  getInstrumentList(): Promise<BrokerInstrument[]>;
  getCurrentPrice(instrument: string): Promise<BrokerPrice>;
  getOHLCV(instrument: string, timeframe: string, count: number): Promise<OHLCV[]>;

  // Order management
  placeOrder(order: BrokerOrderRequest): Promise<BrokerOrderResult>;
  modifyOrder(externalOrderId: string, modifications: BrokerOrderModification): Promise<BrokerOrderResult>;
  closeOrder(externalOrderId: string, lotSize?: number): Promise<BrokerOrderResult>;
  closeAllOrders(): Promise<BrokerCloseAllResult>;

  // Trade history
  getClosedTrades(from: Date, to: Date): Promise<BrokerClosedTrade[]>;
}
```

---

## 4. Broker Adapter Data Types

```typescript
interface DecryptedBrokerCredentials {
  apiKey?: string;
  apiSecret?: string;
  accountId: string;
  serverUrl?: string;
  additionalParams?: Record<string, string>;
}

interface BrokerConnectionResult {
  success: boolean;
  accountId: string;
  accountType: 'DEMO' | 'LIVE';
  currency: string;
  serverTime: Date;
  error?: string;
}

interface BrokerAccountInfo {
  accountId: string;
  currency: string;
  leverage: number;
  balance: string;   // Decimal string to avoid float precision issues
  equity: string;
  margin: string;
  freeMargin: string;
  marginLevel: string;
}

interface BrokerOrderRequest {
  idempotencyKey: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: string;        // Decimal string
  stopLoss: string;       // Absolute price, decimal string
  takeProfit: string;     // Absolute price, decimal string
  comment?: string;       // Include idempotencyKey here for broker-side dedup
}

interface BrokerOrderResult {
  success: boolean;
  externalOrderId?: string;
  filledPrice?: string;
  filledAt?: Date;
  status: 'FILLED' | 'PENDING' | 'REJECTED' | 'FAILED';
  brokerMessage?: string;
  rawResponse?: unknown;  // Full broker response for audit
}

interface BrokerOrderModification {
  newStopLoss?: string;
  newTakeProfit?: string;
  newTrailingStop?: string;
}

interface BrokerPosition {
  externalOrderId: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  lotSize: string;
  openPrice: string;
  currentPrice: string;
  stopLoss: string;
  takeProfit: string;
  unrealisedPnl: string;
  openedAt: Date;
  commission: string;
  swap: string;
}

interface OHLCV {
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}
```

---

## 5. Adapter Registry

The `BrokerAdapterRegistry` is a factory service that returns the correct adapter instance based on the `brokerId` field stored in `BrokerConnection`.

```typescript
class BrokerAdapterRegistry {
  private adapters: Map<string, IBrokerAdapter>;

  register(brokerId: string, adapter: IBrokerAdapter): void;
  getAdapter(brokerId: string): IBrokerAdapter;
  getSupportedBrokers(): BrokerSummary[];
}
```

Each adapter is registered at application startup via a NestJS provider:

```typescript
{
  provide: 'BROKER_ADAPTER_REGISTRY',
  useFactory: () => {
    const registry = new BrokerAdapterRegistry();
    registry.register('MT5_DEMO_BROKER', new Mt5DemoBrokerAdapter(config));
    // Future: registry.register('OANDA', new OandaAdapter(config));
    // Future: registry.register('CTRADER', new CTraderAdapter(config));
    return registry;
  }
}
```

---

## 6. Credential Security

### 6.1 Storage

Broker credentials are encrypted before being stored in the database. The encryption uses:

- **Algorithm:** AES-256-GCM
- **Key Management:** AWS KMS / HashiCorp Vault (configurable provider)
- **Envelope Encryption:** Data Encryption Key (DEK) generated per credential set, encrypted by the Key Encryption Key (KEK) in KMS
- **Stored Fields:** `encrypted_credentials` (ciphertext), `credential_key_id` (KMS key reference)

### 6.2 Decryption Flow

Decryption happens only in the Broker Adapter layer, never in controllers or DTOs:

```
BrokerService.getDecryptedCredentials(connectionId)
→ Fetches encrypted_credentials and credential_key_id from DB
→ Calls KMS provider to decrypt DEK using KEK
→ Decrypts credentials using DEK (AES-256-GCM)
→ Returns DecryptedBrokerCredentials (in memory only, never persisted)
→ Passes directly to IBrokerAdapter.connect()
```

### 6.3 What Is Never Exposed

- Raw API keys or secrets are never included in API responses
- Decrypted credentials are never logged
- Decrypted credentials are held in memory only for the duration of the adapter call

---

## 7. Connection Health Monitoring

A background job runs on a configurable interval (default: 60 seconds) to health-check all active broker connections:

```
BrokerHealthCheckJob (BullMQ recurring job):
  For each BrokerConnection with status = CONNECTED:
    1. Call IBrokerAdapter.getAccountBalance()
    2. If success:
       - Update BrokerAccount sync state
       - Update last_health_check_at
    3. If failure:
       - Increment failure counter (Redis)
       - If failures >= threshold (default: 3):
         - Set BrokerConnection.status = DISCONNECTED
         - Emit BrokerDisconnected event
         - Notify user
         - Notify admin
         - Suspend active TradingSession for this user
```

---

## 8. Reconciliation

Trade state must be reconciled with the broker's actual state:

```
TradeReconciliationJob (BullMQ recurring job, every 5 minutes):
  For each Trade with status = OPEN (per connected user):
    1. Call IBrokerAdapter.getPositionById(externalOrderId)
    2. Compare local state with broker state:
       - If broker shows closed (SL/TP hit): close Trade record, update realised P&L
       - If broker shows modified: update local SL/TP values
       - If broker shows position not found: flag as RECONCILIATION_ERROR, alert admin
    3. Log reconciliation result
```

---

## 9. Demo / Sandbox Mode

Every broker adapter must support a sandbox/demo mode:

```typescript
interface IBrokerAdapter {
  readonly supportsDemo: boolean;
  setMode(mode: 'DEMO' | 'LIVE'): void;
}
```

Rules:
- New users must validate connection in DEMO mode before LIVE mode is enabled
- Paper trading sessions always use DEMO mode
- Live trading sessions use LIVE mode only
- DEMO and LIVE are separate BrokerConnection records (never the same credentials)

---

## 10. Phase 1 Broker — First Implementation

For Phase 1, one broker adapter is implemented. The adapter is chosen based on regulatory access, API quality, and geographic coverage. The adapter must satisfy the full `IBrokerAdapter` interface.

Architecture considerations for the first adapter:
- Must support REST API or WebSocket for order placement
- Must provide DEMO/sandbox environment
- Must support EURUSD, GBPUSD, USDJPY, and at least 10 major pairs
- Must provide OHLCV data at M1, M5, M15, H1, H4, D1 timeframes
- Must return decimal-safe price and P&L values

---

## 11. Future Broker Adapter Roadmap

| Broker | Priority | Notes |
|---|---|---|
| MetaTrader 5 (MT5) | High | Most widely used — requires MT5 Manager API or third-party bridge |
| OANDA | High | Excellent REST API, good documentation |
| cTrader / Spotware | Medium | Popular with ECN brokers |
| FXCM | Medium | Good API, global reach |
| IC Markets | Medium | High-volume retail broker |
| Interactive Brokers | Low | Institutional-grade, complex API |
| Binance (crypto) | Future — Model B | Crypto support in Phase 2 |

---

## 12. Error Handling in Adapters

Each adapter must map broker-specific errors to the standard `BrokerAdapterError` class:

```typescript
class BrokerAdapterError extends Error {
  constructor(
    public readonly code: BrokerErrorCode,
    public readonly message: string,
    public readonly brokerMessage?: string,
    public readonly isRetryable: boolean = false,
  ) {}
}

enum BrokerErrorCode {
  AUTHENTICATION_FAILED = 'AUTHENTICATION_FAILED',
  INSUFFICIENT_MARGIN = 'INSUFFICIENT_MARGIN',
  INVALID_INSTRUMENT = 'INVALID_INSTRUMENT',
  DUPLICATE_ORDER = 'DUPLICATE_ORDER',
  MARKET_CLOSED = 'MARKET_CLOSED',
  CONNECTION_TIMEOUT = 'CONNECTION_TIMEOUT',
  RATE_LIMITED = 'RATE_LIMITED',
  UNKNOWN = 'UNKNOWN',
}
```

- `isRetryable: true` — Execution Engine may retry with backoff
- `isRetryable: false` — Execution Engine records failure, does not retry, alerts admin

---

## 13. Failure Cases

| Failure | System Response |
|---|---|
| Credential decryption fails | Log error, suspend BrokerConnection, alert admin |
| Broker returns authentication error | Mark connection DISCONNECTED, notify user |
| Order placement returns REJECTED | Record rejection, log broker message, no retry |
| Order placement times out | Retry up to 3 times; if still failing, record as RECONCILIATION_PENDING |
| OHLCV data unavailable | AI Signal Engine falls back to cached data; if stale > threshold, suspend signals |
| Broker returns DUPLICATE_ORDER | Idempotency check; return existing order record without new submission |

---

## 14. Sprint 56 — Server-Authoritative Catalog, Verification Program & Universal cTrader Engine

**Sprint 56 (broker-completion, re-integrated onto the merged main) adds
four layers to this architecture. Authoritative per-broker status, evidence,
and blockers live in `docs/brokers/provider-matrix.md`.**

### 14.1 Server-authoritative broker catalog (status honesty + Phase H gate)

The static, versioned `BROKER_CATALOG` (`registry/broker-catalog.ts`) is the
single server-side source of truth. Every `BrokerDefinition` carries a
normalized `BrokerCapability` set (Directive §M), connection routes,
explicit `environments`, an `authenticationType`, and a `status`
(`BrokerAvailabilityStatus`: SUPPORTED / BETA / NOT_STARTED /
PARTNER_APPROVAL_REQUIRED / UNAVAILABLE) that MUST match implementation
evidence. `BrokerProviderRegistryService` overlays live adapter
availability: **a catalog entry without a registered adapter can never be
reported as SUPPORTED** — the effective status degrades automatically.
Clients (web/admin/mobile) derive the catalog from
`GET /api/v1/broker/registry` — never from client-side lists (Directive §AU).

Implementation status is **separate from production-LIVE approval**
(`BrokerProductionLiveVerification`: `UNVERIFIED` / `VERIFIED` — architect
Phase H). `isProductionLiveEligible(id)` is the fail-closed LIVE gate: absent
or `UNVERIFIED` ⇒ `createConnection(LIVE)` and `enableLiveTrading` reject
with `ForbiddenException` (BETA providers are DEMO-only). `VERIFIED` requires
operator-attested evidence (`verifiedAt` + `evidenceRef` — never secrets).
Only metatrader5 carries `VERIFIED` today (retained production route).

### 14.2 The shared cTrader Open API engine (universal provider)

`adapters/ctrader/` implements one universal engine over the official
**JSON-over-WebSocket** transport (port 5036 — the only JSON port): OAuth 2.0
(platform app `CTRADER_CLIENT_ID/SECRET` + user access token via the
`id.ctrader.com` consent flow), DEMO/LIVE hosts hard-isolated
(`wss://demo|live.ctraderapi.com:5036`), 10s heartbeats, 50/5 req/s rate
limits, clientMsgId-echo request matching, and the full trading surface (all
four order types, modify/cancel/close, positions, reconciliation, deal
history, native margin). Zero new npm dependencies (Node native WebSocket +
fetch). `pepperstone-ctrader` and `icmarkets-ctrader` are **alias catalog
entries sharing this one engine** — duplicated execution engines are
prohibited. Real-account usage is **partner-approval-blocked**: the operator
must register and obtain approval for a cTrader Open API application and
supply its OAuth client credentials; unconfigured credentials fail closed
without ever opening a socket.

### 14.3 Evidence-based DEMO validation (`validate-demo`)

`POST /broker/connections/:connectionId/validate-demo` is the honest
`demoValidated` write path: a capability-aware checklist (14 user-facing
steps from connect through order round-trips to history) runs against the
real adapter, with every step PASS/FAIL/SKIPPED and sanitized detail
(credentials never recorded — `redactString` on all evidence). PASS sets
`demoValidated`; **FAIL revokes a previously-set flag** (fail-closed — the
`enableLiveTrading` gate re-checks at that moment). This strengthens main's
connect-time `demoValidated` auto-write (a connect-implies-validated proxy)
into checklist-driven validation with audit evidence, unblocking the
DEMO-first LIVE-authorization invariant.

### 14.4 The credential-gated provider-verification harness program

`verification/provider-verification-harness.ts` runs an 18-step canonical
checklist (connect → account-info → market-data → positions → market order →
SL/TP modify → partial/full close → trade history → pending order cycle →
margin → reconciliation → reconnect → provider error path) with strict
decimal-string money discipline and sanitized evidence records. Operator
entry points are env-gated specs (`oanda.demo-verification.spec.ts`,
`ctrader.demo-verification.spec.ts`) that run only with operator-supplied
real credentials — **CI is credential-free** (the suites report SKIPPED; the
always-on `paper.harness.spec.ts` proves the machinery). Evidence levels:
DEMO-VERIFIED (harness run with real practice credentials, recorded in the
provider matrix) and PRODUCTION-LIVE-VERIFIED (operator-attested
`evidenceRef` + `verifiedAt` in the catalog). **Unit/contract/sandbox tests
never flip `productionLiveVerification`** — only an operator edit with
recorded evidence does.

### 14.5 Sprint 56 correction round 1 — OAuth token lifecycle & user OAuth connection flow

The architect's 10-point audit of PR #287 found three code gaps; all three are
closed (local commits on `feat/broker-completion`):

**a) cTrader OAuth token lifecycle (`BrokerOAuthTokenLifecycleService`).**
Spotware invalidates the previous `(accessToken, refreshToken)` pair the
moment a refresh succeeds — a refreshed-but-unpersisted credential set is
permanently dead. The lifecycle service therefore:

- tracks access-token expiry INSIDE the encrypted credential
  (`additionalParams.accessTokenExpiresAt`, next to `refreshToken` — never
  plaintext at rest);
- refreshes BEFORE provider use when the token is expired, near-expiry
  (5-minute margin) or of unknown expiry;
- persists the new pair ATOMICALLY (single `UPDATE`: ciphertext + iv + tag +
  keyId + `credentialStatus: ROTATED`) BEFORE the new tokens are handed to
  any consumer;
- fails closed on refresh rejection (typed `ConflictException` + credential
  `INVALID` + re-authorization required) and on persistence failure after a
  successful refresh (the stored pair is dead — `INVALID` is the honest
  state); transient failures (network/timeout/rate) propagate WITHOUT
  poisoning the credential;
- is wired into `BrokerService.connectBroker` and `healthCheck`, so
  reconnect and health paths always run on the current token (the adapter
  session map is updated with the refreshed token before use).

**b) Bounded serialized transport (client engine).** The cTrader client
enforces an explicit in-flight ceiling (`CTRADER_MAX_IN_FLIGHT_REQUESTS =
500` per connection — the worst legal steady state of 50 req/s general × the
10 s request timeout): requests beyond the ceiling fail fast with a
retryable `RATE_LIMITED` error instead of accumulating unbounded pending
state. Correlation (clientMsgId echo), wire ordering, disconnect rejection
and no-replay-of-non-idempotent semantics are pinned by the adversarial
test battery in `ctrader-client.service.spec.ts`.

**c) End-to-end user OAuth connection flow (API + web + mobile).** PR #287
shipped the adapter without any user-facing OAuth path; it now exists:

```
user selects cTrader-family broker (web onboarding / mobile SDK55 screen)
  → POST /broker/connections/oauth/authorize      (server-side single-use
    flow, user-bound, 10-min TTL, bounded store; returns the official
    id.ctrader.com consent URL + flowId)
  → external browser / system browser consent     (cTrader password NEVER
    captured by iRexPro)
  → redirect to the platform-registered redirect URI (env
    CTRADER_REDIRECT_URIS allowlist: web callback page
    /onboarding/broker/callback and, if operator-registered, the mobile
    deep link irexpro://broker/oauth/callback)
  → POST complete {flowId, code}                  (ownership-checked,
    single-use; code exchanged server-side with the PLATFORM application
    credentials; cTID accounts discovered via 2149 with isLive flags)
  → user picks an account
  → POST link {flowId, ctidTraderAccountId}       (canonical
    createConnection path: AES-256-GCM-encrypted credentials incl.
    refreshToken + expiry; accountType derived from the SERVER-reported
    isLive flag; LIVE fails closed for production-LIVE-UNVERIFIED brokers —
    OAuth never weakens the Phase H gate; flow consumed single-use)
  → BrokerConnection created → connect → validate-demo checklist.
```

cTrader's OAuth supports no `state` parameter — correlation is maintained
server-side via the single-use flowId (web keeps its copy in sessionStorage
across the external round trip; mobile keeps it in memory while awaiting the
deep-link return). Tokens exist in plaintext ONLY: (1) in transit to the
token endpoint (TLS), (2) in memory between `complete` and `link` (bounded
TTL), (3) inside the AES-256-GCM ciphertext — never in responses, audit
metadata, logs or exception text (adversarially tested in
`broker-oauth.service.spec.ts` and
`broker-oauth-token-lifecycle.service.spec.ts`).

### 14.6 Sprint 56 correction round 2 — architect findings on PR #290 (transport serialization, replica-safe OAuth state, concurrent refresh, mobile handoff boundary)

The architect's independent code review of PR #290 identified four remaining
production-readiness gaps; all four are closed (local commits on
`feat/broker-completion` after `401b125`). cTrader-family brokers remain
**BETA / production-LIVE UNVERIFIED** throughout — nothing in this round
weakens any fail-closed gate.

**a) Real transport serialization (finding 1).** The production
`NodeWebSocketCtraderTransport.send()` no longer writes to the socket when
OPEN: every outbound frame passes through ONE bounded FIFO outbox per
environment connection, drained by a single drain loop (one frame at a
time — never overlapping writes; a re-entrant `send()` during a drain only
enqueues). Deterministic backpressure: queue capacity (default 1000) with a
typed `CtraderTransportSendError('queue-overflow' | 'not-open')`; nothing is
silently dropped, the client maps send failures to retryable typed errors
and cleans pending entries immediately, heartbeat frames enqueue strictly
FIFO (never reorder requests or app-auth-first ordering), socket close and
intentional `close()` clear the queue (no replay on reconnect), and payloads
are never logged. Proven by a deterministic 12-test transport suite (exact
wire order under 300+50 concurrent submissions, single-drain re-entrancy,
queue ceiling, disconnect-with-queued, heartbeat interleaving, DEMO/LIVE
outbox independence, log secrecy) plus 3 client failure-mapping tests. An
injectable `CtraderSocketLike` factory seam keeps the suite network-free.

**b) Replica-safe OAuth authorization state (finding 2).** The flow store
was a process-local `Map` — unusable with multiple API replicas and lost on
restart. It is now the `broker.broker_oauth_flows` table (TypeORM +
PostgreSQL — this platform's shared store; no Redis exists in the stack):
server-generated opaque flow ids bound to user/broker/redirect URI;
explicit `PENDING → AUTHORIZED → LINKING → CONSUMED` states with
conditional-UPDATE (CAS) transitions — single-use `complete`, single-use
`link` (the transient `LINKING` claim carries a 60-second stale-recovery
window; a failed link restores `AUTHORIZED` so the DEMO-fallback UX
survives); hard TTLs (10 min pending, 5 min authorized) enforced fail-closed
plus lazy sweeps; the `{accessToken, refreshToken}` bundle is AES-256-GCM
encrypted at rest; no token material in logs, audit metadata, exceptions or
responses. Cross-instance proof (`broker-oauth.cross-instance.spec.ts`):
authorize on instance A → complete on instance B → link on instance A; a
third instance continues a flow after "restart"; concurrent duplicate
completion/link allows exactly ONE consumer; cross-user lookups behave as
not-found.

**c) Concurrent OAuth refresh protection (finding 3).** Spotware rotates
BOTH tokens on refresh and invalidates the previous pair — two concurrent
refreshes of one credential generation permanently kill it.
`BrokerOAuthTokenLifecycleService` now serializes refreshes per
`BrokerConnection` ACROSS REPLICAS: a DB-atomic conditional-UPDATE refresh
LEASE (`credential_refresh_lease_expires_at`, 30 s, self-expiring so a hung
winner never stalls the connection) lets exactly ONE replica call the
provider per stale `credential_generation`; losers bounded-wait and ADOPT
the winner's persisted pair (no provider call, no write, no audit, and
never a false INVALID merely because another request rotated successfully);
persistence is a generation CAS (`credential_generation = observed + 1
WHERE generation = observed`) so a stale refresh response can never
overwrite a newer pair (it adopts it); genuinely rejected CURRENT
credentials still fail closed to INVALID; transient errors never poison;
exactly one rotation audit event per generation. Proven by a 6-test
concurrency suite: 20 simultaneous `ensureFreshTokens()` calls → provider
refresh count EXACTLY 1, all callers receive the same new generation, the
stored credential stays ROTATED, no false INVALID, cross-instance refresh,
stale-CAS never overwrites; plus a PG-integration spec for CI.

**d) Production mobile OAuth callback boundary (finding 4).** The mobile
app no longer receives Spotware's authorization code through the
`irexpro://` custom scheme. Production flow: cTrader → the REGISTERED HTTPS
iRexPro server callback (`GET /broker/connections/oauth/callback[/:slot]`,
public, 302-to-deep-link with a minimal no-data HTML body) → the server
immediately consumes/exchanges the provider code and maintains the flow
correlation → the server issues a short-lived opaque ONE-TIME handoff token
(32 random bytes; only its SHA-256 digest and a 120 s TTL are stored;
user-bound; replay/expired/cross-user all fail closed) → a controlled
deep-link handoff (`irexpro://broker/oauth/handoff?token=…` — custom-scheme
interception yields nothing reusable) opens the app → the app POSTs the
handoff token to `/broker/connections/oauth/handoff` (authenticated,
single-use) → the account-selection flow continues exactly as before.
Because cTrader's OAuth has no `state` parameter and redirect URIs must be
exactly registered, mobile-flow correlation uses operator-registered
callback SLOTS (`CTRADER_MOBILE_CALLBACK_URIS`, e.g.
`…/callback/m1 … /mN`): `authorize` with `channel: 'mobile'` claims a free
slot, and the callback resolves the flow by the arriving request path —
exactly-one-PENDING-flow-per-slot is enforced, ambiguity fails closed hard
(no cross-user completion is ever possible). Web OAuth continues unchanged
through its registered HTTPS callback page; the client-supplied redirect
URI for the web channel must now be HTTPS (custom schemes are rejected as
a production provider callback). Expo SDK55 Android/iOS support is
unchanged in mechanism (external system browser + `Linking` deep-link
listener) with a 10-minute await watchdog and clean cancellation feedback;
Account/Security Center behavior is preserved.

### 14.7 Sprint 56 correction round 3 — post-round-2 integration corrections (connection-scoped adapter factory, alias identity, SPOT correlation, session leases, credential-test disposal, BrokerService races)

The architect's post-round-2 review of PR #290 (with the connection-scoped
factory/session architecture developed in #291/#288) identified eight
integration corrections; all eight are closed (commits `085d35f`, `31f7b23`
on `feat/broker-completion` after `ba10983`). This round closes the SUBSTANCE
of issue #288 (shared mutable adapter connection context) by adopting the
#291 contract rather than a competing mechanism. cTrader-family brokers
remain **BETA / production-LIVE UNVERIFIED** throughout.

**a) Connection-scoped mutable adapter contexts (findings 1 + 2 + 7, issue
#288 substance).** `BrokerAdapterRegistry` now implements the #291
factory/session contract: every canonical provider registers a metadata
root PLUS an isolation factory; `getAdapterForConnection(connectionId,
brokerId)` hands ONE mutable adapter context per persisted
`BrokerConnection.id` (concurrent operations on the same connection share
its session; different connections never share); `createEphemeralAdapter`
serves pre-persistence credential tests (never cached); aliases
(`pepperstone-ctrader`, `icmarkets-ctrader`) resolve to the canonical
provider registration — they share the FACTORY and the lower-level provider
infrastructure, never a mutable adapter object. Four fail-closed factory
protections are retained from #291: no factory registered → account
operations refused; factory returning the root singleton → refused; wrong
provider output → refused; a factory reusing a previously-created instance
across independent connections → refused. The cTrader factory receives the
REQUESTED broker id (alias-aware) while the isolated adapter's `brokerId`
stays canonical `ctrader` — the requested identity rides as
`CTraderAdapter.requestedBrokerId` for broker-specific verification. All
account-operation consumers (BrokerService connect/health/rotate/margin/
ohlcv/trades, ExecutionOrchestrator dispatch, StateReconciliation, DEMO
validation) resolve through the session API; the shared `CTraderClientService`
environment-connection pool stays shared by design (it is stateless with
respect to adapter context).

**b) SPOT event correlation (finding 3).** A spot waiter in
`fetchSpotQuote` now requires `payload.ctidTraderAccountId ===
<requesting account>` AND `symbolId` AND a complete bid/ask quote. A 2131
event for a DIFFERENT account on the same shared environment connection can
never satisfy the waiter. Proven adversarially: two accounts, one DEMO
connection, account B's event delivered first — A's waiter stays pending and
resolves only on A's own event; wrong-symbol and partial-quote events never
resolve; two concurrent waiters (one per account, same symbol) each resolve
only on their own account's event; adapter-level two-context
`getCurrentPrice` race included.

**c) Account-session lease/refcount lifecycle (finding 4).** The client's
`ensureAccountSession(env, accountId, token, owner)` acquires a NAMED LEASE
per adapter context; `removeAccountSession(env, accountId, owner)` releases
ONE owner's lease — the provider session (token + 2102 authorization) is
removed only when NO other owner still requires it, and the environment
connection closes only when its last account session goes away.
`releaseOwnerSessions(owner)` releases every lease an adapter context holds
across both environments. Disconnecting one BrokerConnection can therefore
never remove a provider session still required by another BrokerConnection
using the same cTrader account/environment; repeated `connect()` calls
(orchestrator dispatch, health checks) are idempotent lease re-acquisitions.
Proven deterministically: two adapters/one client share ONE session and ONE
2102; A disconnects → B stays connected; the last release tears down session
and transport.

**d) Credential-test lifecycle (finding 5).** `testConnection()` runs its
full disposal in a `finally` path — every provider session the (ephemeral)
context established is released on BOTH the success and every partial-failure
path (2102 succeeded, then discovery/trader fetch failed), and lease
refcounting guarantees sessions owned by PERSISTED connections sharing the
same account are never invalidated. `BrokerService.testCredentials` and the
rotation validation both use ephemeral adapters; rotation releases the
connection's adapter context only AFTER the new credentials persist.

**e) Broker alias identity validation (finding 6).** A centralized policy
(`ctrader-broker-identity.ts`) derives the expected identity token from the
REQUESTED alias id itself (no fabricated provider-title mappings): the
discovered `brokerTitleShort` (2149) is normalized (case/punctuation/
whitespace-insensitive containment) and must match the alias — an
IC-Markets-discovered account fails closed under `pepperstone-ctrader`
(and vice versa) at BOTH the adapter connect path and the OAuth
`linkAccount` path; a missing/empty discovered title under a
broker-specific alias is a mismatch (fail-closed); the generic `ctrader` id
remains broker-agnostic by design.

**f) BrokerService races (finding 8, from #291).** `disconnectBroker` now
performs the guarded persisted-state transition BEFORE any irreversible
provider teardown: a lost race (ConflictException) leaves the provider
session and adapter context untouched for the concurrent winner — a lost
race can never strand a CONNECTED persisted state on a torn-down provider
session; teardown after a WON transition is best-effort (a failure leaves a
recoverable provider session under a DISCONNECTED state), and the adapter
context is released after both. Health-check suspension now transitions
through the guarded write only (the unconditional unguarded status write is
REMOVED): when the guarded suspension loses a concurrency race there are NO
observable side effects — the adapter context is not released and no
SUSPENDED audit/event is emitted (telemetry still records the failure
count); release/audit/event happen only when the guarded transition actually
succeeded. Both behaviors are covered by deterministic race specs (shared
call-order sequences and `affected: 0` mock orchestration).
