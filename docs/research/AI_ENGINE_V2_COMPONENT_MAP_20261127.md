# iRexPro AI Engine V2 — engine component map

Status: research-only component inventory of the V1 Champion engine. This is
backlog item **P1-0**, the shared groundwork the P1 consolidation specs
(P1-1..P1-5 in `AI_ENGINE_V2_EXECUTION_BACKLOG_20261127.md`) consume. No
runtime edit, no model or threshold change, no DB or broker access, no
deployment; deployment hold intact. `executionAuthority: NONE`.

Method: every path, artifact, constant and line number below was re-verified
by direct file reads on this branch's tree (base `main` @ `80c316fe`), and the
Python 128-column claim was verified by *executing*
`multitimeframe_feature_columns()`. The machine-readable mirror
`apps/api/scripts/research/v2-engine-component-map.cjs` (64 components) is
validated by `v2-engine-component-map.test.cjs` in CI — on every run the
drift detector re-proves that each mapped file still exists where recorded,
that the audit-count reconciliation holds (4 scorers / 6 reversal definitions
/ 9 reliability gates / 6 calibration layers / ≥4 exit engines / 5 prediction
families / 6 confidence-floor copies), and that tampering with the inventory
is a typed refusal.

Companion artifacts: `AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md` (findings A1-A10,
B1-B6, C7-C11, D1-D5, E1-E5, F1-F4, G1-G5),
`AI_ENGINE_V2_CHALLENGER_ARCHITECTURE_20261127.md` (V2 decisions V2-1..V2-10),
`AI_ENGINE_V2_EXECUTION_BACKLOG_20261127.md` (P1-0 = this map).

---

## 0. Layer map (verified)

| Layer | Primary code (verified line counts) | Role |
| --- | --- | --- |
| L0 data | `market-data/market-data.service.ts` (priceDigits=10 at line 97), `market-data/services/{provider-quote-candle-store,ctrader-quote-collector,metaapi-quote-collector}.service.ts` | cTrader broker-native M1..H4 candles; MT5 sampled fallback |
| L1 features | `ai/m1-tactical-features.ts` (502 lines; `M1TacticalFeatureSnapshot` at line 16); Python `models/multitimeframe_features.py` (128 columns, executed) | TS 9-feature clamped M1 composite; Python 128-column MTF contract |
| L2 candidate | `ai/m1-tactical-candidate.ts`, `ai/plan-b-multimodel-shadow.ts` (486 lines), `ai/paired-direction-reversal.ts`, `ai/v8-shadow-meta-scorer.ts` | four direction scorers (§1) |
| L3 route/admission | `ai/m1-tactical-route.ts` (six abstention reasons), `ai/ensemble-governance.ts`, `ai/multimodel-authority.ts` + the nine reliability gates (§3) and six calibration layers (§4) | route classification + ensemble admission + DEMO authority |
| L4 trained experts | Python `PlanBV4HighConvictionChallenger`, `PlanBV85PostEntryProtectionChallenger`; TS `ai/high-conviction-overlay.ts`, `ai/owner-demo-entry-outcome-model.generated.ts` | trained consensus + generated owner logistic |
| L5 orchestration | `ai/m1-tactical-scheduler.service.ts` (**4,871 lines**), `ai/vps-forex-signal-collector.service.ts` (**7,283 lines**), `strategy/strategy-orchestrator.service.ts` (**1,536 lines**) | scan → decide → dispatch |
| L7 exits | `broker/adapters/paper-broker.adapter.ts`, `execution/reconciliation/*` (six engines, §5) | exit management (the dominant economic lever, G1) |
| L8 evidence | `ai/m1-tactical-evidence.service.ts` (**3,013 lines**) + decision tables | decision-time persistence + outcome settlement |

Python engine: FastAPI service, signals-only, two shadow challengers,
~30 fenced research families under `app/domain/training/`.

---

## 1. Four direction scorers (A1) — P1-1 unification inputs

