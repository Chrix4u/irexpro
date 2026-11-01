# Direct MT5 Native LIVE Capability Design

## Goal
Finish iRexPro's MetaAPI-free Direct MT5 route so the same native connector can operate DEMO and LIVE accounts from MT5 brokers, while LIVE remains fail-closed until real operator certification evidence exists.

## Safety model
1. MT5 is the authority for account environment. The Windows connector reads `account_info().trade_mode`; DEMO maps to DEMO, REAL maps to LIVE, CONTEST is refused.
2. Connector protocol v2 binds accountType alongside login + broker server. Old v1 connectors fail closed and must upgrade.
3. Server pairing binds terminal accountType to the persisted BrokerConnection environment. An environment switch suspends the connector.
4. LIVE heartbeat never grants trading authority. Only the existing broker authorization/certification flow can set LIVE authorization.
5. Downstream command leasing independently blocks LIVE `PLACE_ORDER` unless authorization_status=ACTIVE and live_trading_enabled=true. Risk-reducing modify/close remain possible when terminal trading is available.
6. Catalog advertises Direct MT5 DEMO+LIVE technical capability but keeps productionLiveVerification=UNVERIFIED until a real LIVE canary certification is run and durable evidence is recorded.
7. No MT5 password is stored by iRexPro. The connector attaches to the already logged-in local terminal and stores only the revocable iRexPro connector token in the OS credential vault.

## Completeness
The current Python connector is missing several server-declared surfaces. Finish and normalize LIST_SYMBOLS, GET_SYMBOL_INFO, GET_OHLCV, GET_ORDER, GET_HISTORY, CLOSE_ALL, plus account/price/position/order/result shapes. Server and Python command sets must be identical.

## Production certification
Code completion does not fabricate LIVE evidence. Production LIVE remains blocked until an operator runs the real-money certification harness against a dedicated paired LIVE terminal and records its durable evidence artifact in the broker catalog.
