# 19 Nov 2026 — EURUSD SELL peak-to-stop incident, owner DEMO

## Verified outcome

Trade `1914c870-08f3-4391-8d90-14ff5c1f087e`, Pepperstone USD **DEMO**,
Confirmed Reversal, SELL EURUSD 1.78 lots, opened 13:08:24 UTC and closed
13:35:36 UTC as `BROKER_CLOSE`. Entry 1.09927000; original SL 1.09983000;
original TP 1.09853000. Actual broker-reconciled exit price was
**1.09985000**, 0.00002000 (0.2 pip) worse than the original SELL stop at
1.09983000. Broker-observed maximum favorable P&L +$30.26 at
13:22:54 UTC, original sizing `finalRiskAtStop` $89.00. Closed gross
**-$103.24**, commission **-$10.68**, realized after-fee **-$113.92**.
No broker-positive SL amendment existed. These are actual database outcomes,
not simulated returns.

## Why the trade was not protected

+30.26/89 = **0.34R**. Existing ordinary Confirmed Reversal profit lock
requires >=1.00R; owner DEMO tiered broker-net giveback lock requires >=0.50R
($44.50 for this position). The persistent adverse loss-cut was disabled,
and its existing model excludes trades that had already reached >=0.15R
peak. The independent candle expert produced repeated
`DETERIORATION_REVIEW_NOW` warnings but has no execution authority.
The position therefore reached the broker-side original loss barrier.

At 13:26:11 UTC, the **prospective** research audit recorded broker-net
P&L -$5.34, peak $30.26, three adverse completed M1 bars (two consecutive
quote-backed), aligned M1 momentum -0.61 and body pressure -0.63. Subsequent
actual broker close was -$113.92 net. A hypothetical close at the
13:26 broker mark is NOT a fill prediction; commission, latency, spread and
slippage still apply.

## DEMO-only loss-gap rescue pilot

`IREXPRO_PEPPERSTONE_DEMO_POST_PEAK_ADVERSE_RESCUE=enabled` activates a
narrow existing-position loss-limiting exit for this owner Pepperstone USD
DEMO only. It requires:
- Existing, independently verified Confirmed Reversal M1 trade and exact
  position side, instrument, lot size, original SL/TP and risk geometry;
- Previous genuine peak between 0.30R and <0.50R, current broker-net P&L
  at/below zero but above -0.70R, >=2 minutes open and >=12 prior
  observations;
- Three completed adverse native M1 bars, two consecutive independently
  quote-backed bars, aligned momentum <=-0.30, latest body pressure <=-0.35,
  fresh latest bar <=75 seconds, and spread <=25% of original stop distance.
- Original broker SL/TP unchanged. Existing 0.50R+ net profit lock, other
  routes, other tenants, and LIVE remain unchanged. No new-entry veto.

The rescue uses the existing idempotent `ExecutionService.closeTrade`
pipeline, `AI_CLOSE_SIGNAL` and a distinct reason code
`pepperstone-owner-demo-confirmed-reversal-post-peak-loss-rescue-v1`.
It can realize a small loss, and broker execution may fail, slip or be
reconciled. It is not a guaranteed stop or substitute for original SL.

## Retrospective selection check

Against read-only owner DEMO M1 exit-intelligence audit snapshots from
Nov 17–19, the conservative conditions above selected this one
incident. A looser two-adverse-candle / >=0.25R rule also selected
several trades that ultimately recovered to profitable closes, so that
looser rule was **not** enabled. This retrospective exercise is small,
not a robust out-of-sample demonstration. Continue prospective outcome
tracking; do not promote it to LIVE or claim guaranteed profitability.

## Next work

Require a prospective cohort of realized DEMO trades, measure net P&L
and worse-vs-better counterfactual paths, then refine threshold with
proper time-split evaluation. The separate broker-side positive stop
amendment executor and readback/authority commit flow remains disabled.
