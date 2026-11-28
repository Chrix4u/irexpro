# iRexPro AI Engine V2 — P1-1 direction-scorer unification spec

Status: research-only specification for backlog item **P1-1** of
`AI_ENGINE_V2_EXECUTION_BACKLOG_20261127.md`. Proposal only: **no runtime
edit, no import into any runtime path, no model or threshold change.** The
Champion (V1) is preserved untouched as the comparison baseline.

Inputs consumed: `AI_ENGINE_V2_COMPONENT_MAP_20261127.md` §1 (four direction
scorers) and §10; `AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md` finding A1; PR
#846's P1-0 executable mirror
(`apps/api/scripts/research/v2-engine-component-map.cjs`). Coordinates with
PRs #834/#836/#837/#838 (M1 abstention chain — conclusions inherited by
reference) and the stacked sibling vehicle #839 (its calibrator-bundle
format WS2.1 is referenced as the output-calibration container; no artifact
of that branch is duplicated here).

Machine-readable mirror:
`apps/api/scripts/research/v2-direction-scorer-contract.cjs`
(+ test, CI step — the drift detector). Every numeric claim below is
verified against the sources on this branch with line references; the
mirror re-proves the file paths and weight sums on every CI run.

---

## 1. Scope and problem statement

The V1 engine evaluates "direction" through **four scorers** with four
feature dialects, four missing-value semantics, and no shared calibration
(audit A1/B1/B5). The same market concept enters the engine as different
columns with different units, so no single evaluation surface can compare
them, and a per-trade decomposition of prediction error across scorers is
structurally impossible. The V2 contract defined here — **DS-1** — is the
single input/output contract any V2 direction scorer must satisfy: one
column set, one unit per concept, one missing-value rule, one output
semantics.

Out of scope: admission thresholds (P1-4/L2 admission consumes the DS-1
output), reversal definitions (P1-2), reliability floors (P1-3), exit
policies (P1-5). DS-1 produces a calibrated direction probability;
everything that *decides* with it is a separate layer.

## 2. The four-scorer inventory (verified on this branch)

Sources: S1 `apps/api/src/modules/ai/m1-tactical-candidate.ts`, S2
`apps/api/src/modules/ai/plan-b-multimodel-shadow.ts`, S3
`apps/api/src/modules/ai/v8-shadow-meta-scorer.ts`, S4
`apps/api/src/modules/ai/adaptive-opportunity-score.ts`.

### 2.1 Input feature sets (the dialect divergence)

