# Offline expert evidence: research data contract

This workflow is descriptive research only. It is disconnected from broker execution, risk settings, signal generation and model promotion.

## Input

The report program accepts a local JSON file containing a positive integer `horizonSeconds` and an `observations` array. Each row contains a unique pseudonymous `sampleId`, UTC `predictionAt`, `evidence` from the individual expert recorder, `outcome` (UP, DOWN or null) and, for resolved outcomes, UTC `labelAt` exactly one declared horizon after the prediction timestamp. Do not commit private datasets or account identifiers to the repository.

## Evidence provenance before evaluation

- Retain the original immutable prediction snapshot, artifact identity, source identity, and independently documented prediction availability timestamp.
- Distinguish source-bar timestamps, evaluation timestamps, persistence timestamps and availability timestamps. An earlier bar label alone does not prove a prediction was available at that time.
- Check source clock semantics, time zones, and ordering before joining evidence to outcomes. Quarantine unresolved discrepancies rather than silently shifting timestamps.
- Do not infer individual expert predictions from aggregate vote counts or substitute retrospective recomputation for a prospective prediction.
- Use independently generated, predeclared outcome labels; distinguish missing outcomes from observed outcomes. Keep selection and labeling rules fixed and documented before reviewing results.
- Keep evaluation groups and data versions traceable. Overlapping observations can be dependent, so descriptive results do not establish statistical independence or causation.
- The evaluator checks structure, duplicate identifiers and label horizons. It does not independently authenticate provenance, validate market data, or establish a model's trade profitability.

## Running locally

From the repository root:

```sh
node --test apps/api/scripts/offline-expert-evaluator.test.cjs apps/api/scripts/offline-expert-report.test.cjs
node apps/api/scripts/offline-expert-report.cjs /path/to/local-research-dataset.json
```

The report emits aggregate prediction statistics only. Empty or unresolved datasets do not produce invented accuracy values. No runtime integration or execution authority is granted.
