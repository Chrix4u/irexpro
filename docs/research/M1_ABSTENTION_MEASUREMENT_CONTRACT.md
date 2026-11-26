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


## Independent review handoff

The historical feature completeness inventory (`m1-feature-coverage.cjs`) is now part of this research branch, with synthetic regression tests and an API CI step. It counts valid, missing, invalid and unverified observations without imputing values or granting qualification.

The next review is an evidence audit, not a model deployment. Verify original decision linkage and chronology, policy version, proposed side, and the availability of direction quality, confidence, composite score, score edge, momentum, alignment and the exact rejection reason. Keep actual settled DEMO observations distinct from unfilled candidates and simulated outcomes. Report aggregate completeness, missingness, descriptive distributions and uncertainty; do not infer execution permission from any group or use after-entry features as inputs. Review selection bias, correlated episodes, route differences and the limitations of the existing confidence heuristic. Document any unsupported conclusion explicitly.

Use only separately authorized deidentified research exports in an isolated environment; do not publish account-specific observations, private reports, credentials or identifiers in the public repository. No broker calls, production database access, runtime wiring, threshold changes, model promotion, live orders or service restarts are part of this handoff.

Checkpoint: at candidate commit `8a8fcf47`, API tests and build completed successfully; final gate and static analysis were still in progress when checked. Updated documentation will receive its own CI result. Actual historical feature extraction and independent calibration remain incomplete.
