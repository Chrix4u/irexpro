# AI Engine V2 — P1-4 calibration-service consolidation spec (CAL-1) and the pre-outcome prediction scoreboard (CAL-2 / V2-7)

Status: research-only consolidation spec (A4/B4). Inputs: component map v1
§4 (six calibration layers + two auxiliaries) and §6 (five prediction
families, six confidence-floor copies), refined by the phase-2 map (§13
scheduler seam) and delivered with an executable mirror
(`apps/api/scripts/research/v2-calibration-contract.cjs`, + test, CI step).
Stacked on the P1-3 reliability consolidation (RL-1); no runtime edit, no
model or threshold change, no DB access, no broker call, no deployment.
`executionAuthority: NONE` on every artifact; the deployment hold stays
intact.

---

## 1. Verified inventory (constants pinned by the CI drift detector)

Six calibration layers and two auxiliaries — same concept (turn resolved
evidence into a calibrated view of a candidate), six mechanisms, no shared
contract:

| # | File | Mechanism | Authority today | Pinned constants (line) |
| --- | --- | --- | --- | --- |
| C1 | `ai/adaptive-prediction-calibration.service.ts` | Bayesian blend of raw confidence/expectedR against resolved ensemble-shadow outcomes; evidence ladder EXACT → PAIR_DIRECTION_ROUTE → ROUTE → GLOBAL | paper block + rescue (local evidence only) | authoritative ≥ 12 (l.8), mature ≥ 20 (l.9), wins/losses ≥ 5/5 (l.10-11), rescue netR ≥ 0.12 (l.12), prior weight 8 (l.13) |
| C2 | `ai/adaptive-edge-matrix.service.ts` | Cell evidence matrix: strength-normalized expectedR blending (24/16/20), smoothed win rate (wins+2)/(n+4), PF/sharpe/drawdown | upsize verdict | mature ≥ 20 (l.7), wins/losses ≥ 5/5 (l.8-9) |
| C3 | `ai/adaptive-shadow-directional-pulse.ts` | Decayed directional pulse (0.65) over the last ≤ 10 resolved outcomes per side | ranking only | max 10/side (l.2), min 4/side (l.3), decay 0.65 (l.4) |
| C4 | `ai/paper-spread-calibration-shadow.ts` (+ history companion) | Session p95 spread with a fixed-fraction floor; cost = 1.25 × spread / stop | economics only | min samples 100 (l.4), min fixed fraction 0.25 (l.5); history window 21 days (`paper-spread-calibration-history.ts` l.27) |
| C5 | `ai/m1-causal-commission-shadow.ts` | Additive p90 causal-fee subtraction from the spread-only expectedR | economics only | min priors 5 (l.4), p90 (l.5) |
| C6 | `ai/m1-probation-causal-cost-stress.ts` | Forward cost stress: 1.25 × spread + 0.5 pip slippage + p90 fee against gross R | economics only | min fees 5 (l.6), min spread bars 5 (l.7), stress 1.25 (l.8), slippage 0.5 (l.9) |
| A1 | `ai/calibration-bidirectional-conflict.ts` | Arbitrates a calibration block against the paired-direction preference | arbiter | balanced epsilon 1e-9 (l.72) |
| A2 | `ai/paper-spread-calibration-history.ts` | Persistence companion for C4 | evidence source | 21-day window (l.27) |

Five prediction families, no shared scoreboard (audit B6):

| # | File | Quantity | Key constants |
| --- | --- | --- | --- |
| P1 | `ai/plan-b-multimodel-shadow.ts` | Plan-B expectedR | artifact v4 (l.3), candidate confidence floor 0.64 (l.50), gross floor 0.08 (l.51), reversal floor 0.18 (l.52) |
| P2 | `ai/v8-shadow-meta-scorer.ts` | v8 logistic probability | artifact (l.1), admission threshold 0.46 (l.3) |
| P3 | `ai/adaptive-prediction-calibration.service.ts` | calibrated win rate | IS the C1 blend output — the only family consuming another layer |
| P4 | `ai/owner-demo-entry-outcome-model.generated.ts` | owner forecastNetR | generated, `RESEARCH_ONLY` — excluded from the qualification scoreboard (B3/D5) |
| P5 | `ai/m1-tactical-expectancy.ts` | M1 expectancy blend | min samples 5 (l.4), prior weight 5 (l.5), recent weight 0.25 (l.6) |

Confidence-floor copies (B5): `CONFIDENCE_THRESHOLD = 0.6` at
`strategy/strategy-orchestrator.service.ts:67` (clamped 0.60–0.70 at
l.216-219) and `CONFIDENCE_FLOOR = 0.60` in the five Python training
modules — the unified ladder must reference exactly one floor per tier.

