# iRexPro AI Engine V2 — execution backlog

Status: research-only backlog for the V2 Champion–Challenger directive.
Coordinates with `docs/EXECUTION_BACKLOG.md` (release-critical accounting
track; disjoint scope) and PRs #834/#836/#837/#838 (M1 abstention research
chain; V2 consumes their conclusions and adds no duplicate artifacts).

Phase numbering: P0 audit (this branch) → P1 consolidation → P2 evaluation
harness → P3 synthetic campaigns → P4 historical replay (blocked) → P5
broker-connected DEMO (blocked on review) → P6 reporting and decision.
Every item carries an owner-of-record role (research), an acceptance
criterion, and a blocking dependency where applicable. No item modifies
production runtime.

---

## P0 — Audit and architecture (delivered in this branch)

- [x] **P0-1** Full-engine audit, seven categories →
  `AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md`. Acceptance: every finding cites
  real files/numbers; M1 findings inherited by reference, not duplicated.
- [x] **P0-2** Challenger architecture with six DEMO-isolation requirements
  mapped to platform capabilities →
  `AI_ENGINE_V2_CHALLENGER_ARCHITECTURE_20261127.md`. Acceptance: each
  requirement has code-verified capability, enforcement contract, and gap.
- [x] **P0-3** Attribution ledger contract (synthetic) →
  `apps/api/scripts/research/v2-challenger-attribution.cjs` (+ test).
  Acceptance: duplicate tradeId refused; append-only semantics; isolation
  and equivalence assertions; authority restricted to research values.
- [x] **P0-4** Statistical evaluation framework (synthetic) →
  `v2-statistical-evaluation.cjs` (+ test). Acceptance: after-cost endpoint,
  Wilson CIs, Brier/reliability, detection limits, typed refusals
  (`INSUFFICIENT_SAMPLE`, `CLUSTERED_INPUT`); reference values pinned.
- [x] **P0-5** Entry/exit decomposition contract (synthetic) →
  `v2-entry-exit-decomposition.cjs` (+ test). Acceptance: realized R =
  design payoff + exit delta + cost drag; cohort deficit classification;
  missing stop distance = typed refusal, never guessed.
- [x] **P0-6** CI verification of all three suites (api-ci.yml steps).

## P1 — Research consolidation (design work, no runtime changes)

- [x] **P1-0** Engine component map (P1 groundwork, delivered in this
  branch) → `docs/research/AI_ENGINE_V2_COMPONENT_MAP_20261127.md` +
  executable mirror `apps/api/scripts/research/v2-engine-component-map.cjs`
  (+ test, CI-verified). Acceptance: 64 components across 17 families; every
  entry cites a path-verified file, exported artifact and constants with
  line references; audit counts reconciled exactly (4 scorers / 6 reversal
  definitions / 9 reliability gates / 6 calibration layers / 6 exit engines /
  5 prediction families / 6 confidence-floor copies; Python 128-column
  contract verified by execution); CI drift detector re-proves path
  existence and count reconciliation on every run; inventory tampering is a
  typed refusal. Inputs for P1-1..P1-6 (see the map's §10).
- [x] **P1-1** Direction-scorer unification spec (A1): inventory the four
  scorers' feature sets; define the single V2 contract (columns, units,
  missing-value semantics). Delivered →
  `AI_ENGINE_V2_P1_1_DIRECTION_SCORER_UNIFICATION_SPEC_20261127.md` +
  executable mirror
  `apps/api/scripts/research/v2-direction-scorer-contract.cjs` (+ test, CI
  step). Acceptance: signed-off spec doc; no runtime edit. Verified: four
  missing-value rules recorded (SILENT_DEFAULT /
  PARTIAL_DEFAULT_NAN_PROPAGATES / THROW_ON_NON_FINITE /
  ZERO_OR_NEUTRAL_ON_MISSING); weight sums pinned (S1 = 1.00, S2 trend =
  1.00, S4 = 1.00, S3 = 29 unnormalized entries); DS-1 fail-closed
  refusals (`SCORER_INPUT_REQUIRED`, `SCORER_UNSUPPORTED_INSTRUMENT`,
  `SCORER_INPUT_OUT_OF_RANGE`); confidence prohibited as an input; one
  correction to component map §1 (the momentum `?? 0` default lives in S2,
  not S3).
