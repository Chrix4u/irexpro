# iRexPro — 04/11/2026 model lineage and actual broker-results comparison
**Historically scoped, read-only forensic audit | All dates UTC = Ghana time**

## Bottom line

The 04/11/2026 winning setup's **core M1 route, Plan B signal scorer,
M1 candidate generation and expert-registry source is STILL AVAILABLE**
in Git. It is NOT evidence of a separate, superior missing AI model.
Its trading intent `model_version` strings match the 10–12 Nov
broker ledger:

- `external-provider/irexpro-multimodel-ensemble-v1/demo-v1`
- `external-provider/irexpro-m1-tactical/m1-tactical-v2-m5-lifecycle`

Exact source comparison: pre-first-broker-fill historical commit
`0ccae758` at 08:26:04 UTC 04 Nov, prior to first fill 08:47:25,
against working branch `5ed54f3e` before this report. The following
sources are byte-identical:
`m1-tactical-route.ts`, `m1-tactical-candidate.ts`,
`plan-b-multimodel-shadow.ts` and `ensemble-expert-registry.ts`.

**Not the same complete trading system:** the scheduler
(`m1-tactical-scheduler.service.ts`), DEMO execution authority
(`multimodel-demo-authority.ts`), reliability, governance and
rollout focus have materially changed. Post-04 Nov
`m1-tactical-features.ts` added failure *diagnostic* code;
there are also changes to separate clock-neutral research scoring
and the broker/exit system. We have NOT independently verified
the exact trained-expert binary weights at each date, so matching
strategy/model IDs and identical core source are NOT proof of
identical loaded trained-expert artifacts.

## Actual reconciled outcomes (do NOT compare EUR and USD sums)

| Ghana trade date/window | Broker | Currency | Closed | Net wins | Net after ALL paid fees | Net profit factor | Mean lot |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 04 Nov | cTrader DEMO | EUR | 14 | 9 | **+€14.53** | 1.640 | 0.178 |
| 04–09 Nov (four trading days) | cTrader DEMO | EUR | 35 | 18 | **−€22.42** | 0.751 | 0.175 |
| 10–12 Nov (three trading days) | Pepperstone cTrader DEMO | USD | 44 | 17 | **−$1,259.71** | 0.680 | 3.064 |

04 Nov: broker gross **+€35.59**, paid commission/swap
**−€21.06**, NET **+€14.53**, 9/14 wins, 5/14 losses,
2.49 lots summed over the fourteen separately closed trades.

Old broker 04–09 Nov: gross **+€27.49**,
paid costs **−€49.91**, NET **−€22.42**.
New Pepperstone 10–12 Nov: gross **−$450.82**,
paid costs **−$808.89**, NET **−$1,259.71**.
Original EUR account mean lot 0.175 vs Pepperstone USD mean lot
3.064 (~17.5× higher traded volume per fill).
Currency, capital base, volatility, broker, fees, account permissions,
fill slippage, entry routes and market regimes differ; never present
these cash sums as a controlled apples-to-apples strategy backtest.

## What actually made money on 04 November?

| Actual execution authority (04 Nov) | Fills | Net winners | Net after fees |
| --- | ---: | ---: | ---: |
| PRIMARY_PLAN_B, trend continuation | 7 | 5 | **+€23.29** |
| BOOTSTRAP_CONTINUATION, independent M1 | 6 | 4 | **−€4.46** |
| M5_EARLY_TRANSITION_HANDOFF | 1 | 0 | **−€4.30** |
| TOTAL | 14 | 9 | **+€14.53** |

Across all four 04–09 Nov EUR-account trading days:
- PRIMARY_PLAN_B: 22 fills, 12 winners, **−€0.95** net,
  profit factor **0.983** — effectively breakeven, not a proven edge.
- BOOTSTRAP_CONTINUATION: 9 fills, 6 winners, **−€3.82**
  after fees — a win-rate trap: 66.7% wins yet losing money.
- M5_EARLY_TRANSITION_HANDOFF: 3 fills, all net losses,
  **−€12.74**.
- QUALIFIED_CONTINUATION: 1 fill, net **−€4.91**.
- Total: 35 closed positions, net **−€22.42**, 4 dates.

