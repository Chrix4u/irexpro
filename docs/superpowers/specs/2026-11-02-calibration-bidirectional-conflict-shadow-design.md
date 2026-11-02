# Calibration ↔ Bidirectional Conflict Shadow Design

## Intent
Measure, prospectively and without changing execution, when adaptive prediction calibration recommends blocking the current candidate while the simultaneously available bidirectional model still favors that same side or favors the opposite side.

## Goals
- Persist one audit-friendly diagnostic per evaluated shadow candidate.
- Use only information available at decision time.
- Distinguish: no calibration block, calibration block/current side favored, calibration block/opposite side favored, calibration block/pair balanced.
- Record the candidate-side and opposite-side directional probabilities plus calibration context.
- Keep `executionAuthority=NONE` and `modifiesExecution=false`.

## Non-goals
- No broker order changes.
- No lot-size changes.
- No calibration threshold changes.
- No automatic reversal or rescue route.

## Approach
Use a small pure evaluator beside the existing calibration/paired-direction modules, then persist its output into `trading.ensemble_shadow_decisions.components.calibrationBidirectionalConflict` after paired-direction probabilities are available. This keeps the diagnostic independent from execution selection and makes it queryable for prospective evidence.

## Safety constraint
No execution, sizing, route-selection, governance, or risk function may consume the new diagnostic in this change.

- Telemetry persistence is best-effort: storage failure must never block a scan or order path.
