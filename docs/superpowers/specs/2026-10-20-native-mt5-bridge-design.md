# iRexPro Native MetaTrader 5 Bridge — Design

**Date:** 2026-10-20
**Status:** Design for review
**Owner:** Lightworld Technologies Limited / iRexPro

## 1. Goal

Add a first-party MetaTrader 5 connection path that does not depend on MetaApi for normal client operation. The user keeps a normal MT5 terminal logged into their broker account and installs an iRexPro Expert Advisor (EA). The EA creates an outbound secure connection to iRexPro, streams broker-native account/market state, receives authenticated trading commands, and executes them through the user's MT5 terminal.

MetaApi remains an optional compatibility/fallback connector. cTrader remains a separate official Open API connector. The AI, risk, execution, reconciliation, audit and governance layers must continue to interact only through `IBrokerAdapter`.

## 2. Success criteria

1. A client can pair a DEMO MT5 account with iRexPro without a MetaApi subscription.
2. iRexPro receives broker-native Bid/Ask, account state, positions, orders, symbol specifications and OHLCV from the connected terminal.
3. iRexPro can place, modify, partially close and fully close orders through the same `IBrokerAdapter` contract used by existing providers.
4. Every command is idempotent, authenticated, connection-scoped and auditable.
5. Disconnects fail closed for new execution and are visible immediately in the UI.
6. Reconnect/restart reconstructs provider truth before new orders are accepted.
7. DEMO certification is mandatory before LIVE certification. LIVE stays disabled until a provider-specific certification artifact is approved.
8. Existing MetaApi-backed connections continue to work during migration.
9. No MT5 trading password needs to be stored by iRexPro for the native bridge: the user logs into MT5 locally and the bridge pairs the already-authenticated terminal to iRexPro.

## 3. Non-goals

- Do not bypass a broker's own account, trading, market-data, geographic, leverage, regulatory or platform restrictions.
- Do not make MetaApi-backed records silently use the native bridge.
- Do not grant a native bridge LIVE authority merely because the legacy MetaApi MT5 adapter previously had verification evidence.
- Do not allow the bridge to change AI model thresholds, risk policy, position sizing or signal governance.
- Do not treat a connected terminal as proof that trading is permitted; terminal/account trade flags remain authoritative.

## 4. Current iRexPro boundary to preserve

The existing `IBrokerAdapter` already defines the required provider contract: connection lifecycle, account/balance, margin, market data, order capabilities, order placement/modification/close, positions, closed trades and reconciliation reads. `BrokerAdapterRegistry` creates connection-isolated adapter instances so one account cannot overwrite another account's mutable state.

The native MT5 work therefore replaces the transport underneath a new adapter. It does not create a second execution engine.

## 5. Provider identity and migration

### 5.1 New canonical provider

Introduce a new provider id:

- `metatrader5-native` — **MetaTrader 5 — iRexPro Native Bridge**

Keep the current provider unchanged initially:

- `metatrader5` — existing MetaApi-backed implementation

This avoids changing the meaning of persisted `BrokerConnection` rows and avoids incorrectly inheriting legacy certification evidence.

### 5.2 Migration policy

After the native bridge passes DEMO and LIVE certification:

1. New MT5 connections should default to `metatrader5-native` in the UI.
2. Existing MetaApi connections remain on their original provider until the user explicitly migrates.
3. An assisted migration flow creates a new native connection, validates account identity/mode, completes a reconciliation snapshot, and only then retires the MetaApi connection.
4. MetaApi may remain selectable as `MetaTrader 5 — Cloud/MetaApi` for customers who prefer a terminal-less hosted connector.

No in-place provider-id mutation is allowed while orders/positions are active.

## 5.3 Product terminology and connection workflow

The product must keep these concepts separate:

- **Broker** — the regulated trading firm/account provider that holds the client trading account (for example Deriv, Pepperstone, IC Markets or OANDA).
- **Trading platform** — the account technology the broker exposes (for example MetaTrader 5 or cTrader). MetaTrader 5 and cTrader are not brokers.
- **iRexPro connector** — the transport/integration iRexPro uses to reach that platform/account (for example iRexPro Native MT5 Bridge, MetaApi Cloud, cTrader Open API or a broker-native API).

