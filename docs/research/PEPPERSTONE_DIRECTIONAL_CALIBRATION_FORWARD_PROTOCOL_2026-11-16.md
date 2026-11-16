# iRexPro: direction selection forensic review and forward calibration
**Owner Pepperstone cTrader DEMO USD — 16 November 2026, Accra/UTC**

## Confirmed findings
All 74 actual trades opened 10–16 November have consistent BUY/SELL through the
immutable signal identity, M1 decision, trade intent, broker order reservation
and recorded executed position (0 mismatches). The cTrader order mapping
BUY -> 1 / SELL -> 2 is correct for these recorded trades. The earlier
malformed-direction-as-SELL fallback was patched, tested and deployed
(commit b9957e30). That flaw was a real preventive code issue, **not**
evidence of historical accidental inverse orders.

Actual 74 broker trades: 32 wins, 42 losses, net -$1,402.72, profit factor 0.701.
A profit factor below 1.0 means losses outweigh wins; profit factor itself
is not negative. By Plan-B route:
- Trend continuation: 61 trades, 27 wins, -$1,583.85 net, PF 0.578.
- Confirmed reversal: 9, 3 wins, +$82.88 net, PF 1.113.
- Early transition: 4, 2 wins, +$98.25 net, PF 1.491.
There are only five independent weekdays in this cohort; market regime and
strategy allocation changed between them.

The new *after-the-fact* quality-threshold audit `audit-pepperstone-directional-consensus.cjs`
records the same 74 trades, owner/broker/DEMO/USD scoped, and refuses
inverted/missing direction provenance. It compares the selected M1 score
to the opposite same-bar candidate, but will **not** use the opposite score
as as-of evidence if written after the original trade intent. All 74 paired
opposite M1 scores were available by original intent and **all 74 executed
directions had a larger M1 score than the opposite candidate**. Thus the
problem is economic efficacy/calibration, not choosing the lower-scoring
M1 direction by accident.

Retrospective scored trade subsets (USD after actual commissions/swaps):
| Minimum Plan-B directional quality | Historical retained trades | Net | PF |
|---|---:|---:|---:|
| Original unrestricted | 74 | -$1,402.72 | 0.701 |
| >=0.55 | 29 | -$310.22 | 0.846 |
| >=0.60 | 19 | +$56.20 | 1.039 |
| >=0.65 | 11 | +$237.97 | 1.272 |

**These thresholds were explored after seeing the data and are NOT a
forward-qualified edge.** Higher threshold does not ensure profit; the
single trend-continuation trade with score >=0.65 lost $265.54. A strategy
that historically keeps profitable trades while excluding losers can
underperform on unseen dates. Historical "excluded losses" are not
bankable savings on a changed future trading account.

## Prospectively registered experiment
**Frozen start: 2026-11-16 17:50 UTC (GMT/Ghana).** Research protocol
authored before its first eligible sample. Code:
- `apps/api/scripts/audit-pepperstone-forward-direction-calibration.cjs`
- `apps/api/scripts/audit-pepperstone-forward-direction-calibration.test.cjs`
- `apps/api/scripts/irexpro-forward-direction-shadow.pm2.config.cjs`
- Private report:
  `/home/lightworld/webapps/irexpro-research/forward-direction-calibration/latest-report.json`

Research side selection from M1 decision records with Plan-B paper admission
and governance eligibility only (no broker authority implied). The first
qualified same-bar candidate each 15-minute per-instrument window is used.
If both BUY/SELL qualify within the same M1 bar, choose the higher
contemporaneous Plan-B ensemble score, and timestamp the research decision
at the latest score observation; ties abstain. This avoids blindly picking
BUY simply because the M1 scanner loops BUY first. As-of candidacy
and scoring cannot depend on the subsequent price.

Compare selected versus opposite **virtual** direction using next M1 native
broker bid/ask mark on entry side (BUY ask/SELL bid) and future exit side
(BUY bid/SELL ask) at 3, 5, 10 and 15 minutes. Additional cost: estimated
$6 per standard lot round-trip commission and 0.2 pip slippage. Position
sizes are normalized for research, not authorized broker lots. Both sides
can lose after spread/fees. No modeled first-hit stop/target, executable
quote at original decision instant, financing or actual slippage: results
are *mark proxies*, never guaranteed tradable returns.

Lookback is bounded to a rolling seven days since the frozen start. No
historical outcomes before the experiment start are inserted. Observer
polls every five minutes and updates one private file. All queries use
read-only repeatable-read transactions, exact owner session/broker/DEMO/USD
scope, bounded signal count and timestamped native quotes. No secret data
or raw owner identifier is written to logs.

