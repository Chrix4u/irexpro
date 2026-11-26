# iRexPro AI Engine V2 — Independent audit findings (seven categories)

Status: offline research only. No runtime import, no database access, no model
change, no threshold change, no broker call, no deployment. This document is
the audit deliverable of the V2 research directive; it coordinates with, and
does not duplicate, PRs #834, #836, #837 and #838 (M1 abstention research
chain, head `55c11626` combined). Where a finding was already established
there, it is referenced, not restated.

Investigator role: independent principal AI architect / quantitative research
review. The unit of analysis is the **entire engine** — the TypeScript
decision stack in `apps/api/src/modules/{ai,strategy,trading,execution,risk,
market-data}` plus the Python signal engine in `services/ai-engine` — not
merely M1.

Audit inputs: full-tree code reading on `main` @ `9ec10e40`; the persisted
schema and decision-time write paths; the operator-supplied aggregates
already pinned in PR #836 (`docs/research/M1_ABSTENTION_INTELLIGENCE_RESEARCH.md`
on the combined branch); the LIVE-blockage root causes established on
`research/live-execution-blockage-20261125`. No production database, no
broker credentials, no per-trade private data were accessed. The separately
authorized anonymized 192-trade DEMO research export is **not present in
this repository** (verified: no matching file by name or content class;
references to anonymized artifacts exist only as VPS-local research
directories in prose). Per-trade R-multiple evidence exists only inside
database tables (`trading.ensemble_shadow_decisions.components.outcome.netR`,
`trading.trades`), which are out of research reach until separately
authorized. All aggregate-level statements below that depend on that dataset
are inherited from PR #836's pinned aggregates and are marked as such.

---

## 0. Engine map (as audited)

The engine is a layered system; the labels below are used throughout.

| Layer | Primary code (real paths, `apps/api/src/modules/` unless noted) | Role |
| --- | --- | --- |
| L0 data | `market-data/services/provider-quote-candle-store.service.ts`, `services/ctrader-quote-collector.service.ts`, `metaapi-quote-collector.service.ts` | cTrader broker-native M1..H4 candles; MT5 sampled fallback; spread evidence |
| L1 features | `ai/m1-tactical-features.ts` (TS); `services/ai-engine/app/domain/models/{feature_engineering,multitimeframe_features}.py` | TS: 9-feature clamped M1 composite; Python: 128-column MTF contract |
| L2 candidate | `ai/m1-tactical-candidate.ts`, `ai/plan-b-multimodel-shadow.ts`, `ai/paired-direction-reversal.ts`, `ai/v8-shadow-meta-scorer.ts` | four independent direction-scoring implementations |
| L3 route/admission | `ai/m1-tactical-route.ts` (six abstention reasons), `ai/ensemble-governance.ts`, `ai/multimodel-authority.ts` | route classification + ensemble admission + DEMO authority (PRIMARY_PLAN_B / HIGH_CONVICTION_RESCUE / BLOCKED) |
| L4 trained experts | Python `PlanBV4HighConvictionChallenger`, `PlanBV85PostEntryProtectionChallenger`; TS `ai/high-conviction-overlay.ts`, `ai/owner-demo-entry-outcome-model.generated.ts` | trained XGBoost consensus + give-back classifier + generated owner logistic |
| L5 orchestration | `ai/m1-tactical-scheduler.service.ts` (4,871 lines), `ai/vps-forex-signal-collector.service.ts` (7,283 lines), `strategy/strategy-orchestrator.service.ts` | scan → decide → dispatch through the shared pipeline |
| L6 risk & execution | `risk/risk.service.ts`, `execution/services/position-sizing.service.ts`, `execution/execution.service.ts`, `execution/orchestration/*` | fail-closed risk pipeline, sizing, dispatch, CAS order state |
| L7 exits & protection | `broker/adapters/paper-broker.adapter.ts` (profit lock), `execution/reconciliation/{live-demo-profit-protection,pepperstone-demo-net-profit-lock,pepperstone-demo-post-peak-rescue,verified-profit-stop-runner-policy}.ts`, `ai/post-entry-demo-drawdown-guard.service.ts` (v8.9) | four-plus independent exit-management engines |
| L8 evidence | `ai/m1-tactical-evidence.service.ts` (3,013 lines) + decision tables (`trading.m1_tactical_decisions`, `ensemble_shadow_decisions`, post-entry observation tables) | decision-time persistence + outcome settlement |

