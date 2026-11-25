# iRexPro afternoon clock and stop-path audit — 11 November 2026

Scope: Pepperstone cTrader DEMO, USD account, Ghana UTC. All numbers below are
read-only research from sampled broker M1 quotes. They are NOT actual broker
fills or a deployable backtest.

## Problem

Nov 10 and 11: M1 scanner continued after 13:30, but no broker-native orders
were authorized. Plan B's historic UTC-hour features reduce scores later in
the day. PR #743 added an independent clock-neutral comparison only.

## Reproducible research

From apps/api:

    IREXPRO_RESCUE_START=2026-11-09T00:00:00Z \
    IREXPRO_RESCUE_END=2026-11-11T22:00:00Z \
    node scripts/audit-planb-clock-rescue-economics.cjs

The code uses a read-only repeatable-read PostgreSQL transaction, validates
the active owned cTrader DEMO account, replays saved decision-time features
and consensus, and uses the first later broker bid/ask entry price, later
bid/ask marks, and earlier closed commissions. Five-minute pair/side sample
de-duplication reduces but does not eliminate time correlation.

Of 2,109 routed M1 episodes, 2,109 successfully reproduced original scores
and consensus; 843 were after 13:30 Ghana.

### Estimated cost-adjusted outcome marks

| Afternoon cohort | n | Positive share | Mean USD / standard lot |
| --- | ---: | ---: | ---: |
| All at 5 minutes | 812 | 32.0% | -7.50 |
| All at 60 minutes | 808 | 47.3% | +18.14 |
| Clock-neutral newly crossing threshold, 60m | 99 | 43.4% | -4.00 |
| Clock-neutral newly admitted Plan B, 60m | 13 | 46.2% | -8.45 |
| Newly admitted and independently screened, 60m | 1 | 0% | -8.00 |

The positive all-candidate 60m mean does NOT account for prior SL/TP hits,
protection exits, slippage or portfolio constraints. The clock-rescued subset
did not demonstrate a positive mean at 60m.

### Sampled stop-path forensics

Candidate stop and target are compared only to contiguous post-entry FULL
M1 buckets. The candles have broker-sampled midpoint high/low, not tick-level
bid/ask high/low; first-touch and within-minute ordering remain uncertain.
A missing minute fails closed. The entry minute is deliberately excluded.

Of 843 afternoon candidates, 649 had a complete 60-minute sampled path,
149 had data gaps and 45 lacked valid entry/horizon geometry or evidence.

Among 649 complete paths, 226 showed a witnessed stop first, 166 witnessed
target-close first, 257 witnessed neither. 43 stopped-first candidates had
a positive after-cost 60-minute quote mark. USDJPY: 140 complete paths,
71 stop-first, 19 stop-first then positive at 60m.

A hypothetical 1.5x wider stop avoided 116 of the original witnessed stop
crossings. Only 28 of those had a positive 60m mark, while 88 remained
non-positive. For USDJPY it avoided 40, with 10 positive. Wider stops were
not rebudgeted to keep risk equal, and these are not tradable PnL claims.

## Decision

Do not promote clock-neutral threshold directly. Do not globally widen stops.
Preserve news/drift/regime, rollover, broker spread, portfolio, risk, profit
protection and execution gates. Focus next on a conditional, session- and
pair-aware ENTRY and EXIT strategy validated with real broker tick paths,
strict causal commissions, SL/TP first touch and purged chronological
holdout days. No broker orders or runtime trading rules changed in this audit.

## Tests

From repository root:

    node --test apps/api/scripts/audit-planb-clock-rescue-economics.test.cjs \
      apps/api/scripts/audit-short-horizon-m1-episodes.test.cjs \
      apps/api/scripts/planb-hypothetical-stop-path.test.cjs \
      apps/api/scripts/audit-planb-clock-factor-funnel.test.cjs

The research scripts are safe to run on staging; they do not modify the DB.