**Authority:** SHADOW ONLY, `modifiesExecution:false`,
`placesOrders:false`. No broker positions, engines, live configuration,
promotion thresholds, existing risk/SL/TP rules or model weights are
changed by this experiment.

## Decision gates for later
Do not resume trend continuation or auto-invert trading due to a handful
of apparent wins. Evaluate at least several separate unseen market sessions,
per-route net after costs, win/loss asymmetry, adverse excursions, and
risk-normalized outcomes. First require independently verified profitable
after-cost expectation and acceptable max drawdown; propose a separately
reviewed DEMO-only pilot before granting any new execution authority.
The existing operator-requested Pepperstone DEMO continuation pause
remains in effect until explicitly changed.

## 16 November 2026 — Forward observer maturity and data-health enhancement

The first observer report shortly after launch was blank because it deliberately
waits **19 minutes** after each M1 decision to collect all 3/5/10/15-minute
outcome marks. A blank scored table before that boundary does not mean that
the scanner or market-data feed stopped.

At **18:06 UTC**, a direct read-only check showed:
- 136 M1 scanner decisions since the fixed start at 17:50
- 9 Plan-B paper-admitted, 7 governance eligible, **7 jointly qualified**
- **7 qualified candidate decisions still waiting for outcome maturity**
- broker-native quote last sampled within seconds; source verified
- 0 matured episodes so far by design; no real broker authorization
- early qualified observations were mixed: continuation with weak directional
  scores and USDJPY reversals with independent M1 reliability blockers

The report now separates `scannerDecisions`, `paperAdmitted`,
`governanceEligible`, `jointlyQualified`,
`waitingForMaturity`, `maturedQualified`, last M1 scan time, latest
qualified decision time, last native broker quote time and freshness.
This lets the operator distinguish **data unavailable**, **waiting for
maturity**, and **matured with measured hypotheses**.

Prospective analysis is additionally partitioned by the **predeclared**
feature-quality bands below 0.55, 0.55–0.60, 0.60–0.65 and >=0.65,
by instrument/direction, and by M1 route (including `ABSTAIN`).
These quality partitions were suggested by retrospective discovery and
must not be presented as independent unbiased hypothesis discovery;
their *future* measured outcomes are the prospective holdout.
No automatic execution threshold is derived from these partitions.

The output and observer remain owner-scoped, 100% read-only, with
`placesOrders=false` and `modifiesExecution=false`.

## Continuing observation: no false-empty and durable history

The observer now includes two layers of status that must not be conflated:
`jointlyQualified` includes admitted research observations that may still be
inside the 19-minute settlement window, while `maturedQualified` and
`selectedEpisodes` describe fully elapsed, deduplicated episodes. The report
names `QUALIFIED_SIGNALS_WAITING_FOR_OUTCOME` instead of showing zero as
though signals never existed. It also records recent scanner timestamps,
verified broker quote timestamps, and native-quote freshness.

The prospective daily outcomes are now broken down by
`byQualityBand` (predetermined 0.55, 0.60, 0.65 boundaries),
`byInstrumentSide`, and `byM1Route`. This distinguishes whether a BUY
or SELL hypothesis performed well and whether M1 actually confirmed it.
`ABSTAIN` remains a research observation only and never gains execution
authority from a favorable later mark.

After the first 20 minutes of the following UTC day, finalized day outcomes
are archived **once** to
`/home/lightworld/webapps/irexpro-research/forward-direction-calibration/daily/YYYY-MM-DD.json`
in a restricted directory, with 0600 file permissions. The immutable daily
archive prevents the rolling seven-day research window from discarding the
prospective evidence needed for a longer, independent multi-day evaluation.
Tests verify no premature archive, no overwrite of finalized days and
rejection of authority-bearing reports.

At **18:08 UTC**, diagnostics showed 152 scanner decisions, 11 paper-admitted,
8 jointly qualified, 8 still waiting for maturation and fresh broker-native
quotes. The first possible fully matured outcome from the 17:52 research
candidate is after approximately 18:11 UTC. Until then, showing zero wins or
losses would be premature.

## 18:17 UTC integration verification and clean quote evidence

The first matured signal (AUDUSD SELL at 17:52) exposed two issues
that could not be detected while the outcome cohort was empty:

1. The matured-decision SQL had a trailing comma before `FROM`.
   Fixed it. Verified the exact owner/broker-scoped query using
   `EXPLAIN` and executed it against the VPS PostgreSQL read-only
   transaction (eight genuine qualified rows in the test window).
   Regression tests now reject the original malformed SQL.

