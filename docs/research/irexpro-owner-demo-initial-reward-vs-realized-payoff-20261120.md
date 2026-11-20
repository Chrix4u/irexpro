# iRexPro owner demo: original 1.6R planned reward vs actual exit payoff

**Research as of 20 November 2026 ~04:31 UTC**, Pepperstone cTrader USD DEMO, exact owner-scoped, Nov 17 onward. Pure read-only; the active owner-authorized 4–6 lot DEMO trial remains unchanged and automatically expires at 12:00 Ghana time.

## Defensible comparison source

To prevent hindsight, the read-only SQL joins each broker-**settled** `trading.trades` record to its **original pre-intent** `trading.m1_tactical_decisions` and `trading.trade_intents`, with the decision evaluated/persisted before intent creation and before broker opening, and same-side/instrument/stop/target geometry. Original stops and targets come from the intent (not a possibly updated broker trade row).

A normalized **realized net-to-original-fill stop-risk ratio** uses actual broker fill, the original intent's stop distance, position lots, USD-currency conversion where necessary, then actual gross realized P&L **plus commission and swap**. This measures after-fee performance against original stop geometry; it is **not** a guaranteed maximum loss or a model-predicted future return.

Only independently signed `DEMO_DRAWDOWN_GUARD` audit events count as a guard close. Other `AI_CLOSE_SIGNAL` reasons are kept separate. Generic `BROKER_CLOSE` is not claimed to prove stop or target trigger; price proximity to original levels is reported as a descriptive label.

## Exact settled outcome

214 trades, 118 wins and 96 losses; 214/214 original pre-intent decisions verified. Actual after-cost net **-$2,288.29**, profit factor **0.6218**, gross winners +$3,762.41 and gross losers -$6,050.70.

**The original planned take-profit distance is 1.60 times the planned stop distance for all 214 trades, winners and losers alike.** Therefore, original gross TP:SL geometry is NOT a trade-by-trade differentiator in this period. The realized payoff is materially different:

| Exit type | Trades | After-cost net USD | Mean realized net R (original fill/intent stop) | Notes |
|---|---:|---:|---:|---|
| `PROFIT_PROTECTION` | 107 | +$2,985.26 | **+0.4155R** | 107 net winners; only seven closed within 2 pips of original target |
| `BROKER_CLOSE` | 69 | -$3,496.91 | **-0.8821R** | 56 closed within 2 pips of original stop, seven within 2 of original target; actual triggers unknown |
| Audit-verified five-minute guard | 31 | -$1,463.52 | **-0.7571R** | Correlated losers already in adverse states, not causal evidence guard worsens results |
| Other/unverified AI close | 7 | -$313.12 | **-0.6433R** | Do not classify as independently guard-confirmed |
| **All** | **214** | **-$2,288.29** | **-0.2074R** mean | Mean net winner +$31.88 vs mean net loser -$63.03 |

The favorable gross exit mark may be updated by periodic broker-mark observation rather than every actual tick. Among 107 profit-protection exits, the recorded **gross** realized P&L averaged 76.77% of the recorded favorable gross peak. This is a **sampled mark retention ratio**, not a fill-causality claim.

58/96 eventual net losing trades recorded an earlier positive **gross** marked P&L. For **31** of those 96, the recorded peak even exceeded the **final** realized two-sided commission and swap, in a retrospective static-fee comparison. That does **not** prove an after-cost positive exit could actually be executed at that earlier mark. There is no guarantee from sparse mark observations.

Confirmed Reversal: 136 positions, 67W/69L, net **-$2,059.55**, profit factor 0.4928. Early Transition: 65 positions, 41W/24L, net **-$549.89**, profit factor 0.6951. Trend Continuation: 13, +$321.15; small selected cohort and no authorization to re-enable a paused route.

Within Confirmed Reversal, 63 profit-protection positions generated +$1,711.99, while 46 broker-reconciled closes produced -$2,650.05 and 23 audited five-minute guard exits -$940.96. This identifies substantial negative expectancy despite many small protected winners.

The first actual trial position (AUDUSD SELL 3.44 filled lots, requested 4.20) was counted **separately** in the high-lot trial cohort and closed +$55.04. A subsequent AUDUSD BUY was requested 6.00 lots and **filled 5.35 lots**, proving at least one actual 4+-lot fill by ~04:21 UTC. It was still OPEN then; no realized P&L is attributed to it while open.

## Does profit protection close too early?

Compared the **107 actual broker-confirmed profit-protection exits** to the following prospective native bid/ask archive. BUY is evaluated using BID; SELL using ASK. The clock on both the quote source and archive capture must pass; source/capture delay <=15s, boundary gap <=30s and max adjacent gap <=60s. Incomplete paths are **censored**.

| Time after actual exit | Sufficiently complete paths | Later last quote better than actual exit | Later last quote worse |
|---|---:|---:|---:|
| +1 min | 103 | 36 | 60 (7 flat) |
| +3 min | 101 | 50 | 49 (2 flat) |
| +5 min | 98 | 50 | 44 (4 flat) |
| +10 min | 98 | 51 | 45 (2 flat) |
| +20 min | 94 | 54 | 40 |
| +30 min | 90 | 45 | 45 |

Within the Confirmed Reversal protected exit subset, 20m after the actual exit, **34** complete paths had a more favorable last quote and **19** a worse last quote. But six of these paths sampled the original stop; 21 sampled the original target, with no proof of missing-tick precedence. That could justify a **new independent shadow-only retention policy hypothesis**, not immediate changes to stop/profit protection.

At +1 minute the distribution was already unfavorable to delaying most protected exits (36 better, 60 worse, seven equal among 103 complete). **Blanket delayed profit protection is not supported.** A longer observed favorable quote is neither executable delayed fill nor an after-cost trading outcome; unknown slippage, stopped-path priority, alternative signals and margin remain unresolved.

## New repeatable instrumentation

- `apps/api/scripts/audit-owner-demo-exit-payoff-geometry.cjs`: saved original geometry vs broker-net payoff, with route, day, close reason, observed favorable peak and explicit trial vs baseline.
- `apps/api/scripts/audit-owner-demo-profit-protection-postexit.cjs`: quote-path alternative observation after profitable actual exits, using existing audited native quote ingestion and exact two-clock validation.
- Private reports:
  - `/home/lightworld/webapps/irexpro-research/exit-payoff/latest-report.json`
  - `/home/lightworld/webapps/irexpro-research/exit-payoff/latest-protected-postexit-quotes.json`
  - Daily UTC archives in the same folder's `daily/`.
- Tests `audit-owner-demo-exit-payoff-geometry.test.cjs` and `audit-owner-demo-profit-protection-postexit.test.cjs`.
- The existing **30-minute read-only** owner postexit monitor refreshes both alongside candlestick, lot, guard and entry-formation reports. No new independent timer, order worker, live privilege, risk threshold, stop, or requested lot setting.

## Research implication, not execution authority

The **principal verified gap** is between an equal 1.6R initial geometric target and substantially smaller actual after-cost protected win (~0.42R), compared with -0.88R broker-close average and -0.76R guard-close average. Neither simply keeping positions open longer nor merely increasing lot sizes fixes this automatically.

Recommended next work is to record an **independent future shadow retention classifier**, comparing original 1/3/5/10/20-minute broker-native quote paths and broker stop precedence, by strategy and trading day. Do not train or score the candidate on the same postexit period from which it will be judged; collect forward sessions. No live promotion without verified positive after-fee expectancy and acceptable drawdown.
