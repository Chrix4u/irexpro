# Direct MetaTrader 5 Connector Design

## Intent
Replace MetaApi as iRexPro's MetaTrader transport so users can connect their own MT5 account without paying a MetaApi subscription. Preserve the existing `IBrokerAdapter` execution/risk/reconciliation contract and change only the provider transport underneath MetaTrader.

## Chosen architecture
Use a customer-side Windows connector that runs beside an installed/logged-in MetaTrader 5 terminal. The connector uses MetaQuotes' official `MetaTrader5` Python package to communicate with the local terminal, and maintains an outbound authenticated HTTPS/WebSocket session to iRexPro. iRexPro never reverse-engineers the private MT5 broker protocol and never requires inbound ports on the customer's machine.

### User pairing flow
1. In iRexPro the user chooses **MetaTrader 5 (Direct Connector)** and clicks **Generate pairing code**.
2. iRexPro creates a short-lived single-use pairing code plus a connector installation identifier. No MT5 password is sent to iRexPro.
3. The user installs/launches **iRexPro MT5 Connector** on the Windows PC/VPS where MT5 is installed and already logged in.
4. The connector accepts the pairing code, exchanges it once for a revocable connector token, discovers the local MT5 terminal/account, and sends account identity for confirmation.
5. iRexPro binds that connector to one `BrokerConnection`. DEMO must still validate before LIVE authority can be enabled.
6. Thereafter the connector opens only outbound connections to iRexPro, heartbeats, receives signed/idempotent commands, executes them through the local MT5 terminal, and reports authoritative results/state.

## Security invariants
- Never store or transmit the user's MT5 password through iRexPro.
- Pairing codes are random, single-use, short-lived, and stored server-side only as hashes.
- Long-lived connector tokens are random high-entropy secrets, stored server-side only as hashes; rotation/revocation is supported.
- Every connector request is bound to connector id + broker connection id + account login + broker server.
- Every trade command has an immutable command id/idempotency key. A connector must return the previous result for duplicate command ids and must never execute twice.
- Connector heartbeats carry monotonically increasing sequence numbers and timestamps; stale/replayed messages fail closed.
- Connector can only access its bound account and cannot choose another user's connection id.
- LIVE continues to require existing iRexPro authority/risk/demo-validation gates.

## Protocol v1
Server-to-connector command types:
- `ACCOUNT_SNAPSHOT`
- `GET_PRICE`
- `GET_OHLCV`
- `CALCULATE_MARGIN`
- `PLACE_ORDER`
- `MODIFY_ORDER`
- `CLOSE_ORDER`
- `CLOSE_ALL`
- `LIST_POSITIONS`
- `LIST_ORDERS`
- `GET_ORDER`
- `GET_HISTORY`

Connector-to-server event types:
- `HELLO`
- `HEARTBEAT`
- `ACCOUNT_STATE`
- `COMMAND_RESULT`
- `POSITION_EVENT`
- `ORDER_EVENT`
- `DEAL_EVENT`
- `ERROR`

Initial transport is authenticated HTTPS long-poll/command lease plus heartbeat, because it is simple, works through restrictive NAT/firewalls, and is testable. A WebSocket transport can be added later without changing the command protocol.

## Failure semantics
- If the connector is offline/stale, direct MT5 is `DISCONNECTED`; NEW exposure fails closed.
- An uncertain order dispatch is never blindly retried. Server reconciles by command id/provider ticket first.
- Connector crash/restart reloads its local command journal before accepting commands.
- If MT5 terminal/account changes from the paired login/server, execution is suspended until the user confirms/re-pairs.

## Migration from MetaApi
Phase 1 builds protocol, secure pairing, command lease API, connector agent, and tests while existing MetaApi stays available but not required for the new direct connector.
Phase 2 implements `DirectMt5ClientService` and a MetaTrader transport interface, then switches `MetaTraderAdapter` to direct transport for newly paired direct-MT5 connections.
Phase 3 removes MetaApi operational dependency after direct DEMO UAT proves account state, margin, market data, order placement/modification/close, reconciliation, disconnect and restart recovery.

## Constraints
- Windows is required for the official MetaTrader terminal/Python integration path.
- Mobile MT5 alone is not sufficient to host the connector; the Android/iOS app can still monitor/control iRexPro, but the paired desktop MT5 terminal/connector must remain online for direct execution.
- No profitability or trade-frequency assumptions are coupled to this broker transport work.

## Alternatives considered
1. Reverse-engineer MT5 broker protocol: rejected as fragile, proprietary and broker-dependent.
2. MQL5 Expert Advisor using only `WebRequest`: viable, but deployment/update/debugging is harder and WebRequest requires users to manually allowlist our URL.
3. Local Windows Python connector using MetaQuotes official terminal integration: chosen for the first production path because it gives account/order/history/market-data access through the installed terminal with simpler secure updates and diagnostics.
