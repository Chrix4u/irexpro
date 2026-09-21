# OANDA v20 REST Provider Adapter (Sprint 51 PR-7)

> Status: **BETA** — implemented, registered, and contract-tested in this
> repository; **not yet live-verified** against a real OANDA account.
> This document is the engineering record for the adapter, the mapping
> decisions, and the exact evidence required before OANDA may be promoted
> to `SUPPORTED`.
>
> **Registry truth (architect Phase H):** the OANDA catalog entry carries
> `productionLiveVerification: { status: 'UNVERIFIED' }`. BETA ≠ production-LIVE:
> the implemented adapter makes OANDA **connectable for DEMO use**
> (`isConnectable('oanda') === true`), but LIVE is **fail-closed by code** —
> `isProductionLiveEligible('oanda') === false`, so `createConnection` with
> `accountType: LIVE` and `enableLiveTrading` both reject with
> `ForbiddenException` ("Broker oanda is not production-LIVE verified — …
> BETA is DEMO-only"). No convention, no UI toggle — the server enforces it.
> See `docs/brokers/provider-matrix.md` → "Production-LIVE verification".

## Scope

- Adapter: `apps/api/src/modules/broker/adapters/oanda/oanda.adapter.ts`
- Transport port: `oanda.transport.ts` (`OandaTransport` — injectable; default `FetchOandaTransport`)
- Error mapping: `oanda.error-mapper.ts`
- Symbol normalization: `oanda.symbol-mapper.ts` (Directive §AH — `EURUSD` ↔ `EUR_USD`, broker-suffix aware)
- Tests: `oanda.adapter.spec.ts` (unit) + `oanda.adapter.contract.spec.ts` (shared Directive §AN contract suite)
- Registration: `broker.module.ts` → `registry.register(oandaAdapter)`; catalog entry `oanda` with status `BETA`

## Environments (fail-closed separation)

| iRexPro mode | OANDA base URL | Override env |
| --- | --- | --- |
| DEMO | `https://api-fxpractice.oanda.com` | `OANDA_API_BASE_DEMO` |
| LIVE | `https://api-fxtrade.oanda.com` | `OANDA_API_BASE_LIVE` |

The adapter derives its base URL from `setMode()` and NEVER crosses
environments — asserted by contract-suite §AN-4 for every recorded request.
Per-user OANDA personal access tokens are captured through the existing
encrypted broker-credential store at connect time (`apiKey` field,
in-memory only, redacted from all errors/logs/results — §AN-5).

> The LIVE row above describes the adapter's URL mapping only. While
> `productionLiveVerification` is `UNVERIFIED`, the **server rejects any
> LIVE connection at creation time** (`BrokerService.createConnection` —
> Phase H fail-closed gate), so `api-fxtrade.oanda.com` is unreachable from
> iRexPro in practice. DEMO (fxpractice) is the only reachable environment.

## v20 endpoint mapping

| IBrokerAdapter method | OANDA v20 endpoint | Notes |
| --- | --- | --- |
| `connect` / `testConnection` | `GET /v3/accounts` + `GET /v3/accounts/{id}/summary` | 401 → `AUTHENTICATION_FAILED` |
| `getAccountInfo` / `getAccountBalance` | `GET /v3/accounts/{id}/summary` | balance/marginAvailable/marginUsed decimal strings |
| `getInstrumentList` | `GET /v3/instruments?accountID={id}` | pipLocation/displayPrecision → digits |
| `getCurrentPrice` | `GET /v3/accounts/{id}/pricing?instruments={...}` | last bid/ask; spread = ask−bid |
| `getOHLCV` | `GET /v3/instruments/{instrument}/candles` | `price=M`, mid candles |
| `placeOrder` | `POST /v3/accounts/{id}/orders` | see order mapping below |
| `listOrders` | `GET /v3/accounts/{id}/orders?state=PENDING` (+ TRIGGERED) | working orders only |
| `getOrderById` | `GET /v3/accounts/{id}/orders/{orderSpecifier}` | 404-style → null (legitimate) |
| `modifyOrder` (open trade) | `PUT /v3/accounts/{id}/trades/{tradeSpecifier}/orders` | SL/TP dependent orders |
| `modifyOrder` (working pending order) | `PUT /v3/accounts/{id}/orders/{orderID}` (Phase 5 replace) | routes by working-set lookup; restates the order's current definition + modified SL/TP; v20 replace cancels the original and mints a NEW order id (surfaced as the result handle) |
| `cancelOrder` (concrete, off `IBrokerAdapter`) | `PUT /v3/accounts/{id}/orders/{orderSpecifier}/cancel` | Round 7, Fix 3 |
| `closeOrder` | `PUT /v3/accounts/{id}/trades/{tradeSpecifier}/close` | `units: 'ALL'` or partial |
| `closeAllOrders` | iterate `openTrades` + close each | aggregate result |
| `getOpenPositions` / `getPositionById` | `GET /v3/accounts/{id}/openTrades` (+ batched pricing) | unrealizedPL/financing |
| `getClosedTrades` | `GET /v3/accounts/{id}/trades?state=CLOSED` | realizedPL/financing |

## Order mapping decisions

- **Units vs lots**: OANDA is units-based; iRexPro is lots-based. FX
  conversion: `units = lots × 100000` (contract size), integer-rounded with
  a fail-closed guard when the conversion is lossy.
- **Direction**: OANDA encodes direction in the sign of `units`
  (+ BUY / − SELL).
- **Idempotency (Directive §19/§79)**: the `idempotencyKey` /
  `clientOrderId` is transported as OANDA `clientExtensions.id` on the
  order create payload — verified by contract-suite §AN-6.
- **Order kinds**: MARKET/LIMIT/STOP map directly; **STOP_LIMIT is
  rejected with `INVALID_ORDER_TYPE`** (fail-closed — never silently
  downgraded; OANDA v3 has no composite stop-limit order type).
- **Fill semantics**: `orderFillTransaction` present → `FILLED` with
  fill price/units; only `orderCreateTransaction` → `PENDING`.
- **Order state normalization** (reconciliation): `PENDING` → WORKING,
  `TRIGGERED` → WORKING (triggered stop executing as market), `FILLED` →
  FILLED, `CANCELLED` → CANCELLED, anything unrecognized → `UNKNOWN`
  (fail-closed interpretation).
- **Pending-order modification (Phase 5)**: `modifyOrder` routes by
  working-set lookup — a WORKING pending order (LIMIT/STOP/MARKET_IF_TOUCHED)
  is replaced via the official v20 replace endpoint
  (`PUT /v3/accounts/{id}/orders/{orderID}`), restating the order's CURRENT
  definition (instrument/units/price/timeInForce/priceBound plus any carried
  `stopLossOnFill`/`takeProfitOnFill`) with the modified SL/TP; optional
  fields the original order did not carry are omitted, never fabricated.
  v20 replace CANCELS the original order and CREATES a replacement with a
  NEW order id — the replacement id is surfaced as the result's
  `externalOrderId` so callers (and the verification harness) retarget.
  `clientOrderId`/`clientExtensions` are NOT part of the replace body
  (documented limitation: the replacement order does not inherit the
  original's `clientExtensions.id`). Dependent orders
  (TAKE_PROFIT/STOP_LOSS/TRAILING_STOP_LOSS) and executing MARKET orders are
  not replaceable through this surface and fail closed (`INVALID_REQUEST`).
  An open TRADE keeps the `PUT /trades/{id}/orders` dependent-orders path.
  An id in neither set fails closed through the provider's own 404
  (`POSITION_NOT_FOUND`).

## Margin approximation

OANDA v3 exposes no margin-calculation endpoint. `getRequiredMargin`
computes `units × price × marginRate` (FX) as a documented approximation
in decimal-string arithmetic, returning `null` whenever instrument or
price data is unavailable — the Risk Engine fails closed on null.

Leverage: OANDA reports `marginRate`, not leverage. `BrokerAccountInfo.leverage`
returns the conservative floor `1` so downstream leverage-based checks can
never overstate available exposure.

## Error normalization (Directive §AJ)

| OANDA signal | BrokerErrorCode | Retryable |
| --- | --- | --- |
| 401 / `access_denied` | `AUTHENTICATION_FAILED` | no |
| token-expired semantics | `AUTHORIZATION_EXPIRED` | no |
| account 404 | `ACCOUNT_NOT_FOUND` | no |
| account suspended semantics | `ACCOUNT_DISABLED` | no |
| 400 validation | `INVALID_REQUEST` | no |
| instrument validation | `INVALID_INSTRUMENT` | no |
| market closed semantics | `MARKET_CLOSED` | no |
| 429 | `RATE_LIMITED` | yes |
| 5xx | `PROVIDER_UNAVAILABLE` | yes |
| network timeout | `CONNECTION_TIMEOUT` | yes |
| anything else | `UNKNOWN` | no |

`brokerMessage` retains the provider message + `requestId` for diagnostics;
the raw payload is never persisted or logged.

## Capabilities honestly declared

`ACCOUNT_READ, BALANCE_READ, POSITION_READ, ORDER_READ, HISTORY_READ,
MARKET_DATA, REST, API_TOKEN, DEMO, LIVE, ORDER_PLACEMENT,
ORDER_MODIFICATION (open-trade SL/TP **and** working-pending-order replace —
Phase 5), CLOSE_ALL, MARGIN_CALCULATION` — the same set the broker catalog
declares for `oanda`. (Working-order CANCELLATION also exists as an adapter
surface — `cancelOrder`, Round 7 Fix 3, see the endpoint table above — while
the catalog's `BrokerCapability` enum has no ORDER_CANCELLATION member to
declare; the additive method is discovered structurally by the verification
harness, not through the capability list.)

**NOT declared**: `MARKET_DATA_STREAMING` / `WEBSOCKET` — v20 SSE price
streams remain NOT implemented; the adapter is REST-polling only (every
price read is a `GET /pricing` poll — no persistent stream connection).

**Future work — deliberately NOT claimed**:
- **Provider-side idempotency (ETag / `X-RequestID`)**: the adapter sends no
  `If-None-Match`/ETag caching and no v20 request-id idempotency headers; no
  provider-side dedup is claimed (the platform's dispatch-certainty contract
  assumes none — `clientExtensions.id` is identifier alignment, not
  exactly-once).
- **`/v3/transactions` reconciliation**: the transaction stream /
  since-transaction endpoints are not wired; reconciliation reads order/trade
  state only.

## Requirements before SUPPORTED (operator checklist)

These same items are the **production-LIVE verification evidence** required
before `productionLiveVerification` may be flipped to `VERIFIED` in
`BROKER_CATALOG` (operator-attested practice-account validation records):

1. Obtain an OANDA practice (fxpractice) personal access token and connect
   a real DEMO BrokerConnection end-to-end (**connect**).
2. Verify account-info reads for that connection (`GET
   /v3/accounts/{id}/summary` — balance/margin fields) (**account-info
   round-trip**) and the full order cycle: market fill, resting limit,
   SL/TP modification, partial close, close-all, history (**order
   round-trip on the practice account**).
3. Verify reconciliation against live provider state for ≥ 24h.
4. Add v20 streaming (SSE) or document its permanent omission.
5. Confirm rate-limit behavior under production load and tune
   `rateLimitProfile` defaults.
6. Re-run the shared §AN contract suite against a recording proxy for
   response-shape drift.
7. Record the evidence here (dates, ticket ids, exported provider
   confirmations — never secrets) and set
   `productionLiveVerification: { status: 'VERIFIED', verifiedAt, evidenceRef }`
   on the OANDA catalog entry; update the matrix row in
   `docs/brokers/provider-matrix.md`.

Until every required item is attested, the registry stays at
`{ status: 'UNVERIFIED' }` and LIVE remains fail-closed. **No test in this
repository fabricates a VERIFIED OANDA** — the only `VERIFIED` fixture is
metatrader5 (live-proven production route).
