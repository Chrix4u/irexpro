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
