# Why iRexPro stopped opening reversal/early-transition trades — 16 November 2026

**Owner scope:** active Pepperstone cTrader **USD DEMO**, read-only PostgreSQL
audit after last confirmed closed trade at 15:17:52 UTC/Ghana.
**Market window:** 15:17–21:00 UTC, before the 21:00–00:00 counter pilot.

## Verified signals — not broker order or actual trade counts

| Category | Repeated model checks | Plan B admitted and governance eligible | Broker authorized |
| --- | ---: | ---: | ---: |
| CONFIRMED_REVERSAL | 60 | 60 | 0 |
| EARLY_TRANSITION | 11 | 11 | 0 |
| TREND_CONTINUATION | 2,670 | 29 | 0 |

The last actual AUDUSD SELL trade opened 15:11:22 UTC and
**closed 15:17:52 UTC**. It was a **loser**, and historical
models with zero orders after this point do not demonstrate profitability.

For the 71 alternate strategy checks:
- Model Plan B and governance **both accepted 71/71**.
- M1 timing classification was **ABSTAIN 53**, **M1_EARLY_TRANSITION 15**,
  and **M1_TREND_CONTINUATION 3**, but did not match the Plan B route
  required by the older execution authority.
- The final trained broker-native expert gave **zero CONFIRM** outcomes:
  it labeled opportunity ABSTAIN even when its directional votes agreed.
  Expert direction agreed in **32** scans and opposed in **39**.
- Scanner blockers included
  `MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED` 60 times and
  `MULTIMODEL_EARLY_TRANSITION_NOT_M1_CONFIRMED` 11 times.
  Some also had a separate M1 pair-side degradation warning.
- A retrospective *screening* of these same 71 checks, holding normal
  Plan B admission, governance, positive estimated after-cost R >=0.12,
  valid broker-native spread, M1 confidence >=0.67 and directional
  score >=0.55, positive independent stop/target geometry, and an aligned
  native expert majority with probability score >=0.25, yields
  **18 historical scan checks** (15 reversal, 3 early transition).
  They are repeated decisions, NOT realized profits or 18 independent
  fills. This figure is retrospective and is not proof the strategy
  will be profitable prospectively.

## Root cause and the limited correction

The original approach stacked three different approvals for essentially
the same fact: Plan B successfully recognized a reversal/early transition,
but the M1 route label (timing specialist) still had to repeat the precise
Plan B strategy and the independent expert had to reach a final CONFIRM
despite its expert opportunity model classifying everything ABSTAIN.

The **new** `pepperstone-demo-advisory-alternate-trial.ts` is an
opt-in, limited **DEMO-only** bridge. It allows a properly admitted
reversal/transition even when M1 route is ABSTAIN or M1_EARLY_TRANSITION
and the independent expert finishes ABSTAIN, *only when expert directional
votes agree >=2/3*, native/fresh, opportunity probability >=0.25.
The model's own after-fee R, spread, M1 direction-quality, independent
stop and target, no OOD drift and broker risk remain mandatory.

**Frozen upcoming window:** Tuesday **17 November 2026 15:00–20:00**
Africa/Accra (UTC). **At most four DEMO tagged intents**, max **4.00
lots**, always subject to the unchanged **0.25% of allocation stop risk**
and broker margin/currency exposure checks. This is a ceiling, not a
promise of 4 lots or four entries. It never targets LIVE, never
automatically closes opposite positions, never replays old scans,
does not re-enable trend continuation, and self-expires at 20:00.

The earlier Monday late-evening COUNTER pilot is independent and still
expires at 00:00. The 21:00–23:15 market produced mostly ROLLOVER_RISK,
OOD drift, weak after-cost estimates, and no counter orders. Do not
disable market-risk gates to force activity in that environment.

## Evaluation and release requirements

Regression test both a valid advisory expert ABSTAIN path reaching the
existing risk/broker dispatch and fail-closed invalid signals, timestamps,
broker identity and cost/spread. Require successful API type-check,
complete build, owner-scoped DEMO preflight and backup. Audit actual
`trading.trade_intents` and `trading.trades` with
`m1_pepperstone_demo_advisory_alternates=true` after the pilot; a
screened signal is not a broker fill. Do not confuse estimated positive
R with net actual money earned after commission, slippage and swap.