## 2. Divergences the frozen corpus proves (CL-D01..CL-D12)

Ten divergence records + two controls, verdicts computed by faithful
predicate mirrors on every run (`buildCalibrationMatrix`); tampering with
the corpus, the statistics or the mirrors is a typed refusal. Seven records
carry a true disposition conflict (support and oppose on the same evidence),
two are within-layer splits, and the disagreement kinds are verdict (3),
maturity (1), economics (3), authority (3):

- **CL-D01 (verdict)** — recent-8 with exactly 1 win and net −1.20: C1
  degrades (`wins ≤ 1`) and blocks; C2 requires zero wins, stays MATURE with
  pf 1.32222 and upsizes. Same trajectory, opposite admission verdicts.
- **CL-D02 (maturity)** — a 10-row cell is C1-non-authoritative (SPARSE) and
  C2-COLLECTING (≥ 8) at the same time: the maturity vocabularies label one
  evidence state differently.
- **CL-D03 (verdict)** — the decayed pulse SUPPORTS (advantage 0.65) the side
  the calibrated layers block: ranking versus calibration.
- **CL-D04 (economics, within-layer)** — the 100-sample boundary moves costR
  from 0.0625 (fixed fallback) to 0.03125 (p95 with floor): the shadow
  disagrees with the fixed assumption by 0.03125R.
- **CL-D05 (economics)** — realized blended history stays positive
  (CALIBRATION_APPLIED, 0.163636R) while the forward p90 fee (−0.05R) and the
  stress view (−0.10R) both flip the same candidate negative.
- **CL-D06 (economics)** — C1 grants rescue (net 0.128571R, winProb
  0.605714, pf 2.25) on realized evidence; the forward stress view of the
  same geometry is −0.10R.
- **CL-D07 (authority)** — the recent-payoff blend drags P5 to −0.011364R,
  below the 0.08 paper floor, while C1 rescues the same cell.
- **CL-D08 (verdict)** — C1 rescues, C6 opposes (−0.15R), and C2 flags
  drawdown-driven degradation (dd 0.253521 > 0.12) with a stable recent-8.
- **CL-D09 (authority, within-layer)** — the same calibration block binds
  the candidate only when the paired-direction preference agrees
  (BLOCK_CURRENT_SIDE_FAVORED active; opposite-side preference leaves it
  inactive).
- **CL-D10 (authority)** — at ROUTE level C1 degrades to a stance WITHOUT
  authority (`blockRecommended` stays false; `stanceWouldBlock` true) while
  C2's exact-cell fixture upsizes — the authority gap CAL-1 closes.
- **CL-D11 / CL-D12 (controls)** — every layer independently supports a
  mature positive cell; empty evidence abstains everywhere.

## 3. CAL-1 — the unified calibration contract

One calibration service over one evidence record (extraction seams §4):

1. **One evidence ladder.** Cell key = instrument | direction | session |
   state | strategyRoute | decisionPolicyVersion. Ladder EXACT →
   PAIR_DIRECTION_ROUTE → ROUTE → GLOBAL with the C1 collapse-overlapping-
   episodes discipline at every level. Levels keep the coarse buckets as
   evidence, never as authority (CL-D10).
2. **One sample ladder** (reconciles C1 12/20, C2 8/20, C3 4/side, C4 100,
   C5/C6 5 as tier rules, not six private vocabularies):
   - COLD — samples < 4 → authority NONE (C3/C5/C6 abstain today; C1/C2
     SPARSE).
   - SCOUT — 4 ≤ samples < 12 → SHADOW_ONLY (recorded, never binding).
   - AUTHORITATIVE — 12 ≤ samples (or ≥ 20 without 5/5) → ADVISORY: blend
     applies, block/rescue vocabulary recorded on the scoreboard only.
   - MATURE — samples ≥ 20 and wins ≥ 5 and losses ≥ 5 →
     PAPER_BLOCK_RESCUE: the C1 block/rescue predicates, restricted to
     local evidence (EXACT / PAIR_DIRECTION_ROUTE), exactly as today.
3. **One blend.** Probability: `clamp01((raw·8 + wins)/(8 + samples))`;
   expectedR: `(raw·8 + Σ netR)/(8 + samples)` — the C1 Bayesian form with
   prior weight 8. C2's strength-normalized blending (24/16/20) and P5's
   prior-5/recent-0.25 blend become inputs to the same estimator family,
   not parallel authorities.
