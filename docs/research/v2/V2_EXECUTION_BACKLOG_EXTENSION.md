# iRexPro AI V2 — Research Execution Backlog Extension

Research-only. Branch `research/ai-v2-challenger-architecture-20261127`. The production engine, risk controls and LIVE boundaries are untouched. Each item records its own definition of done; nothing is marked complete without committed reproducible evidence (test +, where applicable, authorized data export referenced).

**Coordination:** this extends the existing `V2_EXECUTION_BACKLOG.md` workstreams (WS0–WS6, PR #839). Item mapping: Stage-0 foundations → WS0; RES-V2-01/02/03/05 → WS1/WS4/WS3 evidence prerequisites; EVAL-V2-10/11 and GOV-V2-01 → WS2; ISO-V2-10..14 → WS5; carried coordination → WS6. Task IDs here use the `-V2-` extension namespace and never renumber the existing workstream items.

## Execution contract (inherits docs/EXECUTION_BACKLOG.md)

- One independently reviewable vertical slice at a time; research, DEMO testing and production changes remain strictly separated.
- No automatic promotion from this backlog. No claim of profitability or production readiness from retrospective performance.
- Coordinate with open PRs #834, #836, #837, #838 (M1 stack) and #810/#813/#818 (platform/expert/blockage reviews) before touching shared contracts — duplication is forbidden.

## Stage 0 — Offline foundations (this PR)

- [x] AUD-V2-01 First-pass full-engine audit across the seven weakness categories with code-grounded evidence (`docs/research/AI_V2_AUDIT_FINDINGS.md`).
- [x] ARCH-V2-01 Layered Challenger architecture with the six DEMO-isolation requirements mapped (`docs/research/AI_V2_CHALLENGER_ARCHITECTURE.md`).
- [x] EVAL-V2-01 Evaluation metrics module: net after-cost, expectancy, max DD, profit factor, Brier/ECE calibration, chronological stability, deterministic bootstrap CI, overlap clustering (`apps/api/scripts/research/v2-settled-trade-economics.cjs` + tests).
- [x] EVAL-V2-02 Cost-first lower-bound admission policy with six abstention reasons aligned to the #836 taxonomy (`apps/api/scripts/research/v2-challenger-admission.cjs` + tests).
- [x] EVAL-V2-03 Paired Champion–Challenger comparison: unpaired-refusal, exact sign test, paired bootstrap CI, minimum-window rule (`apps/api/scripts/research/v2-paired-champion-challenger.cjs` + tests).
- [x] ISO-V2-01 DEMO-isolation topology validator for the six comparative-environment requirements, descriptor-only (`apps/api/scripts/research/v2-demo-isolation-topology.cjs` + tests).
- [x] CI-V2-01 All V2 research tests wired into `api-ci.yml` on the PR path.

## Stage 1 — Historical replay (blocked on authorized exports)

- [ ] RES-V2-01 Obtain separately authorized anonymized DEMO exports (M1 192-trade cohort baseline + extended settled window) under the PR #834 evidence contract; document field completeness gaps without imputation. Definition of done: coverage report + gaps list, no fabricated fields.
- [ ] RES-V2-02 Entry-intelligence replay: decision-time features only, chronological holdout, per route/pair/session calibration curves; predicted-vs-realized R gap decomposition (calibration error vs cost drag vs exit confound). Definition of done: replay script + calibration report on the authorized window, CI stated.
- [ ] RES-V2-03 Exit-management replay on identical fixtures: fixed-geometry vs peak-retention vs trailing variants, MFE/MAE path grids; each variant's paired comparison vs incumbent exit. Definition of done: paired window report with sign test + bootstrap CI.
- [ ] RES-V2-04 Abstention counterfactual study on the #836 cohort with explicit selection-bias caveats (abstained cohort is not comparable to admitted cohort; report both, conclude neither).
- [ ] RES-V2-05 Broker-observed cost export per instrument (P90 spread, commission, slippage) from DEMO; until delivered, admission stays refused (PAPER_CONSERVATIVE cannot admit).

## Stage 2 — Independent offline evaluation

- [ ] EVAL-V2-10 Pre-registered evaluation window set; freeze before running; record the criteria (net after-cost, risk-normalized expectancy CI, max DD, PF, ECE/Brier, stability fraction, sample sufficiency) before observing results.
- [ ] EVAL-V2-11 Sample-size honesty report: given observed variance, the minimum settled trades / windows required to distinguish a 0.05R edge at 95%; state plainly when current samples cannot.
- [ ] GOV-V2-01 Challenger artifact freeze (hash + provenance manifest); retirement criteria for unused observers (audit finding f).

## Stage 3 — Broker-connected DEMO comparison (only after independent review)

- [ ] ISO-V2-10 Instantiate the two-engine DEMO topology per the architecture doc §4 (separate Pepperstone cTrader DEMO accounts, engine identities, engine-scoped credentials/positions, equivalent starting conditions). Prerequisite: operator authorization + platform support via the #810 architecture review line; this repository only records the topology contract.
- [ ] ISO-V2-11 Immutable attribution ledger implementation (append-only, SHA256-chained, engine-stamped) — research side only; no production service modification.
- [ ] ISO-V2-12 Comparative dashboard: per-engine netAfterCostReturn, riskNormalizedExpectancy, maxDrawdown, profitFactor, calibration; paired-window view.
- [ ] ISO-V2-13 Paired-window DEMO evaluation campaign: ≥30 non-overlapping windows (target: more, given overlap-inflation caveats), broker-confirmed outcomes, reported costs and execution quality; verdicts only from `v2-paired-champion-challenger.cjs` semantics.
- [ ] ISO-V2-14 Promotion review packet: paired CI, calibration ECE, sample sufficiency, limitation list; decision reserved to the operator. No automatic promotion.

## Carried coordination items (outside V2 scope, tracked in docs/EXECUTION_BACKLOG.md)

- #818 retarget to `main` after #810 merges.
- #836 outstanding statistical corrections; #837 integration review; #838 CI-only mirror lifecycle.
- Deployment hold `DEPLOY-HOLD-ACTIVE-BROKER-20261122.txt` remains intact.

## Checkpoint — 2026-11-27 (M1 milestone slice: research contract frozen)

- Branch `research/ai-v2-challenger-architecture-20261127`, stacked on the combined M1 research candidate (`55c11626`) and the prior V2 slices (`681e670c`, `ebceae3d`, `e7915606`, PR #839 head); nothing in the existing V2 or M1 artifacts was altered.
- This slice delivered the four M1-milestone workstreams of `V2_EXECUTION_BACKLOG.md`:
  - **WS1.1** `docs/research/v2/schemas/decision-record-v1.schema.json` + `v2-decision-record-schema.cjs` (+14 tests) — the C1–C6 contract as a versioned, canonically hashable JSON Schema with a self-contained validator; a record is accepted only when schema AND semantic contract both pass.
  - **WS2.1** `v2-calibrator-bundle.cjs` (+12 tests) — isotonic (PAVA) and Platt calibrators serialized into canonical, SHA-256-pinned, load-time-verified bundles; tampering any value (parameters or metadata) is refused; non-monotone calibrators refused (the V1 cap-0.738 defect class); CALIBRATED state derivable only from holdout evidence ≥100.
  - **WS2.2** `v2-purged-calibration.cjs` (+10 tests) — purged chronological calibration: unsorted input refused, two-sided purge (test decisions inside the outcome horizon AND train labels not yet knowable at test start), per-fold bundle path fit→serialize→pin→load-verify, held-out-only Brier/ECE, CALIBRATED only at ≥100 held-out records, end-to-end determinism.
  - **WS3.2** `V2_HOLD_VS_CLOSE_COUNTERFACTUAL_PROTOCOL.md` + `v2-hold-vs-close-shadow.cjs` (+13 tests) — the pre-registered hold-vs-close counterfactual shadow protocol, frozen and SHA-pinned before any fixture path was examined; post-freeze amendment structurally refused; first-touch bracket with worst-case stop-first rule; exact two-sided sign test hand-verified; power honesty table included; verdict vocabulary cannot adopt or recommend.
- 48 new tests; the whole V2 research suite is 106/106 green; the M1 stack (38 tests) is untouched and green. All tests run offline on synthetic fixtures; no authorized row-level data was accessed; no broker account was created or modified.
- Milestone M1 status: WS1.1/WS2.1/WS2.2/WS3.2 ✅ frozen. Remaining M1 items: WS1.2/WS1.3 (supersede-counting persistence + fill↔decision linkage specs), WS3.1/3.3–3.5 (exit state machine, profit-retention ladder re-derivation, corpus open questions as pre-registered experiments).
- Blockers for Stage 1 are unchanged: authorized anonymized exports (RES-V2-01), broker cost export (RES-V2-05).
- No profitability, edge or production-readiness claim is made or implied by this slice.

## Checkpoint — 2026-11-27 (extension slice)

- Branch `research/ai-v2-challenger-architecture-20261127`, stacked on the combined M1 research candidate (`55c11626`) and the prior V2 slice (`681e670c`, PR #839 head); nothing in the existing V2 or M1 artifacts was altered.
- This extension delivered: `v2-settled-trade-economics.cjs` (trade-level after-cost economics, deterministic bootstrap CIs, overlap clustering), `v2-challenger-admission.cjs` (lower-bound cost-first admission), `v2-paired-champion-challenger.cjs` (paired statistical comparison), `v2-demo-isolation-topology.cjs` (six-requirement validator) — 4 modules + 4 test files, 35 tests, plus the seven-category audit companion and this backlog extension.
- All tests run offline with synthetic fixtures; no authorized row-level data was accessed; no broker account was created or modified.
- Blockers for Stage 1: authorized anonymized exports (RES-V2-01), broker cost export (RES-V2-05).
- No profitability, edge or production-readiness claim is made or implied by this backlog.
