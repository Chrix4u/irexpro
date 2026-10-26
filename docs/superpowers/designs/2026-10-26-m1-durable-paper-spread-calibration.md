# M1 Durable PAPER Spread Calibration Design

## Intent
Make M1 PAPER admission and execution-cost simulation deterministic across API restarts and independent of which instrument the M5 collector most recently selected.

## Current defect
`M1TacticalMarketDataService` reads `LivePaperMarketDataService.getPaperFallbackSpread()`. That value is mutable in-memory state. The M5 collector recalibrates only its current best instrument from durable broker spread history, so M1 can see a calibrated spread before a restart and a much wider static spread immediately after restart. This changes M1 net expected R and execution authority without any change in the M1 signal.

## Goals
- Derive M1 PAPER spread from durable 21-day, same-UTC-session broker spread history using the existing P95 + 25%-of-static floor rule.
- Seed the PAPER execution cache with that same derived spread before M1 can submit a trade, so admission economics and simulated fill geometry agree.
- Cache by broker-source connection, instrument, UTC date, and spread session to avoid repeated database queries.
- Fall back to the existing static instrument spread when history is missing, invalid, or below the existing 100-sample maturity threshold.
- Preserve all DEMO/LIVE broker-native spread requirements and promotion rules.

## Non-goals / anti-goals
- Do not lower net-expected-R, drift, reliability, or event-risk gates.
- Do not widen M1 stops or change target R.
- Do not treat PAPER calibration as promotion-grade broker spread evidence.
- Do not change static spread constants or the existing calibration thresholds.

## Approaches considered
1. **Always use static PAPER spreads.** Safest but permanently overstates costs where mature broker history demonstrates a lower conservative P95; rejects useful PAPER research participation.
2. **Persist the mutable PAPER cache.** Removes restart reset but keeps M1 coupled to M5 candidate selection and adds another durable state surface.
3. **Resolve calibration directly from durable quote history per M1 pair/session and seed the execution cache.** Chosen. It removes cross-timeframe ordering dependence, reuses existing evidence, remains conservative when history is sparse, and keeps PAPER execution internally consistent.

## Architecture
Extract the existing durable calibration-history SQL into a shared AI helper that accepts a `DataSource`, source connection id, instrument, and evaluation time. The M5 collector continues to use the same helper, preserving behavior. `M1TacticalMarketDataService` optionally uses the helper with `multimodelBrokerExpert.sourceConnectionId`; its first PAPER snapshot per pair/session evaluates the existing calibration rule, seeds `LivePaperMarketDataService.setPaperFallbackSpread()`, and returns the same calibrated spread to governance.

## Safety invariants
- Missing source connection/DataSource/history => static fixed spread.
- Fewer than 100 same-session positive spread samples => static fixed spread.
- Mature calibration cannot fall below 25% of the static spread.
- PAPER calibration remains `PAPER_SIMULATION_SPREAD`, never `BROKER_OBSERVED_P90` promotion evidence.
- M1 admission spread and PAPER execution fallback spread must be identical for a decision.
