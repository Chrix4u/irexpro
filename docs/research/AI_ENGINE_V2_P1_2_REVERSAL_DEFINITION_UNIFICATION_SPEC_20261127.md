# iRexPro AI Engine V2 — P1-2 reversal-definition unification spec

Status: research-only specification for backlog item **P1-2** of
`AI_ENGINE_V2_EXECUTION_BACKLOG_20261127.md`. Proposal only: **no runtime
edit, no import into any runtime path, no model or threshold change.** The
Champion (V1) is preserved untouched as the comparison baseline.

Inputs consumed: `AI_ENGINE_V2_COMPONENT_MAP_20261127.md` §2 (six reversal
definitions) and §10; `AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md` findings A2
and F4; the P1-1 executable mirror
(`apps/api/scripts/research/v2-direction-scorer-contract.cjs`, whose DS-1
calibrated probability is the conviction input RD-1 consumes). Coordinates
with PRs #834/#836/#837/#838 (M1 abstention chain — conclusions inherited by
reference, no artifact duplicated).

Machine-readable mirror:
`apps/api/scripts/research/v2-reversal-definition-contract.cjs`
(+ test, CI step — the drift detector). Every numeric claim below is
verified against the sources on this branch with line references; the
mirror re-proves the file paths, re-computes the corpus verdict matrix, and
reconciles the disagreement statistics on every CI run. The corpus verdicts
are **computed by faithful predicate mirrors, never hardcoded assertions**.

---

## 1. Scope and problem statement

The V1 engine answers one question — "is a reversal confirmed on this bar?"
— with **six different definitions** (audit A2, severity high). Three are
bar-level confirmers that can each route or admit an evaluation (R1, R2,
R3); one is a fusion shadow that re-asks R1's question without R1's
failed-breakout discriminator (R4); one exists **specifically to observe the
disagreement between the first two** (R5 — audit A2/F4: the engine keeps a
service whose purpose is to measure the mismatch between two of its own
definitions); and one is an execution-side DEMO probe with a sixth,
different conviction surface (R6 — expert unanimity). The same market
concept enters the engine as six gates with four different conviction
floors (0.6 quality / 0.64 confidence / 0.64+0.40828402366863903 paired
probabilities / 0.7 expert confidence), two different economics floors
(0.18 gross / 0.08 net), two different regime-support sets
({TREND_WEAK} vs {TREND_WEAK, TREND_EXTENDED}), and one definition-specific
structural discriminator (the failed breakout).

The V2 contract defined here — **RD-1** — is the single input/output
contract any V2 reversal decision must satisfy: one column set, one unit
per concept, one missing-value rule, one predicate structure with
pre-registered constant slots. The frozen disagreement corpus committed
here is the comparison baseline: any V2 change to a reversal constant must
be justified against every corpus record it flips.

Out of scope: direction scoring (P1-1/DS-1), reliability floors (P1-3),
calibration containers (P1-4), exit policies (P1-5), admission thresholds
(L2 admission consumes the RD-1 verdict).

## 2. The six-definition inventory (verified on this branch)

Sources: R1 `apps/api/src/modules/ai/m1-tactical-route.ts` (+ policy in
`m1-tactical-candidate.ts`), R2 `plan-b-multimodel-shadow.ts`, R3
`paired-direction-reversal.ts` (+ threshold re-export from
`v8-shadow-meta-scorer.ts`), R4 `m1-reversal-timing-fusion-shadow.ts`, R5
`planb-reversal-m1-continuation-shadow.ts`, R6
`confirmed-reversal-cross-sleeve-canary.ts`.