`BrokerConnection` remains the internal persisted entity name for backward compatibility, but customer-facing copy should use **Trading account connection** or **Connect trading account** where practical. The provider id identifies the connector technology; `providerBrokerIdentity` records the server-derived actual broker identity when the platform exposes it.

The connection workflow becomes:

1. Choose the **connection method / platform**.
2. For **MetaTrader 5 — iRexPro Native Bridge**, pair the already logged-in MT5 terminal; the bridge detects account login, broker/company, server, DEMO/LIVE mode and capabilities.
3. For **cTrader — Open API**, authorize with cTrader ID; iRexPro discovers the cTrader trading accounts and their broker identity.
4. For a direct broker API such as OANDA, authorize the broker directly.
5. Show the detected **Broker**, **Platform**, **Connection method**, **Account** and **Environment** for confirmation before DEMO validation/execution eligibility.

Canonical customer-facing connector labels:

- `metatrader5-native` — **MetaTrader 5 — iRexPro Native Bridge** (preferred first-party MT5 route once certified).
- `metatrader5` — **MetaTrader 5 — MetaApi Cloud** (optional hosted/compatibility route).
- `ctrader` — **cTrader — Open API**.
- Direct broker adapters retain the broker brand in the label, e.g. **OANDA — Direct API**.

A broker may expose more than one platform and those accounts remain distinct. For example, a Deriv MT5 account is connected through the MT5 connector, while a Deriv cTrader account is connected through the cTrader connector. iRexPro must never assume a cTrader account is reachable through MT5 merely because the same broker also supports MT5.

## 6. Architecture

```text
                         iRexPro AI / Risk / Execution
                                   |
                           IBrokerAdapter contract
                                   |
                   NativeMetaTrader5Adapter (API)
                                   |
                      MT5 Bridge Session Registry
                                   |
                  authenticated RPC / event envelopes
                                   |
                      MT5 Bridge Gateway (VPS)
                                   |
                       outbound TLS connection
                                   |
                    iRexPro Bridge EA (.ex5)
                                   |
                       MetaTrader 5 Terminal
                                   |
                        Client's MT5 Broker
```

The EA always initiates the network connection. iRexPro never needs inbound access to the user's computer, so NAT/home routers do not need port forwarding.

## 7. Components

### 7.1 `NativeMetaTrader5Adapter`

A connection-scoped NestJS adapter implementing the full `IBrokerAdapter` interface. It translates normalized iRexPro calls into RPC commands sent to the bridge session and maps bridge responses/errors back into standard broker types and `BrokerAdapterError` codes.

Responsibilities:

- enforce provider/mode/account binding;
- declare MT5 order capabilities;
- request account, margin, symbol, price and OHLCV state;
- place/modify/close orders;
- list positions/orders/history for reconciliation;
- preserve decimal-string money values at the API boundary;
- never infer success after a timeout;
- classify dispatch certainty for uncertain command outcomes.

### 7.2 `Mt5BridgeGateway`

A dedicated long-lived connection service, separate from normal request/response HTTP controllers. It owns terminal sessions, heartbeats, RPC correlation and event fan-out.

Responsibilities:

- terminate TLS;
- authenticate/pair EA installations;
- maintain one active writer session per approved `BrokerConnection.id`;
- reject account/mode identity drift;
- correlate RPC `requestId` to responses;
- publish ticks/order/deal/account events;
- detect stale/disconnected sessions;
- reject replayed commands/nonces;
- expose sanitized health to the API/observability layer.

The gateway must be horizontally scalable later through a shared session directory/message bus, but the first release may run as a single supervised process while preserving a clean session-registry interface.

### 7.3 `iRexProBridgeEA.mq5`

An MQL5 Expert Advisor installed on one MT5 chart. It is an execution/telemetry bridge, not an AI strategy. It must never invent signals or override iRexPro risk decisions.

Responsibilities:

- pair the logged-in MT5 account to one iRexPro connection;
- publish terminal/account/broker identity and capabilities;
- stream current broker-native ticks for configured instruments;
- expose rates/history, symbol properties and native margin calculations;
- execute signed commands through MT5 trade functions;
- publish trade transaction/order/deal state;
- reconnect with bounded exponential backoff;
- retain a bounded local idempotency journal across transient disconnects;
- display connection/mode/account status visibly on the chart.