| Concept | S1 column (unit) | S2 column (unit) | S3 column (unit) | S4 column (unit) |
| --- | --- | --- | --- | --- |
| EMA separation | `emaSeparationAtr` (ATR, **signed**, sign applied in builder l.118) | `emaSeparation` ([0,1]-clamped, l.129) | `emaSeparation` (standardized (x−0.5)/0.5, l.117) | — (only via upstream `directionQuality`) |
| EMA slope | `emaSlopeAtr` (ATR/bar, signed, w 0.10) | — | — | — |
| Momentum | `momentum1Atr`/`momentum3Atr`/`momentum5Atr` (ATR, signed; w 0.10/0.16/0.10; score adds 0.05·momentum1Atr) | `shortHorizonMomentumAtr` (ATR, raw signed; **non-finite → 0**, l.135-137) | `shortHorizonMomentumAtr` — **declared in `V8ShadowMetaInput` (l.27) but unused by the scoring function** | — |
| MTF strength | `alignment.{m5,m15,h1,h4}` + `higherTimeframeAgreement` (signed, w 0.20) | `mtfStrength` ([0,1], w 0.23) | `mtfStrength` (standardized (x−0.5)/0.5, w −0.3645) | — |
| RSI-14 | `rsi14` → `rsiBias=(rsi−50)/25` (w 0.04) | `rsi14` → `clamp01((rsi−50)/22)` (w 0.10) | `rsi14` → `rsiStrength=±(rsi−50)` → `(x−11)/11` (w −0.0470) | — |
| Extension | — | `extensionAtr` (ATR, regime gate ≤1.15 l.119) | `extensionAtr` (standardized (x−0.75)/0.75, w 0.1152) | — |
| Volatility | `volatilityScore` (only inside confidence −0.08, l.160) | `volatilityScore` (regime gate ≥0.65 → VOLATILE, l.118) | `volatilityScore` (standardized (x−0.375)/0.375, w 0.0298) | — |
| Candle micro | `closeLocation`, `lowerWickRatio`, `upperWickRatio` (w 0.08/0.05), `breakoutUp/DownAtr` (w 0.08), `failedBreakout*` (booleans) | — | — | — |
| M5/M30 optional | `m5LatestBodyPressure?`, `m5DirectionalRun?`, `m30*` (`?? 0`, l.126-129); `m5BodyExpansionRatio?` (`?? 1`, l.130) | — | — | — |
| Confidence | **output** (capped 0.738, l.157-161), then input to `score` (+0.15, l.165) | **input** (floor 0.64 l.50; transform (x−0.6)/0.2 l.128) | **input** (standardized (x−0.7)/0.08, l.114) | — (consumes `netExpectedR` + upstream `directionQuality`) |
| Time | — | `scanTime` (sessionQuality: UTC 7–16/16–20/else = 0.90/0.72/0.52, NY 17 → 0.1, l.286-293) | `scanTime` → `hour_sin/cos` harmonics (l.120-121) | — |
| Instrument | unrestricted | 6 majors (inherited from S3's guard) | 6 majors, **throws otherwise** (l.96-98) | unrestricted |
| Portfolio/edge | — | open positions (overlap risk, l.302-358) | — | `netExpectedR`, `edge`, `exposure`, `marketState` (10 inputs, l.20-49) |

### 2.2 Output formulas and weights (verified)

- **S1** `directionQuality = clamp01(0.5 + clampSigned(Σwᵢ·clampSigned(fᵢ))/2)`
  with 9 weights 0.19/0.10/0.16/0.10/0.20/0.08/0.05/0.04/0.08 (l.146-154,
  **sum = 1.00**); `confidence = min(0.738, clamp01(0.5 + 0.3·dq + 0.08·efficiency5 − 0.08·volatilityScore))`
  (l.157-161 — audit B1); `score = dq + 0.15·confidence + 0.05·momentum1Atr + 0.05·htfAgreement` (l.163-167).
- **S2** (trend path) `directionQuality = clamp01(0.42·clamp01((conf−0.6)/0.2) + 0.25·clamp01(emaSeparation) + 0.23·clamp01(mtfStrength) + 0.10·rsiDirectional)` (l.124-133, **sum = 1.00**); route-specific variants
  `reversalDirectionQuality` (0.45/0.20/0.20/0.15, l.226-238) and
  `earlyTransitionDirectionQuality` (0.60/0.25/0.10/0.05, l.182-194);
  consumed by `ensembleScore = clamp01(0.22·meta.probability + 0.15·direction + 0.12·quality + 0.11·exit + 0.10·pairSide + 0.08·session + 0.10·economicQuality + 0.12·portfolio.quality)` (l.401-410).
- **S3** `probability = sigmoid(Σ 29 BASE_WEIGHTS·standardized features)` (l.51-80, l.112-131 — a fitted logistic, weights are **not** normalized); threshold 0.46 (l.3); `expectedR = p·(2.5/1.5) − (1−p)` (l.132); Plan-B variant subtracts frozen sym+ps logit contributions (l.146-156); clock-neutral research variant subtracts the hour harmonics (l.178-199).
- **S4** opportunity aggregation (not a direction scorer itself):
  `score = clamp01(Σ 10 weights)` with `directionQuality` carrying **0.11 of 1.00** (l.7-18), all other inputs orthogonal to direction.

### 2.3 The four missing-value semantics (the defect class DS-1 closes)

| Scorer | Rule observed (line) | Failure mode |
| --- | --- | --- |
| S1 | `?? 0` for optional M5/M30 fields (l.126-129); `?? 1` for `m5BodyExpansionRatio` (l.130); clamps do not guard NaN | missing evidence silently becomes "neutral momentum"; NaN propagates through `clamp01` into `directionQuality` |
| S2 | `Number.isFinite(shortHorizonMomentumAtr) ? v : 0` (l.135-137) — only for momentum; its `clamp01` (l.111-113) does **not** guard NaN | one field defaulted to 0, every other field propagates NaN |
| S3 | `finite()` **throws** on any non-finite required input (l.89-92, l.100-105) | strictest, but an untyped crash, not a typed refusal |
| S4 | `clamp01` returns **0** on non-finite (l.73-75); `shadowDirectionalPulseQuality` undefined → 0.5 (l.111-114); PF/DD null → 0.4 (l.103-104) | missing evidence silently becomes "worst quality" or "neutral" depending on the field |

One concept, four rules: silent-zero, silent-zero-for-one-field, crash,
silent-zero-or-neutral. A V2 evaluation surface cannot reason about
"abstention because features were missing" (the #836 taxonomy) when the
scorers erase the distinction between *absent* and *zero*.

**Correction to the component map §1:** the map's missing-value note
("S3 defaults unknown `shortHorizonMomentumAtr` to 0 (l.133-137)")
mis-attributes the default. Those lines live in S2
(`plan-b-multimodel-shadow.ts` l.135-137), which reuses the
`V8ShadowMetaInput` type declared in S3's file; S3 itself **never reads**
the field. The mirror and this spec record the corrected attribution; the
map's counts are unaffected.

## 3. DS-1 — the single V2 direction-scorer contract

### 3.1 Input schema (one column set, one unit per concept)

All columns are required unless marked `?` (optional, nullable, presence
recorded). Sign convention: **direction alignment is applied exactly once,
at ingestion** — every signed column is positive when it favors the
candidate direction; no scorer re-applies signs internally.

| Group | Column | Unit / range | Notes |
| --- | --- | --- | --- |
| identity | `instrument` | enum: 6 majors | unsupported → typed refusal `SCORER_UNSUPPORTED_INSTRUMENT` |
| identity | `direction` | `BUY \| SELL` | alignment reference |
| identity | `decisionTime` | ISO-8601 UTC | single time authority; `decisionHourUtc` derived once, inside |
| identity | `policyVersion` | string | scoreboard cohort key |
| structure | `emaSeparationAtr` | ATR units, signed | replaces S1's ATR form, S2/S3's [0,1] forms |
| structure | `emaSlopeAtr` | ATR/bar, signed | S1 lineage |
| momentum | `momentum1Atr` / `momentum3Atr` / `momentum5Atr` | ATR, signed | explicit horizons; no single overloaded "shortHorizon" column |
| momentum | `m5Momentum1Atr` / `m5Momentum3Atr` | ATR, signed | M5-lifecycle |
| micro | `m5BodyPressure3`, `m5LatestBodyPressure?`, `m5DirectionalRun?` | fraction / fraction / count | S1 optional set |
| micro | `m5BodyExpansionRatio?` | unsigned ratio, **neutral 1.0** | the only ratio-neutralized optional |
| macro | `m30DirectionalEfficiency?`, `m30MomentumAtr?` | [−1,1] / ATR | S1 optional set |
| macro | `higherTimeframeAgreement` | [−1,1], signed | replaces S1 htf + S2/S3 mtfStrength |
| macro | `alignment.m5/.m15/.h1/.h4` | [−1,1], signed | per-timeframe agreement |
| micro | `closeLocation` | [0,1] | |
| micro | `lowerWickRatio`, `upperWickRatio` | [0,1] | |
| micro | `breakoutAtr` | ATR, signed | direction-side breakout, S1 lineage |
| oscillator | `rsi14` | [0,100] raw | alignment derived once inside (S1 /25, S2 /22, S3 /11 forms all retired) |
| regime | `extensionAtr` | ATR, unsigned | S2/S3 lineage |
| regime | `volatilityScore` | [0,1] | |
| geometry | `atr14`, `price` | price units | stop geometry authority (P1-5), recorded for decomposition |
| efficiency | `efficiency5` | [0,1] | S1 confidence lineage, now a plain feature |
| cost | `estimatedExecutionCostR` | R units | cost enters as a feature/record, never silently (audit C-series) |

**Prohibited as input:** any upstream `confidence` value. S2/S3 consume a
`confidence` produced elsewhere (S3 standardizes it at 0.7±0.08; S2 floors
it at 0.64; S1 caps its own at 0.738 — the B5 floor/cap constellation).
DS-1 breaks the loop: features in, probability out, one place.

### 3.2 Missing-value semantics (one rule)

1. A required column that is absent, `null`, `undefined` or non-finite →
   **typed refusal `SCORER_INPUT_REQUIRED` (fail-closed)**. No silent
   default, no NaN propagation, no crash. The refusal is recorded, not
   swallowed — the abstention taxonomy (#836) then classifies it.
2. Optional columns are **nullable**: absence is recorded as `null` in the
   decision record with an explicit presence flag. Absence is never
   rewritten to `0` (S1/S2/S4 behavior) — a missing M5 body pressure is
   *missing*, not "neutral momentum".
3. `m5BodyExpansionRatio` absent → recorded `null`; the neutral value `1.0`
   may be substituted **only** in V1-compat replay and the substitution is
   logged as an explicit event.
4. Ratio/enum sanity: values outside the declared range → typed refusal
   `SCORER_INPUT_OUT_OF_RANGE` (never clamped into range; clamping is a
   V1 defect class, audit B-series).

### 3.3 Output contract

| Field | Semantics |
| --- | --- |
| `rawScore` | the uncalibrated model output (linear score / logit), recorded for audit and decomposition |
| `probability` | **calibrated** p(direction aligned) from a calibrator bundle in the #839 WS2.1 format (isotonic/Platt, hash-pinned, monotone) |
| `calibrationState` | `UNCALIBRATED` \| `CALIBRATED` — `CALIBRATED` only derivable from ≥100 recorded holdout records (decision-record C1) |
| `inputsUsed` | the exact column subset consumed (presence flags), so abstention attribution is reconstructible |
| `registration` | pre-outcome prediction registration to the V2-7 scoreboard (P1-4) — probability, time, policyVersion, instrument, direction |
| `executionAuthority` | `NONE` — research contract; admission is a separate layer |

No internal confidence cap and no internal admission threshold: the V1
0.738 cap (B1), the 0.46/0.408 thresholds (B2) and the six 0.60 floor
copies (B5) are retired with the dialects that carried them. Thresholds
live only in the L2 admission layer, evaluated on the calibrated
probability against pre-registered criteria.

### 3.4 Migration map (proposal only — no runtime edit)

| V1 scorer | V2 disposition |
| --- | --- |
| S1 `m1-tactical-candidate.ts` | feature dialect is the closest ancestor of DS-1's schema (signed ATR columns); becomes the reference V1-compat replay adapter; its `confidence`/`score` transforms are retired |
| S2 `plan-b-multimodel-shadow.ts` | its route-specific quality functions move behind the L2 admission layer; `directionQuality` dialect retired; its momentum default rule deleted (SCORER_INPUT_REQUIRED replaces it) |
| S3 `v8-shadow-meta-scorer.ts` | the 29-weight logistic is preserved **as a frozen baseline artifact** (V1 Champion baseline) consumed through a DS-1 adapter that maps its standardized dialect to DS-1 columns; its `finite()` throw becomes `SCORER_INPUT_REQUIRED` |
| S4 `adaptive-opportunity-score.ts` | unchanged in role (opportunity aggregation) but its 0.11 `directionQuality` slot consumes DS-1's calibrated `probability`; the silent zero-on-NaN clamp is replaced by the typed refusal |

## 4. Acceptance criteria (backlog P1-1)

- [x] Four-scorer feature-set inventory with columns, units, weights,
  thresholds and missing-value semantics, code-verified with line
  references (§2, mirrored in `v2-direction-scorer-contract.cjs`).
- [x] Single V2 contract DS-1 defined: columns (§3.1), units per concept,
  one missing-value rule (§3.2), one output semantics (§3.3).
- [x] Signed-off spec: this document is the sign-off record; the
  executable mirror is the enforcement surface.
- [x] No runtime edit: nothing in this change imports or modifies any
  production module; all four scorer sources are untouched.
- [x] Drift detection: CI re-proves the four scorer paths exist, the
  weight sums (S1 = 1.00, S2 = 1.00, S4 = 1.00, S3 = 29 entries), and the
  missing-value divergence count (4 distinct rules recorded) on every run;
  tampering with the committed inventory is a typed refusal.

## 5. Boundaries

Research-only: no runtime import, no production data, no DB or broker
access, no deployment; deployment hold intact; V1 Champion untouched.
Every artifact here carries `executionAuthority: NONE`. Coordination: M1
chain conclusions (#834/#836/#837/#838) inherited by reference; the
calibrator-bundle container and scoreboard slots belong to the stacked
sibling #839 and are referenced, not duplicated. No private datasets;
synthetic fixtures only.
