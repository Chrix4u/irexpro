# cTrader focused DEMO pairs: preferential provider-native data collection

Date: 2026-11-05

## Why

The currently authorized cTrader DEMO **entry** scope is exactly AUDUSD, GBPUSD and EURUSD. USDJPY, USDCAD and USDCHF remain research-only. Yet the active cTrader collector was still sharing its per-cycle historical cTrader requests equally across all six. This caused the same ~30-second M1 history cadence and M5/M15/H1/H4 broker-history cadence for entry and research pairs, even though research-only pairs cannot create new orders.

At 20:48 UTC, the bound FULL_AUTO DEMO session remained active since 13:05:33 UTC with zero new trades. Last 60 minutes: 354 evaluated, 69 non-ABSTAIN candidates, **0** paper-admitted Plan B, **0** broker-authorized, **0** executed. Underlying model reasons were mostly out-of-envelope extension, weak value or low quality; no observed broker fill had failed. This patch **does not** relax model gates, claim profitability or force an entry.

## Implementation: priority without starving research

The existing history collector uses a 15-second configured cycle, exactly **three M1 requests and one M5/M15/H1/H4 context request**. All six receive *separate* approximately one-second cTrader bid/ask quote sampling. The existing 16-context-slot rotation (6 M5, 6 M15, 3 H1, 1 H4) from PR #635 is preserved.

Only when the configured six symbols are **exactly three approved DEMO entry pairs plus three research-only pairs** do we prioritize provider-native historical collection:

- M1: **three out of four cycles** refresh the three eligible entry pairs; **every fourth cycle** refreshes the three research pairs. Both groups still fetch full provider-native M1 history, so research minute data remains available even when sample cycles are less frequent.
- M5/M15/H1/H4: per-timeframe independent four-slot group cursor; **three of every four** requests for that timeframe refresh a rotating eligible entry pair, **the fourth** visits a rotating research-only pair. Independent timeframe offsets prevent any particular timeframe or research pair from being unintentionally starved.
- For *every other* instrument configuration (only three, unusual symbols, etc.), preserve the original round-robin behavior.
- Continue fetching exactly four historical requests per cycle (no new provider API entitlement, no MetaAPI, no increased history bursts) and independently sample live bid/ask quotes for **all six**.
- No synthetic candles, insufficient-evidence fallback, broker position/order call, or additional DEMO execution authority.

### Expected nominal cadence at 15 seconds/cycle

| Data | Focused DEMO pairs | Research-only pairs |
| --- | --- | --- |
| M1 history refresh | Three of four cycles; max ~30 sec gap | One of four; ~60 sec gap |
| M5 and M15 context | max ~3 min gap | max ~8 min gap |
| H1 context | max ~6 min gap | max ~16 min gap |
| H4 context | max ~16 min gap | max ~48 min gap |
| Spot bid/ask sampling | unchanged continuous path | unchanged continuous path |

These are **nominal request schedules**, not guarantees that cTrader replies with a fresh completed bar. The current DEMO M5/M15 readiness continues to reject stale data. Shadow model execution, stop protection, lot policy (preferred 0.20 with broker-aware risk scaling) and research outcomes are unchanged.

## Verification

The updated 192-cycle mock broker collection test asserts:
- A fixed **768 historical requests** (576 M1 + 192 timeframe context) and 192 × 6 independent quote requests, same as before.
- Per focused-pair M1 requested **144** times and per research-pair **48** times.
- Per focused pair in 192 cycles: M5/M15 18 each, H1 9, H4 3; per research pair M5/M15 6 each, H1 3, H4 1.
- Max M5/M15 and H1 inter-request gaps satisfy the nominal schedule; no research symbol starves.
- Nonstandard and 3-pair configuration continue to work with unchanged round robin.

Targeted Jest, TypeScript, ESLint and CI checks must pass before deployment.

## Open profitability issue

The engine cannot currently open cTrader DEMO positions because new candidates fail Plan B paper and governance admission, market envelope or cost/recent-loss checks. Prioritized data eliminates **avoidable research-pair contention**, not poor after-cost expectancy. Track real broker net P&L and qualifying entry count prospectively. We must not lower risk gates or automatically graduate z.ai shadow suggestions on only three days of outcomes.
