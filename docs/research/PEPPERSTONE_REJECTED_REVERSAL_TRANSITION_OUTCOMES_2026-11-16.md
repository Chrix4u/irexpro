# Pepperstone DEMO — Rejected reversal and early-transition candidates audit
**Date:** 16 November 2026 (Ghana/UTC)
**Status:** completed retrospective, read-only. **No trade authorizations changed.**

## Questions answered
Are the ~478 reversal and ~188 early transition observations genuine missed winning trades? Did any pass? Is the proposed opposite-direction counter trading live?

### Gate truth, live DB query at approximately 16:31 UTC
The counts increased as more M1 scans completed.

| Plan-B strategy | Decision rows | Plan-B paper-admitted | Plan-B governance eligible | Broker-native authorized |
|---|---:|---:|---:|---:|
| CONFIRMED_REVERSAL | 486 | 485 | 485 | 0 |
| EARLY_TRANSITION | 192 | 192 | 192 | 0 |

**Preliminary Plan-B admission does not mean execution authority.** The independent M1 timing specialist, broker safety, pair-side reliability and other gates remain decisive.

- 427 confirmed-reversal decisions had *only* `MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED`. In total, 477 included that blocker; 58 also involved `M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED`. None had `M1_CONFIRMED_REVERSAL`; M1 labels were 388 `ABSTAIN`, 63 `M1_EARLY_TRANSITION`, and 35 `M1_TREND_CONTINUATION`.
- 186 early-transition decisions had *only* `MULTIMODEL_EARLY_TRANSITION_NOT_M1_CONFIRMED`. Six others had `M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED`. M1 labels were 168 `ABSTAIN`, 18 `M1_TREND_CONTINUATION`, and 6 `M1_EARLY_TRANSITION`.
- All 678 were scanned decisions, **not** 678 independently executable broker trades.

### Historical replay #1: completed native M1 OHLC, 15-bar first-touch proxy
Source: existing tested `audit-planb-m1-timing-counterfactual.cjs`, with the date explicitly set to 2026-11-16, a 10,000 decision cap and no truncation. Snapshot at 16:32 UTC; matured signal window ended 16:16. This method deduplicates a given instrument/direction/route if a repeat occurs within five minutes. It subtracts estimated M1 execution cost R but should NOT be read as fully broker-commission-calibrated.

| Route | Signal episodes | Measurable | Hypothetical positive | Hypothetical negative | Unobservable | Ambiguous | Combined estimated net R |
|---|---:|---:|---:|---:|---:|---:|---:|
| CONFIRMED_REVERSAL | 306 | 288 | 134 | 154 | 17 | 1 | -16.2325 R |
| EARLY_TRANSITION | 85 | 82 | 38 | 44 | 3 | 0 | -4.8025 R |
| **Combined** | **391** | **370** | **172** | **198** | **20** | **1** | **-21.0350 R** |

These are virtual first-touch proxies from midpoint M1 OHLC, NOT actual broker entries/stops. Ambiguity is explicitly excluded; multiple episode paths can overlap. They establish only that some signals moved favorably, not that 172 live trades would have been profitable.

### Historical replay #2: broker-native bid/ask marks with added costs
New tested script: `apps/api/scripts/audit-pepperstone-alternative-route-opportunities.cjs`. Snapshot at approximately 16:38 UTC, through 16:19 UTC, so the 15-minute outcome is complete. 677 raw alternative decisions in the matured window; 5,977 M1 price rows inspected. The script rejects missing, stale, non-broker-native or invalid bid/ask quotes, and reports missing comparisons without imputing P&L.

Rule: select **the first admission-eligible signal in each 15-minute window**, chronologically rather than selecting the hindsight winner. Simulate BUY entry at ASK or SELL at BID using the NEXT M1 quote minute; exits use the broker BID/ASK at 3,5,10,15 minute fixed horizons. Deduct **$6 estimated round-trip commission per 1 standard lot** and **0.2 extra pip slippage**. The spread is already paid by using correct bid/ask sides. This method has no broker-executable fills and cannot verify earlier stop losses or take profits.

**15-minute horizon, separate strategy windows:**
- CONFIRMED_REVERSAL: 168 chronologically selected; 107 verifiable; 45 positive, 62 negative; mean **−1.39 pips** after estimated costs.
- EARLY_TRANSITION: 69 selected; 41 verifiable; 17 positive, 24 negative; mean **−1.51 pips** after estimated costs.

**Stricter position constraint:** Only one first opportunity per instrument every 15 minutes, regardless of direction/strategy: 180 selected, 109 verifiable at 15 minutes, 43 positive and 66 negative, mean **−1.46 pips** after costs. 71 selected lack complete verified evidence.

At 5-minute horizon, separate route cohorts: reversal 115 verifiable (40 positive/75 negative, mean −1.07 pips); early-transition 41 verifiable (13 positive/28 negative, mean −1.60 pips).

**Small watchlist, NOT promotional evidence:** Among one-position-per-instrument opportunities at 15 minutes, USDCAD BUY labeled Plan-B confirmed reversal had 3/5 estimated positive after costs (combined +6.02 pips), and AUDUSD SELL labeled confirmed reversal had 4/5 estimated positive (+5.70 pips). Both use M1 `ABSTAIN` and each sample is five; do not declare any repeatable trading edge, relax confirmation or authorize live orders from these subsets. These groups were inspected after outcomes, so their apparent outperformance is subject to look-ahead selection bias at the research *interpretation* stage.

### Why these are not deployable profits
- Rejected forecasts may move profitably *later* yet fail immediate stop-loss / slippage / entry-timing economics.
- Some overlapping BUY and SELL forecasts cannot be combined into one actual account.
- 15-minute fixed-hold marks do not model first-hit broker stops; the independent OHLC first-touch proxy can differ.
- Broker M1 samples are not timestamp-exact actionable trade fills.
- Both analyses cover one day, not multiple independent market regimes. Friday's reversal success came from only two actual trades.
- Only a prospective, cost-aware, separately monitored and independently validated strategy should receive eventual DEMO authority.

### Main/reversal/counter status verified
1. The **existing Plan-B `CONFIRMED_REVERSAL` and `EARLY_TRANSITION` strategies** are already part of the real demo decision/authority system. They may execute **only** when their strict confirmation, cost, capital and broker gates pass. So far today they have **zero executed positions**.
2. The user's requested *opposite-direction COUNTER* is a **separate virtual research sidecar**, labeled `COUNTER_SIM`, paired to each actual MAIN broker position. PM2 service `irexpro-counter-shadow` was online at 16:30 UTC. The report explicitly sets `executionAuthority:'NONE'`, `isBrokerOrder:false`, `modifiesTrading:false`. **It has never been authorized to submit actual reverse broker orders**; no real-money account was affected.
3. The new Pepperstone DEMO trend-continuation pause remains enabled as of 16:15 UTC; API healthy; no new entry permissions were granted by this research.

### Next engineering focus
Review decision-time M1 reversal confirmation mismatch and the six early-transition reliability-degraded cases using independent features; design a prospective shadow-only label refinement with no broker exposure. Preserve prospective observations and independent out-of-sample evaluation. Do not allow any `ABSTAIN` signal to become executable merely because a subsequent price mark was positive.

### Reproducibility
`cd apps/api && node --test scripts/audit-pepperstone-alternative-route-opportunities.test.cjs`
`cd apps/api && node scripts/audit-pepperstone-alternative-route-opportunities.cjs`

Private raw replay report:
`/home/lightworld/webapps/irexpro-research/alternative-route-opportunities/latest-report.json`
