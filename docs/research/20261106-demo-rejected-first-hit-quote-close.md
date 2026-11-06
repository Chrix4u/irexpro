# DEMO false-rejection first-barrier audit — 6 November 2026

## The user-facing problem

The last actual cTrader DEMO trade closed on 5 November at 07:19 UTC.
The FULL_AUTO session resumed at 13:05:33 UTC and produced no new
trades despite continuous scanning and fresh broker quotes. The
15-minute price-proxy analysis showed profitable price changes in
many rejected cases. It could not establish whether their original
take-profit was reached before their original stop-loss.

The new audit retains the original candidate.stopDistance and
candidate.targetDistance; joins the last broker quote recorded
before decision to 30 minutes of timestamped broker-native M1
candles; and evaluates side-correct quote-close barrier outcomes.

## Research limitations and fail-closed treatment

- Pinned scanner user, exact cTrader DEMO broker data source and
  AUDUSD/EURUSD/GBPUSD only. Non-ABSTAIN decisions with
  execution_authority NONE; excludes actual broker orders.
- Latest four days, capped at the most recent 4,500 signal
  decisions; only entry quotes at or before decision and no older
  than 180 seconds. Earliest per pair across both sides and all
  M1 routes, separated by more than 15 minutes. No outcome-based
  sampling.
- Requires a complete 31-minute quote path from the decision
  minute. Data gaps, first-minute predecision quotes, and invalid
  prices are unobservable rather than wins.
- BUY uses entry ask and future bid close; SELL uses entry bid and
  future ask close. Original stop and target geometry is preserved.
- The source OHLC high and low represent sampled MIDPOINT prices,
  not true tick-side bid/ask extremes. A conservative midpoint
  wick envelope (2x sampled spread plus one pip) marks possible
  earlier stop/target touches as ambiguous. A TP-first quote close
  cannot prove the exact broker first tick, fill, net outcome or
  stop/target sequencing between samples.
- The extra one-pip scenario is only estimated friction, not
  audited broker commissions or financing. No new model weight,
  execution authority, risk setting or broker call is allowed.

## First anonymized historical snapshot

442 independent attempted entries across four UTC dates, including
95 observations after the November 5 FULL_AUTO session began:

| Observed quote-close path (30-minute window) | Count |
| --- | ---: |
| TP quote-close first, no earlier adverse wick warning | 16 |
| SL quote-close first, no earlier favorable wick warning | 27 |
| Ambiguous possible earlier TP/SL wick | 12 |
| Neither barrier at quote closes | 16 |
| Wick-only or otherwise unresolved path | 19 |
| Unobservable gaps | 5 |
| Total | 95 |

The particular AUDUSD SELL rejected at 14:29 UTC on November 5 used
an as-of entry bid approximately 0.70006, stop distance 5 pips
(stop ~0.70056), and target distance 8 pips (TP ~0.69926).
A sampled ask quote close fell below target at 14:37:59 UTC, with
no earlier possible adverse wick in the conservative envelope.
It therefore qualifies as a TP_FIRST_QUOTE_CLOSE_PROXY example.
Illustrative target is +1.6R gross, or +1.4R after an assumed one
additional pip. Not a verified fill or true after-commission P&L.

The 16 TP-first cases are a credible group of missed opportunities,
but more candidates were observed SL-first, while others remain
unresolved. Picking only winners in hindsight would worsen an
already net-loss-making strategy.

## Deployment boundaries

The SQL is read-only and source-bound; PostgreSQL is explicitly
default_transaction_read_only=on with an 80-second statement timeout.
The Python classifier has no model writes, trading permissions or
account credentials. The existing weekday research script runs
this analysis and retains only a 0600 anonymized JSON report,
removing temporary quote data (CSV). Two incorrectly doubled
shell-continuation backslashes in the previous research challenger
invocation were corrected to keep the weekday workflow functional.

The next step is to compare false-rejected TP-first and SL-first
cohorts by regime, side, timing, predicted economic R and observed
broker costs. An execution-eligible change requires a separate
independent time-split holdout, positive real after-commission
economics and bounded drawdown. This study cannot auto-promote.
