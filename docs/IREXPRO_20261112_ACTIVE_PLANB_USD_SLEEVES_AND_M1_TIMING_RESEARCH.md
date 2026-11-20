# iRexPro Plan B — November 12 intraday entry timing and actual broker profitability
**Read-only research, live connected Pepperstone cTrader DEMO USD account.**

## Corrected operational audit

The legacy Plan B realized-sleeves research utility targeted a `ctrader`
broker and an `EUR` ledger. It cannot represent the current owner-bound
`pepperstone-ctrader` FULL_AUTO DEMO account in USD. We did NOT overwrite
the old EUR report. A new operational audit lives at:

`apps/api/scripts/audit-active-planb-primary-sleeves.cjs`

Run manually from `apps/api`:
`node scripts/audit-active-planb-primary-sleeves.cjs`

It uses a REPEATABLE READ READ ONLY transaction; discovers the ACTIVE
FULL_AUTO, CONNECTED, ACTIVE-authorized DEMO owner connection (not stale
M1 market data config), reads the actual currency and a bounded 21-day
broker closed-trade ledger, and groups ONLY
`multimodel_execution_authority_path='PRIMARY_PLAN_B'` intents.
Incomplete broker gross/commission/swap stays visible as UNPRICED,
never imputed to zero or silently promoted. It writes a mode-0600
PRIVATE report to
`/home/lightworld/webapps/irexpro-research/active-planb-sleeves/latest.json`.
It neither grants execution nor changes broker orders.

Run on 2026-11-12 UTC: 43 fully priced PRIMARY_PLAN_B closes,
**3 separate trading days**, net **−$1,258.72 USD**,
gross **−$449.92**, paid broker costs **−$808.80**,
net profit factor **0.68**, 17 net winners and 26 net losers.
Total sample is concentrated in only 3 days, so no broad
performance or future profitability claim is supported.

By Plan B strategy:
- TREND_CONTINUATION: 33 closes, net **−$1,301.95**, PF **0.57**.
- CONFIRMED_REVERSAL: 7 closes, net **−$44.72**, PF **0.94**.
- EARLY_TRANSITION: 3 closes, net **+$87.95**, PF **1.44**, only 1 day.

Promising historical pair-side-sleeves, NOT validated promotions:
- AUDUSD SELL TREND_CONTINUATION: 7 closes, 5 net wins, 3 trading days,
  **+$322 net**, PF **2.28**.
- EURUSD SELL TREND_CONTINUATION: 4 closes, 3 net wins, 2 trading days,
  **+$346 net**, PF **4.09**, insufficient distinct days.
Other sleeves, especially GBPUSD and USDCHF, generated larger losses.
The active display had already been narrowed to EURUSD/AUDUSD.

## Why not force more reversal orders

Separate existing read-only 15-completed-minute first-touch study:
`apps/api/scripts/audit-planb-m1-timing-counterfactual.cjs`

Exact 2026-11-12 14:00–22:47 UTC scope:
- 2,073 decisions, 3,167 completed cTrader quote candles,
  29 de-duplicated Plan B admitted-but-M1-timing-rejected episodes.
- 27 `TIMING_ONLY`: 21 evaluable, 9 net-positive and
  12 net-negative, aggregate **−1.1225R**.
- 23 CONFIRMED_REVERSAL: 17 evaluable, 6 positive,
  11 negative, aggregate **−3.7775R**.
- 3 TREND_CONTINUATION: all evaluable, 2 positive,
  1 negative, aggregate **+0.545R**.
- 3 EARLY_TRANSITION: 2 evaluable and 2 positive,
  aggregate **+3.125R**, one unobservable.

**These are hindsight counterfactuals, NOT actual fills or
forward-validated edges.** Multiple episodes remain temporally
correlated. Both path and commission assumptions can differ from
real cTrader fills. In particular, relaxing M1 confirmation
for every Plan B confirmed reversal would include many historical
stop-first losses. Small positive subgroups are research hypotheses,
not authorizations.

## What was NOT changed

- No M1 route relaxations, no forced broker orders, no SL/TP/lot
  changes, no risk cooldown overrides.
- No false claim that the 0.01-lot QUALIFIED_CONTINUATION loss
  contaminated primary Plan B's loss brake. That one used
  `external-irexpro-m1-tactical`; all 43 primary fills used
  `external-irexpro-multimodel-ensemble`, and the current
  primary brake already filters by that exact strategy code.
- Independent M1 promotion probation, after-cost risk accounting,
  session/rollover gate and broker stop controls remain intact.

## Next safe milestone

Collect prospective primary Plan B decisions and real after-fee
closed trade outcomes for at least 10–12 distinct trading days.
Evaluate EURUSD/AUDUSD pair+direction+strategy separately,
including FIRST TOUCH of stop before later directional payoff.
Do not promote a trend/reversal route based on 1–3 days or
boost trading size to compensate for recent losses.

Report tests: 8 passing `node --test` cases, current owner isolation,
currency, signed commission/swap, incomplete fees, history truncation
and proof the research can never change execution authority.
