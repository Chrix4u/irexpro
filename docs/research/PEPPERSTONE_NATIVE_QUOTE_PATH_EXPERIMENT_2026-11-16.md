# Pepperstone DEMO native-quote observation and sampled exit-path experiment
**Start:** 16 November 2026, approximately 19:01 UTC/Ghana.
**Status:** separate research sidecars, owner-scoped, no broker order authority.

## Finding
The Pepperstone quote-candle table preserves aggregate M1 midpoint OHLC,
positive-spread sample counts, and only the **last** positive bid/ask quote
and timestamp for each minute. Historical within-minute ordering has
already been discarded. Around 18:58 UTC all six major pairs had active
native quotes, with approximately 11–50 positive spread samples per minute,
depending on instrument. Aggregated M1 OHLC **cannot** prove stop-loss
and take-profit ordering at tick resolution.

## Collector
- Code: `apps/api/scripts/collect-pepperstone-native-quote-snapshots.cjs`
- Unit tests: `collect-pepperstone-native-quote-snapshots.test.cjs`
- Process config: `irexpro-native-quote-shadow.pm2.config.cjs`
- Private observations:
  `/home/lightworld/webapps/irexpro-research/native-quote-snapshots/YYYY-MM-DD.jsonl`

The observer polls the **already persisted** M1 data every 2 seconds; it
does **not** ask the broker for additional quotes or restart the API/AI
engine. A row is saved only when its cTrader-native observation has
positive spread, valid bid below ask, an instrument on the six-major
allowlist, timestamp within the M1 bucket, and no more than 10 seconds
between quote sample and observer time. Each row is:
`[nativeSampleAt,observerAt,instrument,bid,ask]`.
No owner UUID, broker connection ID, secret or token is persisted.

The owner and broker identity are checked on **every read** through an
active full-auto USD Pepperstone cTrader DEMO session. Reads use
`BEGIN READ ONLY`; collection writes only to private local research
JSONL, never to production database tables.

Safety: one process, 2-second cadence, 36 MiB/day upper bound, 7-day
raw snapshot retention; only date-named files are pruned. File mode
0600, directory mode 0700. Dates above the limit stop writing and
report `DAILY_BUDGET_REACHED`.

**This is a time-stamped *sampling* system, not guaranteed tick-complete
history.** Database polling can skip multiple quotes between polls.
It only works **after its activation**; earlier historical price paths
cannot be reconstructed by claiming these snapshots existed.

## Independent sampled-path auditor
- Code: `apps/api/scripts/audit-pepperstone-sampled-exit-path.cjs`
- Tests: `audit-pepperstone-sampled-exit-path.test.cjs`
- Process config: `irexpro-sampled-path-shadow.pm2.config.cjs`
- Private report:
  `/home/lightworld/webapps/irexpro-research/native-quote-snapshots/latest-path-report.json`
- Immutable day archives after 00:20 UTC:
  `.../native-quote-snapshots/finalized-path/YYYY-MM-DD.json`

The auditor consumes the existing frozen forward-direction-cohort
(`START=2026-11-16T17:50:00Z`). It cannot change forecast selection,
the user's Pepperstone demo trade session, broker orders, or risk gates.
It only evaluates eligible *future* episodes with fresh as-of snapshots.

For each episode the entry is **the first saved broker sample no later
than 12 seconds after the actual decision time**. A selected BUY enters
at ASK and hypothetical SELL at BID; exits always use the correct
opposite quote side. Each side has its own hypothetical mirrored initial
risk/target distance. It scans subsequent sampled prices chronologically
to report the first **observed** stop or target level.

Every 3/5/10/15-minute fixed-hold counterfactual includes the observed
spread through bid/ask sides, plus $6/standard-lot commission and 0.2 pip
extra slippage. A missing entry or missing timely exit mark is `UNKNOWN`,
not zero P&L or a profit. Gaps >10 seconds are prominently labeled.
Even an observed stop level is **not a confirmed executed stop fill**,
and `NO_TOUCH_OBSERVED` is not proof no stop occurred between samples.

The report is grouped by day, route and horizon to support later
multi-day comparisons, but single-day after-the-fact observations
do not validate a prospective trading edge. Daily snapshots are
immutable, first created only after the full last day's 15-minute
outcomes mature, and are never overwritten.

## Existing demo authority, unchanged
- The owner-requested Pepperstone DEMO TREND_CONTINUATION pause remains
  `enabled`.
- Confirmed reversal / early transition remain subject to the
  independently verified M1, cost and broker gates.
- Existing COUNTER and forward-direction evaluation remain
  **SHADOW ONLY**, with `placesOrders=false` and
  `modifiesExecution=false`.
- **NO LIVE account trades and no forced reverse orders.**

## Baseline actual broker economics (74 closed Nov 10–16)
10 Nov: 17 trades, 5 wins, -$442.35, PF 0.791.
11 Nov: 19 trades, 10 wins, -$396.20, PF 0.712.
12 Nov: 8 trades, 2 wins, -$421.16, PF 0.050.
13 Nov: 20 trades, 13 wins, +$170.35, PF 1.588.
16 Nov: 10 trades, 2 wins, -$313.36, PF 0.315.
Five sessions: 32W/42L, net -$1,402.72, PF 0.701.
Friday alone was profitable. Prospective multi-day profitability is
not established by this one-day research experiment.
