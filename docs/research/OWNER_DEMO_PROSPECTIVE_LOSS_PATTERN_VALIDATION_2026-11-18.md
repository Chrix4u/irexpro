# iRexPro forward-only loss-pattern shadow: owner Pepperstone USD DEMO

The 17–18 November 2026 loss-forensic report (updated through ~21:30 UTC) observed **98 closed original-route trades**, including 44 losers and 54 winners. These are a fully inspected *discovery* dataset, not an out-of-sample validation set.

## Implementation

- `apps/api/scripts/watch-owner-demo-loss-pattern-shadow.cjs` is a **read-only** prospective observer.
- At first start it freezes `/home/lightworld/webapps/irexpro-research/loss-entry-forensics/latest-training-cohort.json` to the private `loss-pattern-forward/frozen-baseline.json`, creates owner-specific `activation.json`, and refuses replacement or mismatch on restart.
- Only **brand-new, still OPEN**, owner-scoped Pepperstone USD DEMO positions detected within **90 seconds** of broker open qualify for entry capture. If a position is already closed or a freeze-time decision is unavailable, enrollment is marked missed, rather than retrospectively producing a fake “prediction.”
- Pre-order features come exclusively from the exact trade-intent’s `trading.m1_tactical_decisions` candidate and governance with evaluated_at <= broker open; tied to the original broker trade. They include H1/H4/M15/M5 directional context, M1/M5 momentum, M5 candle body pressure, Plan-B meta-probability, score, independent-expert state, and original planned direction and strategy.
- Six substantive preregistered hypothesis families: Confirmed Reversal USDJPY BUY; Confirmed Reversal M5 opposition; Early Transition M1 momentum opposition; H1+H4 dual opposition; Plan-B meta <0.50; and M5 candle pressure against entry. The expert's abstention is retained as a *non-discriminating control* to measure its false-positive rate.
- The same pre-outcome ENTRY journal now stores a **separate frozen candlestick fingerprint** from completed broker-native M1/M5 candles: last three valid OHLC bars, body-to-range and upper/lower-wick ratios, named rejection-wick / wide-body / doji labels, and an adjacent engulfing check. The candle must have been closed, created, last sampled and last updated **no later than the original decision time**, otherwise its state is UNKNOWN. A late-built or revised bar cannot be called a pre-entry signal.
- These candle signatures are evidence for future matching/research ONLY, not new strategy rules, model retraining, model auto-flips, broker order vetoes, or additional risk controls.
- If the later broker close timestamp is not strictly after the ENTRY snapshot capture time, settlement is not eligible as a prospective validation outcome—even if the application had temporarily reported the trade as OPEN.
- Compare future warning-positive **and** warning-negative orders, including all winners, losers, commissions and after-fee P&L.
- A simple nearest-history metric reports descriptive similarity but stays `INSUFFICIENT_INDEPENDENT_HISTORICAL_EXAMPLES` while fewer than five comparable examples across three days exist.
- The observer also records **broker-reported net unrealized peak** crossings of **0.25R / 0.50R** if the position is genuinely OPEN at the observation; eventual settlement remains in a separate, future-outcome stage.
- The private files are under `/home/lightworld/webapps/irexpro-research/loss-pattern-forward/` and are **not committed to public GitHub**. The source and synthetic tests can be committed.
- The original demo execution and all risk, lot size, broker stop, broker TP, and profit-protection permissions remain unchanged. LIVE accounts are never in scope.

## Future validation limitations

Retrospective losers do not prove the opposite direction would have won. Do not flip sides, suppress orders, or promote a model solely from this discovery sample. Assessment must cover future independent dates with verified settlement, correct spread and commission, false rejection of profitable orders, fill uncertainty, and risk/drawdown. Since the feature hypotheses were selected by looking at 17–18 November, those dates cannot be reused as untouched validation.

The research is separate from the existing native-quote and frozen-60-second-entry shadow collectors. It can be deployed or stopped independently of the execution engine.

## Verification

```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/watch-owner-demo-loss-pattern-shadow.test.cjs
node scripts/watch-owner-demo-loss-pattern-shadow.cjs
pm2 start scripts/irexpro-owner-loss-pattern-forward-shadow.pm2.config.cjs
pm2 show irexpro-owner-loss-pattern-forward-shadow
```

Read only the summary at `/home/lightworld/webapps/irexpro-research/loss-pattern-forward/latest-summary.json`. A `0` enrolled result means **no new eligible trades have been observed after activation**, not that an entry-model improvement has been validated.
