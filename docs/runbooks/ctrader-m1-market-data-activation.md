# cTrader M1 market-data activation

## Purpose

Use a linked cTrader DEMO account as the broker-native market-data source for the governed M1 tactical PAPER sleeve while keeping execution, evidence ownership, capital allocation, and trade lifecycle bound to the existing PAPER connection.

This path does **not** grant cTrader LIVE authority and does not change the production-LIVE certification gate.

## Provider approval gate

The cTrader Open API application can have valid client credentials while Spotware still rejects application authorization because the app is not active. While the provider portal is pending/blocked, configure:

```env
CTRADER_APP_APPROVAL_STATUS=pending
```

The broker registry then exposes `PROVIDER_APP_APPROVAL_REQUIRED` instead of presenting cTrader OAuth as operationally ready.

Change the value to `active` only after the Spotware Open API portal visibly reports the application active and an application-authentication probe succeeds.

## Activation sequence

1. Confirm `CTRADER_CLIENT_ID`, `CTRADER_CLIENT_SECRET`, and the registered HTTPS web callback are configured.
2. Confirm `CTRADER_APP_APPROVAL_STATUS=active` only after provider approval.
3. Complete cTrader OAuth and link a **DEMO** cTrader account.
4. Run the existing cTrader DEMO validation/harness and require it to pass before using that account as an M1 source.
5. Keep the normal PAPER binding unchanged:

```env
VPS_FOREX_SCANNER_ENABLED=true
VPS_FOREX_SCANNER_USER_ID=<irexpro-user-uuid>
VPS_FOREX_SCANNER_BROKER_CONNECTION_ID=<paper-connection-uuid>
```

6. Bind the read-only cTrader source and enable collection:

```env
M1_TACTICAL_MARKET_DATA_CONNECTION_ID=<ctrader-demo-connection-uuid>
M1_TACTICAL_CTRADER_COLLECTION_ENABLED=true
M1_TACTICAL_CTRADER_COLLECTION_INTERVAL_MS=15000
M1_TACTICAL_CTRADER_INSTRUMENTS=EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF
```

7. Restart the API through the normal release/deployment workflow.
8. Verify all six pairs receive fresh live bid/ask samples and broker-native history.
9. Verify M1 tactical decisions continue to record the PAPER broker connection as their execution/evidence binding while market-data reads use the cTrader source connection.
10. Do not promote any cTrader LIVE path from this work. Production LIVE remains separately fail-closed behind provider certification and existing execution safeguards.

## Data semantics

- cTrader historical M1 bars warm M1/M5/M15 features.
- H1 and H4 history are fetched directly so the tactical model can warm promptly without waiting days for sampled M1 bars.
- Historical trendbars never invent bid, ask, or spread values. Historical rows are stored with spread fields null.
- Execution-spread evidence is built only from fresh broker-native cTrader bid/ask observations.
- The collector is disabled by default and requires an exact user + source connection binding.
- A non-cTrader or non-CONNECTED source fails closed.

## Request-rate discipline

The collector intentionally limits each 15-second cycle to three M1 historical reads plus one H1/H4 historical read. Live quote reads are separate. This keeps the historical burst below cTrader Open API's documented historical request limit while rotating through all six pairs.

## Rollback

Set:

```env
M1_TACTICAL_CTRADER_COLLECTION_ENABLED=false
M1_TACTICAL_MARKET_DATA_CONNECTION_ID=
```

and redeploy/restart normally. The M1 sleeve then falls back to its existing execution-connection market-data binding and remains governed by the same fail-closed snapshot/spread checks.
