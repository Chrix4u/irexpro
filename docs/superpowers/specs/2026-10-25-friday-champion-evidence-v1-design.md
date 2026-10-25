# Friday Champion Evidence v1 Design

## Intent
Protect the deployed Friday PAPER champion while turning the accumulated research and forward PAPER results into one reproducible decision record. This work must not create a new trading model or widen execution authority.

## Goals
- Treat `external-provider/irexpro-multimodel-ensemble-v1/paper-only-v1` normal M5 execution as the current forward champion candidate.
- Summarize closed PAPER evidence by model, route, instrument, direction, and route/pair/side using only sanitized fields.
- Separate all-policy descriptive evidence from policy-compatible evidence used for execution recommendations.
- Preserve the frozen six-pair ~100k Dukascopy research result as a rejection baseline for the generic 1m/5m/10m classifier family.
- Preserve the v84 broker-native prospective result as a formal rejection, not a candidate to rescue with threshold changes.
- Fail closed on execution recommendations: historical/stale policy losses may diagnose but may not veto current PAPER authority.

## Non-goals
- No DEMO/LIVE promotion.
- No threshold tuning against the weekend audit.
- No hard-coded instrument blacklist.
- No retraining of the generic six-pair classifier already rejected by the frozen ~100k study.
- No use of user IDs, broker connection IDs, account IDs, credentials, or raw order identifiers in generated evidence.

## Evidence classes
1. **Forward PAPER ledger**: closed trades from the PAPER broker for the active multimodel engine. Exact normal-M5 model version is the champion cohort.
2. **Compatible realised sleeve evidence**: only trades whose `decision_policy_version` is in the same compatibility lineage already declared by `PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS`.
3. **Frozen historical research**: the six-pair Dukascopy walk-forward summary. This is diagnostic/rejection evidence and cannot itself authorize execution.
4. **Broker-native prospective research**: the frozen v84 post-cutoff report. This is falsification-only and cannot authorize execution.

## Champion decision
The forward normal-M5 cohort is labelled `PROVISIONAL_FORWARD_CHAMPION` only when all directly measurable conditions hold:
- at least 50 closed trades;
- positive realised PnL;
- realised profit factor >= 1.15;
- positive-instrument fraction >= 0.67.

Balanced accuracy, formal walk-forward Sharpe, and percentage max drawdown are reported as not established by the realised trade ledger alone. Therefore this audit never grants PAPER/DEMO/LIVE promotion authority.

## Compatible sleeve veto diagnostics
A route/pair/side can be labelled `MATURE_WEAK_COMPATIBLE_SLEEVE` only when:
- it has at least 8 closed normal-M5 trades in the declared compatible policy lineage; and
- realised profit factor is below 1.0, or there are losses and no gross profit.

This v1 audit only reports that state; it does not modify execution. That prevents a weekend post-hoc change from blocking a current policy on stale evidence.

## Output
Generate a deterministic, sanitized JSON report containing:
- report version and generation timestamp;
- champion cohort metrics and checks;
- per-route, per-instrument, pair-side, and route/pair/side forward metrics;
- compatible sleeve maturity diagnostics;
- frozen 100k research gate observations for 1m/5m/10m;
- frozen v84 prospective verdict and key metrics;
- explicit `modifies_execution: false`, `approved_for_demo: false`, and `approved_for_live: false`.