| # | File | Output formula (verified) | Key constants (lines) |
| --- | --- | --- | --- |
| S1 | `ai/m1-tactical-candidate.ts` | `directionQuality = clamp01(0.5 + composite/2)`; composite = 9-term fixed-weight sum (line 145-154) | stop 1.1×ATR (l.24), target 1.6R (l.25), minStopPips 5 (l.26), **maxConfidence 0.738** (l.27); weights 0.19/0.10/0.16/0.10/0.20/0.08/0.05/0.04/0.08 (l.146-154) |
| S2 | `ai/plan-b-multimodel-shadow.ts` | `directionQuality()` (l.124-133) = 0.42·conf-term + 0.25·emaSeparation + 0.23·mtfStrength + 0.10·rsiDirectional | conf floor 0.64 (l.50); expectedR floor 0.08 (l.51); portfolio floor 0.35 (l.61) |
| S3 | `ai/v8-shadow-meta-scorer.ts` | `probability = sigmoid(logit)` (l.131) over frozen `BASE_WEIGHTS` | threshold **0.46** (l.3); target R 2.5/1.5 ≈ 1.67 (l.4); shadow threshold 0.40828402366863903 (l.7); **29 weight entries** (l.51-80) |
| S4 | `ai/adaptive-opportunity-score.ts` | opportunity score = 10 weighted inputs (sum = 1.00, l.8-17) | directionQuality carries weight **0.11** of ten |

S1 confidence = `min(0.738, clamp01(0.5 + 0.3·directionQuality + 0.08·efficiency5 − 0.08·volatilityScore))` (l.157-161) — the audit's B1 transform. S1 score adds 0.15·confidence + 0.05·momentum1Atr + 0.05·htfAgreement (l.163-167). None of the four outputs is calibrated against the same outcome table (A1); units and missing-value semantics differ per scorer — exactly the columns/units/missing-value contract P1-1 must define once for V2.

**Missing-value semantics observed:** S1 clamps every composite term via `clampSigned` and reads `?? 0` defaults for optional M5/M30 fields (l.120-135); S2 clamps terms into [0,1] individually; S3 defaults unknown `shortHorizonMomentumAtr` to 0 (l.133-137); S4 clamps to [0,1] with `Number.isFinite` else 0. The V2 contract must pick one rule, not four.

## 2. Six reversal definitions (A2) — P1-2 inputs

| # | File | Predicate (verified) | Constants (lines) |
| --- | --- | --- | --- |
| R1 | `ai/m1-tactical-route.ts` | `reversalImpulse` (l.97-106): failed breakout against direction + quality/momentum/ema-slope gates; `m5ReversalConfirmed` (l.108-118): establishedTurn (≥0.08/≥0.08/≥−0.1) OR decisiveFreshTurn (≥0.6/≥0.3/≥−0.1) on completed M5 bars | via policy: minReversalQuality 0.6 (candidate l.32), minReversalImpulseAtr 0.25 (l.33) |
| R2 | `ai/plan-b-multimodel-shadow.ts` | `reversalConfirmed` (l.141-155): TREND_WEAK + conf ≥ 0.64 + extension ≤ 1.15 + volatility ≤ 0.55 + momentum ∈ [0.5, 1.5] + expectedR ≥ 0.18 | l.50-54 |
| R3 | `ai/paired-direction-reversal.ts` | paired BUY/SELL probability-gap gate | min direction probability **0.64** (l.3); min absolute probability 0.40828402366863903 (l.4); min aligned momentum 0.15 (l.5); min net expectedR 0.08 (l.6) |
| R4 | `ai/m1-reversal-timing-fusion-shadow.ts` | fusion shadow over the R1/R2 timing disagreement | min quality 0.6 (l.6), min momentum 0.25 (l.7) |
| R5 | `ai/planb-reversal-m1-continuation-shadow.ts` | observation-only: M1 continuation coexisting with CONFIRMED_REVERSAL regime | artifact `planb-reversal-m1-continuation-asof-shadow-v1` (l.14) |
| R6 | `ai/confirmed-reversal-cross-sleeve-canary.ts` | DEMO probe: cost-aware confirmed reversal must not inherit the EARLY_TRANSITION degraded-sample veto; 4-hour cooldown | lot cap 0.2 (l.14) |