| # | Role | Predicate (verified, lines on this branch) | Key constants |
| --- | --- | --- | --- |
| R1 | bar-level confirmer — the only definition whose TRUE routes an order in V1 (`M1_CONFIRMED_REVERSAL`) | `reversalImpulse` (l.97-106): failed breakout against direction ∧ quality ≥ 0.6 ∧ momentum1/3Atr ≥ 0.25 ∧ momentum5Atr ≥ 0.125 ∧ slope > 0; `m5ReversalConfirmed` (l.108-122): established (≥0.08/≥0.08/≥−0.1) ∨ decisive (≥0.6/≥0.3/≥−0.1); conjunction l.192-193, gated by scoreEdge ≥ 0.08 (l.203); signal-without-turn abstains `M5_REVERSAL_NOT_CONFIRMED` (l.207-209) | policy l.28/32/33: 0.08, 0.6, 0.25; relaxation 0.5 (l.103); turn block l.114-116, l.118-120 |
| R2 | bar-level confirmer — Plan-B shadow admission side | `reversalConfirmed` (l.141-155): TREND_WEAK ∧ confidence ≥ 0.64 ∧ extensionAtr ≤ 1.15 ∧ volatilityScore ≤ 0.55 ∧ signed momentum ∈ [0.5, 1.5] ∧ grossExpectedR ≥ 0.18; momentum signed by direction (l.135-139) | 0.64 (l.50), 0.18 (l.52), 0.5 (l.53), 1.5 (l.54); **1.15 and 0.55 are inline literals** (l.150-151), not named constants |
| R3 | bar-level confirmer — paired probability-gap gate | directional probabilities `sigmoid(logit(buy) − logit(sell))` (l.98-101); ladder (l.132-156): directional ≥ 0.64 → preferred ≠ primary → absolute ≥ 0.40828402366863903 → regime ∈ {TREND_WEAK, TREND_EXTENDED} → aligned momentum ≥ 0.15 → netR ≥ 0.08; netR = p·T − (1−p) − cost (l.113-116) | l.3-6: 0.64, 0.40828402366863903, 0.15, 0.08; the only definition with a typed reason ladder |
| R4 | fusion shadow — "would R1 confirm without the failed-breakout requirement?" | state ladder l.107-123: planB reversal admitted → original route ≠ already-confirmed → quality ≥ 0.6 → momentum1/3 ≥ 0.25 → momentum5 ≥ 0.125 → slope > 0 → completed M5 turn → **failed breakout must be absent** → `ALTERNATIVE_CONFIRMATION_CANDIDATE` | 0.6 (l.6), 0.25 (l.7), relaxation /2 (l.93) |
| R5 | observation-only witness of the R2-vs-R1 disagreement | `mismatchObserved` (l.72-73): planB route `CONFIRMED_REVERSAL` ∧ M1 route `M1_TREND_CONTINUATION`; prospective-study ladder follows (netR > 0.1 l.57, scoreEdge ≥ 0.3 l.64, quality ≥ 0.68 l.66, htf ≥ 0.2 l.68, M5 floors l.74-78); never permits an order | study floors 0.1/0.3/0.68/0.2/0.18/0.1/0.12 |
| R6 | execution-side DEMO probe — cross-sleeve canary | gate chain l.43-79: M1 route `M1_EARLY_TRANSITION` ∧ degraded-transition veto active ∧ no loss-streak veto ∧ strategy route `CONFIRMED_REVERSAL` ∧ execution/economic gates green ∧ event CLEAR ∧ drift NORMAL ∧ netR > 0 ∧ broker-native expert aligned, freshness ≤ 120 s, confidence ≥ 0.7, ≥ 3 unanimous votes | lot cap 0.2 (l.14), 120 s (l.63), 0.7 (l.66), 3 votes (l.79); 4-hour cooldown and lot ceiling enforced in the scheduler |

