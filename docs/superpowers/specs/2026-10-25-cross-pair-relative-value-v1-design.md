# Cross-Pair Relative-Value v1 Design

## Intent

iRexPro has exhausted several same-pair and pooled one-hot model families on the frozen six-major corpus without finding durable spread-aware economics. The next experiment must change the information set materially rather than retune thresholds. This candidate asks whether synchronized divergence among the six USD majors contains a causal short-horizon relative-value edge.

## Chosen approach

Use the exact six frozen MTF corpora previously certified by SHA-256 in v6. At each synchronized decision minute, convert the current M1 return into a common USD orientation: USD-base pairs (USDJPY, USDCAD, USDCHF) keep their sign; USD-quote pairs (EURUSD, GBPUSD, AUDUSD) invert it. For each pair, compute a leave-one-out median USD return from the other five pairs and define the pair residual as its own USD-oriented return minus that common factor.

The first screen is deliberately non-parametric and model-free. It tests two predeclared hypotheses only:
- **Mean reversion:** trade against a large cross-pair residual.
- **Continuation:** trade with a large cross-pair residual.

Residual magnitude is standardized causally with rolling past-only statistics. Candidate activation floors are selected only on an inner chronological calibration tail from a bounded predeclared quantile grid. Outer validation is untouched by threshold/direction selection.

## Economics

Use the existing causal spread-aware long/short net-return labels produced by `load_and_prepare_corpora`; do not invent a new cost model. Evaluate horizon 1 first. A candidate calibration tail must have enough observations, both LONG and SHORT participation, positive mean net return, and PF >= 1.10. The outer early-rejection screen still uses the locked project gates where defined: PF >= 1.15, Sharpe >= 1.0, max drawdown <= 12%, balanced accuracy >= 0.52 when meaningful, positive instrument fraction >= 67%, and at least 24 non-overlapping opportunities per validation day.

## Leakage controls

- Exact frozen corpus hashes must match v6 before analysis.
- `decision_time` is UTC and all six pairs must be present at a synchronized minute.
- Cross-pair features use only values available at that same decision time or earlier.
- Leave-one-out common factor excludes the scored pair itself.
- Rolling residual normalization uses only current/past residuals, never future labels.
- Inner calibration and outer validation are horizon-purged.
- Validation cannot choose hypothesis, quantile, side, pair, or any threshold.
- No Oct 2–13 broker prospective holdout data is reused; that holdout is consumed.

## Early rejection rule

Run one horizon-1 outer fold first. If no calibrated mean-reversion or continuation sleeve produces positive validation economics with meaningful participation/breadth, reject the cross-pair residual idea before any ML. Only a credible raw edge justifies a learned cross-pair model or horizon-5 expansion.

## Governance

Research only. `approved_for_paper=false`, `approved_for_demo=false`, and `approved_for_live=false` regardless of screen outcome. No forced trade quota and no lowering economics/evidence gates.
