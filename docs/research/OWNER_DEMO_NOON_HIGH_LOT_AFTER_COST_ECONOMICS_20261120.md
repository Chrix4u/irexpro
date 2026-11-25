# Pepperstone USD DEMO — high-lot trial: after-cost economics (20 Nov 2026)

## Why this audit was extended

A high win count alone concealed the actual payoff imbalance in the owner's short-lived 4+ lot trial. The existing strictly owner/connection/artifact-scoped, READ ONLY reporter `apps/api/scripts/audit-owner-pepperstone-demo-noon-lot-trial.cjs` now includes `economics` overall and per strategy, instrument, filled-lot bucket, and strategy/instrument combination. The data source remains **actual broker fills/settlements**, including signed booked commission and swap. Open, unfilled or unreconciled records never contribute fabricated P&L.

## Initial validated 10:58 UTC result

38 settled positions, 25 net wins, 13 net losses, and 2 still-open positions (40 total filled intents at 10:58 UTC). Actual broker-booked realized P&L **+$922.42**, signed commission **-$933.18**, swap **$0.00**, settled after-fee **-$10.76**. Winning settlements aggregate +$1,819.26 and losing settlements aggregate -$1,830.02 (already AFTER fees). Mean net win **+$72.77**, mean net loss **-$140.77**, win rate **65.79%**, after-fee profit factor **0.9941**, descriptive break-even win rate at *observed* payoff sizes **65.92%**. The latter is not an ex ante forecast or an order gate.

**Lot buckets refer to ACTUAL broker-filled quantity, not requested lots:**

| Filled lot group | Settled | Net wins/losses | Settled USD net | Profit factor |
|---|---:|---:|---:|---:|
| Below 4 | 22 | 14 / 8 | -$63.54 | 0.9339 |
| 4 or above | 16 | 11 / 5 | +$52.78 | 1.0608 |

The apparent advantage of the >=4-lot bucket is not causal evidence that larger lots improve entry accuracy; entries, pairs, regimes and loss magnitudes differ. Most important route/pair contributions at this snapshot: Confirmed Reversal USDJPY +$327.12, EURUSD +$228.48, USDCAD -$235.00, AUDUSD -$91.39; Early Transition AUDUSD -$268.05, USDJPY +$28.08 (single trade). There are too few independent market days to convert these observations into new trading gates.

## New fields and interpretation

- `economics`: settled count, win/loss/flat, win rate, aggregate net wins/losses, total net, realized broker P&L before fees, signed commission and swap, mean win/loss, profit factor, descriptive break-even win rate, settled lot sum and USD per settled lot.
- `byLotBucket`: only filled and settled broker trades, grouped by actual filled lots `ACTUAL_BELOW_FOUR` and `ACTUAL_FOUR_PLUS`.
- `riskCoveredSettlements`, `riskMissingSettlements`, `recordedInitialStopRiskUsd`, `meanRealizedNetR`, `pooledNetPerRecordedInitialStopRisk`: after-cost outcome normalized against strictly pre-fill recorded allocation stop-risk. The allocation source is now restricted to `capital_allocations.created_at <= trade.opened_at` instead of a later `now()` limit; a missing or nonpositive initial stop-risk remains UNKNOWN, never imputed. These are distinct descriptive R measurements, not return on account equity.
- `byStrategyInstrument`: signed-net economics for each actual execution strategy+instrument; `byStrategy` and `byInstrument` also retain previous counts with a nested `economics` object.
- Undefined profit factor and break-even when there is no appropriate losing and/or winning payoff are returned as `null`, not Infinity, fabricated returns or 100% promises.

## Verification and unchanged execution policy

Run `node --test apps/api/scripts/audit-owner-pepperstone-demo-noon-lot-trial.test.cjs` from the repository root; run `node apps/api/scripts/audit-owner-pepperstone-demo-noon-lot-trial.cjs` for a fresh read-only report. Eight focused unit tests cover signed fees, exclusion of open/pending positions, actual versus requested fills, lot bucket partition, missing ex-ante risk, unknown expectancy, precise account scope and the 12:00 UTC expiry boundary.

This update only improves **reporting**, not trading or risk policy. Existing trial permission and exact 12:00 UTC expiry remain intact. No API restart, model promotion, instrument suspension, broker stop amendment, lot cap increase or LIVE account permission. These results must be reviewed with the progressive profit-retention after-update cohorts, later sampled original TP/SL target paths and future independent trading days before an executable decision. The sampled future TP touch is never treated as an actual broker fill.

## Updated as-of 11:30:41 UTC (still before noon trial cutoff)

43 broker-filled trial intents, 42 settled, 1 open; settled net **-$62.35** from realized gross $974.87, booked commissions -$1,037.22, swap $0.00; 27 winners and 15 losers. All 42 settled trades have valid allocation stop-risk records recorded no later than the broker open. Mean realized net R **-0.0233R** and pooled net/recorded initial-stop-risk **-0.0087**. Actual fills below 4 lots: 24 settlements, -$274.17, mean **-0.1013R**. Fills 4 or more lots: 18 settlements, +$211.82, mean **+0.0807R**. Neither observational contrast is an instruction to increase lot size. The remaining open trade is excluded from settled economics.

The persistent half-hourly read-only monitor had started before the initial audit enhancement was committed; its Node `require()` cache retained the older report module and refreshed the `latest-report.json` without new `economics` fields. Restart ONLY `irexpro-owner-demo-drawdown-guard-postexit-shadow` once after updating this audit, not the trading API, in order to load the currently committed reporting module. Verify its status, report fields, no execution rights and stable uptime afterward. Never use this watcher to place orders, change risk, amend broker stops or alter the noon expiry.
