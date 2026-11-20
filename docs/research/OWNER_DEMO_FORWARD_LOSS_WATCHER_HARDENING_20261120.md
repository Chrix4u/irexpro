# iRexPro forward loss-pattern study — watchdog and route-specific after-cost evidence

**Owner Pepperstone cTrader USD DEMO only — 20 November 2026, Ghana time. RESEARCH-ONLY.**

## Problem verified

At about 13:34 UTC, PM2 reported the loss-pattern forward watcher as ONLINE, but its most recent written entry/outcome summary was dated **13:01 UTC**; recently opened positions had not been enrolled. The underlying PostgreSQL service independently responded to a read-only test query in 191 ms. The exact cause of the stalled process was not proven, but restarting **only the research watcher** restored report updates by 13:35 UTC. Do not misrepresent the gap as proof of a trading API failure. The trading API remained online and returned HTTP 200.

This service has a strict entry-time enrollment deadline: original decision and actual OPEN status must be verifiably observed within 90 seconds of opening. Six entries had been marked MISSED by the resumed 13:36 report. **These missed positions must not be reconstructed and falsely passed off as prospective captured entries.** Reporting should expose the coverage shortfall.

## Code changes

Source: apps/api/scripts/watch-owner-demo-loss-pattern-shadow.cjs. Added a watchdog that starts **before the initial polling tick**, detects a research step which remains busy longer than **90 seconds**, and exits just this watcher so PM2 can restart it; 8-second PostgreSQL connection timeout, 15-second query client timeout and restart after three sequential read-only research failures. No change to any broker API, M1 signal evaluation, sizing, margin, risk profile or LIVE trading.

The research dashboard now includes:
- All saved original entry-time warning groups and exact unchanged frozen history.
- Per-strategy and per-instrument broker-net profit/loss, including win rate, after-fee profit factor, and indicative normalization by pre-fill allocated risk. The pre-fill denominator may fall back to recorded allocation riskAmount rather than broker-executable stop-risk, so treat R-like figures cautiously.
- Per-strategy and pre-registered-warning subgroups with hypothetical losers avoided **AND winning trades wrongly discarded**, using only entries actually enrolled on time. Each warning is research-only and cannot veto execution.
- Breakdown by recorded close reason (profit protection / AI close / broker close), explicitly descriptive rather than broker execution reason attestation.
- No retraining, no direction flips and no deployment of an entry blockade.

## Baseline forward enrollment as of 13:36 UTC (research watcher scope)

152 valid entry-time frozen events were subsequently matched to 152 signed broker-net settlements, on **two distinct entry dates**. An additional six missed entry windows are marked and excluded; therefore these data are not a census of the entire day's demo orders. Strategy summary:

| Route | Settled | Wins | Losses | After-cost booked net |
|---|---:|---:|---:|---:|
| CONFIRMED_REVERSAL | 124 | 62 | 62 | -$1,686.14 |
| EARLY_TRANSITION | 28 | 21 | 7 | -$126.92 |
| Both | 152 | 83 | 69 | -$1,813.06 |

Pre-registered warning **CR_M5_OPPOSES**: 74 enrolled and settled, 34 wins / 40 losses, combined **-$1,561.34** net. This is a risk marker worth exploring, but a blanket blocker would exclude 34 observed winning trades. In stark contrast, **ET_M1_MOMENTUM3_OPPOSES** was observed in 8 enrolled trades, **all 8 winners, $331.00** booked net. This difference is a strong warning against a route-agnostic abstention rule.

These two forward dates alone do not establish a stable out-of-sample strategy or make user accounts qualified for LIVE. Later prospective trades must show incremental after-cost and risk-adjusted improvement, independent days, missing-data coverage and false-positive winner counts.

## Operational next checks

1. Verify that the watcher writes fresh summary files across multiple 12-second polls and survives normal market-data/DB delays; investigate any subsequent restart or missing windows without silently backfilling.
2. Evaluate each pre-registered warning by route and instrument and on new, untouched trading dates. Abstain only if a frozen rule demonstrably improves risk-adjusted after-fee performance **without excessive missed winners** and is first tested as reversible DEMO-only gating.
3. Keep the authorized ongoing 7-lot DEMO size cap, owner Start/Stop controls, broker stop-risk, drawdown and margin controls unchanged. No new LIVE trading or stop amendments.

Tests: apps/api/scripts/watch-owner-demo-loss-pattern-shadow.test.cjs, including the watchdog/timeout detection and false-positive winner accounting. Research authority zero.
