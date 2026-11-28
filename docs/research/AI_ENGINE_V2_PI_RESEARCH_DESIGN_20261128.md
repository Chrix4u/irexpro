# AI Engine V2 — Predictive Intelligence Research Phase (PI)

Date: 2026-11-28. Directive: independent predictive-intelligence research
after the E-10 conclusion that threshold adjustments and exit-policy tuning
alone do not establish predictive advantage (all eight tested
market-condition cells negative after costs).

Status: **delivered offline on the research branch** — all artifacts
research-only (`executionAuthority: NONE`); V2-G1 preserved as the
immutable baseline; no LIVE authority, no broker provisioning, no
production changes.

---

## 1. Directive mapping

| Directive | Item | Where |
|---|---|---|
| 1 | Preserve current V2 generation as immutable baseline | PI-0 `v2-baseline-freeze.cjs` |
| 2 | Extend backlog with predictive-intelligence phase | backlog §PI |
| 3 | Independent trend-continuation / reversal / regime / expected-return models, chronological leakage-controlled datasets | PI-3, PI-4 |
| 4 | Classical / boosted / temporal candidates; complexity vs out-of-sample value | PI-4, PI-5 complexity table |
| 5 | M1/M5/M15/H1/H4 context across six pairs | PI-1, PI-2, PI-3 features |
| 6 | Common prediction opportunities incl. rejected, identical outcome definitions | PI-3 grid |
| 7 | Separate direction-prediction quality from exit policy, sizing, costs | Layer A vs Layer B |
| 8 | Secure ingestion contract + synthetic fixtures; no broker records | PI-1, PI-2 |
| 9 | Feasible offline work + tests + docs + reproducibility; held-out preserved | PI-5..PI-7 |
| 10 | Statistically credible positive after-cost expectancy before broker-connected recommendation | PI-5 gate |

Anti-goal (enforced): no additional confidence gate, abstention rule or
frequency reduction is counted as intelligence improvement. Layer A is
computed on the FULL common grid (100% coverage) for every candidate.

## 2. Privacy

Every fixture in this phase is **fully synthetic** (seeded PRNG output,
`SYNTHETIC_FIXTURE` provenance). The ingestion contract refuses raw broker
records at the boundary (`DATA_PROVENANCE_REFUSED`); the only future
non-synthetic path is an operator-authorized export (P4), used offline.
Original broker evidence remains preserved securely offline exactly as
recorded in `AI_ENGINE_V2_SENSITIVE_DATA_REMEDIATION_20261128.md`.
No squash-merge of the research branch to conceal history, no shared
history rewrite, no new broker accounts — none performed.

## 3. Components

- **PI-0 immutable baseline (V2-G1)** — `v2-baseline-freeze.cjs` pins
  SHA-256 of the six core runnable artifacts delivered at `559d4d06`
  (intelligence engine, engine features, paired simulator, offline
  harness, E-10 campaign, E-10 results artifact, hash `50c7ef8b…`).
  In-place drift is a typed refusal (`BASELINE_TAMPERED`); later phases
  add artifacts but never modify the frozen generation.
- **PI-1 ingestion contract** — `v2-historical-data-contract.cjs`: bar
  schema validation (order, duplicates, alignment, OHLC, volume), M1 →
  M5/M15/H1/H4 aggregation with trailing-partial-bucket protection and
  interior gap accounting, and `closedBarAt` no-future-peek lookup (a
  higher-TF bar is visible only after its full window closed).
- **PI-2 fixtures** — `v2-pi-market-fixtures.cjs`: six pairs
  (EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF), M1 base aggregated
  through the PI-1 contract. Scenarios: `PI_NULL` (zero planted edge,
  continuation rate ≈ 0.5 verified), `PI_PLANTED_CONTINUATION`
  (conditional calm-momentum 60-minute drift; P(continuation|trigger) =
  planted 0.56, measured 0.5576; non-overlapping trigger windows),
  `PI_TREND_REGIMES` (episode ground truth), `PI_REVERSION` (OU pull).
- **PI-3 common dataset** — `v2-prediction-dataset.cjs`: the FULL common
  grid of prediction opportunities (rejected/abstained included;
  abstention never shrinks the denominator), identical fixed-horizon
  outcome definitions for every candidate (up / cont / rev events,
  ATR-normalized forward return `fwdR` and cost `costR`), multi-TF
  context features restricted to closed bars (no-future-peek proven by
  mutation test), decision spacing = label horizon (non-overlapping
  labels), chronological walk-forward splits with purge + embargo
  (24 M5 bars), 20% held-out preserved against tuning, train-only scaler.
- **PI-4 candidates** — `v2-pi-models.cjs`: classical (prior baseline,
  L2 logistic full-batch GD, closed-form ridge), temporal
  (recency-weighted logistic with chronology-aware decay; AR(5) on
  lagged realized outcomes), boosted (gradient-boosted shallow stumps,
  25/100 rounds; logistic and squared loss), plus a fixed-threshold
  regime classifier. All deterministic; complexity descriptors
  (parameter counts) recorded for the complexity-vs-value comparison.
- **PI-5 campaign** — `v2-pi-campaign.cjs` + CLI `v2-pi-run.cjs` +
  committed artifact `runs/v2-pi-campaign-20261128/pi-results.json`
  (SHA-256 `448b3132…`): six symbols × 50 days × three scenarios;
  7,110 opportunities per scenario (5,688 dev / 1,422 held-out);
  six-fold walk-forward with purge + embargo; Layer A/Layer B split;
  null FP control; planted-edge sensitivity with required-N check;
  complexity-vs-value table; held-out final report; pre-registered
  broker-connected gate.