Python engine: FastAPI service, signals-only (paper candidates; live refused
at scheduler registration), two shadow challengers, ~30 fenced research
families under `app/domain/training/`.

---

## 1. (a) Architectural weaknesses and duplicated intelligence

Findings A1–A9. Severity is stated for research and for the V2 design.

- **A1 — Four parallel direction scorers.** `m1-tactical-candidate.ts`
  (`directionQuality`, 9-feature fixed-weight composite),
  `plan-b-multimodel-shadow.ts` (its own `directionQuality`),
  `v8-shadow-meta-scorer.ts` (30-feature frozen logistic, threshold 0.46),
  `adaptive-opportunity-score.ts` (directionQuality as one of ten weighted
  inputs). Each feeds a different admission surface; none is calibrated
  against the same outcome table. Research severity: high — any V2 claim of
  "the model's direction estimate" is ambiguous until these are unified or
  explicitly stratified.
- **A2 — Six reversal definitions.** `m1-tactical-route.ts`
  (`reversalImpulse`, `m5ReversalConfirmed`), `plan-b-multimodel-shadow.ts`
  (`reversalConfirmed`), `paired-direction-reversal.ts`
  (`PAIRED_REVERSAL_MIN_DIRECTION_PROBABILITY=0.64`),
  `m1-reversal-timing-fusion-shadow.ts`, `planb-reversal-m1-continuation-shadow.ts`
  (which exists specifically to observe the mismatch between the first two),
  `confirmed-reversal-cross-sleeve-canary.ts`. The engine keeps a service
  whose purpose is to measure the disagreement between two of its own
  definitions of the same concept. Severity: high.
- **A3 — Nine reliability/evidence gates of the same shape.**
  `m1-tactical-reliability.ts`, `m1-shadow-pair-side-reliability.ts`,
  `m1-meaningful-scout-reliability.ts`, `m1-provisional-scout-reliability.ts`,
  `paper-route-reliability.ts`, `paper-scout-realised-payoff.ts`,
  `demo-profitability-reliability-gate.ts`,
  `pepperstone-demo-advisory-quality-risk.ts`,
  `paper-research-requalification-shadow.ts` — each computes
  samples/wins/losses/PF/netR with its own min-sample floors. Severity:
  medium (consolidation target for V2).
- **A4 — Six calibration layers.** `adaptive-prediction-calibration.service.ts`
  (Bayesian blend, prior weight 8, authoritative at ≥12 samples),
  `adaptive-edge-matrix.service.ts` (mature at ≥20),
  `adaptive-shadow-directional-pulse.ts` (decay 0.65),
  `paper-spread-calibration-{shadow,history}.ts`, `m1-causal-commission-shadow`
  (fee p90), `m1-probation-causal-cost-stress`. `calibration-bidirectional-conflict.ts`
  exists solely to arbitrate conflicts between two of them. Severity: medium.
- **A5 — Duplicated ensemble intelligence in Python.** The event-pair-bundle
  mode of `BaselineXGBoostModel` (pooled opportunity + per-pair direction +
  regime router, thresholds from training medians) implements the same
  architecture as `PlanBV4HighConvictionChallenger`'s frozen three-expert
  consensus — the same regime thresholds appear in both
  (`baseline_xgboost.py:540-549` vs `high_conviction_challenger.py:317-325`).
  One path is publishable, the other frozen-shadow. Severity: high for V2
  (the Challenger must define exactly one implementation of its consensus).
- **A6 — Five unimportable research modules (dead references).**
  `six_pair_v74_quote_profitability_router.py`, `six_pair_v74_micro_ev_router.py`,
  `six_pair_v75_quote_sleeve_router.py`, `six_pair_v75_pair_specialists.py`,
  `bounded_final_campaign.py` import modules that were never committed
  (`quote_microstructure`, `single_pair_v41/v42`); stale `__pycache__`
  artifacts prove they once ran locally. Severity: medium — evidence of an
  uncontrolled research treadmill (~30 numbered families v11…v39).
