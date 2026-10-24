# Direct MT5 Onboarding Design

## Intent
Make MetaTrader 5 onboarding understandable and affordable for ordinary iRexPro users. Direct MT5 is the recommended route: the user links an already logged-in Windows MT5 terminal without giving iRexPro an MT5 password and without needing a MetaApi subscription.

## User flow
1. User chooses MetaTrader 5 and selects **Direct Connector (recommended)**.
2. User creates a DEMO BrokerConnection with the MT5 account number and an optional display name. No password/API key is requested.
3. iRexPro generates a short-lived single-use pairing code bound to that owned BrokerConnection.
4. User installs/runs the iRexPro MT5 Connector on the same Windows PC/VPS as MT5 and enters the pairing code.
5. Connector reads the logged-in terminal's account login and broker server. Redemption succeeds only when the terminal login matches the BrokerConnection account id.
6. The onboarding page polls owner-facing connector health and shows pairing/connected/execution-ready state.
7. DEMO validation and automation gates remain separate; pairing alone never enables LIVE authority.

## Connection methods
- **Direct MT5 — recommended:** no MetaApi subscription; outbound HTTPS connector; no broker password reaches iRexPro.
- **MT5 via MetaApi — optional hosted path:** retained separately for users/operators who want cloud-hosted connectivity.
- **cTrader:** existing OAuth flow remains unchanged.

## Security and authority
- Pair code is single-use and expires.
- Pairing is allowed only for the authenticated user's MT5 BrokerConnection.
- Terminal login must match the BrokerConnection account id before the connector becomes ACTIVE.
- Broker server is learned from MT5 and fenced after pairing; a terminal switch suspends execution.
- Fresh heartbeat and `trade_allowed=true` are required for execution readiness.
- Pairing never bypasses connect/DEMO-validation/risk/allocation/session authority, and never grants LIVE.

## UX states
`NOT_CREATED -> PAIRING -> CONNECTED_NOT_READY -> READY`, plus explicit `STALE`, `TRADING_DISABLED`, `SUSPENDED`, `REVOKED`, and `ERROR` states. The UI shows the 10-character pairing code and expiry, setup instructions, and a refresh/polling status. Credentials/password fields are hidden for the Direct MT5 method.

## Non-goals
- No production MetaTrader transport cutover in this onboarding change.
- No LIVE activation.
- No storage or relay of MT5 passwords.
- No removal of MetaApi or cTrader paths.

## Approaches considered
1. Reuse the generic API-key form. Rejected: wrong mental model and would encourage users to paste secrets that Direct MT5 does not need.
2. Create pairing requests with no BrokerConnection and create the account only after redemption. Rejected for now: requires schema/ownership changes and weakens the existing BrokerConnection authority boundary.
3. **Chosen:** create an owned DEMO BrokerConnection first using the MT5 account number, then pair the local terminal to that exact record. This is the smallest secure path and makes account mismatch fail closed.
