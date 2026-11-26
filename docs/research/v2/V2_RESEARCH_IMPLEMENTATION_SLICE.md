# iRexPro AI V2 — Research Implementation Slice (Stage-0 Modules)

Research-only implementation slice for independent review. This document implements the layers of the existing `V2_ARCHITECTURE_PROPOSAL.md` (P1–P10 principles, L0–L6 layers) and the `V2_CHAMPION_CHALLENGER_DEMO_EVALUATION_DESIGN.md` isolation model with executable, tested modules. Nothing here is deployed, executed or connected to any broker account. AI V1 remains the untouched Champion baseline; V2 is developed in complete isolation.

**Relationship to the existing V2 research (PR #839 head 681e670c):** the prior slice delivered the architecture proposal, the defect-register audit, the decision-record contract, the attribution ledger module and the decision-level evaluation metrics (`v2-evaluation-metrics.cjs`). This slice adds the four missing executable planes and the seven-category audit companion — it does not alter or duplicate any existing artifact.

## 1. Purpose and red lines

**Purpose.** Establish whether a more robust, statistically defensible and economically sustainable architecture can be developed from the existing platform, measured under equivalent conditions against the Champion.

**Red lines (unchanged from the directive):** no production credentials or DB access, no broker orders, no LIVE execution, no replacement deploys, no production service modification, no private data in the public repo, no profit or production-readiness claims from retrospective performance. The comparative environment is **broker-connected Pepperstone cTrader DEMO accounts** — not internal paper trading — but only after this architecture passes independent review.

## 2. Design principles implemented by this slice (each traces to an audit category)

1. **Calibration before edge** (category b): every admission input carries a provenance-checked calibrated probability with holdout sample size and P10/P90 bounds — raw scores are refused at the gate.
2. **Cost-first admission** (category g1): expected value is computed net of broker-observed friction; admission requires the *lower bound* of net expected R to be positive — never a point estimate.
3. **Uncertainty is a first-class output** (category d): bootstrap CIs, window stability and sample-sufficiency width are decision-record fields, not afterthoughts.
4. **One accountable intelligence per question** (category f): no overlapping heuristic policies — the admission module is the single entry gate; each guard is named and individually attributable.
5. **Entry and exit measured separately** (category e): the admission gate (entry intelligence) and the exit-policy plane are separate measurement planes evaluated on identical fixtures before any architectural conclusion.
6. **Abstention is a decision, not a failure** (PR #836 taxonomy): abstention reasons are categorical, evidence-complete, and their counterfactual value is measured with selection-bias caveats.
7. **Champion–Challenger discipline** (directive): V1 stays untouched; V2 runs as a separate engine identity on an isolated DEMO account; comparison is paired per market window and refuses unpaired evidence.

## 3. This slice's modules mapped to the existing L0–L6 layers

The layers are defined in `V2_ARCHITECTURE_PROPOSAL.md` §3. This slice contributes executable contracts for L2, L4 and L5 (L0 decision-record and L6 evidence-ledger modules already exist from the prior slice):

- **L2 — Admission (`v2-challenger-admission.cjs`).** Expected net R = p·avgWinR − (1−p)·avgLossR − costR, evaluated at **p10**. Abstention reasons aligned to the #836 taxonomy: `MISSING_EVIDENCE`, `UNCALIBRATED_CONFIDENCE`, `COST_DOMINATED`, `PREDICTIVE_UNCERTAINTY_HIGH`, `DIRECTIONAL_CONFIDENCE_LOW`, `RISK_RESTRICTION`. PAPER_CONSERVATIVE costs can score but never admit.
- **L3 — Exit policy plane.** Exit candidates (fixed-geometry TP/SL, peak-retention locks, trailing) are policy functions over the position's realized path; each is replayed on identical MFE/MAE fixtures so exit variants never contaminate entry evaluation, and vice versa. A candidate exit policy is retired unless it beats the incumbent on paired windows (L4).
- **L4 — Evaluation harness.** `v2-settled-trade-economics.cjs` (net after-cost, expectancy, max DD, profit factor, Brier/ECE calibration, chronological stability, deterministic bootstrap CIs, overlap clustering) and `v2-paired-champion-challenger.cjs` (paired per-window differences, exact sign test, paired bootstrap CI, minimum-window rule, unpaired-refusal). Win rate is reported and explicitly declared non-evidence.
- **L5 — DEMO isolation.** `v2-demo-isolation-topology.cjs` validates the two-engine descriptor against the six mandatory requirements (§4).
- **L6 — Governance.** Frozen artifacts with hash; promotion requires the project's existing gates (PF ≥ 1.15, positive folds, Sharpe ≥ 1, ≤12% DD) *plus* V2 additions: calibration ECE below the base-rate benchmark, CI-excludes-zero on the paired comparison, minimum windows, and per-route sample sufficiency. Retirement: any shadow observer that has not produced a decision-relevant measurement in a review cycle is deleted, not archived (responds to observer sprawl, finding f).

## 4. Champion–Challenger DEMO isolation (the amendment's six requirements)

| # | Requirement | V2 design element | Validator |
|---|---|---|---|
| 1 | Independent DEMO account isolation | Each engine holds its own Pepperstone cTrader DEMO account; distinct `accountIdRef`; never shared | `R1_INDEPENDENT_DEMO_ACCOUNT` |
| 2 | Separate engine identities | `AI-V1-CHAMPION` and `AI-V2-CHALLENGER` as distinct engine identities | `R2_SEPARATE_ENGINE_IDENTITY` |
| 3 | Independent position ownership | Positions and credentials are `ENGINE_SCOPED`; no cross-engine mutation; non-shared credentials | `R3_INDEPENDENT_POSITION_OWNERSHIP` |
| 4 | Equivalent starting conditions | Identical starting equity, instrument set, volume constraints, risk configuration | `R4_EQUIVALENT_STARTING_CONDITIONS` |
| 5 | Immutable performance attribution | Append-only, engine-stamped, SHA256-chained ledger records (windowId, engineId, accountIdRef, netPnlUsd, costsUsd, maxDrawdownUsd, recordedAt, hashes) | `R5_IMMUTABLE_PERFORMANCE_ATTRIBUTION` |
| 6 | Comparative performance dashboard | Per-engine views with netAfterCostReturn, riskNormalizedExpectancy, maxDrawdown, profitFactor, calibration | `R6_COMPARATIVE_DASHBOARD` |

The validator is descriptive only — it validates a topology descriptor; it never creates, connects or modifies a broker account. Broker-connected DEMO evaluation happens only after this architecture and its offline evidence pass independent review (Stage 3, §5).

## 5. Verification ladder (each stage gates the next)

- **Stage 0 — Synthetic fixtures (implemented now).** All V2 modules run on synthetic data in CI: `node --test apps/api/scripts/research/v2-*.test.cjs`. Correctness is hand-computed assertions, not simulated plausibility.
- **Stage 1 — Historical replay (authorized, anonymized).** Replays use separately supplied anonymized DEMO exports under the PR #834 evidence contract: chronological separation, future-data-leakage refusal (decision-time features only), realistic transaction costs, and settled-outcome-only scoring. Entry and exit replayed in separate experiments.
- **Stage 2 — Independent offline evaluation.** Same harness, frozen windows, pre-registered criteria: net after-cost return, risk-normalized expectancy with CI, max drawdown, profit factor, calibration ECE/Brier, stability fraction, sample sufficiency. Sample-size honesty: 121–192 settled trades cannot distinguish modest edges; the harness must say so (it does — `ciExcludesZero` and `ciWidthRelativeToAbsMean`).
- **Stage 3 — Broker-connected DEMO (only after independent review).** Two isolated Pepperstone cTrader DEMO accounts per §4, evaluated over paired market windows with broker-confirmed outcomes: reported costs, execution quality, drawdown, consistency. The paired comparison module refuses unpaired windows; verdicts require CI-excludes-zero with ≥30 windows and never constitute profitability claims.

## 6. Relationship to existing work (no duplication)

- PR #834 (evidence completeness), #836 (abstention taxonomy), #837 (integration), #838 (CI mirror): V2 reuses the evidence contract and the six-concept abstention taxonomy; the M1 cohort remains their subject. V2's abstention reasons are aligned to the #836 taxonomy codes.
- PR #810 (DEMO/LIVE architecture review), #813 (expert research), #818 (blockage review): V2's L5 topology is the research-side counterpart of #810's platform concerns; the observer-provenance issues in #813 map to L6 retirement criteria.
- `docs/EXECUTION_BACKLOG.md` P1 items RES-01..RES-05: V2's evaluation harness is a concrete implementation path for RES-03/RES-04; model-governance review RES-05 maps to L6.

## 7. Assumptions and outstanding requirements

1. Anonymized historical DEMO exports (the 192-trade M1 cohort and any extended window) will be supplied separately by the operator under existing authorization; none are committed here.
2. Broker-observed cost samples (P90 spread + commission + slippage) per instrument must be exported from DEMO before Stage 2 conclusions; until then all cost evidence is `PAPER_CONSERVATIVE` and admission stays refused.
3. Calibration samples per (pair, route) ≥ 100 before any probability is admitted as calibrated (mirrors `ENSEMBLE_SLEEVE_CORE_MIN_CLOSED_TRADES`).
4. The exit-policy evaluation fixtures (MFE/MAE path grids) need a Stage-1 export; their absence is listed as a blocker in the backlog, not assumed away.
5. No claim in this proposal depends on retrospective performance; every future claim will be a CI with sample size and leakage caveat.

## 8. Explicit non-goals

- No replacement of the V1 production engine; no modification of risk controls; no LIVE activation; no production credential or database access; no broker account creation at this stage; no performance projection or expected-profit narrative. The Challenger exists to be *measured*, not promised.
