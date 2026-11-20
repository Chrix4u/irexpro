# iRexPro: Candlestick Expert Shadow-Mode Promotion Review
**Verified:** 2026-11-20, approximately 01:05 UTC.

## Scope and current status
- Read-only owner Pepperstone cTrader **USD DEMO** model and broker-outcome comparison.
- Model types: separately frozen M1 and M5 forming-candle experts, trained on a limited history, formally **research-only**, no broker order authority.
- Research workers `irexpro-forming-candle-shadow`, `irexpro-forming-candle-forward-shadow`, and `irexpro-forming-candle-outcome-audit` remain online.
- M5 at +15 seconds is often unavailable due to the last finalized native M5 candle arriving late; do **not** replace it with hindsight. Current prospective M5 evaluation is primarily the +285-second stage.
- Frozen research-manifest explicitly states the original temporary training accuracy report was lost. Real prospective predictions provide the primary currently verifiable measurement.

## Prospective next-candle forecasts (20 Nov 00:55 UTC snapshot)
- 8,673 input forecasts across the **latest two UTC trading dates**; 8,577 matched later completed native candle outcomes; 9 pending; 87 native outcome unavailable.
- M1 +15s: 3,437 matched, 44.14% three-class label accuracy; 38.65% prior-candle continuation baseline, 41.93% directional positive **after spread only**, no commission.
- M1 +45s: 4,335 matched, 44.01% accuracy; 39.42% preceding-candle baseline, 42.14% directional positive after spread only.
- M5 +285s: 805 matched, 44.10% accuracy; 45.34% preceding-candle baseline, 43.15% directional positive after spread only.
- Model output is `RED_OR_DOWN`, `COST_SMALL_OR_FLAT`, or `GREEN_OR_UP` of the **following candle**, not a broker-executable buy/sell order, return target, stop-risk, or actual profit.
- M1 >=65% confidence: 326 recent forecasts; **307 small/flat**; M1 >=90% confidence: all were small/flat. Do not call raw confidence a probability of a profitable directional trade. M5 high-confidence performance is not yet sufficiently robust.
- Multiple fixed stages of one underlying candle, shared market time, and four USD instruments are strongly correlated. Do not present the 8,577 episodes as independently executed trades.

## NEW causal pre-entry alignment against actual closed broker trades
Research script: `apps/api/scripts/audit-owner-demo-candle-expert-trade-alignment.cjs`
Private output: `/home/lightworld/webapps/irexpro-research/forming-candle-predictions/latest-trade-alignment.json`

- Owner Pepperstone cTrader USD DEMO closed trades opened **after** 2026-11-17 17:00 UTC: 127.
- Successfully matched to latest safely persisted M1 forecast no older than 90 seconds and **written before trade intent**: 103. Unmatched: 24.
- High-confidence M1 small/flat at those particular trade-intent moments: **0/103**. There is therefore no realized historical trade-benefit sample yet for a >=65% flat-veto or delay rule.
- Opposing directional M1 forecast, exploratory >=40% raw class confidence:
  - EARLY_TRANSITION: 13 matched trades; **11 winners, 2 losers**, +$205.08 actual broker net. A blanket disagreement veto would discard many winners.
  - CONFIRMED_REVERSAL: 33; **13 winners, 20 losers**, -$785.06 actual broker net. Suggestive but **would also discard 13 winners**.
  - TREND_CONTINUATION: 4; **4 winners**, +$323.89 actual broker net. Do not extrapolate.
- Opposing flag uses the latest available M1 expert prediction and original direction only, not later bars. Dollar results belong to **the original executed positions**; hypothetical avoidance/delay offers **no verified substitute broker fill**, and cannot be credited with those losses as saved profits.
- These are **exploratory** retrospective groupings despite causal feature timestamps; repeated trades, lot sizes, session choice, USD concentration and after-the-fact analysis prevent promotion.

## Engagement design — stages
1. **Now:** maintain M1/M5 expert in running forward shadow mode; collect and audit next candle outcomes plus joined original trade decisions with true quote/write time.
2. **Advisory/diagnostic:** expose a non-authoritative readout alongside existing strategy entries: current bar context, next-candle 3-class probabilities, source freshness, applicable timeframe, and `AGREES` / `DISAGREES` / `FLAT` / `UNAVAILABLE`. Clearly mark research-only and distinguish this from the existing trained ensemble expert.
3. **Timing simulation:** on signals arriving *before* market entry, register predefined `ENTER_NOW` vs `WAIT_1/3/5m` vs bounded pullback/confirmation alternatives with true bid/ask, spread, SL/TP, order rejection, full broker commission and capped signal expiry. Flag unavailable quotes and never substitute future knowledge. Track missed profitable trades and lost opportunities.
4. **Qualification:** enough independent **future** market days and across sessions/pairs, stable calibration and **after-cost** net improvements versus unchanged entry policy, fewer stop-first losses without unacceptably missing winners, and passing existing iRexPro risk/performance promotion standards.
5. **Only then:** limited demo-only advisory authority with explicit configuration, telemetry and rollback. No autonomous new order authority or live promotion on current research evidence.

## Safe operation and tests
```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/audit-owner-demo-candle-expert-trade-alignment.test.cjs scripts/audit-owner-demo-prospective-candle-outcomes.test.cjs scripts/owner-demo-forming-candle-forward-shadow.test.cjs
node scripts/audit-owner-demo-candle-expert-trade-alignment.cjs
```
All three scripts are observational and have no broker order or SQL mutation path. The audit script guards chronology, quote validity, owner/demo scope, row limits, and separately counts unmatched trades.

**Decision as of this review:** not profitable as proven, **do not promote to direct demo or live execution**, and do not veto trades using disagreements without independent forward after-cost qualification.
