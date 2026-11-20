# Pepperstone DEMO profit-lock counterfactual barrier replay (18 Nov 2026)

**Scope: owner-only Pepperstone cTrader USD DEMO. READ ONLY, no orders, no stop amendments, no LIVE trading authority.**

Prior post-exit audit inspected only subsequent M1 bid/ask close marks. That cannot prove whether the original SL/TP could have been touched during a delayed-exit hypothetical and could silently include missing minutes. This release extends the same archival research script (no trade path changes) with a separate STRICT sampled-barrier evidence field. The old sampled-price output is retained for backwards compatibility.

For every closed PROFIT_PROTECTION trade, query actual broker fill price and original SL/TP, source-filtered native completed M1 candles, positive native bid/ask samples and valid within-bucket timestamps, positive spread, OHLC geometry and uninterrupted minute buckets. Compute counterfactual quote-close comparison at 3/5/10/15 minutes, but separately classify **possible** original stop and take-profit envelope overlap using native sampled M1 OHLC. Neither the high/low extremes nor the following bid/ask closes are broker-executable fills. If the post-exit path has missing/bad samples, mark incomplete, never a protected win. The fractional minute after a trade was closed is unobserved until the next complete M1 minute; every complete sampled window here has that gap, so **not one delayed exit is broker-certified**.

Read-only report at 2026-11-18 08:22:42 UTC: 49 profit-protection trades in the period beginning 17 Nov, 48 with mature sampled 10-minute windows. Of these, 27 had complete and consecutive quote-backed M1 bars, 21 were missing/invalid. Of the 27, original SL envelope possible on three, original TP possible on seven, with no same-window both at 10 minutes. In the 17 without sampled barriers, the 10-minute quote-side close was better for five and worse for twelve. All 27 had unobserved partial-exit minutes. This is NOT an order outcome backtest, nor a causal prediction, nor after-commission proof of hypothetical delayed exits.

By Plan B route on 10-minute clean sampled paths: EARLY_TRANSITION: 2 better, 5 worse (7); CONFIRMED_REVERSAL: 3 better, 7 worse (10). AUDUSD and EURUSD had insufficient data completeness for reliable instrument-level conclusions; avoid imputing missing candles as favorable returns. Three-class forming-candle expert accuracy was around 42–46% in the two forward trading dates, but positive directional movement after estimated spread remained only around 40–45%, with commission unmodeled; its promotion remains off.

The results **do not** justify suspending the existing winner protector or extending all trades. Further research should validate broker-native bid/ask price path and minimum stop distances, determine the earliest strictly causal qualifying protected runner, and compare ACTUAL after-cost portfolio outcomes over additional separate sessions. Current Pepperstone demo adverse cut and win protection remain unchanged.

Reproduce on authorized VPS:

    cd /home/lightworld/webapps/irexpro-staging/apps/api
    node --test scripts/audit-pepperstone-profit-lock-postexit.test.cjs
    node scripts/audit-pepperstone-profit-lock-postexit.cjs

Private result: /home/lightworld/webapps/irexpro-research/profit-lock-postexit/latest-report.json. It includes `strictBarrierSummary`, `strictBarrierSummaryByRoute`, `strictBarrierSummaryByInstrument` and per-horizon `strictBrokerNativeBarrierEvidence`. There are 9 unit tests (previous 4 + 5 strict quality checks); all passed.
