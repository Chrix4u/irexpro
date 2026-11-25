# DEMO / LIVE execution parity acceptance criteria

## Current behavior
The promoted ensemble family is shared, but the paths are not equivalent. The strategy orchestrator admits server-promoted external DEMO strategies and deliberately narrower server-origin LIVE primary M1 signals. Experimental DEMO fallback, alternate, rescue and pilot paths are not automatically production qualified. Allocation-aware DEMO market geometry rebases stop and target distances to a fresh executable quote; LIVE validates absolute geometry. The same nominal minimum stop distance can therefore yield different decisions after quote movement.

## Acceptance criteria for future migration
- Replay the same immutable signal and quote fixtures in both paths, comparing every stage and classifying account-specific constraints separately from strategy conditions.
- Compare strategy-route admission, confirmation, price geometry, risk sizing, cost-inclusive expectancy, protection, accounting and exit logic.
- Keep broker certification, freshness, stop/target direction and minimum distances, margin, capital, fee-inclusive risk, idempotency, and protective-order atomicity mandatory.
- Do not convert an experimental DEMO authorization into LIVE authority. Qualification must be independently validated with held-out evidence and realistic execution costs.
- Validate any revised geometry in offline replay before considering promotion; reject invalid/expired signals and do not widen monetary risk or rely on stale quotes.
- Require a quiescent trading session, verified artifact, rollback and separate release approval before changing the running execution path.

This PR is characterization only. Tests use invented market-price fixtures and mocked dependencies. No account records, broker credentials, real orders or customer information are included. It does not change trading authority or runtime behavior.
