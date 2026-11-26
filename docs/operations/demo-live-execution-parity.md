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

## Shared identity registry (centralization record)

The frozen primary identity and the historical DEMO strategy codes now live in
one registry, `apps/api/src/modules/strategy/server-m1-signal-origin.ts`
(`PRIMARY_M1_MODEL_IDENTITY`, `EXTERNAL_IREXPRO_STRATEGY_CODES`). Runtime
signal production, orchestrator admission, evidence SQL and the post-entry
DEMO drawdown guard all read these constants. No string is duplicated between
DEMO and LIVE admission logic; a future model rollout changes the registry
once, in one commit, and cannot silently split the accounts onto divergent
identities.

## LIVE stop-distance rejection diagnosis (absolute geometry)

Three LIVE scan signals were rejected with measured stop distances of 4.4,
3.6 and 4.1 pips against the configured five-pip minimum. Root cause: LIVE
validates absolute geometry — the model's stop was anchored to a closed-bar
reference, and adverse quote movement between signal generation and the fresh
executable quote shortened the measured distance. This is the risk gate
working as designed (fail-closed, exact-decimal `INVALID_SL_DISTANCE` with the
measured and minimum pips in the rejection message). DEMO rebases model
geometry onto the fresh executable quote before the same check, preserving
the model's intended risk distance. Migrating LIVE to rebased geometry is a
runtime behavior change: it stays subject to the acceptance criteria above
(offline replay, quiescent session, rollback, separate approval) and is
intentionally NOT included in the characterization PR. Orchestration refusals
now also record per-leg `liveBoundaryChecks` diagnostics so a continuously
scanning, never-executing LIVE account can be diagnosed from the audit log
alone (which leg of the certification boundary failed, and the
account-independent `primaryModelDecision`).

## Verified historical DEMO statement evidence (offline snapshot)

Broker-disconnected analysis of the balance-chain-verified Pepperstone DEMO
statement export (424 closed deals, 2026-11-10 → 2026-11-23, deposit
50,000.00 USD):

- Realized net −7,045.21 USD; gross price P&L −693.88 USD; cost wedge
  −6,351.33 USD ≈ 90% of the net loss at a stable −6.00 USD/lot.
- Win rate 53.5% with average win 53.94 USD vs average loss −97.91 USD
  (payoff ratio 0.55); expectancy −16.62 USD/deal; net −6.66 USD/lot.
- Maximum drawdown −7,221.03 USD (14.44% of peak equity).
- Walk-forward split: week 2 scaled deal count 76 → 348 while gross stayed
  negative (−337.59 → −356.29 USD); volume scaling amplified cost losses
  without improving price results.
- Strategy-route attribution (e.g. the continuous-reversal evidence route's
  221 of 251 recorded execution decisions) lives in the application database
  and must be certified from `trade_intents` / `m1_tactical_decisions`
  records; it is deliberately not inferred or fabricated offline.