2. A broker-native quote M1 candle may have `bid_close = ask_close`
   (zero spread) even when its `positive_quote_sample_count > 0`.
   Such last-close fields **must not** be treated as executable
   zero-spread markets, nor should all those candles be thrown away.
   The database also preserves independent
   `last_positive_bid`, `last_positive_ask`,
   `last_positive_spread` and `last_positive_sample_at`.
   The monitor now exclusively aliases these *timestamped native
   positive-spread* fields into its bid/ask mark model.
   It rejects invalid timestamps or non-positive quoted spreads,
   and does not use synthetic zero-cost fills.

As of ~18:17 UTC, the forward monitor had recorded 216 scanning
decisions, 10 jointly paper-admitted/governance-eligible scans,
four matured qualified scans, and **three non-overlapping,
bid/ask-comparable research episodes**. At a fixed 15-minute
virtual holding horizon: the selected side was positive in 2/3,
the opposite was positive in 0/3; mean estimated after-cost pips:
selected +1.948, opposite -4.219. This is **far too small** to
prove profitable prediction. One USDJPY reversal with higher quality
failed after costs; two continuation signals with low quality were
positive at 15 minutes. These are contrasting *research examples*,
not authorization to resume continuation.

The protocol still lacks tick-exact stop-loss first-touch checks;
the observed favorable 15-minute return does NOT establish that
a broker position would have survived the path to that mark.
No broker order, model weight or live execution authority was changed.

20 Node regression tests passed across the historical and
prospective research scripts; the API health remains separate
from and unaffected by the shadow observer.

## 18:44 UTC — conservative M1 barrier-path review

New read-only, side-by-side research module
`apps/api/scripts/forward-direction-m1-barrier-review.cjs` uses
the existing owner-scoped broker-native M1 candle midpoint ranges, the
last timestamped positive spread and the *simulated* next-minute bid/ask
entry. For every subsequent full M1 bar, it determines whether a
stop-loss or take-profit **might** have been touched for the chosen
direction and separately for the inverted direction.

It labels only:
- `POSSIBLE_STOP_BEFORE_TARGET`
- `POSSIBLE_TARGET_BEFORE_STOP`
- `AMBIGUOUS_BOTH_POSSIBLE`
- `NO_POSSIBLE_TOUCH_IN_INSPECTED_BARS`
- `UNKNOWN_...` for missing/invalid input

These are **possible M1-range interactions**, not actual stop fills.
The first entry minute is skipped because the entry is modeled
from its last positive sample; using the entire entry-minute range
would include price movements before the hypothetical entry.
The last positive spread is NOT guaranteed to equal the spread at
the minute's high or low, and no tick-ordering can be recovered from
aggregated candles. This method can miss within-minute crossings and
misorder stop versus target. No inferred fills are added to the
after-cost fixed-hold P&L or treated as realized trading results.

At ~18:44 UTC the frozen prospective cohort included 432 M1 scanner
decisions, 15 qualified observations, 10 matured qualified observations
and 5 unique non-overlapping episodes with native bid/ask marks.
At the 15-minute horizon, chosen direction had 2/5 positive marks,
opposite 2/5, mean net selected -0.354 pips and opposite -2.134 pips.
In the chosen-side M1 review: 1 possible stop-before-target, 1 possible
target-before-stop, 3 without a possible barrier touch in inspected
full-minute bars. Reverse-side review: also one possible stop,
one possible target, and three no possible touches.
For example, a qualified USDJPY BUY reversal first indicated
a possible stop interaction at 17:59, while its mirrored SELL
first indicated a possible target interaction at 18:00. Neither
is a verified broker order/fill and neither should be activated
from this sample.

New independent tests cover BUY/SELL asymmetry, same-minute
ambiguity, missing quote path, invalid spread/ranges, and
unassessed partial entry-minute risk. Integration adds per-route
and per-horizon counts, without granting authority, changing
live trading, or weakening existing risk gates.

## 19:10 UTC — exit-minute causality guard

One further lookahead correction has been applied to the older M1
midpoint-bar proxy `forward-direction-m1-barrier-review.cjs`.
If a possible stop/target crossing occurs in **the same M1 bucket
whose positive bid/ask quote supplies the horizon exit mark**, the
candle's high/low may include ticks *after* that quote timestamp.
The research status is now `UNKNOWN_EXIT_MINUTE_ORDER`, never
`POSSIBLE_STOP_BEFORE_TARGET` or `POSSIBLE_TARGET_BEFORE_STOP`.
The entry minute also remains unverified. A targeted regression test
reproduces this boundary.

This does not rewrite actual broker P&L, change any trading permission,
or claim exact tick order. The forward counterfactual after-cost marks
remain fixed-hold scenarios, separate from uncertain M1 first-touch.