Line-reference note versus the component map §2: the map's "l.50-54" for
R2's constants holds exactly (0.64@50, 0.18@52, 0.5@53, 1.5@54 — l.51 is
the non-reversal gross floor 0.08); no correction is required this time
(unlike P1-1's §1 correction). The enrichment this spec adds: R2's two
ceilings are **inline literals**, and R5's/R6's full ladders (previously
cited only by their artifacts) are now mapped line-by-line.

## 3. The frozen disagreement corpus (the P1-2 acceptance artifact)

Twelve synthetic borderline decision-time snapshots, committed in
`v2-reversal-definition-contract.cjs` as frozen fixtures (`RV-D01`..`RV-D12`).
Every record carries all six definitions' input surfaces (identity, R1
candidate block, R2 regime/economics block, R3 paired-probability surface,
R4 admission state, R5 route pair, R6 canary gates as a frozen all-green
baseline plus per-record overrides). The verdicts below are **computed** by
the mirror's faithful predicate re-implementations and reconciled against
the committed expectations on every validation run.

| Record | Scenario (divergence class) | R1 | R2 | R3 | R4 | R5 | R6 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RV-D01 | R1-only: Plan-B regime TREND_HEALTHY and paired edge 0.60 < 0.64 both reject what R1 confirms | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| RV-D02 | regime-support divergence {WEAK} vs {WEAK,EXTENDED}: R1+R3 confirm, R2 rejects | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| RV-D03 | R2-only (no failed breakout); R4 flags the alternative, R5 records the institutional mismatch | ✗ | ✓ | ✗ | ✓ | ✓ | ✗ |
| RV-D04 | mirror image of RV-D01: R2+R3 confirm (BUY side) while R1 lacks the breakout | ✗ | ✓ | ✓ | ✓ | ✓ | ✗ |
| RV-D05 | R3-only on TREND_EXTENDED: R2 rejects the regime R3 supports | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ |
| RV-D06 | **CONTROL** — all six reject: the near-miss corridor (0.59 quality, 0.63 confidence, 0.5993 paired edge, 1.16 ext, 0.56 vol, 1.6-band… every gate by its smallest margin) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| RV-D07 | R1 signal without a completed M5 turn vs R2 confirmation — the timing disagreement R4 exists for | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ |
| RV-D08 | momentum-band divergence: R2 rejects 1.6 > 1.5 while R1 and R3 confirm | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| RV-D09 | economics-floor divergence 0.08 vs 0.18: net 0.119 clears R3, gross 0.17 fails R2 | ✗ | ✗ | ✓ | ✓ | ✓ | ✗ |
| RV-D10 | extension divergence: 1.16 > 1.15 rejects R2 only | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ |
| RV-D11 | volatility divergence (0.56 > 0.55) plus R3 momentum-reject at 0.10 aligned | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| RV-D12 | canary divergence: R2+R3+R4 confirm while R6 rescues the EARLY_TRANSITION-labelled candidate | ✗ | ✓ | ✓ | ✓ | ✗ | ✓ |

Statistics (validated, not asserted by hand): **11 disagreement records + 1
all-reject control; confirmation counts R1=5, R2=4, R3=7, R4=5, R5=4, R6=1;
12 distinct verdict+reason patterns.** Every record's rejection carries a
reason code matching the source gate order (e.g. RV-D09 R2 `GROSS_...`
vs R3 `PAIRED_REVERSAL_CANDIDATE` on the same bar). R5 and R6 are disjoint
witnesses by construction: R5 fires only on the `M1_TREND_CONTINUATION`
label, R6 only on `M1_EARLY_TRANSITION` — the corpus records the two
disagreement modes the engine itself institutionalized.

Corpus design decisions, recorded for reproducibility: (a) the R1 mirror
reduces `classifyM1TacticalRoute` to its reversal-predicate chain (scoreEdge
gate → signal → M5 turn → confirm); the continuation/transition branches
belong to the P1-0 component map's L3 surface, not the reversal verdict;
(b) the canary surface is a frozen all-green baseline plus per-record
overrides — both halves are committed fixtures; (c) all inputs are
synthetic; no private data, no production tables (boundary of audit C11).

## 4. RD-1 — the single V2 reversal contract

### 4.1 Input schema (one column set, one unit per concept)

Sign convention inherited from DS-1: alignment applied exactly once, at
ingestion; signed columns are positive when favoring the candidate
direction.

