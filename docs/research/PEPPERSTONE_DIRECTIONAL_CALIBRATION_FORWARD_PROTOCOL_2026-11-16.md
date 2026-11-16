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
