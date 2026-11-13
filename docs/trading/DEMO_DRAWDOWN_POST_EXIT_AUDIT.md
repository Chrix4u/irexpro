# DEMO drawdown guard — after-exit, broker-native quote audit (v1)

**Endpoint:** authenticated GET `/api/v1/ai/research/demo-drawdown-guard-after-exit`

**Execution:** NONE. No change to AI Start/Stop, entry strategy, broker SL/TP,
risk limits, live/demo close authority, position volume or database state.

- Select the authenticated user's latest connected cTrader-family DEMO account
  with recent FULL_AUTO trading history. Never blend currency, broker connection,
  user, paper and LIVE records.
- Inspect up to 24 most recent settled trades explicitly closed by the v8.9
  DEMO drawdown guard and older than the full 60-minute retrospective window.
- Read the **same broker connection's independently quoted bid/ask M1 closes**
  after the exit. For BUY compare executable BID to original SL/TP; for SELL
  compare ASK. Do not use the partial candle of the actual closing minute.
- An event marked `ORIGINAL_SL_CROSSED_FIRST` means the original stop threshold
  was crossed at an observed M1 *quote close*, **not that an unmodified stop would
  have filled at its exact price**. Bar extremes or assumed intrabar fills never
  count. No future evidence informs an earlier live trading decision.
- Missing or synthetic quotes, noncausal timestamps, gaps before the first
  crossed level, or insufficient full-window quote coverage prevent confident
  classification. Exact broker deal ordering remains unknown without ticks.
- Results are evidence for auditing whether *past* early exits possibly
  avoided a larger loss. They must not alone enable or disable the real guard.

## Pepperstone example: 10 November 2026

Read-only evaluation at 11:38 UTC on staging DB recorded three v8.9 guard
closures and found the original SL threshold was later crossed in all three
post-exit observation windows; no TP quote-close was observed. Full quote
coverage for all three:

| Exit | Settled net loss (USD) | First subsequent SL-crossing M1 candle | Classification |
| --- | ---: | --- | --- |
| GBPUSD BUY 08:41:30 UTC | -92.00 | 08:53 M1 bar (closed 08:54) | SL first |
| GBPUSD SELL 10:32:18 UTC | -164.00 | 10:35 M1 bar (closed 10:36) | SL first |
| USDCHF BUY 10:37:33 UTC | -218.98 | 10:40 M1 bar (closed 10:41) | SL first |

This evidence favors *retaining* the early-loss guard for further DEMO
evaluation while reviewing entry quality. A counterfactual unchanged SL fill
or certainty about future TP must not be inferred from these quotes.
