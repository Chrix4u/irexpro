# Expanded cTrader DEMO first-hit model experiments — 6 November 2026

## Why this matters

iRexPro remains in a long DEMO no-entry period. Previous replay work
showed favorable price moves and one strong AUDUSD missed-TP case, but
none established that the current strategies have positive *prospective*
after-broker-cost expectancy. PR #647's first-hit classifier used only
a short selection of rejected M1 events, primarily three completed UTC
trading dates. This study tests whether additional trusted earlier
candles and market-state features improve out-of-time selection.

## Critical source-provenance distinction

The configured cTrader DEMO account has broker-native M1 candles back
to 27 October. Many older candles have populated bid/ask *closing*
prices, valid midpoint OHLC and sample counts, but a NULL
last_quote_sample_at. Those rows cannot be treated as timestamped
broker quotes. The expanded source query therefore admits a historical
candle only after its minute has **fully closed** and explicitly
labels its last-quote time as a **COMPLETED_CANDLE_END_PROXY**.
It never labels that time as a witnessed exact tick. The original
recent exact-timestamp first-hit study remains separate.

Source only: exact configured scanner user, exact cTrader DEMO connection,
three eligible pairs, broker-native M1 candles, non-executed model
candidates and read-only PostgreSQL. Fixed 16-minute UTC, earliest-per-
pair/bucket as-of sampling reduces load, then the existing Python
>15-minute-per-pair de-overlap runs across all routes and directions.
Selection is never based on price result, admission outcome or predicted R.
14-day window and newest-first capped 4,500 candidate buckets. Every
30-minute path requires original stop and target, side-correct quote
closes and conservative midpoint wick ambiguity checks.

Research snapshot: **1,607** distinct source rows across nine UTC dates;
after validation and cross-route/pair de-overlap **1,063**
independent opportunities, including **700** with at least one
candle-close timing proxy and **363** with observed last-quote
timestamps. The eighth completed date precedes the partial November 6
day. There is no inference of tick-side first hits or actual fills.

## Two fixed model variants

Both are L2-regularized logistic regression classifiers, fitted only
to *earlier* TP-first/SL-first quote-close resolved outcomes (not to
censored cases), with C=0.25 and no performance-based re-tuning of
that hyperparameter or the 20% selection fraction.

- **Baseline**: original as-of pair, side, route, regime, admission
  reasons, predicted net R and original reward-to-risk information.
- **Enriched**: baseline plus 20 whitelisted as-of numeric
  technical/ensemble measurements including EMA separation and slope,
  aligned M1/M5 momentum, M30 efficiency, M5 run/expansion, direction
  and breakout quality, ensemble scoring, trade/exit/side/session
  quality, meta probability, and as-of ATR/spread. Missingness is
  explicit; values are clipped to predeclared plausible ranges.
  The feature scaler fits on the historical training fold **only**.

Both variants are tested on the next completed UTC trading date with a
35-minute embargo before it and a fixed top-20%-by-predicted
expected-R selection. No outcome, next price or later market-state
field is available to a selection. The partial current day is never
the holdout.

## Results: five forward-in-time test folds

Eligible holdout dates: October 30 and November 2, 3, 4, 5.

| Pooled unseen holdouts | All candidates | Baseline top 20% | Enriched top 20% |
| --- | ---: | ---: | ---: |
| Candidates | 725 | 143 | 143 |
| TP-first quote-close indications | 92 | 19 | 24 |
| SL-first quote-close indications | 185 | 40 | 42 |
| Ambiguous, incomplete or unhit | 448 | 84 | 77 |
| Estimated R among resolved only | -0.3365 | -0.3627 | -0.2545 |

The enriched challenger **improves the estimated resolved-only result
relative to the previous challenger**, but remains **negative**,
and even the all-candidate cohort is negative. The enriched model
underperformed the baseline on November 4. Its pooled pessimistic
mean R assuming censored outcomes all stop is approximately -0.76R;
the optimistic counterpart assuming all censored outcomes reach target
is around +0.64R. The enormous gap demonstrates insufficient
path certainty, not an established profit opportunity.

The newest completed day's holdout (November 5) was 172 candidates:
baseline top 34 had 6 TP / 11 SL / 17 unresolved, with -0.2824R
resolved mean; enriched top 34 had 8 TP / 13 SL / 13 unresolved, with
-0.2095R. These results are only historical quote-close proxies.
Real broker commission, financing, slippage, stop/target tick
ordering and fill eligibility are NOT reproduced.

## Release and protection boundaries

This work updates ONLY the research SQL, ephemeral feature training,
aggregate private reporting and the preexisting scheduled
read-only research workflow. First-hit exact-timestamp reports
continue to be computed separately. The extended source export is
private, temporary and removed; only a small anonymized JSON report
is retained in the configured private research directory. The new
model's weights are NEVER saved or registered. Neither classifier can
start trading, place orders, promote a sleeve, change lot size,
change a model's live scores, bypass governance, or change stop logic.

The model remains **NON-EXECUTING RESEARCH** even if later reports
look positive. Meaningful progress requires many more independent
verified market days, full broker-side quote/tick path recovery,
actual after-commission/financing economics, and strong positive
purged holdout performance with drawdown control before proposing
a separately reviewed tiny DEMO-only canary.

No profitability or increased trade frequency is claimed.
