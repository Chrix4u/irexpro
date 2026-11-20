# Pepperstone DEMO alternate-entry funnel audit — 17 November 2026

Read-only inspection at approximately 00:28–00:35 UTC/Ghana, on the owner-scoped active Pepperstone cTrader USD DEMO account. No orders, risk changes, restarts, trial extensions or LIVE promotions were performed.

## Expired counter-direction pilot: 16 Nov 21:00–17 Nov 00:00 UTC

| Check | Count |
|---|---:|
| Repeated M1 decisions | 1,392 |
| Out-of-distribution blocker | 1,314 (94.4%) |
| Plan-B not admitted blocker | 1,377 |
| Plan-B governance blocked | 1,380 |
| Continuation timing not ready | 1,263 |
| M1 ABSTAIN / trend / early-transition routes | 1,191 / 120 / 81 |
| Plan-B paper-admitted observations | 15 |
| Governance paper-execution eligible | 12 |
| Trained expert final CONFIRM | 1 |
| Broker-native authorized decisions | 0 |
| New trade intents / opened trades | 0 / 0 |

These counts are repeated instrument/side/minute checks and blockers can overlap. The instruments observed were AUDUSD, EURUSD, USDCAD and USDJPY. No broker trade order was submitted, so broker execution and lot sizing were NOT the immediate source of zero trades.

## Out-of-distribution diagnostics

The persisted actual model drift diagnostics identify empirical-range violations: EMA separation HARD_LOW 775, multi-timeframe strength HARD_LOW 700, volatility HARD_LOW 635, extension/ATR HARD_HIGH 495, confidence HARD_LOW 309, and RSI HARD_HIGH 160. The frozen envelope was derived from a 4,599-event training/development corpus. Rollover-risk regime contributed 404 OOD decisions. This does not by itself distinguish real market regime change from a feature-transform or scaling mismatch; compare matched source inputs against the frozen training quantiles, and qualify any revision on held-out broker-native data. Do not simply suppress OOD flags.

## Active advisory reversal / early-transition DEMO pilot

Its separate authorized window is 16 Nov 23:36 to 17 Nov 20:00 UTC, maximum four submitted intents and up to 4.00 lots per trade only within the existing 0.25% allocation risk-at-stop, margin, fee, spread, stop and portfolio protection. TREND_CONTINUATION remains paused.

Forward inspection 23:36–approximately 00:33 UTC: 457 decisions, ZERO eligible advisory decisions, ZERO broker intents and ZERO actual fills. Reason counts: 371 not-admitted route, 40 disabled at initial rollout, 35 historical broker-identity labels (23:40–23:45 only), five independent M1 direction/stop checks, four after-fee/economic checks, two expert-direction checks. In the inspected decisions after 00:17 UTC the broker-identity label did not recur; the broker itself was confirmed CONNECTED, ACTIVE, DEMO. These are repeated evaluations, not distinct opportunities. Qualified Plan-B reversals still failed independent M1 directional/stop thresholds.

## Broker state, tests and outcomes

The API health probe returned HTTP 200 and API/web PM2 processes were online. A newer web build was present. The owner-bound DEMO FULL_AUTO session was active, and no open/pending/closing trade records were found at inspection.

The last actual position opened on 16 Nov 15:11:22 UTC: AUDUSD SELL 1.72 lots, closed net approximately -$98.04 with recorded costs. Ten completed trades from 16 Nov totalled -$313.36. No LIVE model promotion is justified by these results.

Focused Jest trials (advisory alternate and counter pilot) passed 17/17 checks on 17 Nov.

## Next engineering actions

1. Audit decision-time EMA separation, MTF strength, volatility and ATR feature values and transformations against the fixed model training ranges, by route/instrument/hour; shadow test corrections before any change in execution authority.
2. Investigate why Plan-B admitted reversal/early-transition samples still fail independent M1 directional/stop geometry, with prospective after-cost and first-stop/first-target evidence.
3. Continue the previously authorized time-limited DEMO experiment without exceeding four intents, 4.00-lot maximum or existing account risk. Verify real broker fills separately from scanner or paper predictions.
4. Keep rollover, OOD, broker risk, continuation pause and all LIVE promotion gates intact until sufficient cost-adjusted holdout and actual fill performance support a narrowly controlled change.

This research note does not place orders or authorize any new trial window.
