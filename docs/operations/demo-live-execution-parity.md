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

## Route compatibility inventory

The shared primary ensemble identity does not imply identical execution eligibility.
The scheduler can emit the following distinct authority paths; preserve their
individual provenance rather than relabeling an experimental signal as primary:

| Authority path | Existing primary LIVE predicate |
| --- | --- |
| PRIMARY_PLAN_B | Requires matching M1 timing or the documented native-expert bridge, plus server provenance |
| HIGH_CONVICTION_RESCUE | Not qualified |
| DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE | Not qualified |
| DEMO_ADVISORY_REVERSAL_EARLY_ENTRY_PILOT | Not qualified |
| DEMO_EXPERT_COUNTER_ENTRY_PILOT | Not qualified |
| DEMO_ALTERNATIVE_TIMING_TRIAL | Not qualified |
| M5_EARLY_TRANSITION_HANDOFF | Not qualified |
| EXTENSION_EXHAUSTION_DEMO_SCOUT | Not qualified |
| Professional M1 fallback tiers | Not qualified |

The new offline compatibility regression cases explicitly distinguish model
identity recognition from production qualification for these routes. No route
is granted new authority by these tests.

### Evidence requirements

For historical evaluation, group durable successful execution decisions by
the linked trade intent's original authority path (fall back to recorded
governance authority only when unavailable, and label missing evidence).
Deduplicate by actual trade identity for economic analysis; execution-decision
counts alone do not establish unique trades, realized returns, or profitability.
Analyze closed-trade coverage, accounting completeness, costs, drawdown,
adverse excursion and out-of-sample performance separately. Never infer
unrecorded quotes or replay an old signal into the broker. Account-specific
sizing must not be conflated with strategy qualification. Preserve live
certification, provider identity, fresh quotes, stop validation and all other
execution controls throughout the offline comparison.
