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
