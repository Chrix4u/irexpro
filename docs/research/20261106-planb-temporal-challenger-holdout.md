# Plan B DEMO rejected-entry temporal challenger — 2026-11-06

## Actual no-trade cause and model result

The last cTrader EUR DEMO trade closed at 2026-11-05 07:19 UTC; the
FULL_AUTO session began at 13:05 UTC on November 5 and continued evaluating
M1 signals without any new trade. Read-only database queries of the current
session and authorized pairs AUDUSD, EURUSD, GBPUSD at about 00:09 UTC
showed 480 non-ABSTAIN proposed entries over eight hours: only six passed
Plan B paper admission, and zero received broker execution authority.
Most proposed entries failed direction quality, market-regime eligibility,
or predicted after-spread expectancy. cTrader prices were fresh.

Important clarification: SLEEVE_COLLECTING alone does NOT prohibit
DEMO simulated execution (paperExecutionEligible may be true); it blocks
promotion beyond research. Of those six paper-admitted decisions:
- Two trend-continuation entries did not clear after-spread net expectancy.
- One had stressed market drift.
- One had high-impact event risk and reliability vetoes.
- Two confirmed-reversal Plan B decisions lacked the required
  independent M1 reversal timing confirmation, with additional
  restrictions on one case.
Multiple blockers overlap; no across-the-board veto relaxation is justified.

## Reproducible challenger model

The research-only demo_planb_temporal_challenger.py fits a logistic
regression selector to the existing broker-side 15-minute price-outcome
dataset. It uses ONLY as-of-decision facts: instrument, direction,
M1 and Plan B routes, admission flag, and known rejection codes.
No future price, outcome, or timestamp enters the features. The source
preprocessor already rejects bad quote provenance/timestamps, wrong
symbols and overlapping events across both sides.

- Pre-registered model: logistic regression, C=0.25, liblinear solver.
- Train on earlier UTC days only, with a 20-minute embargo ahead of
  the held-out day; evaluate strictly on the latest distinct UTC day.
- Choose the top 20% of the untouched holdout, not an after-the-fact
  "best" threshold.
- BUY receives future bid minus entry ask; SELL receives entry bid
  minus future ask; deduct an additional estimated 1 pip.
- Current cohort: 423 independent opportunities over three UTC days.

### Latest held-out day (November 5)

| Cohort | Observations | 15-minute mean quote proxy |
| --- | ---: | ---: |
| All independently sampled proposals | 204 | -0.985 pips |
| Challengers fixed top 20% | 40 | -1.728 pips |

The challenger performed worse and MUST NOT be promoted or used to
place DEMO/LIVE orders. This is a fixed-horizon quote-based proxy,
NOT actual fills, stop/TP path, real commission, or realized account P&L.
Three dates are too short for strategy qualification.

## Continuous non-executing evaluation

The existing weekday private VPS research workflow already writes a
bounded rejected-entry CSV. A new research-only step fits the ephemeral
challenger and writes a small private JSON report next to the CSV.
No model binary/weights are persisted and no model registry, broker
order, account session or risk controls can be modified. A synthetic
12-day test also confirms promotion_allowed=false.

Before any DEMO entry candidate promotion, require 12+ separate
market days, broker-cost/SL/TP reconstruction, independent walk-forward,
stress tests, positive unseen after-fee returns and drawdown limits.
This report makes no profitability claim and imposes no trade-count quota.
