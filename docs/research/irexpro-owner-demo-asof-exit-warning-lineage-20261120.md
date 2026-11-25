# iRexPro owner Pepperstone USD DEMO — as-of profitable-then-deteriorating exit review

Research verified **2026-11-20 ~04:41 UTC**. Exact owner and Pepperstone cTrader **USD DEMO**, from Nov 17 onward. NO execution, lot-size, stop-loss, profit-lock or live account changes. The authorized temporary larger-lot trial remains active only until **12:00 GMT / Ghana time**.

## Why the earlier 31 positive peaks cannot simply be closed

The existing broker-side telemetry takes a sampled maximum favorable `position.unrealisedPnl` approximately every five seconds and runs the actual protection controls. However, its separate durable independent exit-intelligence audit is written **approximately once per minute**. A positive peak reconstructed from final trade telemetry does not necessarily correspond to a positive, actionable, after-fee broker close at a precise earlier time.

The existing standard paper-profit-lock policy `evaluatePaperProfitLock` requires favorable peak at least:
- **+1.0R** for the `CONFIRMED_REVERSAL` route,
- **+0.75R** for the `EARLY_TRANSITION` route,
before it arms under that route, with additional retention requirements. The Pepperstone net-profit lock can evaluate certain eligible setups differently, requiring valid fee reserves, a proven stop and order timing. Positivity alone is not a missing-close proof.

## Source and strict as-of verification

`apps/api/scripts/audit-owner-demo-asof-exit-warning-lineage.cjs` reads ONLY:
1. Owner broker-backed settled or open Pepperstone cTrader **DEMO USD** positions.
2. Their immutable attached `trading.trade_intents` route.
3. Existing `DEMO_POSITION_EXIT_INTELLIGENCE_SHADOW` records signed for exactly that owner/trade.

An independent observation is eligible only when:
- `observedAt >= broker openedAt`;
- `observedAt <= audit.persistedAt <= broker closedAt` for settled positions;
- `0 <= persistedAt - observedAt <= 30 seconds`;
- actual broker-reported unrealized P&L and already-computed current/peak R are all finite.

Out-of-order, late-persisted, missing or stale event evidence is excluded rather than retroactively counted as known at the earlier decision time.

The future final broker net and the final `max_favorable_pnl` are **OUTCOMES**, not as-of early evidence. The fixed retrospective baseline from Nov 17–20 is explicitly research-only and not a sealed independent holdout.

## Observed coverage and why it matters

At 04:41 UTC, 214 complete settlements: **118 winners / 96 losers, net -$2,288.29**. Only **66** trades had at least one verified independent minute-level observation; the other **148** lacked the required audit coverage. This large uneven missingness is **not random**: the one-minute instrumented audit began only Nov 19, and short positions may finish without receiving a minute sample. Don't use these 66 as a population-wide performance estimate.

Of all 96 losers:
- **31** have a retrospective favorable mark above eventual recorded commission and swap cost, but this is **not** proof of an executable after-cost historical close.
- **12** of the 31 have any verified minute-level position-exit monitoring observation.
- **11** of the 31 have a **separately recorded positive broker-reported unrealized P&L** before the broker close.
- The other 20 lack such a positive minute-level audit; do not interpret their missing sample as never having been profitable.

Minute monitor evidence also contains **24** of 96 losing trades with an already recorded deterioration review recommendation. In the fully covered group, the relationship with winners must still be tested.

## Explicit early warning candidate — hypothetical only

A **candidate deterioration review** is defined only from **persisted, contemporaneous** minute audit observations:

1. At least one preceding positive `currentBrokerNetPnl` observation.
2. Two **consecutive** `DETERIORATION_REVIEW_NOW` observations, no intervening other recommendation, recorded no more than 180 seconds apart.
3. Both warning observations were recorded **after** the preceding positive observation.
4. Both observation and persist clocks pass the as-of check before the actual broker settlement.

**The candidate never dispatches a broker order.** This does not model latency, spread/fee reserve, mandatory minimum stop, quote freshness or future fill and therefore does not establish realizable profit.

| Among 66 verified settled trades | Candidate flagged | Candidate absent |
|---|---:|---:|
| Actual winner | 9 | 29 |
| Actual loser | 13 | 15 |
| Actual after-fee net USD | **-$575.70** | **-$31.35** |

Within `CONFIRMED_REVERSAL` (47 covered), the candidate flagged 17: **6 later winners and 11 later losers**. Those 17 settled for **-$457.91**. Among 14 `EARLY_TRANSITION` covered, flagged 5: **3 winners and 2 losers**. Even though the flag is associated with poor results in this retrospective sample, it would also appear before actual winning trades. **No exit can be authorized on this evidence alone.**

The two observed dates (Nov 19 and Nov 20) were already examined for other research, and the sample is too small for independent prospective confirmation. Benchmark against future untouched trading sessions, with chronological split by day/instrument, and require after-fee actual or broker-fillable cost-aware simulations.

## Implemented monitoring

- Source: `apps/api/scripts/audit-owner-demo-asof-exit-warning-lineage.cjs`.
- Regression suite: `apps/api/scripts/audit-owner-demo-asof-exit-warning-lineage.test.cjs`.
- Owner-scoped private output: `/home/lightworld/webapps/irexpro-research/exit-payoff/latest-asof-exit-warning-lineage.json`.
- Daily UTC archive: `.../exit-payoff/daily/YYYY-MM-DD-asof-warnings.json`.
- Added to existing 30-minute *read-only* `irexpro-owner-demo-drawdown-guard-postexit-shadow` monitor. No new order-capable worker or independent schedule.
- Existing broker trading API, AI engine, stop-losses, profit-protection policies and USD DEMO noon lot trial remain unchanged.

## Next engineering gate

Forward shadow study only: freeze at-risk position's exact as-of quote clock, independent M1 state, fees/commission reserve, profit-stop feasibility and position risk R at the candidate moment. Evaluate *new* future broker market paths after that moment, censoring missing quote samples and proving stop-vs-target sequence; compare all losing and eventually winning candidate positions, and require true net incremental value. Do not attempt to close orders retroactively on published sample outcomes.
