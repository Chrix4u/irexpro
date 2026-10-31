# Profit Protection Counterfactual Tracer Plan

**Goal:** Automatically settle every mature cTrader DEMO PROFIT_PROTECTION exit into a durable TP-first/SL-first research outcome.

### Task 1 — Pure classifier
- Add a pure M1 barrier classifier and RED tests for BUY/SELL TP first, SL first, same-candle ambiguity, and data gaps.
- Implement minimal classifier.

### Task 2 — Research service
- Add a service that loads mature unclassified profit-protection trades, loads post-close M1 candles, classifies, and persists checkpoint-240 observations with authority NONE.
- Add RED/GREEN service tests including SQL scope and idempotency.

### Task 3 — Module + verification
- Register service in AiModule.
- Run focused and related regressions, tsc/build/diff check.
- Merge/deploy only if green; verify historical backfill count and outcome distribution after startup.
