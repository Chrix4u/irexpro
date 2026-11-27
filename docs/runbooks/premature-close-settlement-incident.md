# Premature local closure and delayed broker settlement — incident review

## Observed behavior (sanitized)
Operator-provided broker and internal history views show two economically corresponding positions marked CLOSED internally several minutes before the broker's actual closing deals, with missing exit price, realised P&L, and commission. One provider closing order was a market order and the other a protective order, while the internal history retains close-intent labels. Native internal identity matching and original runtime execution paths have not been independently verified. No private account identifiers, deal records or screenshots are included.

## Source-confirmed failure mechanism
- ExecutionService.closeTrade uses a local clock for closedAt on a FILLED dispatch outcome.
- ReconciliationResolutionService.closeTradeFromProvider can mark CLOSED when closedTrade is null, assign a local observation timestamp and leave economics null. Its audit differentiates provider time from local observation.
- proveUniqueCtraderDemoSettlement rejects differences greater than 180 seconds, even if the remaining fingerprint agrees. The newly added synthetic regression reproduces this rejection.
- backfillClosedDemoSettlement fills only absent economics; it does not replace the stored closedAt. Its existing audit records providerClosedAt separately.
- The close-order proof additionally requires dispatch chronology and a close time within 999 ms of the recorded internal close. The current single-market-close proof cannot establish that an AI close request caused a protective broker order.
- Broad history pagination and native position linkage remain separate potential defects. Do not attribute all outstanding warnings to the timestamp discrepancy.

## Required corrective design and acceptance
1. Trace the original close-request audit, terminal transition, provider snapshot provenance and native opening/closing order and deal links on the exact authorized DEMO connection. Establish which code path ran, whether local absence was mistaken for terminal closure, and whether account/position selection was reliable.
2. Independently prove current provider position state, complete native history and causal order linkage. Distinguish an AI/manual close intent from an actual broker protective execution. Do not infer the protective deal was caused by a different local market request.
3. Design a durable representation of close-request time, local observation time, provider execution time and settlement completeness. Unconfirmed timestamps must not be represented as broker execution times. Review exposure and risk invariants before changing any lifecycle behavior.
4. Review a separate historical correction path for legacy terminal records with missing economics and provisional timestamps. Require native identity, complete deal evidence, exact economics, scoped idempotency, concurrency fences, audit trail and independent review. Do not simply expand the 180-second or 999-ms windows, guess monetary values, or overwrite conflicting settled data.
5. Validate synthetic cases: accepted but not filled; wrong account or position; broker snapshot omission; delayed complete close; protective order versus market request; multiple partial deals; duplicate deliveries; concurrent settlement; missing or conflicting economics. Verify gross, fee, swap, net and authoritative duration separately. No real order placement in tests.
6. Require authenticated read-only DEMO verification and guarded release review before declaring incident resolved. This PR only reproduces the refusal in source tests; it changes neither runtime behavior nor accounting records.

Related: #841 history completeness, #848 offline position history comparison, #847 deployed failure categories.
