# iRexPro — why entries collapse in the Ghana afternoon and evening
**12 November 2026 | Pepperstone cTrader DEMO | Verified at 18:42–18:52 UTC**

## Correcting the earlier missed diagnosis

The user repeatedly observed no trades from about **13:00 to 01:00 Ghana time
(GMT = UTC)**. Earlier investigations focused on M1 thresholds, broker quote
capture and individual recent vetoes but did not aggregate the actual
decision-to-approval funnel by UTC hour. That omission was material.

The PostgreSQL service session reports `America/Toronto`, **not UTC**.
For historical analysis always extract `evaluated_at AT TIME ZONE 'UTC'`
before calculating local Ghana hours. Casting `date_trunc('day',timestamptz)`
or `extract(hour from timestamptz)` directly yields Toronto-local buckets
and is inaccurate for this question. The application TypeScript `getUTCHours`
already uses correct UTC semantics.

## Actual scanner findings, 12 November

In the two currently active instruments, EURUSD and AUDUSD:

| UTC/Ghana hour | M1 evaluations | Plan B paper-admitted | Actual execution approvals |
|---|---:|---:|---:|
| 12:00–12:59 | 240 | 35 | 0 |
| 13:00–13:59 | 240 | 35 | 0 |
| 14:00–14:59 | 240 | 25 | 0 |
| 15:00–15:59 | 240 | 15 | 0 |
| 16:00–16:59 | 240 | 1 | 0 |
| 17:00–17:59 | 240 | 3 | 0 |

There is **no global hardcoded 13:00 broker shutdown**. Even after 13:00,
some Plan B-admitted candidates reached the other blocking safety layers.
The sharpest model-admission decline is 15:00–18:00. The last Pepperstone
DEMO trade on this date was entered 10:09 UTC and another EURUSD trade
closed at 10:19 UTC.

## Actual time-bias components

1. `adaptiveMarketSession()` uses `hour >= 13` to classify NEW_YORK rather
   than LONDON. Session-sliced evidence may reset/go sparse.
2. Plan B active frozen meta scorer has *development-era* clock harmonics:
   `hour_sin = +0.215165...` and `hour_cos = -0.153135...`.
   They change the estimated probability without any market-price change.
   A clock-neutral comparator already existed but had no execution authority.
3. The Plan B session-quality term jumps from 0.90 at 07–15 UTC to
   0.72 at 16–19 UTC and 0.52 at other times. New York 17:00 local
   is individually penalized to 0.10 for true rollover. The ensemble
   includes 0.08 × sessionQuality and counts it as one consensus vote.
4. In a 356-decision sample across 17:00–18:59, active clock-weighted
   meta rejected **70** signals which crossed the *old* meta threshold
   only when the hour-harmonic was removed (24 of 172 at 17:00,
   46 of 184 at 18:00).
   This is a noncalibrated counterfactual, **not 70 viable orders**.
5. Of the same 356, 224 were TREND_WEAK and 108 TREND_EXTENDED,
   thus **332 (93.3%)** remained in poor regimes independent of
   the hour weight. Only 2 Plan B paper-admitted at 17:00 and zero
   at 18:00; neither resulted in execution. Removing a single clock
   weight alone will not cure the broader model problem.
6. Another independent implementation erroneously classified
   **21:00–23:59 UTC every day as three hours of rollover**.
   In November the genuine NY 17:00 rollover is 22:00–22:59 UTC,
   whereas in July it is 21:00–21:59 UTC. It disagreed with
   the DST-aware Plan B rollover rule.

## Implemented correction (session clock only)

New `forex-session-clock.ts`: a shared `America/New_York`
17:00 rollover mapping; ASIA after genuine rollover and during the
normal early UTC hours; LONDON 07:00–12:59; NEW_YORK for the afternoon
through true rollover. Applied consistently to:

- `adaptive-market-state.ts`
- `paper-spread-calibration-shadow.ts`
- `paper-spread-calibration-history.ts` SQL using PG timezone-aware
  America/New_York hour, independent of the DB connection timezone
- `adaptive-edge-matrix.service.ts` missing-tag fallback
- `adaptive-prediction-calibration.service.ts` missing-tag fallback

Tests cover exact winter/summer rollover boundaries, preserving genuine
rollover no-upsize and no-trade policy, plus historical spread SQL.
**No account-level SL, margin, kill-switch, max drawdown or existing
position logic is disabled.**

## Remaining work required before claiming trading restored

- Hour-harmonic model must be genuinely recalibrated on
  prospective broker quote+fill data; removing its coefficients
  without revalidating the admission threshold is not evidence
  of profitable trades.
- Regime/timing model remains excessively restrictive in 16–20
  UTC; develop a distinct validated transition/extension strategy
  with small DEMO exposure and exits matched to timeframe.
- Instrument-specific after-cost first-touch outcomes remain
  necessary; recent independent M1 studies have negative
  retrospective results.
- Validate successful actual broker executions after any authorized
  DEMO promotion. Trading is **not restored** by this session-clock fix.
