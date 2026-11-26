# M1 abstention intelligence — independent research report

Status: offline research only. No runtime import, trading authority, policy
promotion, model change, database access, broker call or service restart.
Research-only documentation and synthetic tests; coordinates with, and does
not duplicate, PR #834 (`research/m1-decision-evidence-coverage-20261126`).

Investigator role: independent quantitative-research review. The reviewed
operator aggregates are: 192 settled DEMO trades (105 W / 87 L); M1 abstained
on 154 (86 W / 68 L); reported M1-confidence AUC 0.4752; both abstention and
non-abstention cohorts net-negative after costs.

---

## 1. Independent technical review

### 1.1 What M1 actually computes

`m1-tactical-candidate.ts` derives, per direction, from one feature snapshot:

- `directionQuality = 0.5 + directionalComposite / 2`, where
  `directionalComposite` is a fixed-weight linear sum of nine clamped signed
  features (EMA separation 0.19, HTF agreement 0.20, momentum-3 0.16, slope
  0.10, momentum-5 0.10, close pressure 0.08, breakout 0.08, wick pressure
  0.05, RSI bias 0.04 — weights sum to 1.0). It is an ordinal heuristic
  index on [0,1], not a probability.
- `confidence = 0.5 + 0.3·directionQuality + 0.08·efficiency5 −
0.08·volatilityScore`, hard-capped at 0.738. It is a monotone affine
  transform of `directionQuality` plus small modifiers; its scale is
  compressed by design so it stays inside the drift envelope's [0.64, 0.8]
  hard band. It is not calibrated against any outcome.
- `score = directionQuality + 0.15·confidence + 0.05·momentum1 + 0.05·HTF`,
  and the route classifier consumes `scoreEdge = score(BUY) − score(SELL)`
  against `minDirectionalEdge = 0.08`.

### 1.2 Route classification and abstention reasons

`m1-tactical-route.ts` emits exactly six abstention reasons with a fixed
evaluation precedence: `INVALID_COUNTERFACTUAL_PAIR` → `HIGHER_TIMEFRAME_
CONFLICT` → `DIRECTION_EDGE_TOO_SMALL` → `M5_REVERSAL_NOT_CONFIRMED` →
`M5_CONTINUATION_EXHAUSTED` → `NO_VALID_ROUTE`. The recorded reason is the
first triggered predicate, so any latent later predicates are masked — one
recorded reason is a partial state, never a complete veto vector. Only the
`HIGHER_TIMEFRAME_CONFLICT` (−0.12 inclusive) and `DIRECTION_EDGE_TOO_SMALL`
(0.08) boundaries are single-predicate and well-defined;
`M5_REVERSAL_NOT_CONFIRMED` is two alternative sub-paths (established turn
OR decisive fresh turn); exhaustion and NO_VALID_ROUTE are compound.

### 1.3 Governance, authority and evidence recording

`m1-tactical-governance.ts` maps M1 routes onto the shared ensemble
governance layer and asserts `executionAuthority: PAPER_ONLY_RESEARCH | NONE`
with `promotionEligible: false` and `qualificationEvidence: false` by
construction. The trained-expert overlay (`high-conviction-overlay.ts`,
Python Plan-B v4 broker score) is advisory-only (`modifiesExecution: false`)
and carries its own abstention state with votes
(`longVotes`/`shortVotes`/`ensembleConfidence`/`meanOpportunityProbability`)
— an abstention at that layer is a different object from an M1 route
abstention. The scheduler persists every evaluation, including ABSTAIN rows,
to `trading.m1_tactical_decisions` with full `candidate` and `governance`
JSONB at decision time (see the evidence matrix below).

### 1.4 PR #834 coordination

PR #834 already delivers: reason-specific abstention margins in original
units (`m1-abstention-margin.cjs`, `abstentionStrength: null` by design),
a decision/outcome coverage audit (`m1-decision-evidence-coverage.cjs`), and
a feature-completeness inventory (`m1-feature-coverage.cjs`). This research
extends that base with two new artifacts and does not modify any of them:

- `m1-abstention-taxonomy.cjs` — the six-concept semantic separation
  (Section 4) in executable form.
- `m1-cohort-statistics.cjs` — the cohort statistics of Section 3,
  implemented on operator-supplied aggregates only, with every reference
  value cross-verified against scipy (Fisher exact, Hanley-McNeil SE,
  Wilson intervals) before being pinned in tests.

