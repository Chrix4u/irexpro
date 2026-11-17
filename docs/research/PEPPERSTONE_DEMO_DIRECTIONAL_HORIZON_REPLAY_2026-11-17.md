# Pepperstone DEMO directional replay — 17 November 2026

## Objective and safeguards

User priority: correct prediction of BUY/SELL direction, not smaller lot sizes. Continue unlimited DEMO evidence collection while determining when apparent reversals become continuations (or vice versa). This report comes from the **actual owner-scoped Pepperstone cTrader USD DEMO**, not public forex backtests. No LIVE account, broker order, profit-protection policy, stop loss, margin gate, or trade-count quota was changed by this research.

## Reproducible tool

Research CLI: apps/api/scripts/research-owner-demo-direction-horizons.cjs

Unit tests: apps/api/scripts/research-owner-demo-direction-horizons.test.cjs

Run on VPS in apps/api:

    node --test scripts/research-owner-demo-direction-horizons.test.cjs
    node scripts/research-owner-demo-direction-horizons.cjs --out=/tmp/irexpro-directional-replay.json

The tool queries the configured owner's connected Pepperstone DEMO only. It retrieves original M1 directional decisions and subsequent genuine broker-native M1 bid/ask quotes for EURUSD, AUDUSD, USDJPY and USDCAD, then computes original-side R at 1/3/5/10 minutes. BUY exits are marked at observed bid, SELL at ask. It requires a completed candle, a late-bar quote timestamp, and data that would have existed by each horizon. There is no future-data leakage into the original decision or causal fee estimates.

Historical completed commissions and swaps, normalized to trade initial stop risk, supply a **p90 estimated fee** only if at least five **already closed as-of the decision** broker samples existed. The result is a hypothetical after-fee R, not an actual filled trade or realized profit.

One earliest decision per instrument, direction, Plan-B strategy route and 20-minute market episode reduces exaggerated sample counts. Episodes on simultaneously correlated forex pairs are not necessarily independent.

## Actual 24h replay results

Replay around **11:03 UTC / Ghana time, 17 November 2026**: 11,365 raw decisions; 946 distinct market episodes, only 25 broker-authorized episodes.

All scanner episodes at +5 minutes:
- Confirmed Reversal: 280 episodes; 52.1% favorable original direction; 39.7% estimated after-fee favorable (267 with verified prior fee samples).
- Early Transition: 90 episodes; 45.6% favorable original direction; 34.5% estimated after-fee favorable (87 fee-evidenced).
- Trend Continuation: 576 episodes; 46.2% favorable original direction; 34.1% estimated after-fee favorable (560 fee-evidenced).
- All episodes: 47.9% direction favorable, 35.8% fee-adjusted favorable.

For the 25 **broker-authorized** episodes:
- +1m: 32% favorable direction, estimated mean after-fee -0.207R.
- +3m: 68% favorable direction, estimated mean after-fee -0.063R.
- +5m: 64% favorable direction, estimated mean after-fee -0.030R.
- +10m: 48% favorable direction, estimated mean after-fee -0.187R.

These do not represent the realized net outcomes of the actual 25 orders. Decisions, execution prices, intraminute stop hits, TP, changing fees and closing logic may differ.

## One-minute confirmation experiment

Replay around **11:06 UTC**. Only 8 of the 25 broker-authorized episodes first moved favorably after one minute. Comparing the **same eight cases** with an immediate original hypothetical entry versus waiting one full minute and entering at the subsequent executable ask/bid:

- +3m estimated mean after-fee: immediate +0.162R; delayed -0.066R.
- +5m estimated mean after-fee: immediate +0.257R; delayed +0.029R.
- +10m estimated mean after-fee: immediate -0.025R; delayed -0.254R.

The simple rule **wait until the price already moves favorably** surrendered too much entry advantage here. Do not turn on this delayed-entry rule.

## Unfavorable first minute but direction eventually right

Replay around **11:09 UTC**. Of 25 broker-authorized episodes, 17 moved against the predicted direction during the first minute. For those 17, the **original trade direction from the original price** became favorable at:

- +3m: 64.7% direction favorable, only 35.3% estimated after-fee favorable; mean estimated -0.169R.
- +5m: 58.8% direction favorable, only 29.4% estimated after-fee favorable; mean estimated -0.165R.
- +10m: 35.3% direction favorable, only 29.4% estimated after-fee favorable; mean estimated -0.264R.

This validates the concern that some trades move adversely first and become right later. It **does not prove those trades could avoid the broker stop** or that widening the stop is economically justified. Price path reconstruction and actual executable quotes are required before making such a claim.

## Model-development implications

1. Direction and entry timing are different. Being right in 3–5 minutes does not guarantee a positive after-cost or after-stop outcome.
2. Neither the current direction hypotheses nor a naive wait-one-minute confirmation rule demonstrated robust out-of-sample after-fee expectancy. High lots only multiply results.
3. Collect and compare **causal** price-path features of false reversals, valid reversals and true continuations; include broker spread/commission, higher-timeframe context and entry timing.
4. Train and evaluate using forward chronological splits and disjoint market episodes. Never promote one recalled pattern, or multiple correlated trades from one swing, directly into a BUY or SELL authority.
5. Current continuously recording pattern-memory module remains shadow-only. The research script is repeatable, bounded for analysis only, and does not impose a trading quota. No existing broker or LIVE safety gate was weakened.

## Verification

All eight Node replay tests passed on the user's VPS, and the read-only replay completed with actual broker-native M1 marks. Source and test commits are on the ongoing iRexPro branch. The report is research, not a guarantee of profitability, model retraining, or proof that any proposed entry-timing rule should go live.