R5 exists specifically to observe the disagreement between R1 and R2 (audit
A2/F4). P1-2 will freeze a synthetic corpus of borderline bars where these
six disagree — the map above is the input list for that corpus.

## 3. Nine reliability gates (A3) — P1-3 inputs

| # | File | Floors (verified, with lines) |
| --- | --- | --- |
| G1 | `ai/m1-tactical-reliability.ts` | min samples 5 (l.6); early-loss brake 3 (l.7); early-transition brake 2 (l.8); recent payoff samples 5 (l.9); recent avgR floor −0.1 (l.10); max samples 20 (l.11) |
| G2 | `ai/m1-shadow-pair-side-reliability.ts` | min samples 3 (l.4); max 20 (l.5); max age 7d (l.6); min PF **1.5** (l.7); min avgR 0.1 (l.8); min positive fraction 0.4 (l.9) |
| G3 | `ai/m1-meaningful-scout-reliability.ts` | min samples **6** (l.5); max 20 (l.6); age 7d (l.7); PF 1.5 (l.8); avgR 0.1 (l.9); positive fraction 0.4 (l.10) |
| G4 | `ai/m1-provisional-scout-reliability.ts` | min samples 3 (l.5); mature floor 6 (l.6); age 7d (l.7); PF **2.0** (l.8); avgR **0.2** (l.9); positive fraction **0.5** (l.10) |
| G5 | `ai/paper-route-reliability.ts` | trend episodes **20** (l.4); PF 1.0 (l.5); maxDD 0.12 (l.6); reversal episodes 8 (l.8) |
| G6 | `ai/paper-scout-realised-payoff.ts` | min trades 6 (l.2); reduce PF 1.0 (l.3); shadow PF 0.75 (l.4); reduced lot cap 0.05 (l.5) |
| G7 | `ai/demo-profitability-reliability-gate.ts` | no numeric floors — converts M1 loss-streak state into blocker `M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK` (l.32/39) |
| G8 | `ai/pepperstone-demo-advisory-quality-risk.ts` | inline floor `recent.samples >= 3` (l.138) |
| G9 | `ai/paper-research-requalification-shadow.ts` | episodes 8 (l.3); PF 1.15 (l.4); Sharpe 1.0 (l.5); maxDD 0.12 (l.6) |

Min-sample floors range 3→20 and PF floors 1.0→2.0 for the same kind of
evidence — the explicit sample-count ladder P1-3 must unify.

## 4. Six calibration layers (A4) + two auxiliaries — P1-4 inputs

| # | File | Mechanism / constants (verified) |
| --- | --- | --- |
| C1 | `ai/adaptive-prediction-calibration.service.ts` | Bayesian blend, **prior weight 8** (l.13); authoritative ≥12 samples (l.8); mature ≥20 (l.9); min wins/losses 5/5 (l.10-11); rescue net-expectedR 0.12 (l.12) |
| C2 | `ai/adaptive-edge-matrix.service.ts` | mature ≥20 (l.7); min wins/losses 5/5 (l.8-9); supplies edge quality + smoothed expectedR |
| C3 | `ai/adaptive-shadow-directional-pulse.ts` | decayed pulse over last ≤10 outcomes/side (l.2), min 4/side (l.3), **decay 0.65** (l.4) |
| C4 | `ai/paper-spread-calibration-shadow.ts` (+ history companion) | min samples **100** (l.4); min fixed fraction 0.25 (l.5) |
| C5 | `ai/m1-causal-commission-shadow.ts` | fee **p90** estimator (l.5); min prior trades 5 (l.4) |
| C6 | `ai/m1-probation-causal-cost-stress.ts` | spread stress ×1.25 (l.8); slippage +0.5 pip (l.9); min priors 5/5 (l.6-7) |
| A1 | `ai/calibration-bidirectional-conflict.ts` | arbitrates conflicts between two of the layers above (F4 signature) |
| A2 | `ai/paper-spread-calibration-history.ts` | persistence companion for C4 |