### 7.4 Pairing service and UI

User flow:

1. User chooses **MetaTrader 5 — Native Bridge**.
2. iRexPro creates a short-lived one-time pairing code bound to the user and target connection.
3. User downloads/installs the signed iRexPro EA and adds the iRexPro bridge host to MT5's allowed network list.
4. User attaches the EA to one chart and enters the pairing code.
5. EA reports account login, broker server, company, currency, leverage, account mode, margin mode and terminal trade permissions.
6. Server displays the detected account and asks the user to confirm the binding.
7. DEMO validation runs before the connection becomes execution-eligible.

The pairing code is not a long-lived credential and cannot authorize trades after pairing completes.

## 8. Transport protocol

### 8.1 Primary transport

Use a persistent outbound TLS socket from the EA to a dedicated iRexPro bridge endpoint. MQL5 officially supports socket creation/connection and TLS operations from Expert Advisors, subject to the terminal's allowed-address list.

Application frames are length-prefixed UTF-8 JSON for v1. Binary/protobuf can be added later only if measured load requires it.

Each envelope contains at least:

```json
{
  "protocolVersion": 1,
  "type": "COMMAND|RESPONSE|EVENT|HEARTBEAT",
  "sessionId": "...",
  "requestId": "...",
  "sequence": 123,
  "sentAt": "2026-10-20T09:00:00.000Z",
  "nonce": "...",
  "payload": {},
  "signature": "..."
}
```

### 8.2 Security

Transport security is layered:

1. TLS encryption to the iRexPro bridge endpoint.
2. One-time pairing token for enrollment.
3. Rotatable per-installation bridge credential after pairing.
4. HMAC/authenticated application envelopes with sequence + nonce + timestamp.
5. Strict connection binding to expected account login, broker server and DEMO/LIVE mode.
6. Replay rejection and bounded clock-skew validation.
7. No broker password transmitted to or stored by iRexPro.
8. Secrets never written to application logs.

If TLS/authentication/session identity cannot be verified, trading fails closed.

## 9. Terminal and account identity

A bridge session reports and continuously checks:

- MT5 account login;
- trade server name;
- broker/company name;
- DEMO/LIVE account classification where obtainable;
- currency and leverage;
- account margin mode (hedging/netting/exchange);
- terminal connected state;
- terminal trade permission;
- account trade permission;
- EA automated-trading permission;
- terminal/build and EA version.

A material identity change invalidates the session and requires re-verification. A LIVE account must never attach to a connection declared DEMO or vice versa.

## 10. Market data

The native bridge supplies actual broker-side terminal observations:

- `SymbolInfoTick` Bid/Ask/Last/time;
- symbol digits, point, tick size/value, volume min/max/step, stops/freeze levels;
- synchronized OHLCV via `CopyRates`/equivalent rate reads;
- broker trading sessions and symbol trade mode where needed.

Rules:

1. Tick events are timestamped using MT5/broker tick time and bridge receive time.
2. Closed-candle model evidence is never built from an incomplete bar.
3. Broker-native Bid/Ask may become execution/protection authority only for the exact bound account/session.
4. Historical model features remain subject to the same causal/available-at rules as every other iRexPro source.
5. Feed gaps/staleness are explicit health states, never silently filled with fabricated prices.

This native market feed can eventually replace Deriv as the preferred fast mark for an attached MT5 account, while Deriv/Twelve Data can remain independent research/reference feeds.

## 11. Trading commands and idempotency

Supported normalized commands map to MT5 requests:

- `GET_ACCOUNT_INFO`
- `GET_SYMBOLS`
- `GET_TICK`
- `GET_RATES`
- `CALCULATE_MARGIN`
- `LIST_POSITIONS`
- `LIST_ORDERS`
- `GET_ORDER`
- `GET_HISTORY`
- `PLACE_ORDER`
- `MODIFY_ORDER`
- `CLOSE_POSITION`
- `CANCEL_ORDER`
- `CLOSE_IREXPRO_POSITIONS`

Every mutating command contains:

- iRexPro `idempotencyKey`;
- stable `requestId`;
- expected account/session identity;
- command expiry;
- normalized order payload;
- iRexPro ownership marker/magic number/comment.

The EA records completed mutating request ids/idempotency keys in a bounded persistent local journal. A duplicate command returns the original known result or provider truth; it never submits a second trade.

`OrderSend()` returning transport/basic success is not treated as final execution success by itself. The bridge reports MT5 retcodes plus subsequent transaction/deal/order evidence, and iRexPro reconciliation resolves uncertain outcomes.

## 12. Position ownership

The bridge must distinguish iRexPro-managed positions from manual/other-EA positions using a reserved magic-number namespace plus a deterministic comment prefix.

Normal **Stop AI** behavior closes only positions/orders owned by the relevant iRexPro connection/session. It must not close a client's unrelated manual positions. This matches the existing `ExecutionService.closeAllAiOpenPositions()` behavior, which closes iRexPro trades individually through the normal close/reconciliation path.

The core adapter method `closeAllOrders()` retains its existing account-wide emergency meaning and must **not** be used to implement routine Stop AI. The native adapter therefore preserves both semantics: selective AI flatten through normal per-position closes, and explicit account-wide emergency flatten only when the execution control plane requests that operation.

This ownership rule should be reflected in adapter/reconciliation tests before LIVE certification.

## 13. Hedging and netting accounts

MT5 can expose different position accounting models.

- **Hedging:** multiple independent positions per symbol are supported. iRexPro may maintain multiple valid same-instrument positions subject to its own portfolio/risk governance.
- **Netting:** the broker/account maintains one net position per symbol. The adapter must map iRexPro execution intent to the actual netted provider state and must not pretend independent tickets exist when MT5 does not expose them that way.

The account's margin mode is detected during pairing and becomes part of connection capability metadata. Unsupported strategy semantics fail closed rather than being approximated.

## 14. Margin, sizing and symbol constraints

For LIVE eligibility, margin/order validation uses broker-native terminal data whenever possible:

- `OrderCalcMargin`/native margin data;
- volume min/max/step;
- stops level and freeze level;
- symbol trade mode;
- filling/order modes;
- account free margin and margin level.

If a required broker-native constraint cannot be determined safely, risk validation fails closed.

## 15. Event model and causality

The EA publishes events for:

- tick;
- account snapshot/heartbeat;
- order accepted/rejected/changed;
- deal/fill;
- position changed/closed;
- terminal connectivity and permission changes.

Each event carries provider time (where available), local terminal time, gateway receive time and monotonic sequence. The server rejects sequence regression and records gaps.

The adapter may query provider truth after an event, but it must never turn an older cached event into newer execution evidence.

## 16. Reconnect and recovery

1. On socket loss the EA reconnects with bounded exponential backoff and jitter.
2. New iRexPro execution is blocked while the bridge is stale/disconnected.
3. On reconnect the server requires a fresh account identity snapshot plus full positions/orders snapshot before marking the adapter healthy.
4. Reconciliation compares MT5 truth with iRexPro non-terminal orders/trades.
5. Uncertain previous mutating commands are resolved by idempotency key/provider ticket/history; never blindly retried.
6. Open iRexPro positions continue to exist at the broker even if the cloud connection drops. The EA/terminal remains responsible for broker-hosted SL/TP already attached to positions/orders.

## 17. Protection requirements

LIVE orders should attach broker-hosted SL/TP at placement whenever the broker/order mode supports it. A cloud/bridge disconnect must not be able to remove baseline protection from an already-open trade.

Dynamic profit protection/trailing behavior may use fast broker-native ticks while connected, but any protection that exists only in cloud memory is supplemental, not a substitute for the baseline broker-hosted stop.

## 18. Health states

Expose at least:

- `UNPAIRED`
- `PAIRING`
- `CONNECTED_SYNCING`
- `CONNECTED_READY`
- `STALE`
- `DISCONNECTED`
- `IDENTITY_MISMATCH`
- `TRADING_DISABLED_TERMINAL`
- `TRADING_DISABLED_ACCOUNT`
- `VERSION_UNSUPPORTED`

Trader UI must show the exact reason new trades are blocked.

## 19. Versioning and forced upgrades

The gateway and EA negotiate `protocolVersion` and `eaVersion`.