- **A7 — Exit-protection logic in four-plus engines with divergent numbers
  for the same concept.** PAPER `evaluatePaperProfitLock` (arm +0.50R,
  retention 0.70/0.75/0.80/0.85/0.90) vs Pepperstone DEMO
  `evaluatePepperstoneDemoNetProfitLock` (0.55/0.65/0.75/0.80, progressive
  TP overlay to 0.91) vs `LiveDemoProfitProtectionService` thesis/adverse
  functions vs v8.9 drawdown guard (force-close ≤ −0.4R at 7 min,
  `PLAN_B_V89_DEMO_DRAWDOWN_CLOSE_R = -0.4`) vs post-peak rescue
  (`pepperstone-demo-post-peak-rescue.ts`, 0.30–0.50R unprotected band).
  No shared constants or code. Severity: high — exit management is the
  dominant economic lever (see G1) and cannot be evaluated as one policy.
- **A8 — Owner carve-outs resolve by precedence buried in the scheduler.**
  7-lot requested ceiling (`owner-pepperstone-demo-ongoing-seven-lot.ts`) vs
  weak-reversal pull-back to 4 lots (`owner-demo-weak-reversal-exposure-ceiling.ts`)
  vs 6-lot high-conviction ceiling (`pepperstone-demo-high-conviction-lot-ceiling.ts`)
  vs recovery canary 0.01 lot / 240 min. The "narrowest cap wins" precedence
  lives only in `m1-tactical-scheduler.service.ts` code, not in one policy
  module. Severity: medium.
- **A9 — Expired trial capsules still evaluated per scan.**
  `pepperstone-demo-alternative-trial` (ended 2026-11-16), `-advisory-alternate-trial`
  (ended 2026-11-17), `-counter-pilot` (ended 2026-11-20), noon-lot trial
  (ended 2026-11-20) are inert but still executed as predicates each scan;
  `multimodel-demo-authority.ts` is a `@deprecated` re-export shim. Severity:
  low.
- **A10 — Two reconciliation systems with separate taxonomies.**
  `execution/reconciliation/state-reconciliation.service.ts` (9 discrepancy
  types) vs `broker-reconciliation/services/broker-trade-reconciliation.service.ts`
  (LIVE statement import, own run/discrepancy tables). Severity: low-medium
  (intentional separation but compounding audit surface).

## 2. (b) Uncalibrated confidence

