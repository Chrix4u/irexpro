# iRexPro — Early M5 quote-context training and outcome maturation

**Date:** 17 November 2026 UTC
**Scope:** owner-only Pepperstone cTrader USD DEMO, EURUSD/AUDUSD/USDJPY/USDCAD.
**Execution authority:** NONE. A research data pipeline, NOT a new active trading expert.

## Starting point

The deployed "as-of" M5 context collector (research commit \`3cd5f33a\`) already recorded the previous five-minute candle as sampled positive bid/ask observations by **15 seconds into the next five-minute period**, and demonstrated that native M5 candle rows were often created **123 seconds median after the previous candle closed** (572 retrospective M5 examples). Reconstructing current database M1 values after the fact is not a credible as-of substitute because M1 rows can be revised later.

The 18:48 UTC **three-hour read-only quote-quality diagnostic** (35 five-minute periods per pair) found the following number of slots where both a complete prior sampled-quote M5 and fresh +15-second live quote were available:

| Instrument | Historical replay quality slots / 35 |
| --- | ---: |
| EURUSD | **5 / 35** |
| AUDUSD | **30 / 35** |
| USDJPY | **32 / 35** |
| USDCAD | **30 / 35** |

These are historical timestamp-quality assessments, **not prospective forecasts or trades**. EURUSD had 11 missing whole positive-quote minutes, 17 late-first-quote minutes, one stale final-minute quote, and 19 periods with fewer than two fresh positive-spread current-window observations. Do not solve these failures by treating zero or crossed spreads as executable quotes or by lowering trading risk vetoes.

## Upgraded immutable +15s snapshot (v2)

\`apps/api/scripts/collect-owner-demo-m5-asof-context.cjs\` was advanced to \`irexpro-prospective-asof-quoted-m5-context-v2\`, preserving all v1 records.

At each exact +15s five-minute slot, the collector now requires:

- Verified, observed-before-cutoff native positive bid/ask path covering each of the **five completed preceding M1 minute segments** with fresh sampled quotes. These yield sampled **prior M5 OHLC**.
- At least two valid **current M5 quotes in its first 15 seconds**, including a fresh bid, ask, midpoint, observed spread, and midpoint change versus the previous M5 close.
- Original broker-source and local-observation timestamps of the current quote not after the decision cutoff; no source backdating, missing-minute patching, future finished M5 candles or M5 database query.

Snapshots are append-only to \`/home/lightworld/webapps/irexpro-research/m5-context-asof/YYYY-MM-DD.jsonl\` with mode 0600, 90-day rotation, deduplicated by decision period and instrument, and a daily size cap. The capture process cannot trade.

**Verified initial prospective v2 event:** 17 November 2026 **18:50:15 UTC**, two accepted samples (AUDUSD/USDJPY); their later M5 outcomes were not yet mature at 18:50:52 UTC, so both were correctly marked PENDING. EURUSD and USDCAD did not pass the expanded quality requirements at that particular slot. Earlier v1 records remain intact and are **excluded from the v2 model dataset**, never retroactively enriched with later quotes.

## Read-only outcome maturity and training readiness

- Pure validator: \`apps/api/scripts/research-owner-demo-m5-quote-context-readiness.cjs\`
- Database runner: \`apps/api/scripts/run-owner-demo-m5-quote-context-readiness.cjs\`
- PM2: \`apps/api/scripts/irexpro-m5-quote-readiness-shadow.pm2.config.cjs\`
- Private report: \`/home/lightworld/webapps/irexpro-research/m5-context-readiness/latest.json\`

The audit uses exact-owner DEMO broker connection, \`BEGIN READ ONLY\`, strictly verified immutable prospective **v2 context** as INPUT, and only later native M5 OHLC as a research **LABEL**. Native outcome is excluded until the M5 closes and **15 additional minutes** have passed. Incorrect/missing/still-pending native records are not scored as an inaccurate forecast.

Direction labels RED/COST_SMALL/GREEN use a threshold determined entirely at observation time: the greater of the contemporaneous broker bid/ask spread and 5% of the preceding sampled M5 range. The actual future M5 candle is used only to assign the later label. Two cheap as-of non-ML baselines are recorded: **previous sampled M5 body direction**, and **current live midpoint movement versus preceding sampled M5 close**. No sampled-candle label is interpreted as realized net trading profit.

The report counts unique market-time buckets and UTC days; it does not count multiple currency-pair observations at the same time as separate independent market conditions. A preliminary *dataset sufficient for further research training* status can only be reached after at least **20 distinct UTC days, 1,000 distinct five-minute market-time slots, and 200 matured records per instrument** within the recent archive window. Passing these sample-count gates **never** authorizes model promotion, LIVE/DEMO execution or profitability claims.

## Security and execution boundary

Research-only collection and maturation uses no order-placing code, no broker position mutation, no risk-gate bypass and no account credentials exported into the dataset. Do not connect the quote-derived features to the existing **native M5-trained** expert until a separate representation-specific model has been trained and passed chronological, after-cost shadow evaluation across sufficiently varied sessions.

As of this release, **no quote-based M5 expert is trained or activated**. The trading API, Plan B v4, lot controls and broker profit protection are unchanged.

## Validation and operations

\`\`\`sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/collect-owner-demo-m5-asof-context.test.cjs
node --test scripts/research-owner-demo-m5-quote-context-readiness.test.cjs
node --test scripts/run-owner-demo-m5-quote-context-readiness.test.cjs
node scripts/run-owner-demo-m5-quote-context-readiness.cjs
pm2 describe irexpro-m5-asof-context-shadow
pm2 describe irexpro-m5-quote-readiness-shadow
\`\`\`

The v2 collector is already running; the separate readiness watcher refreshes the private report at approximately 14-minute intervals. This does **not** send any alerts or orders. Tests also run as part of \`.github/workflows/research-candle-formation-expert.yml\`.

**Future model work:** accumulate independent real v2 sessions; measure EURUSD positive quote coverage separately; train a distinct as-of quoted-M5 model when qualified; evaluate proper chronological holdouts, calibrated class scores, true spread/roundtrip signed commission, stop-loss and broker fill behavior. Promotion remains prohibited without cost-adjusted evidence.