## 4. Layer semantics (directive 7)

- **Layer A — prediction quality** on the FULL common grid: AUC
  (Hanley–McNeil SE), Brier, accuracy (direction); information
  coefficient (expected return); regime accuracy. Identical outcome
  definitions for every candidate; 100% coverage. The only layer in
  which improvement claims may be made.
- **Layer B — policy/economics**: ONE identical standardized
  fixed-horizon policy for every candidate: entry when the train-derived
  per-symbol breakeven threshold is crossed (τ = 0.5 + cost/(2·E|fwdR|),
  computed from training rows only), exit at the label horizon,
  constant sizing. Differences between candidates in Layer B are
  attributable to direction-prediction quality only — never to
  exit-policy tuning, position sizing or cost treatment.

## 5. Methodology corrections found and applied during this phase

Honest reporting of defects discovered in our own first full-scale run:

1. **Tautological labels.** The reversal label embeds the
   `|past| > 0.5·σ_W` feature threshold and the continuation label
   embeds the past return sign. Their Layer-A AUCs are therefore partially
   feature-determined (boosted stumps reached AUC 0.71 on the *null*
   fixture — definitional structure, not market signal). Correction: null
   FP control and gate claims are restricted to pure forward-outcome
   labels (direction, expected return); continuation/reversal blocks
   carry explicit caveats and are reported for completeness only.
2. **Family-wise false-positive control.** Per-cell one-sided 5% counts
   are descriptive only (cells correlate through shared paths and
   folds); the control verdict requires zero Bonferroni family-wise
   rejections across direction-task cells.
3. **Planted-edge detection task.** The planted continuation edge
   manifests as direction persistence; sensitivity is measured on the
   direction task (null 0.4967 vs planted 0.5341, z = 4.07) rather than
   the diluted continuation task.
4. **H4 volatility degeneracy.** The H4 vol feature was initially
   computed from a single closed-bar return (stdev of one value = 0);
   fixed to four closed H4 bars, with the regime classifier thresholds
   recalibrated empirically.

## 6. Results (full-scale, committed artifact)

Null false-positive control (direction task, 5 models × 6 symbols):
5/30 cells above the per-cell one-sided 5% threshold (descriptive),
**0 Bonferroni family-wise rejections → CONTROLLED**.

Planted-edge sensitivity: fixture continuation rate at triggers
**0.5576** (planted 0.56); direction AUC null **0.4967** vs planted
**0.5341** (z = 4.07); logistic/stumps both recover the edge — the
framework's detection sensitivity is validated on synthetic data.

Held-out final (nothing tuned on held-out):

| Scenario | Model | held-out AUC | after-cost meanR/trade |
|---|---|---|---|
| PI_NULL | logistic-l2 | 0.5170 | −0.347 (55 trades) |
| PI_NULL | recency-logistic | 0.5273 | −0.163 (279 trades) |
| PI_PLANTED | logistic-l2 | 0.5398 | **+0.089** (373 trades) |
| PI_PLANTED | stumps-100 | 0.5365 | +0.048 (286 trades) |
| PI_TREND_REGIMES | logistic-l2 | 0.5248 | +0.230 (446 trades) |
| PI_TREND_REGIMES | ridge (expected return) | IC 0.0771 | +0.230 |

Complexity vs out-of-sample value (the directive's core question):
stumps-100 (300 parameters) buys **nothing** over stumps-25 or the
13-parameter logistic on the direction task (0.5365 vs 0.5398);
stumps-reg-25 ≈ ridge on the expected-return task (IC 0.0761 vs
0.0754); AR(5) (6 parameters) matches or beats every larger regression
model on the regimes fixture (IC 0.0848). **On synthetic fixtures,
demonstrated complexity does not purchase out-of-sample value** at
these task strengths; the classical candidates dominate the
complexity-value frontier.

Regime classification: rule-based classifier accuracy **0.56**
(held-out 0.562) vs majority baseline 0.272 on the regimes fixture —
machine-readable regime ground truth recovered.

Gate (directive 10): **NOT_RECOMMENDED.** Conditions: C1 held-out
after-cost expectancy > 0 with CI excluding zero; C2 significant
prediction-quality improvement vs prior; C3 real-data (operator-authorized
export) evaluation — impossible on synthetic fixtures. One candidate
(ridge, expected return, planted-regimes cell) passes C1+C2 — recorded
as a sensitivity-validation artifact, not a recommendation, because the
edge was planted by us. V2 remains research-only; no LIVE authority.

## 7. Honest conclusion

On fully synthetic fixtures the phase delivers: a secure ingestion
contract, a leakage-controlled common-grid evaluation methodology, a
validated false-positive control, a validated detection-sensitivity
floor, and an honest complexity-vs-value answer (complexity buys
nothing here). **No claim of real-world predictive value is made or
possible from this artifact.** The next real evidence step requires the
operator-authorized historical export (P4-0) and remains blocked; the
broker-connected gate stays closed with C3 explicitly unmet.

## 8. Standing constraints (unchanged)

V1 Champion untouched (V2-G1 freeze guard verifies every run); no
production credentials/DB/broker access; no LIVE activation; deployment
hold intact; synthetic fixtures only in-repo; all artifacts carry
research-only authority semantics.
