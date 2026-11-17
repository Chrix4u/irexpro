# iRexPro — prospective forming-candle predictions (M1/M5)

**Date:** 17 November 2026. **Scope:** only configured owner Pepperstone cTrader USD DEMO research. **No execution authority.**

## Purpose

A retrospective trained model that was evaluated on the same two UTC trading dates did not demonstrate a reliable after-commission edge. A more trustworthy test is to **record the model forecast before the next candle is known**, then assess unique, later matured outcomes by pair, fixed stage, and session.

The earlier as-of quote collector is already deployed as `irexpro-forming-candle-shadow`. The new `irexpro-forming-candle-forward-shadow` service reads the private, immutable archived **15s/45s M1** and **15s/285s M5** partial-candle records, retrieves ONLY completed preceding broker-native M1/M5 bars in a **BEGIN READ ONLY** database transaction, runs the privately stored `RESEARCH_ONLY` Python classifier and regression heads, and appends predictions with their original timestamps to a separate 0600 JSONL archive.

## Causality, forecasting, and scope safeguards

- The timestamped decision slot is selected before forecasting. Same-slot data is read from the existing positive broker-quote archive; no partial bar is reconstructed using a finalized current bar.
- Recreate the training features using only completed preceding OHLC bars, strictly earlier than `barStart`. No current/following candle OHLC enters inference.
- Reject stale broker observations, missing prior bars, malformed spread, ambiguous same-stage duplicates, model artifact mismatch, outdated inference beyond the allowed 12-second decision window, and any forecast for a timestamp within the original training report period.
- The scorer is a local private Python worker with cached research models and no broker credentials in its model input. The JS worker verifies the configured owner DEMO account, queries the broker-native preceding bars read-only, and rejects any nonresearch response.
- Append unique `(decisionAt,barStart,instrument,timeframe)` results to `/home/lightworld/webapps/irexpro-research/forming-candle-predictions/YYYY-MM-DD.jsonl`. The day file is bounded to 24MiB. No account credentials or broker/user IDs are stored.
- Forecasts are **three classes** (RED/FLAT/GREEN), with uncalibrated raw class scores and predicted next-bar body/range normalized by preceding ATR. They are neither BUY/SELL instructions nor actual realized P&L, and `nextCandleOutcomeKnown=false` until an independent later outcome audit.
- No stop, position, lot size, broker execution setting, risk gate, risk budget, profit protection, DEMO/LIVE trading authority, or active AI model is modified.

## Activation and rollback

```sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/owner-demo-forming-candle-forward-shadow.test.cjs
cd ../../services/ai-engine
.venv/bin/python -m unittest discover -s tests -p test_research_forming_candle_forward_score.py -v
cd ../../apps/api
pm2 start scripts/irexpro-forming-candle-forward-shadow.pm2.config.cjs
pm2 describe irexpro-forming-candle-forward-shadow
pm2 save
```

To stop research collection only: `pm2 stop irexpro-forming-candle-forward-shadow`. This does not affect the native quote collector, forming-candle snapshot archive, trading API or broker.

## Promotion boundary

The earlier fixed-stage M5 pilot had small independent samples (132 early and 138 late candle episodes), and M1 was below its baseline. No favorable retrospective M5 percentage qualifies an expert to trade. The new **prospective** archive must accumulate independent later sessions and be evaluated against actual completed next-candle labels, simple prior-candle and training-majority baselines, costs, quote gaps and drawdowns. Only a demonstrated after-cost, chronologically out-of-sample improvement may justify a **shadow-only advisory** evaluation; no automatic order promotion.

**Test provenance:** Python feature-parity/no-future-leakage suite and JS read-only/deduplication suite. GitHub Actions workflow `research-candle-formation-expert.yml` runs both suites.


## Persistence incident and remediation

The first prospective recorder saved three real predictions before a missing temporary training report caused its Python scorer to restart repeatedly. The trained M1 and M5 research model files survived. They now live in a permanent protected directory: /home/lightworld/webapps/irexpro-research/forming-candle-models/v1/ (directory 0700, model artifacts 0600).

The original ephemeral evaluation report was NOT recovered and no accuracy figures have been reconstructed. Instead, frozen-model-manifest.json is an explicitly labeled FROZEN_RESEARCH_MODEL_ARTIFACT_RECOVERY_V1 manifest; its conservative asOf cutoff comes from the latest verified original model file modification timestamp, plus a two-second safety margin. SHA-256 digests bind the manifest to the exact frozen research models. The scorer rejects modified research bytes, weak filesystem permissions, missing or unsafe manifest, in-sample timestamps and nonresearch artifacts.

At 17:16:45 UTC, the recovered service wrote four fresh prospective forecasts and reported PROSPECTIVE_FORMING_SCORER_READY. A negative unit test confirms model tampering is rejected. No trade orders, stops, lot sizes or profit protection changed.

Operational verification: pm2 describe irexpro-forming-candle-forward-shadow; inspect /root/.pm2/logs/irexpro-forming-candle-forward-shadow-out-466.log and count unique keys in /home/lightworld/webapps/irexpro-research/forming-candle-predictions/YYYY-MM-DD.jsonl.


## Prospective next-candle outcome audit (read-only)

The validator scripts/audit-owner-demo-prospective-candle-outcomes.cjs joins only previously saved forecasts to a **later completed** broker-native candle in the same four USD DEMO instruments. For M1 the outcome requires positive native quote sample coverage; M5 uses native trend OHLC only, not invented bid/ask. A label is RED, FLAT or GREEN using the *original, earlier* spread and ATR cost allowance. No current/future OHLC enters the prediction process. Outcomes are not considered mature until at least 30 seconds after the entire following M1/M5 bar closes.

The audit groups by fixed forecast stage and instrument. It never adds correlated early and late snapshots of the same candle as independent trades, and records missing outcomes and pending candles separately. Its directional price measure is only a **spread-only, nonexecuted price proxy** with unmodeled commission, financing and slippage. It cannot certify trading profitability or enable a model.

The background daemon irexpro-forming-candle-outcome-audit runs every five minutes and refreshes /home/lightworld/webapps/irexpro-research/forming-candle-predictions/latest-outcome-audit.json (0600) using BEGIN READ ONLY PostgreSQL queries. The interval is configured locally under apps/api/scripts/irexpro-forming-candle-outcome-audit.pm2.config.cjs and never calls a broker order method.

Initial real forward audit at 17:20:55 UTC: 36 recorded prospective forecasts, 22 matured M1 outcomes, 14 still pending, no missing native outcome. Ten of the 22 matured M1 three-class forecasts matched (45.45%), too few to claim edge; no M5 matured outcomes in the first snapshot.

Start only this service after syntax and nine research unit tests pass:

    cd /home/lightworld/webapps/irexpro-staging/apps/api
    node --test scripts/audit-owner-demo-prospective-candle-outcomes.test.cjs
    node scripts/audit-owner-demo-prospective-candle-outcomes.cjs
    pm2 start scripts/irexpro-forming-candle-outcome-audit.pm2.config.cjs
    pm2 save

Rollback only this service: pm2 stop irexpro-forming-candle-outcome-audit. Trading services must remain unchanged.
