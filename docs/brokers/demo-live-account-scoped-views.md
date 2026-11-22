# DEMO/LIVE account-specific reporting — November 22, 2026

This change is read-only. It does not change AI trade execution, broker authorization, deposit status, or cTrader LIVE certification.

## User behavior
- iRexPro Positions & Activity now offers an explicit account selector when the user has multiple broker connections.
- The overview financial balance/equity is read only from the selected connection.
- The positions and orders endpoints accept an optional connectionId filter. Both queries ALWAYS intersect it with the authenticated user ID; cross-tenant connection IDs cannot fetch another user's trades.
- Browser runtime guards reject any position or order whose brokerConnectionId does not match the chosen account, rather than presenting mixed DEMO/LIVE activity.
- The AI status is reported as "ACTIVE ON ANOTHER ACCOUNT" when another account holds the active trading session. Linking or selecting a LIVE account does not authorize LIVE trading.
- The audit activity timeline and aggregate execution-health counters intentionally remain all-account views and are labeled accordingly.
- Rapid account switches invalidate stale request responses to avoid showing obsolete financial data.
- A malformed connectionId filter returns a clear 400 error.

## Compatibility and limitations
- GET /live-account/positions and GET /live-account/orders retain their original all-account behavior when no connectionId filter is provided (existing callers unaffected).
- The activity/audit timeline remains user-wide, not account scoped. Do not mislabel audit events as belonging to a selected broker connection.
- This is a VIEW selector, not a trading execution-target switch. The AI's authorized connection is controlled independently by its server-side session state.
- User-owned DEMO and LIVE connections are linked through separate broker authorization grants. An MT5-only Pepperstone account cannot use the cTrader OAuth route.
- LIVE orders remain blocked by provider-specific certification and explicit authorization gates. No LIVE orders, migrations, or funding actions are performed by this patch.

## Verification
- API live-account tests: 111 passed; web live-account data guard tests: 17 passed on the isolated branch.
- API and web TypeScript checks passed.
- GitHub CI and staging UAT required before production promotion.
