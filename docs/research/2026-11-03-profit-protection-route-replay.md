# iRexPro profit-protection route replay — staging evidence (2026-11-03)

## Authority and scope

Research-only analysis of *existing* cTrader DEMO `profit-protection-counterfactual-v1` observations and immutable closed-trade records. No part of this work changes a trading order, exit rule, position size, broker connection, stop loss, take profit, or LIVE/DEMO execution authority.

Read-only PostgreSQL queries were executed against the staging database on 2026-11-03 around 17:13–17:19 UTC. Values below are grouped and anonymized. This is historical observational evidence, not a causal or future-profit guarantee. Monetary totals below relate to EUR accounts only. **Do not interpret as LIVE results.**

## Last 48 hours — closed-trade economics

The 36 EUR-denominated CLOSED trades with `closed_at >= now() - interval '48 hours'` yielded:

| Close reason | Trades | Wins / losses on gross | Gross realised EUR | Absolute commission EUR | Net after explicit costs EUR |
| --- | ---: | ---: | ---: | ---: | ---: |
| AI_CLOSE_SIGNAL | 16 | 0 / 16 | -51.38 | 23.54 | -74.92 |
| PROFIT_PROTECTION | 14 | 14 / 0 | +76.52 | 17.79 | +58.73 |
| BROKER_CLOSE | 6 | 1 / 5 | -29.43 | 8.80 | -38.23 |
| **Total** | **36** | **15 / 21** | **-4.29** | **50.13** | **-54.42** |

Signed swap was zero. The financial formula follows the production `execution-read.service.ts` convention: gross `realised_pnl - ABS(commission) + signed swap`. Spread is already embedded in execution P&L and must **not** be subtracted twice.

These figures show that the system is losing money after costs despite 14 positive profit-protection exits. The AI-close cohort is the largest negative segment and warrants entry/exit attribution before any increased lot sizing.

## Four-hour profit-protection counterfactuals

The tracer has 76 evaluations within seven days, evaluated between 2026-10-31 23:14 UTC and 2026-11-03 06:05 UTC, all currently EUR-denominated.

- TP_FIRST: 52
- SL_FIRST: 20
- DATA_GAP: 4
- AMBIGUOUS_SAME_M1: 0
- NEITHER_4H: 0

Resolved TP-first share = 52 / (52 + 20) = **72.2%**. This excludes data gaps and any ambiguous bars. The replay asks *which original barrier would have been touched first within four hours after the protected close*. It does not simulate a realizable order fill.

### Smaller protected profit (gross positive P&L up to 6 account-currency units)

| Strategy route | Total | TP first | SL first | Data gap | Mean actual gross exit R (resolved) | Mean hypothetical barrier R (resolved) | Mean difference R |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| EARLY_TRANSITION | 26 | 19 | 7 | 0 | +0.415 | +0.910 | **+0.495** |
| TREND_CONTINUATION | 21 | 8 | 10 | 3 | +0.487 | +0.162 | **-0.324** |
| CONFIRMED_REVERSAL | 6 | 6 | 0 | 0 | +0.323 | +1.544 | **+1.221** |

**Interpretation:** A universal delayed exit policy would be dangerous. In this limited sample, the small-trade Trend Continuation group benefited from closing early (negative hypothetical hold delta), whereas Early Transition and Confirmed Reversal might have left theoretical opportunity on the table.

The original barrier R is computed as `abs(original TP - entry) / abs(entry - original SL)` for TP_FIRST and `-1R` for SL_FIRST. Actual exit R is traced from recorded realized P&L divided by risk at entry. These are **gross** risk-unit comparisons; even though round-trip commission may be similar for both exits, later slippage, spreads, stop changes, financing, path uncertainty and model regime risk are not captured. Missing entry-risk data must be excluded from `R delta` denominator.

## Readiness status after cTrader collector deployment

SHA `ae90fb4f64c114459c5ac4e62f6e5103884bee55` successfully deployed on staging at 2026-11-03. The 17:13 UTC read-only query found positive broker quote observations over 30 minutes on all six pairs (200–306 per pair), fresh quote timestamps, and closed M5/M15 context inside the existing freshness windows. Candle `bucket_time` is an **opening** timestamp, so calculate context age from `bucket_time + timeframe`, not from `bucket_time` alone. Avoid false stale conclusions.

Recent decisions still show governance blockers such as `PAPER_NET_EXPECTED_R`, `DRIFT_OUT_OF_DISTRIBUTION`, `ENSEMBLE_NOT_PAPER_ADMITTED`, and timing checks. Market-data recovery does not imply any setup is profitable or admitted.

## Implemented in this PR

Read-only improvements to `GET /trading/reports/profit-protection-exit-quality`:

- Group small protected exits separately for each `strategy_route`.
- Report total/resolved/comparable denominators, TP_FIRST/SL_FIRST counts, TP-first percentage *only among resolved outcomes*, and average theoretical hold-versus-protect R delta.
- Separate missing TP/SL ordering from missing R inputs, so null R is not silently treated as zero.
- Display route-level evidence in the web Profit Protection Exit Quality screen with explicit research-only disclaimers. Monetary values remain separate by currency.
- No database migration or broker/AI strategy changes.

## Controlled next steps

1. **Prospective shadow-only comparison:** log what each route-specific delayed-protection candidate would have done *at the original decision time*, including new protection thresholds, adverse path, stop integrity, maximum giveback, and quote execution costs. No intervention during this evidence phase.
2. **Segmentation and validation:** stratify by pair, side, session, volatility, model version, close reason and broker costs; use separate chronological calibration/validation/future holdout windows; report sample sizes, uncertainty intervals, drawdown and cost-adjusted expectancy.
3. **Early Transition:** inspect negative expectancy and short-duration AI_CLOSE_SIGNAL losses before any admission expansion. Eight trades from a prior 24h snapshot are insufficient for a global execution veto.
4. **Promotion:** retain paper shadow until an independently verified, out-of-sample and prospective DEMO-only candidate improves after-cost expected R without violating risk or drawdown limits. No default LIVE rollout. A deliberately small position is preferable to an unvalidated high-lot automated exit change.

Linked investigation: #573; independent z.ai review brief: `review/zai-model-productivity-20261102`.