## 5. Six exit engines (A7) — P1-5 inputs

| # | File | Constants (verified, with lines) |
| --- | --- | --- |
| X1 | `broker/adapters/paper-broker.adapter.ts` | PAPER lock arms at **+0.50R** (l.719; rescue band 0.395R-<0.50R retains 40%); CONFIRMED_REVERSAL arms 1.00R (l.668), EARLY_TRANSITION 0.75R (l.669); retention 0.40/0.70/0.75/0.80/0.85/0.90 by peak band (l.671-676) |
| X2 | `execution/reconciliation/pepperstone-demo-net-profit-lock.ts` | retention **0.55** below 0.5R, 0.65 [0.5,0.75), 0.75 [0.75,1.0), 0.80 ≥1.0R (l.31-33); progressive TP overlay to **0.91** of target (l.88-93, 107) |
| X3 | `execution/reconciliation/live-demo-profit-protection.service.ts` | thesis/adverse evaluation; continuation recovery grace **4.5 min** (l.48) |
| X4 | `ai/post-entry-demo-drawdown-guard.service.ts` | v8.9 guard: force-close ≤ **−0.4R** by minute **7** (l.14/13), 15s cadence (l.15) |
| X5 | `execution/reconciliation/pepperstone-demo-post-peak-rescue.ts` | unprotected band **0.30-0.50R** only (l.144); giveback threshold 0.3 (l.152) |
| X6 | `execution/reconciliation/verified-profit-stop-runner-policy.ts` | fee-inclusive floor ≥ max(0.1·risk, $1) else fail-closed `FEE_INCLUSIVE_STOP_FLOOR_UNPROVABLE` (l.226-232) |

Same concept (protect a favorable excursion), six implementations, no shared
constants — exit management is the dominant economic lever (G1) and the
parameterized retention/force-close policy of V2-6 replaces exactly these.

## 6. Prediction families (E3) and confidence floors (B5)

**Five prediction families, no shared scoreboard:**

| # | File | Quantity | Key constants (lines) |
| --- | --- | --- | --- |
| P1 | `ai/plan-b-multimodel-shadow.ts` | Plan-B expectedR | gross floor 0.08 (l.51) |
| P2 | `ai/v8-shadow-meta-scorer.ts` | v8 logistic probability | threshold 0.46 (l.3) |
| P3 | `ai/adaptive-prediction-calibration.service.ts` | calibrated win rate | prior 8 (l.13), ≥12 authoritative (l.8) |
| P4 | `ai/owner-demo-entry-outcome-model.generated.ts` | owner forecastNetR | 53 + 45 samples, cutoff 2026-11-19, `RESEARCH_ONLY` — coefficients are not V2 inputs (B3/D5) |
| P5 | `ai/m1-tactical-expectancy.ts` | M1 expectancy blend | prior 5 / recent 0.25 (l.5-6), min samples 5 (l.4) |

**Six confidence-floor copies (B5)** — one number, six places:

| Copy | Location | Value / line |
| --- | --- | --- |
| Python 1-5 | `services/ai-engine/app/domain/training/{model_qualification.py:49, bounded_final_campaign.py:50, six_pair_opportunity_selector.py:38, deterministic_strategy_ensemble.py:31, side_selection_three_class.py:32}` | `CONFIDENCE_FLOOR = 0.60` |
| TS 1 | `strategy/strategy-orchestrator.service.ts:67` | `CONFIDENCE_THRESHOLD = 0.6`, clamped 0.60-0.70 (l.213-218) |

## 7. Governance, carve-outs, trials, registry (E2/A8/A9/F1)

