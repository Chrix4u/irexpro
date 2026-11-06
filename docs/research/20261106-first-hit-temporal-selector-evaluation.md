# First-hit chronological selector — 2026-11-06

## Actual model built and tested

The active cTrader DEMO session opened no new orders after the last
actual trade closed at 07:19 UTC on 5 November. Historical first-hit
research found some TP-first possibilities and more SL-first outcomes.

The new demo_first_hit_temporal_selector.py fits a RESEARCH-ONLY,
in-memory logistic regression on earlier independent quote-close
first-hit outcomes. It scores ALL candidates on an untouched,
fully completed UTC date, including those whose future path is
unresolved. It uses a fixed top-20% predicted net R ranking.

Candidate features are exclusively as-of-decision instrument,
direction, M1 and Plan B routes, regime, drift, Plan B paper admission,
estimated net R, estimated execution cost R, original stop/target
ratio, whitelisted admission reasons and existing hard blocker codes.
Future quotes and first-hit labels are never inputs at prediction time.
Training ignores censored events rather than labelling them wins,
and excludes 35 minutes before the holdout date. Held-out data
never influence fit, feature normalization or rank cutoff.

### Independent November 5 holdout

The source spans four UTC calendar days. Training uses two earlier
dates (November 3-4), 80 observed TP-first/SL-first resolved examples.
November 6 is an incomplete day and is deliberately excluded.

| November 5 group | Candidates | TP-first | SL-first | Unresolved | Mean illustrative net R among resolved only |
| --- | ---: | ---: | ---: | ---: | ---: |
| All rejected candidates | 216 | 29 | 52 | 135 | -0.2691 |
| Plan B paper admitted | 20 | 3 | 6 | 11 | -0.3333 |
| New selector, frozen top 20% | 43 | 5 | 17 | 21 | -0.6091 |

The new model is WORSE than the unfiltered sample in the observed
subset. It is explicitly REJECTED FOR DEMO ACTIVATION.

The minus-R values are not broker-realized P&L: the 30-minute
price-path result is based on sampled quote closes and conservative
MIDPOINT wick warnings, with ambiguous cases censored. Extra one-pip
cost is estimated, not a measured broker commission, financing or
broker fill. Anonymized payoff bounds for all censored cases being
SL or TP are hypothetical bounds, not claims about the unknown paths.
There is insufficient data to establish a positive trading edge.

## Repeated research and safety

The existing weekday read-only VPS research runner now updates a
private latest-first-hit-selector-report.json with candidate counts,
training dates, holdout date, censored coverage and R scenarios.
Raw price-path CSV is removed. Model weights are kept only in memory.
There is NO broker order, no model registry, no automated promotion,
no stop/lot/risk parameter change, and no authority to execute.
The nine first-hit tests and eight separate temporal-selector tests
cover source constraints, first-hit ambiguity, time split, no
future-label leakage, bounds, and no order authority.

Next development should use longer broker-side tick/bid/ask histories,
actual commission and true first barrier paths, then multiple
independent, purged out-of-time samples. Only a later, separately
verified positive after-fee result could justify proposing a
small-volume reversible DEMO test.
