# Bidirectional Decision Monitor

This page is a read-only browser projection of persisted `ensemble_shadow_decisions` evidence.

It intentionally exposes only:
- BUY/SELL confidence and meta probability
- gross/net expected R scores
- strategy route and regime
- consensus counts
- drift state
- PAPER admission / execution eligibility
- blocker codes

It intentionally excludes raw model metadata, chain-of-thought, credentials, prices, stops/targets, account P&L, and execution secrets. The page has no mutation endpoint and no trading authority.

## Model drift diagnostics (2026-11-17)

The comparison card includes persisted governance `driftDiagnostics` when present.
These list the exact historical model-range features outside their envelope
(e.g., confidence:HARD_LOW and mtfStrength:HARD_LOW). They are not broker
errors and do not authorize trading. An M5 bidirectional PAPER rejection is
not automatically an M1 DEMO broker execution veto. The model can also fail
independent Plan B admission or have a negative net R after estimated costs.
Historical decision data is immutable; the API merely projects already stored
diagnostics, and the browser translates feature codes into readable labels.
No strategy thresholds, execution gates, or position sizing are changed.
