# iRexPro — Profitability vs Engineering Progress
**Broker-backed baseline, 19 November 2026, approximately 02:44 UTC (Ghana)**

## Executive decision

The system is technically functional: active Pepperstone USD DEMO FULL_AUTO session, verified broker execution, strategy routing, profit-protection closures, and independent USD/candlestick/entry research. **It has not shown a viable positive after-cost trading edge.**

Across **121** settled Pepperstone USD DEMO trades (from 16 Nov 00:00 UTC to the frozen audit):
- **61 wins, 60 losses** = **50.41%** settlement win rate.
- **Realized net after broker commissions and swaps: -$1,859.45.**
- **Broker gross before commission: -$592.25**; commissions **-$1,267.20**.
- **Profit factor 0.529**, far below the project gate of **1.15**.
- Frozen original Plan-B `multimodel_plan_b_expected_r` mean **+0.3242R** vs actual broker-net payoff divided by pre-entry `finalRiskAtStop` mean **-0.2833R**.
- The two R metrics are **not identical forecast targets**, because trade exit policy, fills, risk and forecast horizons differ. The sign and magnitude mismatch is nonetheless strong evidence to investigate **forecast calibration AND exit-policy behavior**. It is not proof that one code bug explains the result.

| Route | Settled | Wins | Profit factor | Net USD | Mean Plan-B expected R | Mean realized broker-net R |
|---|---:|---:|---:|---:|---:|---:|
| Confirmed Reversal | 64 | 33 | 0.5688 | -856.75 | +0.2777 | -0.2455 |
| Early Transition | 45 | 25 | 0.5383 | -692.24 | +0.4098 | -0.2477 |
| Trend Continuation | 12 | 3 | 0.3218 | -310.46 | +0.2509 | -0.6179 |

**19 Nov after midnight**: 12 settled, 4 winners and 8 losers, **-$212.33** net. Confirmed Reversal accounted for 11 trades, **-$212.00**. Four Confirmed Reversal profit-protection wins made **+$165.88 net**; two AI_CLOSE_SIGNAL losses total **-$71.40**; five BROKER_CLOSE losses total **-$306.48**. The latter label is not sufficient to conclude stop-loss versus another broker closure trigger.

## Additional investigation

- Read-only 15m M1 timing replay on 19 Nov: 39 timing-rejected candidate episodes, of which 36 were evaluable; estimated combined outcome **-3.1325R** (including overlapping groups). Confirmed Reversal alone: 30 episodes, 28 evaluable, 12 positive, 16 negative, **-2.535R**. Counterfactual episodes **are not broker fills or trade P&L**.
- Initial retrospective six-pair USD-strength signal was near chance and negative after indicative spread. Forward USD prediction performance has only one day's data, and the separate new-trade attribution observer has no post-activation broker settlements yet. This cannot authorize a feature or an entry veto.
- The 0.25R profit-protection observer has not yet recorded a verified prospective lower-peak crossing. Historical AUDUSD's peak is insufficient proof of a realizable alternative exit.
- Grouped USD-correlated entries mean multiple losing positions can represent one directionally concentrated view. Do not treat the raw number of currency pairs as independent positions.

## Measurable next development priorities

1. **Model calibration, not more trade permissions.** Compare the Plan-B forecast score and meta probability at order time with subsequently net-settled outcomes, grouped by route, pair, session and volatility. Test candidate recalibration on purged chronological holdout market days, not in-sample fills alone.
2. **Entry timing.** Evaluate Early Transition and Confirmed Reversal early-entry signals against market evidence available **before** order submission. Compare delayed-price opportunities with realized winners as well as losers; avoid blanket removal of all unconfirmed entries.
3. **After-cost economics.** Verify broker commission, spread and slippage are all accounted for at entry. Position sizing already has a historical commission reserve, so do not double-charge it; separate spread-only diagnostics from actual after-cost P&L.
4. **Profit capture.** Continue prospective 0.25R versus 0.50R decision-time observation. A historical favorable peak is not a broker-executable close.
5. **Correlated USD exposure.** Measure stop-risk-weighted positions expressing the same USD view. An informational concentration alert could be useful; no new automatic owner DEMO pause has been authorized.
6. **Promotion evidence.** Do not consider LIVE until verified forward profitable performance meets the existing project thresholds (including profit factor >=1.15, positive folds, Sharpe >=1, and <=12% drawdown), with a sufficiently large independent after-cost evaluation.

## Implementation

Reproducible, bounded owner-account audit:
- `apps/api/scripts/audit-owner-demo-realized-vs-predicted-r.cjs`
- `apps/api/scripts/audit-owner-demo-realized-vs-predicted-r.test.cjs`
- Private report: `/home/lightworld/webapps/irexpro-research/model-expectancy-calibration/latest-report.json`

The auditor joins each **settled broker position** to its original trade intent and **pre-entry** capital allocation using an exact Pepperstone **USD DEMO** broker connection and authorized owner ID. It runs in `REPEATABLE READ READ ONLY`, fails on incomplete financials, never conflates model estimated spread cost with actual commission, never silently truncates, and does not alter the live AI, stop/start session, broker orders, strategies, position sizing, risk gates, or LIVE permissions.

Commands:

```sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/audit-owner-demo-realized-vs-predicted-r.test.cjs
node scripts/audit-owner-demo-realized-vs-predicted-r.cjs
```

**Interpretation:** Engineering is progressing, but the current trading system is **not financially qualified**. Future development should be judged by improvements in net expectancy, profit factor and independently verified performance—not trade frequency, model activity or the number of research observers.
