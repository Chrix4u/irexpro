# iRexPro — causal M1 directional horizon replay (owner Pepperstone USD DEMO)
**Research as-of:** 2026-11-17 11:32 UTC (Ghana). **Not a production-trading rule.**

## Purpose
Owner wants iRexPro to make better directional predictions, remember profit-to-loss reversals, distinguish false reversals from genuine continuation, and assess 1/3/5/10-minute forecasts instead of only optimizing lots or blocking entries. Replay is read-only and independent of broker order execution.

## Verified dataset and selection
- Database: exact owner and connected Pepperstone cTrader **USD DEMO** broker connection, broker-native M1 bid/ask rows for the four approved executable pairs (EURUSD, AUDUSD, USDCAD, USDJPY).
- Previous 24h **11,365 raw M1 decisions** condensed to **958 pair+side+route 20-minute episode keys**. This is a deduplication mechanism **not** 958 independent market conditions: opposite directions, routes, correlations and common USD exposures may overlap. 1-minute endpoint available for 947 of those keys.
- Only **24 outcome-labeled episode keys** were linked to decisions whose broker dispatch state was `EXECUTION_SUCCEEDED`; two broker-authorized but risk-rejected episodes are now classified separately. These are episodes, not all broker fills.
- Strict post-decision label: first complete broker M1 bar closing **at or within 60 seconds *after*** the 1/3/5/10-minute horizon, with quote sample during the latter 30 seconds of that bar, bid/ask present, native source, at least two samples, quote no later than analysis as-of. No future label is given to the entry decision, and incomplete/unpriced marks are skipped.
- Baseline: original decision-time candidate entry and original stop distance, scored in `R = signed potential move / initial stop-price distance`, hypothetically closing BUY at subsequent broker bid and SELL at broker ask. This is NOT a confirmed entry fill or realized alternative P&L.
- Fee proxy: historical **90th-percentile fee/R** from at least five already fully settled broker trades closing before each evaluated decision, using actual signed commission and swap. Missing fee history means estimated net is NULL rather than a fictional zero.
- Price staleness sensitivity: candidate entry versus same-minute final broker mid-price had **median absolute discrepancy ~0.12R**, 90th percentile **~0.35R** across ~11,434 M1 rows in a supporting diagnostic. The later mark is not necessarily what was available at decision time. Therefore the replay's accuracy is **preliminary** and true broker-executable backtesting requires a fully aligned tick/entry series.

## Overall outcome labels (not necessarily executable)
| Horizon | Valid episode keys | Directionally favorable share | Mean estimated after-fee R on fee-covered keys |
|---|---:|---:|---:|
| 1 minute | 947 | 44.0% | -0.180R |
| 3 minutes | 949 | 46.6% | -0.173R |
| 5 minutes | 947 | 47.9% | -0.171R |
| 10 minutes | 943 | 48.8% | -0.175R |

The negative estimated net-R indicates that a generic immediate signal on all scanned candidates has no demonstrated reliable cost-adjusted edge in this 24h replay. Most of these scans **were correctly denied execution**.

## Decisions with actual successful broker dispatch
| Horizon | Episode keys | Directionally favorable share | Mean estimated after-fee R | After-fee proxy positive share |
|---|---:|---:|---:|---:|
| 1 minute | 24 | 29.2% | -0.220R | 12.5% |
| 3 minutes | 24 | 70.8% | -0.057R | 50.0% |
| 5 minutes | 24 | 66.7% | -0.012R | 41.7% |
| 10 minutes | 24 | 54.2% | -0.149R | 37.5% |

The 3–5-minute candidate horizon is a research hypothesis, **not** a demonstrated profitable execution rule. A majority of favorable gross price labels can coexist with negative after-fee mean due to movement amplitude and costs, and 24 episodes are not independent out-of-sample validation.

## One-minute confirmation vs immediate entry (research only)
Among 24 executed-decision episode keys with evaluable 5-minute marks, **7** crossed above their original spread-inclusive entry in the predicted direction in the first fully closed M1 minute.
On **those same seven** at the five-minute horizon:
- Retain original immediate decision entry: **estimated +0.350R after historical fees**, broker-exit mark only.
- Delay entry until first M1 close, at its observed ask for BUY or bid for SELL: **estimated +0.137R after historical fees**.
- 17 without first-minute confirmation averaged **estimated -0.161R** using original immediate entry.

This is strongly selection-conditioned: the "confirmed" group is defined by an already profitable first-minute move, and only seven executed episodes met it. It does **not** establish that selecting those seven in real time, entering after an observed quote, or closing after five minutes can replicate these results. Repeated first-minute adverse moves are evidence for *prospective* early-thesis failure research, not permission to invert all orders.

Across all scanned Confirmed Reversal episode keys, first-minute confirmation was observed in 120 of 280, but waiting to enter on those previously favorable moves typically sacrificed much of the observed initial move. A mandatory one-minute wait would be premature.

## What may and may not change
1. Continue existing pattern-memory logging on the owner DEMO as shadow only; preserve historical entry features, exact timestamps, fees and subsequent true outcomes.
2. Research time-horizon-specific side forecasts and movement magnitude after costs; compare short 3–5 minute hypotheses against M1/M5/H1 regime and false-reversal/continuation cases.
3. Evaluate model hypotheses chronologically, by independent market episodes and instrument/side/route, on later untouched data. A "BUY was wrong" record alone must not turn into "SELL is right".
4. **No change** to entry authority, broker SL/TP, performance-fee calculations, position lots, LIVE routing, or daily trade quotas was made in this replay.
5. Investigate broker-executable entry-price alignment, signal timing and spread costs before treating any proxy-R study as live profitability evidence.

## Reproducibility
```sh
cd apps/api
node --test scripts/research-owner-demo-direction-horizons.test.cjs
node scripts/research-owner-demo-direction-horizons.cjs --out=/tmp/irexpro-direction-replay.json
```

Eight tests passed on 17 November 2026, including as-of data, no future price used in a decision, first completed horizon bar at/after target, native bid/ask, fee sample requirements, correlated episode de-duplication, delayed one-minute entry, and separation of actual broker fills from rejected authorizations. No live API/website restart required because this is a read-only research script.

**Research commits:** `f5c2d1be`, `35940629`, `9bdd8a18`, `a4007523`, `75dc231c`, plus related delayed-entry work in the same branch.