| Group | Column | Unit / range | Notes |
| --- | --- | --- | --- |
| identity | `instrument`, `direction`, `decisionTime`, `policyVersion` | enum 6 majors / BUY\|SELL / ISO-8601 UTC / string | unsupported instrument → typed refusal |
| turn | `m5BodyPressure3`, `m5Momentum1Atr`, `m5Momentum3Atr` | [−1,1] / ATR signed / ATR signed | the completed-M5 turn block (R1/R4's shared evidence) |
| turn | `m5LatestBodyPressure?` | [−1,1], nullable | decisive-fresh branch; absence recorded, `finiteOr` default 0 retired |
| impulse | `momentum1Atr`, `momentum3Atr`, `momentum5Atr`, `emaSlopeAtr` | ATR signed / ATR-per-bar signed | replaces R2's shortHorizon band and R3's raw column |
| breakout | `failedBreakoutAgainstDirection` | boolean, **required evidence** | recorded stratifier — never again the sole discriminator (the R1-only gate that R4 exists to question) |
| conviction | `calibratedProbability` | [0,1] | **DS-1's output** — replaces R1 quality 0.6, R2 confidence 0.64, R3's 0.64/0.408284… constellation |
| regime | `regime` | 7-value enum | replaces R2's {TREND_WEAK} vs R3's {TREND_WEAK, TREND_EXTENDED} support sets |
| economics | `netExpectedR`, `estimatedExecutionCostR` | R units | net, cost-inclusive — replaces gross 0.18 vs net 0.08 |
| context | `htfAgreement`; `scoreEdge?` | [−1,1]; ATR signed | recorded context; not gates |

**Prohibited as input:** any upstream `confidence` (the B5 constellation)
and raw directional probability pairs (RD-1 consumes one calibrated
probability, produced by DS-1; R3's internal logit pairing retires).

### 4.2 Missing-value semantics (one rule — same as DS-1)

Required column absent/null/undefined/non-finite → typed refusal
`REVERSAL_INPUT_REQUIRED` (fail-closed). Optional columns nullable with
explicit presence flags; absence never rewritten to 0. Out-of-range →
`REVERSAL_INPUT_OUT_OF_RANGE`; never clamped into range.

### 4.3 The predicate structure (five gates, pre-registered slots)

1. **completedTurn** — established ∨ decisive on completed M5 bars. The
   turn constants (0.08/0.08/−0.1; 0.6/0.3/−0.1) are the R1/R4 shared
   block, carried into V2 unchanged: this is the one structural turn test.
2. **impulseCorroboration** — momentum1/3Atr ≥ θimp ∧ momentum5Atr ≥
   θimp/2 ∧ slope > 0. Slot θimp (proposed 0.25 — R1/R4's floor; R2's
   [0.5,1.5] band and R3's 0.15 floor retire into the pre-registration).
3. **conviction** — `calibratedProbability` ≥ θdir. Slot (proposed 0.64 —
   the strictest bar-level floor observed; the 0.6 quality and 0.408284
   absolute floors retire with their dialects).
4. **economics** — `netExpectedR` ≥ θecon. Slot (proposed 0.18 net — the
   stricter of the two V1 floors, now uniformly net and cost-inclusive).
5. **regimeSupport** — regime ∈ the pre-registered supported set (proposed
   {TREND_WEAK, TREND_EXTENDED} — R3's set; R2's narrower set retires).

**CONFIRMED = 1 ∧ 2 ∧ 3 ∧ 4 ∧ 5.** All five values are proposals frozen at
campaign pre-registration (P5-4) and never edited mid-campaign; each is
the strictest observed V1 value for the same concept, so no V2 slot is
looser than the Champion's tightest gate. The failed breakout is recorded
as evidence and a post-hoc attribution stratifier (which corpus class it
separates: RV-D01/02/08/10/11 vs RV-D03/04/05/09/12), never a required
gate — the corpus shows requiring it costs exactly the RV-D03/RV-D04 class
of confirmations R2/R3/R4 would admit.

### 4.4 Output contract

| Field | Semantics |
| --- | --- |
| `reversalState` | `CONFIRMED \| NOT_CONFIRMED` — the single V2 verdict |
| `turnType` | `ESTABLISHED \| DECISIVE_FRESH \| NONE` — which turn branch fired |
| `gatesPassed` | per-gate booleans (turn/impulse/conviction/economics/regime) — abstention attribution reconstructible |
| `evidenceRecord` | all consumed inputs with presence flags, incl. `failedBreakoutAgainstDirection` |
| `registration` | pre-outcome registration to the V2-7 scoreboard (P1-4) |
| `executionAuthority` | `NONE` — research contract; admission is a separate layer |

### 4.5 Migration map (proposal only — no runtime edit)

| V1 definition | V2 disposition |
| --- | --- |
| R1 `m1-tactical-route.ts` | the turn block and impulse chain survive as RD-1 gates 1-2; the failed-breakout requirement retires to a recorded stratifier; `M5_REVERSAL_NOT_CONFIRMED` remains the gate-1 failure mode |
| R2 `plan-b-multimodel-shadow.ts` | `reversalConfirmed`'s regime/extension/volatility screens become recorded context (regime stays gate 5); its confidence input retires to `calibratedProbability`; the two inline ceilings move into the pre-registered slots |
| R3 `paired-direction-reversal.ts` | the typed reason ladder becomes RD-1's refusal vocabulary; its logit pairing retires (DS-1 produces the single calibrated probability); its netR formula is the RD-1 economics unit |
| R4 `m1-reversal-timing-fusion-shadow.ts` | its question — "would it confirm without the failed breakout?" — is answered **by construction**: RD-1 no longer requires it; the shadow retires with the disagreement it measured |
| R5 `planb-reversal-m1-continuation-shadow.ts` | retires with the R2-vs-R1 mismatch it witnessed; its observation corpus role is preserved in the frozen corpus (RV-D03/04/05/09) |
| R6 `confirmed-reversal-cross-sleeve-canary.ts` | its veto-rescue semantics move behind the L2 admission layer as an explicit, labeled exception path; expert unanimity stays a **separate** execution-side gate, never an RD-1 input |

## 5. Acceptance criteria (backlog P1-2)

- [x] Six-definition inventory with predicates, constants and line
  references, code-verified (§2, mirrored in
  `v2-reversal-definition-contract.cjs`).
- [x] Frozen disagreement corpus committed as synthetic fixtures: twelve
  borderline records, verdicts computed by faithful predicate mirrors and
  reconciled against committed expectations on every run (§3).
- [x] Corpus demonstrates the disagreement: 11 disagreement records + 1
  all-reject control; confirmation counts 5/4/7/5/4/1; 12 distinct
  verdict+reason patterns (validated).
- [x] Single V2 contract RD-1 defined: columns and units (§4.1), one
  missing-value rule (§4.2), one predicate structure with pre-registered
  constant slots (§4.3), one output semantics (§4.4), typed refusals
  (`REVERSAL_INPUT_REQUIRED`, `REVERSAL_UNSUPPORTED_INSTRUMENT`,
  `REVERSAL_INPUT_OUT_OF_RANGE`).
- [x] No runtime edit: nothing in this change imports or modifies any
  production module; all six sources are untouched.
- [x] Drift detection: CI re-proves the six source paths, re-computes the
  verdict matrix, and reconciles all corpus statistics; tampering with
  inputs, expectations, records, or definitions is a typed refusal
  (17-test suite).

## 6. Boundaries

Research-only: no runtime import, no production data, no DB or broker
access, no deployment; deployment hold intact; V1 Champion untouched.
Every artifact carries `executionAuthority: NONE`. The corpus is
synthetic and in-repo — no private datasets (audit C11 discipline).
Coordination: M1 chain conclusions (#834/#836/#837/#838) inherited by
reference; the DS-1 calibrator-bundle container belongs to the stacked
sibling and is referenced, not duplicated.
