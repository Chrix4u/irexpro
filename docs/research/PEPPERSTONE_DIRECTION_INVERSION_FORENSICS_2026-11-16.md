# iRexPro — BUY/SELL direction inversion forensic audit
**16 November 2026, Pepperstone cTrader USD DEMO, user-owned staging database.**

## Question
Could the AI forecast BUY but accidentally send SELL, or vice versa, explaining Monday's 8 of 10 losing positions?

## End-to-end database evidence (read-only)
Scope: 10 Nov 2026 UTC onward, exact owner + `pepperstone-ctrader` + `account_type=DEMO`.

| Linked stage | Matches expected recorded trade direction | Mismatches |
| --- | ---: | ---: |
| Original immutable AI signal identity `trading.ai_signal_identities.material_fields.direction` | 74/74 | 0 |
| M1 tactical decision `trading.m1_tactical_decisions.direction` | 74/74 | 0 |
| M1 evaluated candidate `candidate.direction` | 74/74 | 0 |
| Execution trade intent `trading.trade_intents.direction` | 74/74 | 0 |
| Broker order reservation `trading.orders.direction` | 74/74 | 0 |
| Recorded executed position `trading.trades.direction` | 74/74 | 0 |

The persistent full-auto trading system has no `trading.execution_confirmations` rows for these trades (expected: that table is primarily the SEMI_AUTO confirmation path). Their absence is NOT evidence of a broker direction error.

cTrader adapter encodes `BUY -> ProtoOATradeSide.BUY (1)`; `SELL -> ProtoOATradeSide.SELL (2)`. Both routes already have existing adapter unit tests. No recorded reversal-of-direction bug is established by these records. This is a check on stored trade lineage and intended adapter protocol mapping; it cannot retroactively prove unrecorded provider internals.

## Economic and strategy evidence
74 Pepperstone DEMO closed trades since 10 Nov, 32 winning, 42 losing, net -$1,402.72 after gross + commissions + swaps.

| Plan-B route | Closed | Wins | Actual net USD | Mean recorded directional quality |
| --- | ---: | ---: | ---: | ---: |
| TREND_CONTINUATION | 61 | 27 | -1,583.85 | 0.477 |
| CONFIRMED_REVERSAL | 9 | 3 | +82.88 | 0.700 |
| EARLY_TRANSITION | 4 | 2 | +98.25 | 0.668 |

`directionQuality` is an M1 feature-alignment score (0.5 is neutral in its formula), **not an 80% forecast-accuracy probability**. 61 continuation trades dominate losses; this is a selection/calibration/risk/payoff issue rather than an observed orientation flip.

A qualified trained expert *opposed* 9 trend-continuation trades (3 wins, net -$20.57); the other 52 trend-continuation trades lost net -$1,563.28. Hence simply blocking expert-conflict cases alone would not fix most losses.

The separately running opposite-direction COUNTER simulation already showed that universal inversion is not a robust profitable solution: on Monday 16 Nov the opposite same-exit virtual returns estimated +$63.99 over 10 main trades, but on Friday 13 Nov the 19 comparable counter simulations estimated -$547.65. Neither simulation accounts for exact executable counter fills, independent first-hit SL/TP, account hedging restrictions or exact slippage.

## Preventive direction-mapping hardening
Before this patch, cTrader `placeOrder` encoded side using the ternary:
`order.direction === 'BUY' ? CtraderTradeSide.BUY : CtraderTradeSide.SELL`.
This has a latent malformed-value bug: a runtime `undefined`, `LONG`, `SHORT`, or lowercase `buy` would silently map to SELL despite the TypeScript nominal union type.

Patch in `ctrader.adapter.ts`: reject any runtime direction other than exactly `BUY` or `SELL` before constructing a broker order. Raise `BrokerAdapterError(INVALID_REQUEST, dispatchCertainty=DEFINITELY_NOT_SENT)`. This does not reverse or alter valid orders and does not modify any existing positions. New adapter regression cases prove zero outbound `ProtoOANewOrderReq` for malformed direction inputs.

**This hardening prevents future silent SELL fallbacks; it is not proof this happened in historical trades.**

## Next substantive solution
1. Keep the explicitly enabled Pepperstone DEMO continuation pause while evaluating route-specific entry economics without forcing unconfirmed reversal trades.
2. Run **prospective independent** directional forecast calibration by instrument, regime, direction, expected R after commission/slippage and 1/3/5/10/15-minute horizons.
3. Compare two independently pre-registered policies: (a) abstain on weak/contradictory directional conditions, (b) reversed direction with its **own** stop, target, risk, latency, costs and capital constraints. Do not pick winners after seeing outcomes.
4. Promote only on out-of-sample positive after-cost expected value, profit factor, drawdown and sufficiently many distinct market sessions. A high win rate with huge average losses can remain unprofitable.
5. Keep LIVE trading unapproved; do not force equal and opposite simultaneous broker orders into the same account.
