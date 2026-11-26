# M1 abstention measurement research

Status: offline research only. No runtime import, trading authority, policy promotion, or model change.

The existing M1 route classifier records a reason and scoreEdge, not a calibrated probability of loss or a probability that abstention is correct. The reason-specific measurement helper retains original units and the recorded policy version. A zero shortfall at the inclusive higher-timeframe conflict boundary does not mean eligibility. The two M5 confirmation paths are alternatives, not additive evidence.

## Evidence requirements

- Use separately authorized, anonymized, decision-time records; preserve source version, observation timestamp and the proposed direction. A claimed RECORDED_AS_OF label alone does not independently authenticate provenance.
- Validate recorded feature/decision identity against the source record before using these descriptive measurements.
- Keep broker-settled historical outcomes separate from counterfactual or unfilled cases. Keep missing and ambiguous evidence visible.
- Treat compound rejection reasons, invalid snapshots and unavailable data as unscored. Do not convert existing candidate confidence into abstention probability.
- A numerical abstention-strength score remains undefined until independent calibration establishes its meaning. No fixed percentage is an execution threshold.

## Verification

Run node --test apps/api/scripts/research/m1-decision-evidence-coverage.test.cjs apps/api/scripts/research/m1-abstention-margin.test.cjs in an isolated checkout. Both tests are wired into API CI. This is synthetic regression coverage, not model training or market evidence.

## Checkpoint

PR #834 initially passed eleven executed CI checks (full API lint skipped) at 6e2e6558. Added offline reason-specific margin helper, five synthetic tests, and CI step; updated candidate CI pending. No runtime changes or database queries performed. Next: independently verify the updated candidate, then obtain authorized deidentified decision and outcome evidence for descriptive coverage review. The scalar score is deliberately null until supported by calibration; preserve all existing risk and execution rules.