### 1.5 Verdict on "defensible basis"

The existing numerical measurements (directionQuality, confidence, score,
scoreEdge) do **not** provide a defensible basis for describing abstention
_strength_. They are uncalibrated heuristic indices; the reported AUC
0.4752 over the settled cohort carries no demonstrated outcome information
(Section 3), and none of them is expressed in units of outcome probability.
They are defensible for what they are — deterministic route-geometry inputs
— and that is exactly how PR #834 consumes them (margins to policy
boundaries). Any re-labeling of these magnitudes onto a 0–100 "strength"
scale would be a unit conversion without content.

## 2. Historical evidence completeness

The separately authorized anonymized DEMO research exports were not supplied
into this offline environment, so the matrix below is established from the
persisted schema and decision-time write path in the code, not from row
inspection. Where field availability is conditional, the condition is stated
explicitly. No per-trade private values, account identifiers or credentials
are included or inferred.

| Required evidence class                          | Recorded at decision time? | Where / condition                                                                                                                                                                                                                                                                                                                       | Provenance quality                                                                                   |
| ------------------------------------------------ | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Direction quality                                | Yes                        | `candidate` JSONB, all routes incl. ABSTAIN                                                                                                                                                                                                                                                                                             | RECORDED_AS_OF, first-write-wins                                                                     |
| Directional confidence                           | Yes                        | `candidate` JSONB (cap 0.738)                                                                                                                                                                                                                                                                                                           | RECORDED_AS_OF, compressed scale                                                                     |
| Candidate score                                  | Yes                        | `candidate` JSONB                                                                                                                                                                                                                                                                                                                       | RECORDED_AS_OF                                                                                       |
| BUY/SELL score difference                        | Yes                        | `routeDecision.scoreEdge` + `oppositeM1AtSignal` in governance JSONB                                                                                                                                                                                                                                                                    | RECORDED_AS_OF                                                                                       |
| M1 momentum                                      | Yes                        | `alignedMomentum1/3/5Atr` in `candidate` JSONB                                                                                                                                                                                                                                                                                          | RECORDED_AS_OF                                                                                       |
| M5 momentum                                      | Yes                        | `alignedM5Momentum1/3Atr`, `alignedM5BodyPressure3`                                                                                                                                                                                                                                                                                     | RECORDED_AS_OF                                                                                       |
| M5/M15/H1/H4 alignment                           | Yes                        | `alignedM5/M15/H1/H4` in `candidate` JSONB                                                                                                                                                                                                                                                                                              | RECORDED_AS_OF                                                                                       |
| Candle body and wick                             | **Partially**              | Raw `closeLocation`/`upperWickRatio`/`lowerWickRatio` persist only inside the transformed `directionalComposite` (non-invertible 9-term weighted clamped sum); the explicit body/wick snapshot (`ownerDemoPreEntryCandleSnapshot`) is written **only** when market-data authority is broker-native on the owner DEMO professional phase | Conditional; missing for non-broker-native and non-professional records                              |
| Independent expert votes and probabilities       | Yes, advisory layer        | trained-expert overlay fields (votes, ensemble confidence, mean opportunity probability, regime, freshness, `modifiesExecution: false`)                                                                                                                                                                                                 | RECORDED_AS_OF; distinct layer, never M1's own numbers                                               |
| Exact abstention reason                          | Yes                        | `routeDecision.reason` in governance JSONB; six enumerated values, first-triggered precedence                                                                                                                                                                                                                                           | RECORDED_AS_OF; masked later predicates are not separately recorded                                  |
| Policy versions and original decision timestamps | Yes                        | `candidate.policyVersion` (v1 / v2-m5-lifecycle), `evaluated_at`, `bar_time`, rollout phase/version in governance JSONB                                                                                                                                                                                                                 | RECORDED_AS_OF                                                                                       |
| Settled after-cost outcomes                      | Yes for filled trades      | trades table `realised_pnl`, `commission`, `swap`; decision rows carry `outcome_state`                                                                                                                                                                                                                                                  | BROKER_SETTLED; abstained-but-unfilled candidates have no settled outcome and must remain UNOBSERVED |

### 2.1 Missing, overwritten, inconsistent or retrospectively reconstructed evidence — findings

