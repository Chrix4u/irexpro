# iRexPro — frozen DEMO recovery baseline
**As-of 12 November 2026, Ghana/UTC | Pepperstone cTrader DEMO | Read-only**

This document freezes the actual outcomes and execution funnel before any
further changes to the user-facing AI entry policy. Reproduce with
`cd apps/api && node scripts/audit-demo-recovery-baseline.cjs`.
The script validates the exact connected owner-bound DEMO account and runs
under `BEGIN READ ONLY`; it does not submit, edit or cancel orders.

## Three-day comparison: ACTUAL broker fills, after recorded commissions + swaps

All numbers are USD (the account currency in the linked broker ledger).

| UTC date | All six pairs trades | All six net | EURUSD + AUDUSD trades | Two-pair net | Other four net |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10 Nov | 17 | -442.35 | 6 | +460.00 | -902.35 |
| 11 Nov | 19 | -396.20 | 8 | +814.00 | -1,210.20 |
| 12 Nov | 7 | -420.17 | 5 | -418.00 | -2.17 |

- **11 November full-portfolio result was a loss**, not a profitable trading
  day when all the enabled majors are considered.
- **11 November two focused majors were temporarily positive:** seven winners
  and one loser, net +$814, net profit factor 6.814, closed-trade max
  drawdown $140. This sample of eight trades is far too small to establish
  future expectancy.
- **12 November focused majors deteriorated:** one winner, four losers,
  net -$418, net profit factor 0.023. At the last checked time no new
  broker fill since 10:09 UTC (final two-pair position closed 10:19 UTC).
- All 8 focused trades on 11 Nov used
  `multimodel_execution_authority_path=PRIMARY_PLAN_B`; all 5
  focused trades on 12 Nov did as well. This is not evidence that the
  subsequently added independent M1 fallback was the profitable model.
- The prior profitable sessions included 2–4 lot fills and were sensitive
  to commission and stop/exit path. Increasing trade count or
  restoring volume alone is not strategy qualification.

## Entry-decision compatibility, not merely scans

| Day | Pair | M1 evaluations | M1 routed | Plan B paper-admitted | Both simultaneously | Broker authorized |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 11 Nov | AUDUSD | 2,679 | 430 | 173 | 20 | 5 |
| 11 Nov | EURUSD | 2,082 | 289 | 129 | 14 | 3 |
| 12 Nov | AUDUSD | 2,452 | 344 | 242 | 23 | 3 (2 filled, 1 failed) |
| 12 Nov | EURUSD | 2,436 | 333 | 199 | 21 | 3 (3 filled) |

The M1 route selection and Plan B strategy source files are **unchanged**
between the 11-Nov UTC end-of-day Git snapshot
(`3d67397b`) and this 12-Nov recovery baseline. The scheduler,
execution sizing and context handling **did change**. Directly
rolling back the unchanged core algorithms cannot recreate
11 November's price action or remove today's overlapping admission
requirements.

### Detailed inactivity period: 10:19–20:35 UTC, 12 November

- 2,438 EURUSD/AUDUSD M1 evaluations.
- 153 Plan B paper-admitted and 362 non-ABSTAIN M1 routes.
- Only **16** evaluations had both independent signals at once.
- 137 Plan B paper-admitted candidates had no M1 route;
  346 M1-routed candidates lacked Plan B paper admission.
- One exception authorized, but never reached a broker fill because of
  a previously fixed minimum-lot sizing defect. A false cooldown after
  that failed order was also fixed separately.
- Among the 137 Plan-B-only candidates, common regimes included
  `REVERSAL_CONFIRMED` (72), `TRANSITION_EARLY` (39) and
  `TREND_HEALTHY` continuation (26).
  Reversal candidates lacked independent M1 confirmation and often
  had conflicting higher-timeframe direction.
- Sixteen simultaneously aligned decisions were additionally blocked
  by existing loss-streak brakes, reversal confirmation or timing.
  Some are genuine account or event-risk controls; never remove them
  simply to increase frequency.

The two-model intersection and admission rules, rather than broker
connectivity, are the dominant frequency constraint. But simply
executing Plan-B-only or M1-only signals is NOT validated by
historical trade results.

## Quote-data integrity limits

Older M1 provider minute candles exist, but the DB has **zero**
verified same-minute positive broker bid/ask marks for either focused
instrument on 10 and 11 November:

| Day | Pair | M1 candle minutes | Verified positive bid/ask minute marks |
| --- | --- | ---: | ---: |
| 10 Nov | AUDUSD | 1,438 | 0 |
| 10 Nov | EURUSD | 1,436 | 0 |
| 11 Nov | AUDUSD | 1,435 | 0 |
| 11 Nov | EURUSD | 1,437 | 0 |

The quote-capture improvements began producing verified positive marks
during 12 November. Their coverage is still incomplete. Historical
candle highs/lows without executable bid/ask, intraminute path and
fee evidence CANNOT support a tick-accurate counterfactual and must
not be mistaken for profitability.

## Recovery decision

1. **Freeze the current executable algorithms.** Preserve this
   reproducible baseline and the current Git commit; avoid
   blindly loosening the primary Plan B + M1 voting system.
2. **Keep only EURUSD/AUDUSD in active entry focus.** Historical other
   majors lost more than these two gained. Do not auto-reenable
   them based only on trading frequency.
3. **Use PRIMARY_PLAN_B continuation as the reference champion**,
   because it produced the actual 11-Nov focused trades. Separate
   `EARLY_TRANSITION` and `CONFIRMED_REVERSAL` into individual
   cohorts rather than describing them as one model with one edge.
4. **Independently evaluate M1 continuation** with genuine
   positive bid/ask data and first-touch SL/TP, paid broker fees
   and nonoverlapping decision-time cohorts. If and only if
   the independent route has supported, prospective after-cost
   profitability, promote it to a controlled DEMO trial rather
   than requiring mutually inconsistent primary-vs-fallback votes.
5. **Preserve risk boundaries**: broker min/step, stop-loss, max loss,
   connected account/session provenance, required margin, real
   New York rollover and event risk, pending-intent idempotency.
6. **Acceptance gate for calling the recovery successful:**
   a newly qualified actual Pepperstone broker fill, correct
   exposure/SL/TP, and subsequently repeatable NET-after-fee
   performance across multiple sessions. A minute-level scan
   count or passing API tests alone does not qualify.

This artifact intentionally **does not change trading authority**,
does not claim to restore the previous day's profits and
does not promote any shadow model.