- [x] **P1-2** Reversal-definition unification spec (A2) with a frozen test
  corpus of borderline bars where the six definitions disagree today.
  Delivered → `AI_ENGINE_V2_P1_2_REVERSAL_DEFINITION_UNIFICATION_SPEC_20261127.md`
  + executable mirror
  `apps/api/scripts/research/v2-reversal-definition-contract.cjs` (+ test, CI
  step). Acceptance: disagreement corpus committed as synthetic fixtures.
  Verified: twelve frozen records (`RV-D01`..`RV-D12`), verdicts **computed**
  by faithful predicate mirrors of all six definitions and reconciled
  against committed expectations on every run — 11 disagreement records + 1
  all-reject control (the near-miss corridor), confirmation counts
  R1=5/R2=4/R3=7/R4=5/R5=4/R6=1, 12 distinct verdict+reason patterns;
  six-definition inventory pinned with line references (incl. R2's two
  inline ceilings l.150-151 and the R5/R6 ladders); the unified contract
  **RD-1** (19 columns, five pre-registered gate slots — turn, impulse,
  conviction ≥ DS-1's calibrated probability, net economics floor, regime
  support set — with the failed breakout retired to a recorded stratifier);
  typed refusals `REVERSAL_INPUT_REQUIRED`, `REVERSAL_UNSUPPORTED_INSTRUMENT`,
  `REVERSAL_INPUT_OUT_OF_RANGE`; tampering with inputs, expectations, records
  or definitions is a typed refusal.
- [x] **P1-3** Reliability-layer consolidation spec (A3): one service,
  shared floors, explicit sample-count ladders. Delivered →
  `AI_ENGINE_V2_P1_3_RELIABILITY_CONSOLIDATION_SPEC_20261127.md` +
  executable mirror
  `apps/api/scripts/research/v2-reliability-gate-contract.cjs` (+ test, CI
  step). Acceptance: nine-gate inventory with verified floors and invocation
  sites; one sample ladder (COLD < 3 → SCOUT 3-5 → MEANINGFUL ≥ 6 → cap 20)
  with G4's mature handoff promoted to the ladder rule; one floor set per
  tier taking the strictest observed V1 value; one verdict vocabulary and
  authority gradient (NONE → SHADOW_ONLY → REDUCED → PROVISIONAL → ADVISORY
  → PAPER_FULL → FULL); extraction seams SEAM-1/2/3 defined with
  CI-verified scheduler/collector anchors (the phase-2 §13 runOnce
  requirement); frozen disagreement corpus `RL-D01..RL-D12` (10 divergence
  records + 2 controls, verdicts computed by faithful mirrors and
  reconciled on every run); typed refusals
  (`RELIABILITY_INPUT_REQUIRED`, `RELIABILITY_UNSUPPORTED_SURFACE`,
  `RELIABILITY_INPUT_OUT_OF_RANGE`); tampering with sources, corpus or
  statistics is a typed refusal (21-test suite). Verified: floors span
  3→20 samples and PF 0.75→2.0 across the nine gates; the composition veto
  covers 2 of G1's ten failure reasons (corpus RL-D07); the advisory
  overlay multiplies risk to a 0.2 floor and can never veto.
- [x] **P1-4** Calibration-service consolidation spec (A4/B4) including the
  pre-outcome prediction registration format (V2-7 scoreboard). Delivered →
  `AI_ENGINE_V2_P1_4_CALIBRATION_CONSOLIDATION_SPEC_20261127.md` +
  executable mirror
  `apps/api/scripts/research/v2-calibration-contract.cjs` (+ test, CI
  step). Acceptance: six layers + two auxiliaries and five families pinned
  with path-verified constants (13 anchors re-proven on every run); frozen
  corpus `CL-D01..CL-D12` (10 divergence records + 2 controls, 7 disposition
  conflicts, 2 within-layer splits, 12 distinct patterns) computed by
  faithful mirrors and reconciled on every run; unified contract CAL-1 (one
  evidence ladder, one sample ladder COLD/SCOUT/AUTHORITATIVE/MATURE, one
  Bayesian blend prior 8, one maturity vocabulary, one authority gradient);
  CAL-2 append-only pre-outcome scoreboard with retrodiction and duplicate
  refusal, P4 excluded; typed refusals
  (`CALIBRATION_INPUT_REQUIRED`, `CALIBRATION_UNSUPPORTED_SURFACE`,
  `CALIBRATION_INPUT_OUT_OF_RANGE`, `CALIBRATION_CONTRACT_TAMPERED`,
  `CALIBRATION_PATH_DRIFT`). Integration note (2026-11-28): recovered from
  `research/ai-engine-v2-p1-4-calibration-20261127` @ `f97bb7e9` (stacked on
  P1-3 @ `cff28862` and the P1-0.5 extension @ `31c4e862`), cherry-picked
  post main-sync `ce447f47` with CI/backlog conflict resolution; contract
  content byte-preserved.