- backward-compatible server changes may support multiple EA versions;
- security-critical/incompatible versions become `VERSION_UNSUPPORTED` and cannot trade;
- the UI provides the current signed EA package and upgrade instructions;
- LIVE certification pins a minimum supported EA and gateway protocol version.

## 20. Certification path

The native provider starts with production LIVE verification **UNVERIFIED**.

### Stage A — contract tests

Run the shared broker-adapter contract suite plus native-specific tests for isolation, idempotency, account identity, reconnect, stale sessions, hedging/netting and ownership markers.

### Stage B — deterministic fake-terminal harness

Use a fake bridge transport to exercise command/response/event races, duplicate commands, disconnect during dispatch, out-of-order events and reconciliation.

### Stage C — real MT5 DEMO certification

On a real DEMO terminal verify:

- pair/connect/reconnect;
- account identity;
- Bid/Ask and rates;
- margin/symbol specifications;
- market + pending orders;
- attached SL/TP;
- modify/partial/full close;
- positions/orders/history;
- idempotent duplicate suppression;
- terminal restart recovery;
- network outage recovery;
- kill/Stop AI ownership behavior;
- hedging or netting behavior for the certified account type.

### Stage D — controlled LIVE certification

Use a deliberately small real-money account after DEMO passes. Certification evidence is protocol/provider-specific and cannot be inherited from MetaApi.

Only an approved certification artifact can flip the provider to production LIVE eligibility.

## 21. Rollout phases

### Phase 1 — protocol + fake bridge

- gateway protocol/types;
- session registry;
- fake EA transport;
- `NativeMetaTrader5Adapter`;
- adapter contract tests;
- broker catalog entry `metatrader5-native` (DEMO only).

### Phase 2 — real MQL5 EA, telemetry first

- pairing;
- account/symbol/tick/rates telemetry;
- health/reconnect;
- no mutating commands initially.

### Phase 3 — DEMO execution

- order placement/modification/close;
- idempotency journal;
- transaction events;
- reconciliation;
- DEMO certification harness.

### Phase 4 — user experience + installer

- download/setup wizard;
- pairing status;
- diagnostics;
- update flow;
- clear instructions for the MT5 allowed-network host and AutoTrading permission.

### Phase 5 — controlled LIVE certification

- smallest practical exposure;
- full failover/outage tests;
- certification artifact;
- production-live policy review.

### Phase 6 — make native MT5 the default

Only after evidence supports it. Keep MetaApi as optional hosted fallback.

## 22. Operational model and costs

The native bridge removes a mandatory MetaApi subscription from this connection path, but it is not “zero infrastructure cost.” Lightworld still operates the bridge gateway, API, databases, monitoring, certificates and AI systems. The user must also keep an MT5 terminal connected (typically their computer or a VPS) and comply with their broker's rules.

Future optional product tiers can include:

- self-hosted terminal connector — client runs MT5;
- Lightworld managed terminal/VPS — paid convenience service;
- MetaApi cloud connector — optional third-party route;
- cTrader native Open API — platform API route.

## 23. Why this approach

Alternatives considered:

1. **Keep MetaApi mandatory:** fastest operationally but creates recurring third-party dependency/cost per connected MT account.
2. **Build a native MT5 EA bridge (recommended):** more engineering and certification work, but gives iRexPro control of transport, broker-native ticks and execution while avoiding a mandatory third-party connector subscription.
3. **Only support cTrader/REST brokers:** simpler server architecture but excludes a very large MT5 user base.

The native bridge is therefore the preferred long-term MT5 path, with MetaApi retained as an optional compatibility/hosted route rather than the product's core dependency.

## 24. Implementation guardrails

- No direct edits to deployed staging code.
- TDD: failing test before production implementation.
- Every account-scoped adapter stays connection-isolated.
- No native MT5 LIVE enablement before provider-specific certification.
- No migration of existing MetaApi rows with open orders/positions.
- No broker password stored for native bridge pairing.
- No command without idempotency key and expiry.
- No new execution while bridge health is stale or identity is unverified.
- No manual/client positions closed by normal iRexPro Stop AI.
- No unprotected LIVE position created when broker-hosted baseline SL/TP is required and supported.