1. **Silently dropped re-evaluations (overwritten-class defect).**
   `recordDecision` upserts on
   `(user_id, broker_connection_id, instrument, direction, route, bar_time,
policy_version)` with `DO UPDATE SET updated_at = updated_at` — a
   first-write-wins no-op. A re-evaluation of the same M1 bar after a newer
   M5/M15 completion (same `bar_time`, newer `decisionTime`) can produce a
   different candidate and route, and the second write is discarded without
   any counter or audit row. The schema therefore cannot distinguish
   "stable re-evaluation" from "changed re-evaluation dropped on the
   floor". This is an evidence-completeness defect for any downstream
   abstention research that assumes one row per bar is the full history.
   Recommended (research-only) fix: record a monotonic
   `revision_superseded_count` (or an append-only revision table) without
   touching the winning-row semantics.
2. **Raw candle body/wick availability is conditional** (matrix above), so
   candle-geometry evidence for most historical abstentions survives only
   through the non-invertible composite. It cannot be reconstructed from
   the persisted decision alone — any later claim of original wick
   measurements for those rows would be retrospective reconstruction and
   must be rejected as evidence.
3. **Abstention reason is first-triggered**, so counters per reason
   understate latent predicates (same "overlapping reasons" pattern
   already established for the Nov 25 LIVE blockage). Reason-specific
   abstention-strength models fitted on reason counts inherit this
   truncation bias.
4. **Unfilled abstentions have no outcome class.** Settled outcomes exist
   only where another authority executed the trade anyway (selection,
   Section 3.5) or via shadow/paper episodes marked distinctly. Any export
   that labels an abstention row WIN/LOSS without a settled broker record
   is retrospectively reconstructed and must be filtered
   (`m1-decision-evidence-coverage.cjs` already refuses it; keep that
   contract).
