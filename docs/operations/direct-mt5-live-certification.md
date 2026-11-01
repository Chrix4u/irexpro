# Direct MT5 production-LIVE certification

Direct MT5 is a MetaAPI-free route: the iRexPro Windows connector attaches to an already logged-in MetaTrader 5 terminal and communicates outbound to the iRexPro API. The terminal itself is the authority for account environment (`DEMO` vs MetaQuotes `REAL`, represented by iRexPro as `LIVE`).

## Important state

The adapter and connector support both DEMO and LIVE technically. The catalog remains `productionLiveVerification=UNVERIFIED`. Ordinary LIVE onboarding/exposure remains fail-closed until a real certification canary has passed and a durable evidence artifact has been attested in the catalog/provider matrix. Never change the catalog to VERIFIED from unit tests, paper evidence or a DEMO run.

## Preconditions

1. Use a dedicated, low-balance MT5 LIVE account at the target broker.
2. Install the current protocol-v2 Windows connector on the same Windows host as the logged-in MT5 terminal.
3. Create the operator certification BrokerConnection for broker id `direct-mt5`, environment `LIVE`, with `account_id` equal to the MT5 login, and pair the terminal to it. This bootstrap is an operator-only certification fixture; ordinary user LIVE creation remains catalog-gated.
4. Confirm the connector heartbeat is fresh and reports `accountType=LIVE`, `tradeAllowed=true`.
5. Choose the smallest explicit `DIRECT_MT5_LIVE_CERT_MAX_CANARY_EXPOSURE` that still permits the broker's minimum lot.

## Run

```bash
IREXPRO_ALLOW_LIVE_CERTIFICATION=true \
IREXPRO_LIVE_CERT_OPERATOR_ID=<operator-id> \
DIRECT_MT5_LIVE_CERT_CONNECTION_ID=<paired-live-broker-connection-uuid> \
DIRECT_MT5_LIVE_CERT_ACCOUNT_LOGIN=<mt5-login> \
DIRECT_MT5_LIVE_CERT_MAX_CANARY_EXPOSURE=<positive-decimal-quote-currency-cap> \
DIRECT_MT5_LIVE_CERT_INSTRUMENT=EURUSD \
IREXPRO_LIVE_CERT_EVIDENCE_DIR=<durable-evidence-dir> \
pnpm --filter @irexpro/api exec jest --runInBand \
  src/modules/broker/verification/direct-mt5.live-certification.spec.ts
```

The harness connects in LIVE mode, validates account state and symbol metadata, captures baseline exposure, calculates margin, places only the provider-minimum canary within the explicit exposure cap, verifies provider acknowledgement and position state, applies a risk-reducing protective level, closes the canary, reconciles history, verifies no unexpected residual exposure, and writes/read-back-verifies a sanitized evidence artifact.

## Promotion rule

Only a `certificationResult=PASS` with `evidenceState=PERSISTED` and a verified SHA-256 artifact is eligible for operator attestation. Record the artifact reference and timestamp in `BROKER_CATALOG` and the provider matrix in a separately reviewed change. Until that explicit change is deployed, Direct MT5 LIVE remains unavailable to ordinary users even though the code path is technically complete.