4. **One maturity vocabulary.** SPARSE | COLLECTING | MATURE | DEGRADED
   (C3's INSUFFICIENT/OPPOSED/NEUTRAL/SUPPORTED and C4/C5/C6 reason codes
   map onto it as dispositions, CL-D02).
5. **One authority gradient.** NONE → SHADOW_ONLY → ADVISORY →
   PAPER_BLOCK_RESCUE. A stance without local authority is recorded as a
   stance (CL-D10) and never silently dropped.
6. **One verdict vocabulary.** `CALIBRATED_EDGE_UNFAVOURABLE` (block),
   `MATURE_POSITIVE_CALIBRATED_EDGE` (rescue), `CALIBRATION_APPLIED`,
   `CALIBRATION_EVIDENCE_SPARSE`, `CALIBRATION_EVIDENCE_UNAVAILABLE` —
   plus the A1 arbiter states for bidirectional conflicts (CL-D09).
7. **Forward economics are first-class.** C4/C5/C6 produce economics
   dispositions recorded next to the calibrated view (CL-D05/D06/D08) —
   never silently dropped, never promoted to gates without the operator
   step below.
8. **Typed refusals.** `CALIBRATION_INPUT_REQUIRED`,
   `CALIBRATION_UNSUPPORTED_SURFACE`, `CALIBRATION_INPUT_OUT_OF_RANGE`,
   `CALIBRATION_CONTRACT_TAMPERED`, `CALIBRATION_PATH_DRIFT`. Missing
   evidence abstains; it is never a default (CL-D12).

## 4. Extraction seams

- **SEAM-C1 evidence assembly** — the SQL reads (ensemble shadow decisions,
  trade intents/trades/capital allocations, spread history) move behind one
  assembler that emits the unified evidence record; the C1 history-row
  cache and C2 5-second cache discipline carry over unchanged.
- **SEAM-C2 pure evaluation** — every predicate in this spec is a pure
  function over the assembled record; the mirrors in
  `v2-calibration-contract.cjs` are the reference implementation.
- **SEAM-C3 scoreboard registration/lookup** — CAL-2 registration happens
  at decision time inside the scheduler scan (the phase-2 §13 `runOnce`
  span), resolution joins by predictionId at outcome resolution.

## 5. CAL-2 — the pre-outcome prediction registration scoreboard (V2-7)

One append-only scoreboard for all prediction families (audit B6: five
families, no shared scoreboard):

- Registration record: `predictionId`, `family`, `instrument`, `direction`,
  `strategyRoute`, `session`, `state`, `decisionPolicyVersion`,
  `modelVersion`, `registeredAt`, `rawConfidence`, `rawNetExpectedR`,
  `executionAuthority: 'NONE'`.
- Rules (enforced by `validatePredictionRegistration` /
  `registerPrediction`):
  1. Append-only: registrations are never edited or removed.
  2. Pre-outcome: `registeredAt` must predate the resolution timestamp;
     post-resolution registration is retrodiction and refused.
  3. Duplicate `predictionId` is refused.
  4. Families: `PLAN_B_EXPECTED_R`, `V8_LOGISTIC_PROBABILITY`,
     `CALIBRATED_WIN_RATE`, `M1_EXPECTANCY_BLEND`. P4
     (`OWNER_FORECAST_NET_R`) is RESEARCH_ONLY and excluded from the
     qualification scoreboard (B3/D5).
  5. `rawConfidence` ∈ [0, 1]; `executionAuthority` must be `NONE` — the
     scoreboard never grants order authority.
- Downstream consumers: the P0-4 statistical framework (Wilson CIs, Brier/
  reliability) evaluates registered predictions against resolved outcomes;
  CAL-1 maturity tiers read scoreboard coverage per cell.

## 6. Acceptance criteria and verification

- Executable mirror `apps/api/scripts/research/v2-calibration-contract.cjs`
  with a 21-test suite (`node --test`), wired into api-ci as a dedicated
  step; the drift detector re-proves 13 path/constant anchors and the A2
  window anchor on every run.
- Corpus verdicts are computed by the mirrors and reconciled against
  committed statistics (12 records, 10 disagreements, 2 controls, 7
  disposition conflicts, 2 within-layer splits, 12 distinct patterns).
- Inventory reconciles with audit A4/B4: six layers + two auxiliaries and
  five families, counted exactly.
- Scope guards: research-only; V1 Champion untouched; no runtime import of
  the mirror from production code; no production data; no broker access;
  no deployment. C-3 drift verdict for `main @ aea3d637` (25/25 map
  detectors pass) is recorded in the extension backlog's coordination
  snapshot.
