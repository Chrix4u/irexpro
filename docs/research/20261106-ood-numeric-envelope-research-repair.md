# iRexPro: learn from extended trends without authorizing unqualified orders
Date: November 6, 2026. Research source changes only; no trading authority.

## Live diagnosis

The desktop screenshot reports out-of-distribution trend extension.
The empirical continuation HARD_HIGH threshold for extension/ATR is
1.499639, originally fixed from 4,599 historical events. Exceeding
a validated range does not predict a loss: it signals insufficient
verification of an edge outside that range.

At 10:44 UTC a read-only 2h audit showed 714 M1 evaluations,
119 proposed routes, 518 OUT_OF_DISTRIBUTION vetoes and one
broker-authorized entry. Across 8h routed proposals, 318 had
multimodel OOD and 336 generic OOD, with substantial overlap.

The previous private research report contained 2,472 verified
quote-path proxy examples from only three days; a 10:48 UTC rerun
found 2,994 verified examples across four days. The 12-trading-
day minimum therefore correctly stopped model fitting.

The earlier independent 15m HARD_HIGH extension sample had
261 observations, average -0.8858 pips after an illustrative
one-pip additional friction, proxy profit factor 0.6255.
These are research outcomes, not broker fills or returns.

## Concrete research/data defect

The prior OOD data export included only generic governance OOD
observations and lacked actual numeric ATR extension,
volatility score, EMA separation, MTF trend strength, RSI and
short-horizon momentum. It had just HARD_HIGH/HARD_LOW labels,
insufficient to distinguish a mild outlier from an extreme one.

This patch records six numeric decision-time features using the
same normalization used by the primary Plan-B ensemble, under
governance.oodResearchFeatures. The export includes both
multimodel and generic OOD routes; prefers multimodel drift
diagnostics where appropriate; and pins both entry and future
quote records to the decision's own broker connection.

All six new CSV fields are nullable for historical rows.
The training module keeps older records for descriptive
historical quote-outcome analysis, but refuses numeric-envelope
model fitting unless all six features are valid. It additionally
requires 12 independent qualified UTC days, all three pairs,
and the existing chronological purged train/validation/test.
It never fills old missing values with zero or reconstructs
their magnitudes from HARD_HIGH labels.

## Verification

The patched read-only SQL ran successfully on the existing
DEMO database: 3,124 source rows, 3,075 causally valid rows
over four days, zero exact envelope snapshots before deployment.
The patched analysis correctly reported no fitted model.
A direct feature-input test showed raw extension=2.1 and
RSI14=42 passed into distinct XGBoost input columns.
The 110 existing scheduler tests passed after adding a
typed persistence expectation.

No live ensemble thresholds, lots, order execution, stop/TP,
risk veto, broker commission gate or session controls change.
The next step is to collect enough full-feature broker-native
samples and validate untouched out-of-time after-cost returns
before any independent minimal-volume DEMO trial.
