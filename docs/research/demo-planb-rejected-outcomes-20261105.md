# iRexPro DEMO Plan-B admission/rejected-opportunity audit — 2026-11-05

## The observed two-stage no-trade problem

At about 22:27 UTC, an **ACTIVE** cTrader DEMO FULL_AUTO session had no
new broker orders for over six hours. Among the three currently enabled
DEMO entry pairs (AUDUSD, EURUSD, GBPUSD), the trailing six hours had 1,813
M1 decisions, 365 non-ABSTAIN candidates, and **zero** decisions with broker
authority. Prior to a broker market-data interruption, 358 of the 365
candidates failed model-admission requirements; multiple blockers can
apply to the same candidate.

During the 21:29–22:00 UTC market-data gap, M1 snapshots stopped producing
new persisted decisions; the 30-bar minimum after the >10-minute M1 outage
prevented immediate re-entry using stale history. At ~22:30 UTC new M1
decisions began to appear again, but they were ABSTAIN decisions; the first
12 post-gap focused decisions failed paper net expectancy and Plan-B admission.

A connected cTrader account, an ACTIVE engine, and a green-looking signal
meter do not by themselves grant a broker order.

### Primary non-admission reasons in the trailing six-hour decision cohort

These **overlap** and therefore do not add up to the 365 candidates:

| Plan-B reason | Candidate decisions |
|---|---:|
| EXIT_FEASIBILITY | 264 |
| TRADE_QUALITY | 255 |
| REGIME_TREND_EXTENDED | 253 |
| DIRECTION_QUALITY | 204 |
| META_EXPECTED_VALUE | 155 |
| EXPECTED_R | 152 |

Only four candidate decisions in this six-hour cohort showed Plan-B
admission; **none** had final broker authority. This is not proof of a
broken broker dispatch path; order authorization was already withheld.

## Research-only after-the-fact comparison

Using separately persisted cTrader bid/ask quotes, we evaluated the
**hypothetical 15-minute price path** after proposals that received
`execution_authority = NONE`. We deducted an additional fixed 1 pip
as a conservative provisional friction allowance. We excluded invalid
timestamps, future-leaking inputs and quote gaps, then selected the
earliest observation per pair with strictly more than 15 minutes between
selected observations, across **both** directions and M1 routes.

The initial **24-hour** sample available at approximately 22:33 UTC
contained 1,655 raw quoted candidates and 1,629 causally valid candidates,
then **217** non-overlapping observations over just **two UTC days**:

| Research cohort | Independent observations | Mean 15-minute proxy |
|---|---:|---:|
| All rejected-order proposals | 217 | −1.000 pips |
| Plan-B TREND_CONTINUATION | 198 | −0.837 pips |
| Plan-B CONFIRMED_REVERSAL | 16 | −3.038 pips |
| Reject reason EXIT_FEASIBILITY | 111 | −1.073 pips |
| Reject reason DIRECTION_QUALITY | 119 | −1.455 pips |

These results argue against bypassing model-admission rules just to
increase the trade count. **They do not prove a model is intrinsically
unprofitable**, because a fixed 15-minute mark does not reproduce actual
TP/SL, realistic entry fills, actual commission/swap or position
management; observations from correlated instruments are not independent
experimental repetitions, and the period is very short.

The new `demo_rejected_entry_outcomes_shadow` code repeats this method
on the latest bounded **35-day** private, exact-user and exact-DEMO-connection
data. It emits aggregate research JSON and overwrites a single private
CSV/report snapshot; it has no market-order, permission, training, or model
publication capability. It never labels this proxy as verified broker net P&L.

## Verification and next evidence gates

- Four focused synthetic Python tests cover >15-minute de-overlap across
  routes and both sides, causality checks, unknown diagnostics exclusion,
  missing/infinite values and a fail-closed non-trading report.
- The SQL restricts decisions to the configured cTrader DEMO scanner
  user/broker connection, and quotes to the same source. No user,
  account, token, connection, position or order IDs leave the SELECT.
- The existing weekday OOD private workflow also runs this read-only
  attribution check after the current research step. Neither can promote
  models or change broker permissions.
- Before considering an actual model promotion, collect at least 12
  qualified separate trading days, validate on purged out-of-time folds,
  include broker commission/realised net economics, and keep live market-data
  and existing risk gates untouched.

**Next direction:** investigate trend-continuation exits and quality
calibration, not a blanket threshold reduction. A prospective holdout must
demonstrate a positive after-cost edge before the demo strategy changes.
