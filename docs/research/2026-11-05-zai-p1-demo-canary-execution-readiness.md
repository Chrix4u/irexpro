# z.ai P1 confirmed-reversal DEMO execution readiness — 2026-11-05

## Candidate, not a profit claim

The selected z.ai candidate is 50% partial liquidation at an **existing actual profit-protection close**, with 50% remaining under the **original broker stop-loss and take-profit**. This is NOT the z.ai 50% at 1R and 2.5x ATR trailing proposal, which has not been fully simulated. The independently rechecked 76-trade selected-winners replay shows only 15 confirmed-reversal cases; a 50% hold with an assumed 0.05R extra cost improved 14 resolved cases by a mean **+0.319R** versus closing all. The cohort excludes other trades and is not full-trade after-fee expectancy; historically the broader DEMO reversal route was net negative.

## Why an immediate partial-close order is NOT safe yet

- The provider cTrader adapter supports a volume-specified partial close, but `ExecutionService.closeTrade()` always requests the **full internal Trade.lotSize** and terminally changes the Trade to `CLOSED`. Calling the adapter directly would bypass the auditable execution/orchestrator lifecycle; calling the standard close method to close half would be economically and operationally false.
- There is no durable internal partial-fill ledger with verified provider execution IDs, filled quantities, fees, swap and remaining volume. Without it, the next full-close request may exceed the position's actual remaining volume; accounting and daily loss risk could omit the realized partial leg.
- Ambiguous provider partial-close acknowledgments need restart-safe deduplication and live broker-position reconciliation. Missing broker close P&L must be marked incomplete, never zeroed.
- A partially protected runner must not be immediately closed by the original profit-lock on its next five-second monitoring pass. Its risk R, MFE/MAE telemetry, stop/TP and closed-trade report must accurately reflect the reduced position.
- A separate account-currency-isolated controlled DEMO test and a clean 0.02-lot pilot trade with 0.01-lot close, 0.01-lot remainder and precise commission accounting are required before broker activation. LIVE is forbidden.

## Current change

Add deterministic, read-only preflight `zai-p1-reversal-demo-preflight-v1` at every existing DEMO profit-protection trend recheck, **after the full protective close**. It evaluates broker DEMO provenance, confirmed-reversal route, fresh aligned trend, past-only broker fees, after-fee profitability, valid original price geometry and exact 50/50 decimal-4 lot split. Both half-close and remainder are recorded in anonymized monitoring cohorts. `canSendPartialClose=false`, `modifiesExecution=false` are immutable. No new model authority or order, and no restart of the stopped user trading session.

## Promotion acceptance checklist

1. Atomic, idempotent partial-close dispatch via existing `ExecutionOrchestrator` and a new persistent partial-leg state machine that keeps the trade `OPEN` only while its remaining quantity is known.
2. Broker-native pre/post position-volume verification, correct lots across restarts, no duplicate partial close on timeouts; full stop/trading-session STOP must always close the actual remainder.
3. Include partial realized gross P&L, commission and swap in realized financial cards, daily/portfolio risk limits, trade history and account-currency reports without double counting; use a new ledger as needed.
4. Maintain existing broker stop and TP on runner, and ensure normal adverse-thesis and emergency protections still work.
5. Test cTrader DEMO only with 0.02 lot to 0.01+0.01, reconcile response, restart and manual-close race; run simulated failure-injection and DB concurrency tests.
6. Pre-register small-sample DEMO A/B and independent after-fee outcomes. No LIVE changes, no volume increase, and rollback on any unknown provider state.

This document must not be presented as a deployed executable P1 strategy. It records the concrete safety gap and the tested path to an honest DEMO rollout.