5. **Duplicate cases and provenance labels.** A `RECORDED_AS_OF` label alone
   does not authenticate provenance (PR #834 contract, agreed): decision
   linkage, chronology and policy version must be independently verified
   before descriptive use.

## 3. Statistical investigation (operator-supplied aggregates)

All statistics below are computed by `m1-cohort-statistics.cjs` on the
aggregate counts only; JS implementations were verified against scipy
before pinning. No per-trade magnitudes, instruments or timestamps were
available, so correlation, position-size weighting and exit-management
effects are discussed qualitatively and bounded where possible.

### 3.1 Win-rate groups (Wilson 95%)

| Cohort        | k/n     | Win rate | 95% CI         |
| ------------- | ------- | -------- | -------------- |
| Overall       | 105/192 | 54.7%    | [47.6%, 61.6%] |
| M1 abstained  | 86/154  | 55.8%    | [48.0%, 63.4%] |
| Non-abstained | 19/38   | 50.0%    | [34.9%, 65.2%] |

Overall win rate is statistically indistinguishable from 50% (binomial
two-sided p = 0.22).

### 3.2 Does abstention separate winners from losers? No.

Fisher exact on [[86,68],[19,19]]: p = 0.5865 (odds ratio ≈ 1.27). The
abstention cohort's win rate is indistinguishable from the non-abstention
cohort's. In this sample M1's abstention is not demonstrated to carry
outcome information either way — which is exactly what an abstention-
strength score would need it to carry.

### 3.3 AUC 0.4752 is chance-level at this sample size

Hanley-McNeil SE = 0.042 (105 W vs 87 L); z = −0.59, two-sided p = 0.554;
95% CI [0.393, 0.557]. The interval contains 0.5 comfortably. The study as
sized can only detect |AUC − 0.5| ≥ 0.113 (80% power, α = 0.05); the
observed deviation 0.0248 is ~4.6× below that. Detecting AUC 0.55 needs
about 518 winners and 518 losers; AUC 0.60 needs about 125 per class.
**Conclusion: "AUC 0.4752" must be read as "no measurable discrimination",
not "slightly negative discrimination".** (Directionally below 0.5 is also
consistent with a slight inverse relation, but the CI cannot exclude zero.)

### 3.4 Why 54.7% wins still nets negative: payoff realization, not frequency

Design geometry: stop 1.1×ATR (R = 1), target 1.6R → break-even win rate
38.5% before costs. The observed win rate (54.7%) exceeds that by ~16
points, yet both cohorts netted losses. Under equal sizing this forces
average loss / average win ≥ 105/87 = 1.207 — versus the design-implied
0.625 (1R loss vs 1.6R win). The realized payoff ratio is at least ~2×
worse than design. The dominant economic defect is therefore **exit
management / cost drag truncating wins or extending losses**, not entry
frequency. This mirrors the earlier continuous-reversal DEMO finding
(221/251 fills, net-negative after costs). Caveats: variable position
sizes can distort this bound; per-trade magnitudes were not available to
verify. Note the win counts alone cannot separate the two mechanisms —
they only bound the aggregate.

### 3.5 Selection bias, overlap, correlation, small samples

- **Selection bias (dominant).** Outcomes for "M1 abstained" trades exist
  only where some other authority (Plan B primary, professional fallback,
  rescue paths) executed anyway. The abstention cohort is conditioned on
  the rest of the pipeline saying yes — it is not a random sample of all
  abstentions, and unfilled abstentions (no settled outcome) must remain
  UNOBSERVED rather than imputed.
- **Overlapping observations / correlated instruments.** Six instruments
  with correlated episodes (shared dollar leg, session-driven M5 runs)
  reduce the effective sample below the nominal 192 and 154; cluster-level
  effects cannot be corrected from aggregates alone.
- **Variable position sizes.** Dollar-averaged aggregates
  overweight large-lot episodes; the payoff bound above assumes equal
  sizing and must be re-estimated from per-trade R multiples when
  authorized.
- **Exit management influence.** Trades are managed post-entry (rescue,
  brakes, early-exit logic); settled outcomes are a joint product of entry
  and exit policy, so no measurement in this dataset isolates entry quality
  alone.
- **Route split.** Preliminary per-route differences (Confirmed Reversal /
  Early Transition / Trend Continuation) are reported by the operator but
  counts were not supplied; at 192 total, per-route cells are 30–80
  observations with Wilson half-widths of ±10 points or more — any per-route
  ranking at this size is noise-dominated.
- **Settled vs hypothetical.** Only broker-settled after-cost outcomes are
  treated as observations; paper/shadow episodes and unfilled candidates
  are counted separately and never merged (PR #834's coverage tool enforces
  this; tests pin it).

## 4. Abstention-strength methodology (0–100 feasibility)

A single 0–100 "abstention strength" number would illegitimately collapse
six fundamentally different concepts. `m1-abstention-taxonomy.cjs` encodes
the separation; each slot is filled or explicitly null per record:

1. **Directional confidence** — the model's self-assessed direction
   alignment (M1 `confidence`). A heuristic index; not a probability of
   anything; uncalibrated. Monotone in `directionQuality`, so rescaling it
   to 0–100 changes units, not meaning.
2. **Predictive uncertainty** — dispersion of the outcome distribution
   (ensemble disagreement, conformal intervals). Not recorded for M1 at
   decision time; constructing it requires a calibrated probabilistic
   model, not a re-labeling of existing numbers.
3. **Distance from an existing decision threshold** — geometric margin to
   a gate boundary (scoreEdge shortfall to 0.08; HTF agreement to −0.12).
   Well-defined for single-predicate reasons in original units; this is
   PR #834's margin helper, and it is _geometry_, carrying no outcome
   semantics by itself.
4. **Estimated probability of an unfavorable outcome** — requires a
   calibrated outcome model validated out-of-sample with proper scoring
   rules (Brier, log loss, calibration curves) on settled outcomes, with
   cost adjustment. Does not exist today; AUC 0.4752 is the measured
   absence of it.
5. **Missing or invalid evidence** — data unavailability states. Must be
   surfaced as MISSING/UNVERIFIED and never folded into a numeric strength
   (else data gaps masquerade as model caution).
6. **Mandatory risk restrictions** — policy vetoes (portfolio brake, event
   risk, qualification gates, execution authority NONE). Deterministic
   compliance decisions; attributing them to "model abstention strength"
   misassigns cause and would hide control behavior inside a model number.

### 4.1 Feasibility verdict

- **From existing recorded measurements alone: not feasible.** There is no
  demonstrated outcome information to calibrate against (AUC ≈ 0.5,
  indistinguishable), no uncertainty model, and per-route/per-reason cells
  are far below calibration-grade sample sizes (needed: ~500+ per class for
  a 0.05 AUC effect; available: 86/68 split over ≥3 routes and ≥6 reasons).
- **What would make it feasible, and how to validate:** pre-register a
  route-specific, cost-adjusted outcome model on settled observations only;
  require out-of-sample proper-scoring-rule calibration (Brier + calibration
  curve slope/intercept within tolerance); report per-reason and per-route
  cells with Wilson intervals; keep concepts 1–6 as separate persisted
  fields; and treat any scalar only as a research artifact with
  `executionAuthority: NONE`. No fixed percentage (60% or otherwise) is an
  execution threshold; that claim has no evidential basis and the tests
  pin its absence.
- **Interim defensible practice:** continue PR #834's approach —
  reason-specific margins in original units, six-slot taxonomy, explicit
  nulls, UNOBSERVED for unfilled cases. This is the maximum honest content
  extractable today.

## 5. Identified implementation defects (research-graded)

| #   | Finding                                                                                                               | Class                  | Severity for research                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| D1  | First-write-wins upsert silently drops re-evaluations of the same bar; no supersede counter                           | Overwritten evidence   | High for abstention research; no execution impact                                     |
| D2  | Raw candle body/wick persisted only via non-invertible composite (broker-native professional DEMO snapshot excepted)  | Missing evidence       | Medium; blocks candle-geometry abstention studies                                     |
| D3  | Recorded reason is first-triggered only; later latent predicates unrecorded                                           | Inconsistent evidence  | Medium; truncates reason-level counters                                               |
| D4  | `directionQuality` is triple-registered as trade/exit/pairSide quality in the governance score                        | Duplicated measurement | Low; inflates apparent dimensionality, carries no new information                     |
| D5  | `confidence` cap 0.738 compresses the scale to stay inside the drift envelope hard band                               | Design constraint      | Informational; any percentile-mapping of confidence to 0–100 inherits the compression |
| D6  | Non-abstained cohort is 38 trades (19 W / 19 L) — any "M1 would have improved X" comparison at this size is unpowered | Statistical limitation | High; pre-register before collecting more                                             |

No runtime defect was found in the abstention code path itself: reasons,
policy versions, timestamps and the candidate vector are recorded at
decision time, before dispatch, for all routes including ABSTAIN; the
governance layer asserts no execution authority; the trained-expert overlay
is advisory-only. The recording path is honest; its completeness has the
gaps above.

## 6. Recommended validation methodology (pre-registered, offline)

1. Define the six semantic slots (taxonomy) as the only acceptable
   vocabulary for any future abstention-intelligence artifact; reject any
   export that collapses them into one number.
2. Extend decision persistence with a supersede counter (D1 fix,
   research-only migration; no runtime semantics change).
3. Collect authorized, anonymized per-trade exports with: settled
   after-cost R multiples, per-trade lots, instrument, route, reason,
   policy version, and all candidate-vector fields; verify provenance and
   chronology before descriptive use.
4. Pre-register per-route and per-reason cell targets (≥ 100 settled
   observations per cell, target ≥ 500 per class for AUC 0.55 detection)
   before any discrimination claim.
5. Validate any candidate outcome model out-of-sample with Brier score,
   reliability curves and route-stratified folds; keep correlated
   instruments clustered (block bootstrap by session/instrument).
6. Re-estimate the payoff-realization decomposition (win truncation vs
   loss extension vs explicit costs) from per-trade R multiples — the
   current evidence identifies the direction (Section 3.4) but not the
   split.
7. Never merge settled, paper/shadow and unfilled cases; keep
   qualification and promotion gates entirely outside this research.

## 7. Verification and limits

- New artifacts: `m1-abstention-taxonomy.cjs` (+7 tests),
  `m1-cohort-statistics.cjs` (+6 tests); all 13 pass under `node --test`;
  reference values cross-verified against scipy before pinning. PR #834's
  three suites re-run green in the same tree.
- This branch is documentation and offline scripts only: no runtime import,
  no database access, no model change, no threshold change, no execution
  or promotion authority; deployment hold
  `DEPLOY-HOLD-ACTIVE-BROKER-20261122.txt` remains active and untouched.
- Limits: aggregates only (no per-trade magnitudes, timestamps,
  instruments or route splits were supplied); the evidence matrix is schema-
  and code-derived, not row-verified; route-level statements are
  qualitative until authorized per-route exports arrive; no profitability
  or model-qualification claim is made or implied anywhere in this
  research.