## Historical winners now outside the two-pair high-frequency scanner

04 Nov instrument-direction closed-trade results:
- **USDCAD SELL**: 3 fills, 3 net winners, **+€13.85**.
- **AUDUSD BUY**: 2 fills, 2 winners, **+€5.22**.
- **USDJPY BUY**: 3 fills, 2 winners, **+€3.74**.
- **GBPUSD BUY**: 5 fills, **−€3.98**.
- **USDCHF SELL**: 1 fill, **−€4.30**.
- **EURUSD**: ZERO closed fills on 04 Nov.

Across the larger 04–09 Nov old-account window:
- USDCAD SELL: **5 trades, 4 net winners, +€11.67**,
  net profit factor **3.377**, but ONLY TWO trading days
  (04 and 05 November); genuine *shadow-research candidate*,
  not independent profitability proof.
- USDJPY BUY: 3 trades, 2 winners, **+€3.74**, only ONE
  trading day; insufficient evidence.
- AUDUSD BUY: 6 trades, 3 winners, **−€14.61** over
  the old account period, so 04 Nov's AUDUSD BUY gains
  did NOT persist.

At 23:33 UTC on 12 Nov the active Pepperstone provider continued
collecting owner-bound cTrader positive bid/ask M1 minute candles
for EURUSD, AUDUSD, USDCAD and USDJPY.
BUT the last-hour `trading.m1_tactical_decisions` contained
**only EURUSD/AUDUSD**: the currently chosen two-pair high-frequency
M1 focus suppresses decision generation for the others.
The quotes are present; current independent model decisions for
USDCAD/USDJPY are NOT yet present. Do not claim they are already
being scored by active AI or that broker execution is enabled.

## Recoverability and recommended next experiment

1. **Do NOT rollback the whole 04 Nov code**: entry signal core
   files are the same, while a full rollback would discard more
   recent cost/provenance corrections, broker margin-overflow
   recovery and rollover protections.
2. **Do NOT restore M1 bootstrap trade authority** on the basis
   of its old 66.7% win rate: it was net losing after commission.
   Nor restore the M5 early handoff: all three samples lost.
3. Keep primary Plan B as the historical reference champion,
   but require prospective *actual* after-cost positive expectancy
   before relaxing gates or increasing lots.
4. **Add USDCAD SELL first, USDJPY BUY second to independent,
   NO-ORDER shadow decision evaluation**, leveraging already
   streaming broker-native prices without putting them back
   on the two-pair execution allowlist or UI charts.
   This requires separately implementing/testing a research-only
   scan pathway; a mere quote subscription is NOT a model evaluation.
5. Compare timestamped shadow decision-time signals with actual
   broker BID/ASK spread, first-touch stop/target ordering,
   original signal validity, expected net R, slippage, calendar
   sessions, and multiple independently observed days.
6. Retain owner-bound DEMO account, margin, SL/TP, high-impact
   events, rollover constraints, idempotency and after-cost
   loss-streak brakes. No fixed 2 or 4 lots for previously
   unqualified research-only pairs. An old small winning account
   is not proof of an unlimited-exposure 4-lot strategy.
7. Minimum next milestone: sufficient multi-day prospective
   data for USDCAD/other candidates and a matched-risk
   economic comparison before any staged *DEMO-only* broker
   promotion. Shadow research is not authority to place orders.

## Reproducible audit

From `apps/api`, execute:
`node scripts/audit-nov04-legacy-model-parity.cjs`

The script uses an owner-scoped, REPEATABLE READ READ ONLY
PostgreSQL transaction and exact UTC `timestamptz` boundaries;
separately groups old `ctrader` EUR and new
`pepperstone-ctrader` USD. It never merges currencies,
imputes missing commission, sends orders or changes the
trading session. Private output:
`/home/lightworld/webapps/irexpro-research/nov04-legacy-comparison/latest.json`.

Six regression tests cover owner/broker/currency scoping,
UTC calendar boundaries, after-fee P&L, model attribution,
missing fees and no write/order authority. Exact historical
Git snapshot `0ccae758` remains available from repository
history; do not deploy it blindly.