- [x] **P1-5** Exit-specification consolidation spec (A7/G1): parameterized
  retention/force-close policy; document the four current divergent
  implementations as the comparison baseline; no constants changed.
  Delivered 2026-11-28 (post-sync with main `ce447f47`) →
  `AI_ENGINE_V2_P1_5_EXIT_INTELLIGENCE_UNIFICATION_SPEC_20261128.md` +
  executable mirror
  `apps/api/scripts/research/v2-exit-intelligence-contract.cjs` (+ test,
  CI step). Verified: six-engine inventory path-verified with byte-exact
  constants (X1 ladder + route arms + M1 rescue, X2 tiered retention +
  0.91 overlay, X4 guard 5/7min/-0.4R, X5 unprotected band); X3/X6
  recorded as EVALUATION_BASED divergences (typed refusals, never
  emulated); EI-1 unified schema with 16 typed refusals; frozen champion
  baseline (1.1xATR/5pips/1.6R geometry, no ladder); pre-registered
  challenger preset (X1 ladder + X4 guard + 288-bar time stop).
- [x] **P1-6** Dead-code removal list (A6, A9, D4) — proposal only, staged
  for a separately reviewable cleanup PR (never mixed with research docs).
  Delivered 2026-11-28 →
  `AI_ENGINE_V2_P1_6_REDUNDANT_CODE_INVENTORY_20261128.md` +
  executable scanner
  `apps/api/scripts/research/v2-redundant-code-inventory.cjs` (+ test,
  CI step). Verified: all five pinned A6 files reproduce (plus the
  transitive v75 case), the A9 shim and the D4 0.2-constant group
  reconcile; 45 duplicate-constant groups, 459 unused-export candidates
  and 0 token-level near-duplicate pairs recorded as the removal-list
  proposal.

## P2R — Runnable engine and offline evaluation (extension of P2,
delivered 2026-11-28 on this branch)

Directive extension: the backlog now explicitly requires a RUNNABLE,
isolated V2 intelligence engine — not only architecture documents and
predicate mirrors — plus the complete offline evaluation stack:

- [x] **E-1** Runnable isolated V2 intelligence engine →
  `v2-intelligence-engine.cjs` (+ tests). Acceptance: champion mirror
  (S1 composite byte-exact, frozen hash canary) + challenger policy
  (confidence floor, RD-1-shaped reversal gate, EI-1 exits,
  risk-fraction sizing, V2-7 pre-outcome probability registration);
  research authority only.
- [x] **E-2** Deterministic synthetic market generator (P2-1) →
  `v2-synthetic-market.cjs`. Acceptance: planted drift recovered within
  3 sigma on 20k-bar paths (pinned).
- [x] **E-3** Paired-engine simulator (P2-2) →
  `v2-paired-engine-simulator.cjs`. Acceptance: identical paths and
  costs for both engines; ledger identity exact; equity reconciles to
  settled nets to 1e-9; exit reasons attributed per EI-1.
- [x] **E-4** Attribution-ledger persistence (P2-3) → JSONL export/import
  in `v2-offline-evaluation-harness.cjs`. Acceptance: round-trip
  integrity proof; tamper detection.
- [x] **E-5** Offline evaluation harness computing the seven metric
  families (entry discrimination, confidence calibration, reversal
  detection, exit efficiency, profit retention, cost-adjusted
  expectancy, drawdown) → `v2-offline-evaluation-harness.cjs`.
- [x] **E-6** Comparative performance dashboard (P2-4, R6) →
  `v2-comparative-dashboard.cjs`. Acceptance: read-only projection of
  the ledger (single code path), self-contained HTML.
- [x] **E-7** V1 broker-confirmed evidence window →
  `v2-broker-evidence-window.cjs` + committed statement fixture.
  Acceptance: four-way reconciliation (net total, balance chain,
  realized match, duplicate guard) on the real statement.
- [x] **E-8** Isolated DEMO evaluation environment for independent
  review → `v2-demo-evaluation-environment.cjs` +
  `v2-demo-evaluation-run.cjs`. Acceptance: fail-closed R1/R2/R4
  assembly; byte-identical reruns; artifact hashes printed.
- [x] **E-9** Campaigns P3-1..P3-3 (executed by the harness):
  null false-positive calibration (1,000-replay runs via CLI;
  200-replay artifact committed), known-edge detection power
  (binormal planting, recovered within stated uncertainty),
  exit-dominance attribution (>= 0.90 both controlled arms).