- **B1 — M1 confidence is a capped monotone transform, not a probability**
  (inherited from PR #836 §1.1: `confidence = 0.5 + 0.3·directionQuality +
  0.08·efficiency5 − 0.08·volatilityScore`, hard cap 0.738
  (`m1-tactical-candidate.ts:27`); drift envelope hard band [0.640079,
  0.751451] from a frozen 4,599-event sample in `ensemble-governance.ts`).
  The measured AUC on the settled cohort is 0.4752 — chance-level at this
  sample size (PR #836 §3.3). V2 must not reuse this quantity as an outcome
  probability.
- **B2 — v8 meta scorer is a frozen 30-feature logistic** with admission
  threshold 0.46 (`v8-shadow-meta-scorer.ts:3`), never re-fit since freeze;
  its probability semantics are unverified on DEMO outcomes.
- **B3 — The generated owner logistic is trained on 53 + 45 same-broker
  fills** (`owner-demo-entry-outcome-model.generated.ts`: CONFIRMED_REVERSAL
  53 samples 29W/24L, EARLY_TRANSITION 45 samples 25W/20L; 7 features;
  source `EXACT_OWNER_BROKER_SETTLED_AFTER_FEE_FILLS`, cutoff
  2026-11-19T00:00:00Z, `status: RESEARCH_ONLY`). 7 features on 53 samples
  is ~7.6 observations per parameter — overfit by construction; the
  wrapper correctly denies trade authority. Note for governance: fitted
  coefficients from the owner's private fills are committed in the public
  repo (coefficients, not rows; the directive's "no private datasets"
  boundary should explicitly classify whether generated coefficients derived
  from owner-private fills are publishable — flagged for the review gate).
- **B4 — Adaptive calibration is a small-sample Bayesian blend** (prior
  weight 8; authoritative at ≥12 samples, mature at ≥20). At those sizes the
  Wilson 95% half-width on a 0.55 win rate is ±0.21 — the "calibrated"
  number is still noise-dominated. It does, however, have PAPER teeth
  (can inject `ADAPTIVE_CALIBRATION_NEGATIVE_EDGE` blockers) — an authority
  layer built on unproven calibration.
- **B5 — `CONFIDENCE_FLOOR = 0.60` is copy-pasted in ≥6 modules** (Python
  `model_qualification.py:49`, `bounded_final_campaign.py:50`,
  `six_pair_opportunity_selector.py:38`,
  `deterministic_strategy_ensemble.py:31`, `side_selection_three_class.py:32`;
  TS `strategy-orchestrator.service.ts` CONFIDENCE_THRESHOLD 0.6 clamped
  0.60–0.70). A single threshold that behaves as one number in prose and six
  in fact. Severity: medium.
- **B6 — No proper-scoring-rule calibration anywhere in the runtime path.**
  Brier/reliability appear only in offline qualification
  (`compute_classification_metrics`); no runtime surface records a
  probability whose calibration is tracked against settled outcomes
  end-to-end. This is the single largest gap for V2: an honest Challenger
  needs one calibrated probability per decision, measured continuously.

## 3. (c) Data-quality and evidence-recording defects

- **C1–C6 — the M1 evidence defects D1–D6** established in PR #836 §5
  (first-write-wins upsert silently dropping re-evaluations of the same
  bar; raw candle body/wick preserved only through the non-invertible
  9-term composite; first-triggered abstention reason masking latent
  predicates; unfilled abstentions have no outcome class; RECORDED_AS_OF
  alone does not authenticate provenance; route cells unpowered at n=38).
  Inherited, not restated.
- **C7 — Uniform `priceDigits = 10`** (`market-data.service.ts:97`) computes
  `spreadPoints` on a fixed 10^10 scale for all instruments; any consumer
  interpreting it as broker points mis-scales JPY pairs by 10^7. The Python
  feature contract derives `m1_spread_bps` from it; the scale convention is
  consistent but unit-fragile. Severity: medium (verify per-consumer).
- **C8 — MetaApi "M1 candles" are 30-second quote snapshots**
  (`provider-quote-candle-store.service.ts:58` writes
  open=high=low=close=midpoint on first sample) stored in the same
  `provider_quote_candles` table as cTrader-native bars — mixed-provenance
  rows in one table with no type discriminator on semantics. Fail-closed
  gates exist for freshness, not for bar semantics. Severity: medium.
- **C9 — Silent gap dropping in higher-TF aggregation** and a corpus
  exporter that selects only `sample_count >= 2` minutes: data shortfall
  manifests as fewer candles / richer-sampled minutes, never as an error —
  a selection-bias channel into every downstream study. Severity: medium.
- **C10 — Synthetic bid/ask model for PAPER fills** (`getLatestPositiveSpreadQuote`:
  bid = mid − spread/2 with spread = max(current, rolling P90 capped at
  p50×4/p75×2)) — a conservative model of the book, not observed quotes.
  PAPER and DEMO outcomes are therefore not cost-comparable without
  normalization; the Champion–Challenger design must place both engines on
  broker-observed fills (DEMO) for the final measure.
- **C11 — The 192-trade anonymized research export is not in the repo**
  (definitive search; only VPS-local shadow-audit directories referenced in
  prose). Absence documented as required; all V2 measurements that need
  per-trade R multiples are blocked on separately authorized exports (see
  Backlog, phase H).

## 4. (d) Overfitting and instability

- **D1 — Early-stopping set equals reported-metrics set** in
  `train_xgboost.py` (`eval_set` on the same validation slice whose metrics
  are reported) — a mild but real optimistic bias in the headline offline
  numbers. The MTF pipeline (`train_multitimeframe.py`,
  `model_qualification.py`) uses nested windows with horizon-sized purges and
  is clean in this respect.
- **D2 — The version treadmill is a multiple-comparisons machine.** ~30
  research families (v11…v39, six_pair_v73…v75, demo_*, ood_*) each pass a
  research gate (`DEFAULT_RESEARCH_GATE`: balanced accuracy ≥0.52, Sharpe
  ≥1.0, PF ≥1.15, maxDD ≤0.12, fold/instrument fractions, ≥100
  non-overlapping periods) — but the gate is applied per family after
  iterating families; the probability that *some* family passes by chance is
  far above the per-family error rate. The `zai_economics_first_gate.py`
  (PBO ≤0.5, DSR >0, two independent windows) is the right idea but is
  defined for exactly one family line. V2 must pre-register one primary
  specification, with the family count declared and counted in the
  uncertainty statement.
- **D3 — Frozen drift envelope from 4,599 events** (`ensemble-governance.ts`)
  will go stale as regime mix changes; there is no re-freeze cadence or
  drift monitor on the envelope itself.
- **D4 — Expired trials and immutable rollout policies V1–V8** retained in
  the scheduler evaluate as dead predicates (see A9) — compounding scan cost
  and review surface, with three lot-preference constants for the same 0.2
  number across four names (PAPER_PRODUCT_PREFERRED_LOT etc.).
- **D5 — The generated owner model (B3) is the most acute overfit risk
  in-repo**: per-route logistic on 45–53 samples with a training cutoff
  2026-11-19; any reuse as evidence beyond its RESEARCH_ONLY status is
  prohibited by its own header — V2 treats it as a negative example of
  scope discipline, and its coefficients are not V2 inputs.

## 5. (e) Predicted-vs-realized discrepancies

- **E1 — Realized payoff geometry is ≥2× worse than design.** Design:
  stop 1.1×ATR (1R), target 1.6R (`m1-tactical-candidate.ts:24-25`), implying
  break-even win rate 38.5% before costs and average-loss/average-win 0.625
  under equal sizing. Observed on the settled cohort (PR #836 §3.4,
  operator aggregates): 54.7% wins yet net-negative after costs, forcing
  average-loss/average-win ≥ 1.207 — at least ~2× the design ratio. The
  dominant economic defect is exit management / cost drag truncating wins or
  extending losses, not entry frequency. V2's entry-vs-exit decomposition
  (see `v2-entry-exit-decomposition.cjs`) exists to split exactly this
  effect into win truncation / loss extension / cost drag once per-trade R
  multiples are authorized.
- **E2 — The predicted-cost veto was demoted to shadow.** Ensemble
  admission's `netExpectedR = expectedR − 1.25×spread/stopDistance`
  (`ensemble-governance.ts:416,431`, floor 0.08) is `SHADOW_ONLY`
  (`modifiesExecution: false`) — predicted cost no longer participates in
  admission while realized costs demonstrably flip the aggregate sign. This
  is the clearest predicted-vs-realized gap with an economic consequence:
  decisions pass on gross geometry and fail on net realization.
- **E3 — Multiple prediction layers, no shared scoreboard.** Plan-B
  `expectedR`, v8 meta probability, adaptive calibrated win rate, owner
  forecastNetR, M1 expectancy blend (`m1-tactical-expectancy.ts`, prior 5 /
  recent 0.25) — five families of predicted quantities, none tracked against
  the same realized-outcome ledger with a proper scoring rule. V2
  requirement: one prediction scoreboard, all live predictions registered
  before outcome, scored after settlement.
- **E4 — Fee prediction at p90 vs realized commission** (`m1-causal-commission-shadow`
  p90 estimator; `pepperstone-live-micro-risk.ts` reserves $8/lot) — the
  reserve-vs-realized gap is not recorded anywhere as a calibration metric.
- **E5 — minStopPips = 5.0 (`risk-profile` default) vs realized 4.1–4.4-pip
  LIVE stop rejections** (blockage root cause, prior branch
  `research/live-execution-blockage-20261125`): a policy number chosen
  against an assumption about achievable stop distances that the broker
  contradicted.

## 6. (f) Complexity and expert conflicts

- **F1 — Scale asymmetry between deciders and advisors.** The actual DEMO
  decider is one `canExecute` conjunction in the 4,871-line scheduler,
  upstream `evaluateMultimodelAuthority`, and the risk pipeline. Around it:
  ~160 advisory/shadow files, a 12-entry expert registry in which **every
  entry declares `executionAuthority: 'NONE'`** (`ensemble-expert-registry.ts`).
  The intelligence is predominantly advisory; the executing intelligence is
  predominantly the M1 heuristic composite + governance floors. For V2 this
  means: the "model" being evaluated economically is largely the L2 heuristic
  stack, not the trained experts.
- **F2 — Two collectors with duplicated but unequal pipelines.**
  `m1-tactical-scheduler.service.ts` (DEMO path) and
  `vps-forex-signal-collector.service.ts` (7,283 lines, PAPER path, VPS
  external signals, stop 1.5×ATR / target 2.5×ATR ≈ 1.67R) — different
  geometry, different authority, separate reliability layers. Champion
  economics measured on DEMO cannot be attributed to a single entry
  specification while two exist.
- **F3 — Authority exceptions carved per owner flag.**
  `IREXPRO_OWNER_DEMO_LOSS_PAUSES_ADVISORY_ONLY=enabled` converts three loss
  brakes to warnings for one owner DEMO account — brake semantics silently
  differ between deployments with and without the env var (the
  `BROKER_COST_EVIDENCE_INCOMPLETE` brake still blocks). Documented, but a
  governance differential that V2 must hold constant: Challenger and
  Champion must run under identical brake semantics.
- **F4 — The two-way contradiction is institutionally acknowledged**
  (A2, A4): services exist to arbitrate the conflicts between the engine's
  own overlapping definitions. This is the complexity signature that V2's
  consolidation phase is designed to remove.

## 7. (g) Economic underperformance sources

Ranked by evidence strength, from the operator aggregates (PR #836) and code:

- **G1 — Exit management truncates wins (dominant, bounded).** E1: realized
  payoff ratio ≥1.207 vs design 0.625. Candidate mechanisms in code:
  profit-lock arm at +0.50R with retention ladders (0.55–0.90) and
  progressive TP overlay to 0.91 of target; v8.9 force-close at −0.4R by
  minute 7 (pre-empts the 1R stop); failed-move rescue at ≥15 min with
  peak <0.25R; post-peak rescue giveback conditions. Each is individually
  plausible; the split among win truncation / loss extension / cost drag
  requires per-trade R multiples (blocked, C11). The V2 decomposition
  contract (winTruncationR, lossExtensionR, costDragR) is defined so this
  split is the first computation performed on authorized exports.
- **G2 — Cost drag unmodeled at admission.** E2: gross-geometry admission
  with shadow-only predicted cost; realized commission+swap+spread at DEMO
  scale flips net sign (both abstention and non-abstention cohorts net
  negative after costs on the 192-trade aggregates).
- **G3 — Entry discrimination absent.** M1 AUC 0.4752 — no measurable
  discrimination at this sample size; abstention cohorts statistically
  indistinguishable (Fisher p = 0.5865, PR #836 §3.2). Win rate 54.7% is
  within noise of 50% (p = 0.22). Until a calibrated entry model exists,
  the entry layer's economic contribution cannot be distinguished from
  zero — V2's first falsifiable claim is exactly this null.
- **G4 — Stop-geometry vs cost floor mismatch.** minStopPips 5.0 with 1.1×ATR
  stops colliding with 4.1–4.4 pip rejected stops (E5) — either stops widen
  (risk per trade rises) or entries are skipped (adverse selection on calm
  periods).
- **G5 — Sample scarcity as the binding constraint on every economic
  question.** Non-abstained cohort n=38 (19W/19L); per-route cells 30–80;
  per-reason cells smaller. AUC 0.55 detection needs ~518 per class; the
  platform's own promotion floor (`MIN_PAPER_PROMOTION_M1_ROWS_PER_INSTRUMENT
  = 100_000`) is three orders of magnitude beyond what DEMO can generate in
  weeks. V2's statistical framework must state detection limits up front
  and size the DEMO campaign accordingly.

## 8. Assumptions challenged (explicit)

1. "AI win rate (live) > 50%" as the success metric (PROJECT_VISION.md) —
   unmeasurable at current sample sizes and economically insufficient
   (54.7% wins net-negative). Replace with after-cost, risk-normalized
   expectancy with stated uncertainty.
2. "The AI → Strategy → Risk → Execution one-way pipeline" — true for
   orders; false for intelligence: ~10 calibration/reliability layers feed
   back into admission and sizing on the PAPER path (B4), so the loop is
   already closed in production without a controlled experiment protocol.
3. "Plan-B is the model" — the trained experts hold no execution authority
   (F1); the economically relevant "model" is the heuristic composite plus
   governance floors. Naming matters for the Challenger definition.
4. "More research families will find the edge" — D2: the treadmill's
   multiplicity is itself a source of false positives; pre-registration,
   not iteration, is the V2 instrument.
5. "Historical replay settles the question" — offline replay is
   preliminary only (directive amendment): final measures are
   broker-confirmed DEMO outcomes on isolated accounts.

## 9. Limitations

- Aggregate-level economic statements inherit PR #836's operator aggregates
  (192 settled DEMO trades); no per-trade magnitudes were available to this
  audit, so G1's split is bounded, not measured.
- Schema-derived statements (evidence matrix) are code-verified, not
  row-verified.
- Severity gradings are research judgment, not measured error rates.
- No claim of V2 feasibility-or-infeasibility is made beyond the falsifiable
  statements above; the architecture proposal
  (`AI_ENGINE_V2_CHALLENGER_ARCHITECTURE_20261127.md`) is a design for
  testing that question, not a demonstration of an edge.
- This audit changes no runtime behavior; deployment hold and all
  production boundaries remain intact.