- **Ensemble governance** (`ai/ensemble-governance.ts`): predicted-cost veto is `SHADOW_ONLY` (l.15); frozen 4,599-event drift envelope hardLow 0.640079 / hardHigh 0.751451 (l.133-134); `costR = 1.25·spread/stopDistance` (l.416); paper netExpectedR floor 0.08 (l.431).
- **Owner carve-outs (A8):** 7-lot requested ceiling (l.15), weak-reversal ceiling 4 lots (l.12), high-conviction ceiling 6 lots (l.9); "narrowest cap wins" precedence resolved only inside the scheduler.
- **Expired trials still evaluated per scan (A9):** alternative trial ended 2026-11-16 (l.12), advisory alternate 2026-11-17 (l.15), counter-pilot 2026-11-20 (l.11), noon-lot 2026-11-20 (l.14); `multimodel-demo-authority.ts` is a `@deprecated` re-export shim (l.1).
- **Expert registry (F1):** 12 entries, every entry `executionAuthority: 'NONE'` (entries block from l.67).
- **Duplicated Python consensus (A5):** `baseline_xgboost.py:540-549` and `high_conviction_challenger.py:317-325` carry the same regime thresholds (`m1_spread_bps_median` / `m1_volatility_20_median`).

## 8. Data-quality surfaces mapped (C7/C8)

- `market-data.service.ts:97` — uniform `priceDigits = 10` computes `spreadPoints` on a fixed 10^10 scale (JPY mis-scale risk for any broker-points consumer).
- `provider-quote-candle-store.service.ts` (in `market-data/services/`) — first-sample insert writes `open=high=low=close` as one value (`$4` ×4, l.48-58): MetaApi 30-second quote snapshots persisted as M1 bars, mixed provenance in one table.

## 9. Count reconciliation vs the audit

| Audit claim | Verified | Status |
| --- | --- | --- |
| Four direction scorers (A1) | 4 (§1) | confirmed |
| Six reversal definitions (A2) | 6 (§2) | confirmed |
| Nine reliability gates (A3) | 9 (§3) | confirmed |
| Six calibration layers (A4) | 6 layers + 2 auxiliaries (§4) | confirmed (spread shadow+history counted once, both mapped) |
| "Four-plus" exit engines (A7) | 6 (§5) | confirmed, exact count pinned |
| Five prediction families (E3) | 5 (§6) | confirmed |
| CONFIDENCE_FLOOR in ≥6 modules (B5) | 6 copies (§6) | confirmed with exact lines |
| 12-entry registry, all NONE (F1) | 12 / 12 | confirmed exactly |
| 128-column Python contract | 128 (executed) | confirmed by execution |
| v8 "30-feature" logistic (B2) | **29** `BASE_WEIGHTS` entries (l.51-80) | corrected: 29 entries (10 input fields incl. hour/side; 29 weights incl. bias) |
| Scheduler 4,871 / collector 7,283 / evidence 3,013 lines | 4,871 / 7,283 / 3,013 (verified `wc -l`) | confirmed |

Corrections to audit paths: the LIVE protection service is
`live-demo-profit-protection.service.ts`; candle-store and collectors live
under `market-data/services/`. Line numbers above are current for this
branch's tree; the audit's own line references were taken on `main` @
`9ec10e40` and may drift by a few lines — the CI drift detector re-verifies
paths, not line numbers.

## 10. What the P1 specs consume from this map

- **P1-1** (direction-scorer unification) ← §1: four feature sets, weights, thresholds, and the four divergent missing-value semantics.
- **P1-2** (reversal unification + disagreement corpus) ← §2: the six predicates and their constants are the corpus inputs.
- **P1-3** (reliability consolidation) ← §3: the floor ladder 3→20 samples and 1.0→2.0 PF.
- **P1-4** (calibration consolidation + scoreboard) ← §4 and §6: six layers, five prediction families, no shared scoreboard (B6).
- **P1-5** (exit specification) ← §5: six engines' retention/force-close constants as the comparison baseline.
- **P1-6** (dead-code list) ← §7: expired trials, deprecated shim, and the dead-predicate class.

## 11. Boundaries

Research-only: no runtime import, no production data, no broker access, no
deployment; the Champion is untouched. All counts and line references above
are code-verified on this branch; the executable mirror in
`apps/api/scripts/research/` re-verifies path existence and count
reconciliation in CI on every run. Nothing here grants order authority:
`executionAuthority: NONE`.
