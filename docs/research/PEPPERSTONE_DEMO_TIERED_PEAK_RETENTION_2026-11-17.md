# Pepperstone DEMO tiered retention at 65/75/80% — 17 Nov 2026

## Owner-authorized change

The owner observed that a **USDJPY SELL EARLY_TRANSITION** on 17 Nov 2026 reached a persisted **+$86.20** broker-reported favorable peak but the profit-protection close recorded only **+$49.86** trading P&L, followed by **−$19.08 commission**, giving **+$30.78 net realized**. The position's initial risk-at-stop was **$99.69464595**; its peak was **0.8646R**. An unchanged 55%-of-peak threshold is approximately **$47.41**, potentially surrendering 45% of an observed favorable excursion before the broker close request.

The owner authorized the suggested tighter, **DEMO-only**, reversible profit-lock experiment. Implemented `pepperstone-demo-positive-after-fee-giveback-lock-v3-tiered-owner-demo`:

| Verified broker-net peak/R | Existing (flag off) | Tiered (flag on) |
| --- | --- | --- |
| 0.50–less than 0.75 | 55% peak retention | 65% |
| 0.75–less than 1.00 | 55% | 75% |
| 1.00 and above | 55% | 80% |

**No 85% volatility-adapted enhancement** is authorized without trustworthy, causal, broker-native volatility and a tested close-fill mechanism; 80% is a deterministic initial upper band. At peaks below **0.50R** there is no new permission, and the existing meaningful-peak minimum (initialRisk ×0.5, at least 1.8 historical fee estimate, and fee plus 0.15R), causal commission sample count, buffered positive-after-fee mark, freshness and falling-P&L checks **remain unchanged**.

The two eligible strategy routes for the tiered **feature switch** are `EARLY_TRANSITION` and `CONFIRMED_REVERSAL`. The existing globally enabled positive-after-fee lock still handles `TREND_CONTINUATION` below 0.50R and tagged guarded-pullback positions under their original policy. The tiered switch is **OFF unless** `IREXPRO_PEPPERSTONE_DEMO_TIERED_RETENTION=enabled`, in addition to the original `IREXPRO_PEPPERSTONE_DEMO_NET_PROFIT_LOCK=enabled` and `IREXPRO_PEPPERSTONE_DEMO_ALTERNATE_NET_PROFIT_LOCK=enabled`, with `VPS_FOREX_SCANNER_USER_ID` matching the trade owner and verified account `Pepperstone cTrader DEMO` with USD account currency.

### Concrete scenario validation

For the recorded USDJPY SELL peak **$86.20**, initial R **$99.69**, and additional conservative historical fee reserve **$19.08**, the new 75% floor is **$64.65 broker-reported floating P&L**, with a *conditional* protected after-reserve floor of **$45.57**. A synthetic falling broker mark of **$64.40** produces `PROTECTED_POSITIVE_NET_PROFIT` in the new pure evaluator with estimated $45.32 after extra fee reserve; the same mark in the 55% policy is `NO_PROTECTED_GIVEBACK`, thus held. At an observed $70 mark, the tiered evaluator also **holds**, leaving a still-profitable trend room to seek original TP.

The $64.65 is a **decision threshold, not a broker guaranteed take-profit or hard stop**. Tick gaps, latency, disconnections and spread or additional broker closing charges can result in a worse actual fill or even a loss. No claim of historical achievable +$45.57 is warranted without causal observed price/fill records. An independent expert/M1 trend recheck remains an *audit only* and **cannot veto a due close** while no profitable broker-side stop has been installed and confirmed.

### Broker and risk gates

The change creates no orders, does not alter lot size or original SL/TP, and does not remove broker or portfolio risk, margin, event, volatility/OOD, owner session or drawdown safeguards. Closing continues via the same idempotent `ExecutionService.closeTrade(..., PROFIT_PROTECTION)` path. It grants no LIVE-account authority. A new server log reports `tiered`, `peakRetention`, `legacy55WouldClose`, and `legacy55Floor` on every newly triggered protective close, enabling decision-level comparisons without asserting unobservable counterfactual realized profit.

### Verification

- Pure evaluator boundary tests for 0.50R/0.75R/1.00R, 55%-disabled fallback, old trend continuation, wrong broker/LIVE, mismatched SL/TP, insufficient fee samples, stale evidence and missing after-fee positivity.
- Service-level regression: same owner-scoped broker SELL position closes under new flag at $64.40 and **does not** under old 55% or mismatched owner.
- Production Nest build and PM2 startup log must pass before activation; confirm old stop/TP and profit protection cadence remain active.
- Retrospective comparison is illustrative only until further independent DEMO broker closes accumulate; compare realized after-commission expectancy and effect on full TP runners, not simply gross peak retention.

## Reversibility

To revert just the tiered experiment, set `IREXPRO_PEPPERSTONE_DEMO_TIERED_RETENTION=disabled` (or remove it) and restart the API. The original verified 55% Pepperstone DEMO policy continues. Existing positions are subject to the policy active on their next managed profit-protection observation, without changing their broker-native stops.
