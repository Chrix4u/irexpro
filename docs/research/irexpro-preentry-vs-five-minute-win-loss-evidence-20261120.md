# iRexPro — verified pre-entry formation vs settled win/loss, with later 5m checkpoints

**Audit at 2026-11-20 03:42 UTC.** Owner Pepperstone cTrader, USD DEMO. Research-only. Historical outcomes are observational. **No new executable gate was approved or changed.**

## Why the research matters

We wanted to determine which signal-formation differences **known before opening** distinguish winning trades from losing trades. Earlier results indicated many bad trades from `CONFIRMED_REVERSAL`. We must avoid using later broker P&L, price movement or five-minute AI scores as if they existed when the entry was proposed.

This report uses the **original trade intent + exact linked tactical decision recorded before intent**, compares its pre-intent candidate/ensemble/trained expert information with eventual net broker outcome, and treats the subsequently observed five-minute checkpoint only as a separate later outcome classification.

## Scope and actual economics

From Nov 17 through Nov 20 03:42 UTC:

| Route | Settled | Winners | Losers | Net USD |
|---|---:|---:|---:|---:|
| `CONFIRMED_REVERSAL` | 134 | 65 | 69 | **-$2,156.99** |
| `EARLY_TRANSITION` | 65 | 41 | 24 | **-$549.89** |
| `TREND_CONTINUATION` | 13 | 10 | 3 | **+$321.15** |
| **Total** | **212** | **116** | **96** | **-$2,385.73** |

**All 212 matched the original pre-intent M1 tactical decision** and the saved ensemble strategy. Full net includes recorded commission and swap. For the whole cohort, average winner **+$31.59**, average loser **-$63.03**, profit factor **0.6057**.

By trade entry UTC date:
- Nov 17: 69 trades, net **-$593.01**.
- Nov 18: 30 trades, net **-$740.75**.
- Nov 19: 93 trades, net **-$823.01**.
- Nov 20 partial: 20 trades, net **-$228.96**.

This covers **all closed fills from the requested dates**, not solely trades with usable candle samples.

## Entry-formation evidence and the false-positive problem

The audit reads the original `M1` candidate confidence, aligned M1/M5/H1/H4/M15 conditions, three-candle momentum, candle-body pressure, ensemble plan-B score and meta probability, model consensus, expert state/votes/opportunity and original governance net expected R. Entry decision record and timestamp, intent and trade open time are checked in the order **decision evaluated <= decision recorded <= intent created <= broker opened**.

**No tested historical entry warning replicated under the minimum prior-date and later-date cohort requirements.** In particular:

- `CONFIRMED_REVERSAL` with `M5_DIRECTION_OPPOSES`: 83 flagged trades include **44 losers and 39 winners**. Its loss association varied and reversed in the Nov 20 partial cohort; blanket blocking it would discard 39 actual winners.
- `CONFIRMED_REVERSAL` `PLAN_B_SCORE_LT_064`: 23 flagged trades, **14 losers and 9 winners**, with some association to losses; insufficient consistency and independent later-day evidence to authorize a new cutoff.
- `EARLY_TRANSITION` `M5_DIRECTION_OPPOSES`: 18 flagged include only **4 losers, 14 winners**. Blocking a supposedly opposing signal would have discarded more observed winners than losers.
- The model's independent expert `ABSTAIN` can be present in BOTH eventual winners and losers. Abstention alone does not establish a losing entry.
- Many indicators are correlated; inspecting 20+ possible warnings and multiple route/day groups on the same historical data requires multiple-testing controls and genuinely new prospective market dates.

These are exploratory descriptive associations, **not** independent walk-forward proof. Nov 19 and Nov 20 signals have already been reviewed for other research and are NOT pristine sealed test sets.

## Later 5m context — strictly NOT an original entry feature

Of the 212 closed trades, **135** join a verified, saved `NO_ACTION` five-minute checkpoint whose score and storage timestamps preceded eventual trade settlement. The remaining **77** have missing, unavailable or guard-close-only checkpoints and are excluded from this conditional subset. The `CLOSE_DEMO` historical rows are deliberately not imputed as valid pre-close scores.

The **135 observable continuations** split:
- **Weak or flat** (`current_r < +0.15R` after 5 minutes): 87 trades, 49W/38L, actual net **-$1,585.82**.
- **Strong-positive** (`current_r >= +0.15R` after 5 minutes): 48 trades, 42W/6L, actual net **+$1,281.67**.

Within `CONFIRMED_REVERSAL`:
- Adverse (<0R): 37 trades, **-$984.90** actual.
- Slightly positive (0 to +0.15R): 19 trades, **-$416.21**.
- Strong at +0.15R+: 27 trades, **+$726.66**.

Within `EARLY_TRANSITION`:
- Adverse: 17 trades, **-$368.52**.
- Slightly positive: 9 trades, **+$14.84**.
- Strong positive: 18 trades, **+$240.31**.

This is **conditional post-entry observation**. It is not evidence that any threshold existed before opening, and it **does not prove closing the weak cohort would have improved P&L**. Recovery and stop/target priorities need true tick-accurate after-fee counterfactuals. Not every weak trade lost; weak cohorts contained many winners.

## Implemented research

- Owner-scoped read-only script `apps/api/scripts/audit-owner-demo-preentry-to-5m-outcomes.cjs`.
- Tests `apps/api/scripts/audit-owner-demo-preentry-to-5m-outcomes.test.cjs`.
- Private current report: `/home/lightworld/webapps/irexpro-research/entry-formation/latest-entry-to-five-minute-outcomes.json`.
- Private UTC daily archives: `/home/lightworld/webapps/irexpro-research/entry-formation/daily/YYYY-MM-DD-entry-to-5m.json`.
- Added to preexisting 30-minute `irexpro-owner-demo-drawdown-guard-postexit-shadow` service, alongside after-exit quote path and five-minute checkpoint economics. This reuses the same **read-only** timer; no new broker integration, trading module, live account permission, stop or sizing changes.

### Safe research priorities

1. Prospectively capture entry-time features and independent forecasts **before** order intent with durable timestamps, including candid cases where the tactical advisor abstains.
2. Test explicit market-day-purged pre-entry warnings and compare **both eliminated losers and lost winners**; report after-commission net USD and risk-adjusted R. A majority of losing trades in a selected group is not enough.
3. Independently analyze the typical full loss (`BROKER_CLOSE` often near original stop) versus smaller profit-protection win, before changing stop distance, expected reward or lot size.
4. Keep five-minute -0.4R DEMO guard and candlestick expert execution authority unchanged until new forward evidence supports a tested reversible strategy. Do not promote to LIVE from this cohort.
