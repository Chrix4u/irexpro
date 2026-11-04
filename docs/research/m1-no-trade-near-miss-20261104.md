# iRexPro: broker-native no-trade near-miss study (2026-11-04)

## Decision and scope

This study investigates the recent lack of cTrader DEMO trade openings **without weakening the hard trading gates**. The AI session and connected DEMO broker were ACTIVE/FULL_AUTO; fresh M1 broker-native quotes were present for all six currency pairs. The observed bottleneck was strategy admission: Plan-B regime, distribution drift, after-cost expected return, timing and pair-side reliability.

The reproducible, read-only query is [`apps/api/scripts/audit-m1-near-miss-cohort.sql`](../../apps/api/scripts/audit-m1-near-miss-cohort.sql). Run only against an authorized database connection with read-only permissions:

```sh
psql -X -v ON_ERROR_STOP=1 -f apps/api/scripts/audit-m1-near-miss-cohort.sql
```

It does not create orders, modify risk parameters, update trading state, or write research observations. The existing **VPS No-Trade Diagnostics** workflow also runs the SQL after a successful, gated staging deploy, against the exact checked-out staging script. Its output reports only aggregate route counts and hypothetical R metrics, not user/account identifiers. Missing scripts or unavailable DB access are reported as skipped/failed diagnostic observations, never used to bypass deployment risk gates.

## Cohort and as-of integrity

- cTrader DEMO, executed-authority **NONE**, non-ABSTAIN M1 decisions during the preceding six hours and at least 25 minutes old;
- M1 decision-time estimated net expectancy at least **+0.08R**; valid stop distance, target distance and estimated spread-cost R recorded at the decision;
- take one first decision per broker account / instrument / side / M1 route / 20-minute UTC calendar bin, selected **before** looking at future prices; bins reduce repetition but **do not establish independence** near boundaries or across correlated pairs;
- reconstruct 15 future **complete** broker-native M1 quote-candle buckets, each with a positive independently recorded live quote and last quote timestamp within its own minute; require all 15 consecutive minute buckets;
- use the first future bar's open as a **midpoint proxy** entry, the decision's original stop/target distances, and first barrier touched (TP or SL); same-minute dual touches are ambiguous, incomplete sequences are data gaps, and no barrier yields a 15-minute mark-to-market;
- subtract the persisted estimated spread-cost R. Report extra **0.10R** and **0.20R** cost stress scenarios; those are hypothetical additions, not broker-verified commission forecasts.

Historical prices are used **only to grade** a decision made with earlier information. They must never be used as model inputs at that decision time.

## Initial exploratory run

A verified run on November 4, 2026 produced:

| M1 route | Calendar-bin samples | TP first | SL first | 15-min MTM | Data gaps | Mean spread-adjusted R | Mean with additional 0.10R |
|---|---:|---:|---:|---:|---:|---:|---:|
| Early transition | 107 | 15 | 32 | 60 | 0 | +0.088 | **−0.012** |
| Trend continuation | 43 | 1 | 17 | 25 | 0 | **−0.497** | −0.597 |
| Confirmed reversal | 1 | 0 | 0 | 1 | 0 | +0.050 | −0.050 |

Of these binned candidates, **9/107** early-transition and **5/43** continuation decisions were marked Plan-B paper admitted at the time; therefore it would be misleading to treat the M1 positive expectancy as full Plan-B admission.

This is an exploratory counterfactual, **not profitable trading evidence**. TP/SL barriers are midpoint candle touches, not executable broker fills; spread-cost estimates can omit cTrader commission, financing, conversion, stop slippage, latency and revised lot-size effects. A six-hour window is neither a holdout set nor an independent trading trial. Multiple routes/sides may be exposed to the same market move. Average R can be dominated by mark-to-market episodes. The small early-transition edge disappears with a modest added-cost assumption.

## Technical findings and safe next steps

1. **Do not bypass trend-continuation drift/Plan-B gates.** Positive M1 estimates in the blocked cohort did not translate into favorable 15-minute first-barrier outcomes.
2. **Research early transition separately.** Compare cohorts by pair, side, trade time, event-risk status, high-conviction expert alignment and pair-side reliability. Confirm commission, spread and stop-loss fill assumptions using cTrader broker records.
3. **Use chronological forward-only experiments**, with fixed predeclared route thresholds, a withheld evaluation period, and account-currency after-cost net P&L. Record actual broker-native quote paths and ambiguous/unobservable outcomes. Do not use future outcomes to select which decisions enter the cohort.
4. **Keep absolute stop-loss, emergency adverse-close, kill-switch, exposure, economic expectancy and daily-loss rules intact.** No new DEMO or LIVE authority is justified by this study.
5. **Require demonstrated incremental after-cost expectancy and controlled drawdown** before proposing a separate, reviewed DEMO execution experiment. Verify broker stop-amendment and partial-close reconciliation first.

Research artifact only. No DEMO/LIVE policy promotion occurs by adding this report.
