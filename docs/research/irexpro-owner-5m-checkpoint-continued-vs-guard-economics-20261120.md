# iRexPro owner — five-minute checkpoint economics, continued vs guarded trades

**First verified audit:** 2026-11-20 02:20 UTC. Read-only user-scoped Pepperstone cTrader DEMO in USD. Observations from Nov 17 onward. Source code: `apps/api/scripts/audit-owner-demo-5m-checkpoint-economics.cjs`.

## Why this audit was necessary

The five-minute drawdown guard closes trades below -0.40R. Its original 29 broker-signed closures were `AI_CLOSE_SIGNAL` and showed real losses; however, comparing only guard exits to price quotes after the close cannot tell whether they prevented worse losses. We need the **other** side of the cohort: what became of trades whose original five-minute checkpoint was not severe enough to close.

The research uses only owner-scoped, broker-backed `trading.trades`, `trading.post_entry_shadow_observations` at the original five-minute checkpoint, commission/swap/net broker settlement, and immutable `TRADE_CLOSE_REQUESTED` audit records.

## Observed account economics

Five-minute checkpoint cohort, November 17 onward:

| Cohort | Observations | Settled | Winners | Losers | Actual net USD |
|---|---:|---:|---:|---:|---:|
| `NO_ACTION` / continue, score persisted before trade closed | 128 | 127 | 85 | 42 | **-$373.02** |
| Confirmed drawdown-guard close (exact signed close-request audit) | 30 | 30 | 0 | 30 | **-$1,430.71** |
| Broker checkpoint missing / not ready | 3 | 3 | 0 | 3 | **-$188.17** |
| `CLOSE_DEMO` action without the independent close-request proof | 1 | 1 | 0 | 1 | **-$56.76** |

Why the previously reported guard cohort was 29: the owner-scoped close history gained one additional audit-confirmed close before this later check. The broader `CLOSE_DEMO` count is 31, but only **30** have an independent signed matching `AI_CLOSE_SIGNAL` audit event. The unverified event remains separate and is **not** counted as guard-attributed.

These populations are **not randomized**. The 30 early guard closes began from severe adverse price movement at the checkpoint; they are not evidence of what would have happened if the guard had not intervened. Older close-score timestamps are not used for as-of predictive classification.

## Why good win rate does not mean positive expectancy

Of 127 settled, guard-continued trades:

- **85 winners / 42 losers (66.93% win rate)**.
- Gross net-of-fee winners **+$2,832.83**; losses **-$3,205.85**; total **-$373.02**.
- Average winner **+$33.33**; average loser **-$76.33**.
- Mean loser size **2.29x** mean winner; required approximate breakeven win rate **69.60%**, versus actual 66.93%.
- Realized profit factor **0.8836**.

Five-minute observation risk bands of the **guard-continued** sample (this R occurs **AFTER entry**, NOT at proposal):

| 5m current R | Settled | Wins | Losses | Net USD |
|---|---:|---:|---:|---:|
| Below -0.30R | 10 | 4 | 6 | -$399.75 |
| [-0.30R, 0) | 45 | 22 | 23 | -$873.08 |
| [0, +0.15R) | 28 | 19 | 9 | -$413.17 |
| [+0.15R, +0.40R) | 27 | 25 | 2 | +$675.37 |
| >= +0.40R | 17 | 15 | 2 | +$637.61 |

The positive 5m R groups already win and make money. The weak 5m groups have smaller or negative expectancy **even though some recover and eventually win**. This can inform a shadow exit/timing experiment, but **not** automatically justify closing all losing/flat positions at five minutes.

Continued cohort by route:
- **Confirmed Reversal**: 77 settled, 48 winners, 29 losers, **-$706.78** net.
- **Early Transition**: 42 settled, 29 winners, 13 losers, **-$149.91** net.
- **Trend Continuation**: 8 settled, 8 winners, **+$483.67** net. Small and selected sample; continuation route may be paused for other reasons. This is not sufficient to re-enable it.

## Closing reasons and approximation to original barriers

The continued cohort closed by:
- `PROFIT_PROTECTION`: 74 trades, all recorded net winners, **+$2,055.68**. Mean +$27.78.
- `BROKER_CLOSE`: 51 trades, 11 recorded net winners, 40 losers, **-$2,308.86**.
- `AI_CLOSE_SIGNAL`: 2 trades, both net losers, **-$119.84**.

For the 51 `BROKER_CLOSE` records, the broker exit price was:
- **39** within 2 instrument-correct pips of the **recorded** stop-loss level; net **-$2,948.60** combined.
- **8** within 2 pips of the recorded take-profit level; net **+$706.71**.
- **4** not within 2 pips of either level; net **-$66.97**.

These are **price-distance labels**, not proven broker stop/target trigger identities, because a reconciled `BROKER_CLOSE` label alone does not confirm what triggered the broker. Stop changes, slippage or external intervention can change the interpretation. We did **not** rewrite any original SL/TP or infer an executable alternative close.

## Day-split stability check

Continuing trades, UTC day of checkpoint:

| Day | Settled | Winners | Losers | Actual net USD |
|---|---:|---:|---:|---:|
| 2026-11-17 | 43 | 27 | 16 | -$246.81 |
| 2026-11-18 | 18 | 9 | 9 | -$500.68 |
| 2026-11-19 | 61 | 46 | 15 | +$527.02 |
| 2026-11-20, partial | 5 | 3 | 2 | -$152.55 |

A favorable Nov 19 is **not** sufficient evidence for overall improvement. Most other sampled sessions have unfavorable actual expectancy.

## Implemented and verified research-only pipeline

- Repeatable script `apps/api/scripts/audit-owner-demo-5m-checkpoint-economics.cjs`
- Automated regression suite `apps/api/scripts/audit-owner-demo-5m-checkpoint-economics.test.cjs`
- Appended to existing **30-minute read-only** `irexpro-owner-demo-drawdown-guard-postexit-shadow` PM2 worker. No new order-capable timer or service.
- Private current report: `/home/lightworld/webapps/irexpro-research/drawdown-guard-postexit/latest-five-minute-checkpoint-economics.json`
- Private daily archives: `.../drawdown-guard-postexit/daily/YYYY-MM-DD-five-minute-checkpoint-economics.json`
- As-of discipline: five-minute checkpoint timestamp must agree with opened time; `NO_ACTION` score must have source `READY`, valid probability and record/evaluation timestamps before the eventual trade close. `CLOSE_DEMO` requires a separately signed, matching broker close audit. The historical post-dispatch guard score cannot be reclassified as pre-exit.
- Report segments risk multiple, model route, instrument, buy/sell direction, original closure reason, UTC day and original broker stop/target price proximity.
- No model training, no hypothetical broker P&L inventions, no execution authority, no risk gate change.

## Research decision

Keep the five-minute DEMO -0.40R guard in place until genuine walk-forward benefit for an alternative can be demonstrated. The next research test should compare the **pre-entry** features of eventual weak-5m and strong-5m trades using features frozen before order submission, with chronological folds and embargo to prevent leakage. Then test exit outcomes on future sessions rather than optimizing thresholds retrospectively on this small cohort.

The primary present economic issue is **the imbalance between average winning amount (+$33.33) and average losing amount (-$76.33)**, especially for `CONFIRMED_REVERSAL`. Evaluate source of stop distance, spread/commission, target distance and profit-lock giveback separately, without assuming a single indiscriminate exit rule can fix profitability.
