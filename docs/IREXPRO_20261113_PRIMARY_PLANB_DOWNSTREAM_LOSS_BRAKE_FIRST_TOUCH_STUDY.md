# iRexPro — primary Plan B downstream loss-brake counterfactual
**13 November 2026 | Pepperstone cTrader DEMO | USD | READ ONLY**

## Why this audit was necessary

The 4 November PRIMARY_PLAN_B authorization replay confirmed **zero**
historic primary decisions lost to newly added primary logic. Yet many
qualified decisions receive no broker authorization because downstream
reliability, route-loss or portfolio-loss brakes veto them. The purpose
here is to ask whether removing those brakes *might* have saved or lost
money, rather than loosen gates to increase trade count.

## Reproducible source and exact scope

`apps/api/scripts/audit-planb-downstream-brake-firsttouch.cjs`

Run from `apps/api`:

```bash
IREXPRO_BRAKE_AUDIT_START=2026-11-10T00:30:00Z \
IREXPRO_BRAKE_AUDIT_END=2026-11-13T00:20:00Z \
node scripts/audit-planb-downstream-brake-firsttouch.cjs
```

Immutable report output is written privately at:
`/home/lightworld/webapps/irexpro-research/planb-downstream-brake/latest.json`

The script verifies the exact owner-bound, connected, ACTIVE FULL_AUTO
Pepperstone DEMO **USD** account in a PostgreSQL
`REPEATABLE READ READ ONLY` transaction. It selects only decisions
whose `multimodelAuthority.authorityPath` was `PRIMARY_PLAN_B`
and `multimodelAuthority.executable=true`, but whose actual final
decision did not receive `BROKER_NATIVE` authority and whose blockers
include at least one of these four *downstream* brakes:
- `M1_PORTFOLIO_NET_LOSS_STREAK_BRAKE`
- `M1_MULTIMODEL_LOSS_STREAK_BRAKE`
- `M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK`
- `M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED`

Repeated one-minute decisions for the same pair/side/Plan B route
within a 30-minute window are reduced to the earliest episode leader.
The original decision-time stop/target distances are evaluated against
**15 strictly following, verified completed broker M1 bars**.
The system excludes missing and ambiguous paths; it uses only
the historic commission P90 per lot from already CLOSED same-pair
broker fills *before* the candidate timestamp and adds that
commission risk to the stored original spread/slippage cost R.
Missing fee evidence is not imputed to zero.

### Results (exact Nov 10–12 historical study)

| Group | Unique episodes | Evaluable | Positive | Negative | Estimated total net R |
|---|---:|---:|---:|---:|---:|
| All four downstream brakes | 21 | 14 | 6 | 8 | **−3.4926R** |
| Portfolio net-loss brake only | 12 | 6 | 2 | 4 | **−2.6097R** |
| Early reliability loss-streak only | 7 | 6 | 3 | 3 | **−0.2719R** |
| Early transition degraded only | 1 | 1 | 1 | 0 | +0.2745R |
| Early transition degraded + loss-streak | 1 | 1 | 0 | 1 | −0.8856R |

The group labels refer to overlapping restriction flags on the
same episodes. They must not be interpreted as proof that disabling
a particular single gate would have resulted in execution or
a profitable broker fill.

### Key pair-side distinctions

- AUDUSD SELL / TREND_CONTINUATION: 3 observable,
  1 positive, 2 negative, **−0.8925R**.
- EURUSD SELL / TREND_CONTINUATION: only 1 observable,
  stop-first, **−1.145R**; 2 unobservable.
- USDJPY BUY / TREND_CONTINUATION: 5 observable,
  3 positive, 2 negative, **−0.1047R**, 3 separate UTC days.
- USDJPY SELL / CONFIRMED_REVERSAL: 3 observable,
  1 positive, 2 negative, **−0.9175R**.
- AUDUSD SELL / CONFIRMED_REVERSAL: 1 observable,
  negative, **−0.7075R**; 2 unobservable.
- USDJPY BUY / EARLY_TRANSITION: only 1 observable,
  **+0.2745R**, too little to change policy.

By UTC day:
- 10 Nov: 7 episodes, 3 observable, +0.1034R.
- 11 Nov: 6 episodes, 5 observable, −1.5501R.
- 12 Nov: 8 episodes, 6 observable, −2.0459R.

**Missing evidence**: 5 failed the minimum 3 prior same-pair
closed broker-fee samples; 2 lacked all 15 consecutive verified
M1 candles. The 14 measurable outcomes across 3 UTC days are
*not* 14 actual trades, and no modeled fill or tick-accurate
quote sequence is available.

Within the 14 observable episodes, the first-touch midpoint
proxy saw 3 stops first, 2 targets first, and 9 15-minute
mark-to-market exits. This is not the same as the production
SL/TP execution life cycle.

## Decision

**Do not restore unrestricted old downstream entry permissions**.
The observed no-order opportunities had negative aggregate
estimated outcomes; the portfolio brake prevented many additional
loss-making paths. The small approximately breakeven USDJPY BUY
continuation sample is worth prospective shadow monitoring but
does not establish positive after-fee expectancy.

**No execution, size, stop, policy, session, deployment, API or
broker order changes resulted from this audit.** The four
owner-requested executable pairs (EURUSD, AUDUSD, USDCAD, USDJPY)
remain configured as before.

## Research caveats and next milestone

- Hypothetical entry uses next completed broker M1 OHLC **open**.
  It is not a guaranteed immediately executable ASK/BID entry
  at the original decision time.
- Broker OHLC high/low are sampled midpoint extrema; a real
  BUY SL is triggered by BID and a SELL SL by ASK. Even when
  the midpoint does not cross the SL, spread widening might.
- When target and stop cross in the same minute, the result
  is ambiguous and excluded. The measured stop/target risk
  is optimistic relative to tick-based worst-case fills.
- Missing quote or prior fee data is not a trade win/loss.
- One original stop/target geometry is used: stop widening,
  latency, slippage and dynamic risk allocation were not replayed.
- Per-episode R is a risk-normalized **model outcome**; it
  cannot be summed as broker-account USD actual P&L.
- Multiple brake reasons may co-occur; results are not a
  randomized causal experiment.
- Even 3 distinct days are not sufficient for forward strategy
  promotion. Additional independent prospective trading
  sessions and actual after-cost broker fills are required.

**Follow-up:** improve as-of decision/quote coverage and run an
isolated USDJPY BUY continuation shadow candidate with minimum
multi-day sample threshold. Retain all broker risk, portfolio
drawdown, commission, rollover and high-impact-event vetoes.