- [ ] **E-10 (next)** Full 1,000+-replay null and edge campaigns on CI
  hardware; multi-instrument campaigns; walk-forward variant of the
  paired simulator.

## P2 — Evaluation harness (offline, synthetic)

- [x] **P2-1** Deterministic synthetic market generator (bar paths with
  known planted edge, zero edge, and adverse-selection scenarios) for
  campaign rehearsals. Acceptance: planted parameters recovered by the
  framework within stated uncertainty. Delivered → E-2 above.
- [ ] **P2-2** Paired-engine simulation harness: Champion-shaped and
  Challenger-shaped policies evaluated on identical synthetic paths with
  identical costs. Acceptance: paired deltas have correct coverage in
  Monte-Carlo rehearsal.
- [ ] **P2-3** Attribution-ledger persistence adapter (research DB sandbox
  or file export — no production DB). Acceptance: round-trip integrity
  tests.
- [ ] **P2-4** Comparative dashboard read-only projection prototype on the
  synthetic ledger (R6). Acceptance: projection cannot diverge from ledger
  (single code path).

## P3 — Synthetic campaigns

- [ ] **P3-1** Null-discrimination campaign: verify the framework detects
  "no entry edge" at honest rates (false-positive rate ≤ nominal) across
  ≥1,000 replays. Acceptance: size/level calibration report.
- [ ] **P3-2** Known-edge detection campaign: planted AUC 0.55/0.60 edges
  detected at the pre-registered power. Acceptance: detection-power table
  matches Hanley–McNeil predictions.
- [ ] **P3-3** Exit-dominance campaign: planted win-truncation and
  loss-extension scenarios; decomposition must attribute ≥90% of planted
  deficit to the correct channel. Acceptance: attribution accuracy report.

## P4 — Historical replay (BLOCKED: data authorization)

Blocked on the separately authorized anonymized per-trade exports
(audit C11: the 192-trade dataset is not in the repo; per-trade R
multiples exist only in production tables out of research reach).

- [ ] **P4-0** Documented absence + data request (this branch documents it;
  the operator must authorize the export).
- [ ] **P4-1** Provenance/chronology verification of the export (decision
  linkage, policy version, as-of discipline) per PR #834's contract.
- [ ] **P4-2** Entry-vs-exit decomposition on real per-trade R multiples
  (G1 split: win truncation / loss extension / cost drag).
- [ ] **P4-3** Calibration backtest of the single V2 probability contract
  (out-of-sample Brier/reliability, route-stratified).
- [ ] **P4-4** Historical replay report — explicitly labeled preliminary.

## P5 — Broker-connected DEMO (BLOCKED: independent review + provisioning)

Gate: architecture review checklist (architecture doc §6) fully signed off
before the first broker-connected minute.

- [ ] **P5-1** Owner provisions two isolated Pepperstone cTrader DEMO
  accounts (R1); connection ids registered.
- [ ] **P5-2** V2 identity registry declared (R2); generations frozen.
- [ ] **P5-3** Equivalence verification run (R4) and recorded.
- [ ] **P5-4** Campaign pre-registration: primary endpoint (after-cost net
  expectancy in R with interval), cluster unit, stopping rule, detection
  limit, family count = 1. Frozen before first trade.
- [ ] **P5-5** Simultaneous run under identical conditions; brake
  semantics identical (F3); attribution ledger live; dashboard projection
  on.
- [ ] **P5-6** Interim reports at pre-declared checkpoints only; no ad-hoc
  peeking; every peek disclosed in the final report.

## P6 — Reporting and decision

- [ ] **P6-1** Final comparative report: broker-confirmed after-cost
  outcomes, uncertainty, calibration, entry/exit separation, all
  pre-registered analyses + disclosed deviations.
- [ ] **P6-2** Go/no-go recommendation for V2 with explicit statistical
  basis, or documented null result. No production-readiness claim from
  retrospective performance.

## Standing constraints (every phase)

- V1 Champion untouched; no production credentials/DB/broker access; no LIVE
  activation; no deployment; deployment hold intact.
- No private datasets in the public repo; synthetic fixtures only in-repo.
- Coordinate with #834/#836/#837/#838 (M1 chain: when it merges, retarget
  V2 artifacts referencing it); PR #818 stays stacked on #810 as before.
- All V2 artifacts carry research-only authority semantics
  (`executionAuthority: NONE`).
