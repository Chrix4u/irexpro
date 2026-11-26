# iRexPro AI V2 — Challenger Architecture Proposal (Research-Only)

**Branch:** `research/ai-v2-challenger-architecture-20261127`
**Status:** research-only architecture proposal. Nothing in this document is implemented in any executable trading path. No production engine, model, threshold, risk control, database, broker connection, credential or service is modified. AI V1 remains the untouched Champion. Deployment hold remains active.

---

## 1. Executive summary

The audit (`V2_ENGINE_AUDIT_FINDINGS.md`) finds that iRexPro's engineering discipline (as-of evidence, fail-closed gates, append-only ledgers, broker-native data) is unusually strong, while its **decision intelligence is structurally unable to learn from its own outcomes**:

1. **Confidence is not a probability.** Five non-commensurable scalars feed one 0.60 gate; measured discrimination is at chance (AUC 0.4752/0.5216/0.4685) and forecasts are systematically optimistic by ~0.5R.
2. **The loss is an exit-side and cost-side problem, not an entry-side problem.** Exit-type R decomposition: protected exits +0.42R vs broker-closes −0.88R and guard-closes −0.76R against a uniform 1.6R design; commissions 0.146–0.202R/trade, 3× the modeled cost.
3. **Duplicated intelligence cannot be audited.** Two M1 stacks, three Plan-B scorers, five confidence semantics, three `directionQuality` definitions, ≥5 expectancy computations per decision.
4. **The evidence ledger under-reports its own decisions** (first-write-wins persistence, placeholder governance values, blocker-list erasure) — the learning loop is corrupted at the source.
5. **A version treadmill with small-sample gates** has consumed the research capacity without ever producing a qualified candidate.

AI V2 is a **Champion-Challenger research architecture** designed around one idea: **make every decision carry a calibrated, commission-inclusive, provenance-complete probability statement, then hold it accountable to broker-confirmed outcomes on isolated DEMO accounts under equivalent conditions.** V2 is specified to be evaluated — not assumed superior — against V1 on isolated Pepperstone cTrader DEMO accounts (`V2_CHAMPION_CHALLENGER_DEMO_EVALUATION_DESIGN.md`).

---

## 2. Design principles (each traces to a documented V1 defect)

| # | Principle | V1 defect it removes |
|---|---|---|
| P1 | **One decision core, one confidence semantics** | D-01 five confidence scalars; path-dependent dispatched confidence |
| P2 | **Calibration is a load-time verified artifact, not an offline experiment** | D-01 calibrators exist only offline |
| P3 | **Abstention is a six-slot uncertainty record, never a scalar** | PR #836 taxonomy; D-01 cap-0.738 monotone transform |
| P4 | **Cost-first economics: no executable decision without a commission-inclusive expected-net-R** | D-03 3× cost understatement |
| P5 | **Entry intelligence and exit management are separate modules, evaluated separately** | D-03 exit-type dominates expectancy |
| P6 | **Append-only evidence with supersede counting; as-of or explicitly reconstructed** | D-04 first-write-wins; blocker erasure |
| P7 | **No inline owner/account/lot carve-outs; a versioned policy layer owns all permissions** | D-05 10+ inline owner checks; hardcoded pilots |
| P8 | **One geometry per instrument-minute; R-multiple normalization for all comparisons** | D-02 dual geometries |
| P9 | **Drift/OOD is a first-class decision input with a runtime gate** | D-04 no runtime OOD in Python |
| P10 | **Simplicity budget: fewer experts, fewer thresholds, pre-registered validation only** | D-05 12-expert lattice, 27-version treadmill |

---

## 3. V2 layered architecture

### L0 — Market-data and feature plane (single source of truth)
- One feature contract (the M1/M5/M15/H1/H4 MTF-128 closed-candle contract, provenance rules preserved), consumed by **one** client: the V2 decision core.
- **Per-candle provenance retained end-to-end** (source, sample window, retrieval time) — removes the provenance-flattening defect; mixed-provenance guards become effective again.
- Inter-candle gap detection fail-closed; `before`-cursor semantics honored by every adapter; one timezone convention (UTC everywhere, broker-time normalized at the adapter).
- Runtime drift statistics (PSI/KS against the frozen training manifest) computed on the feature plane and exposed as decision inputs (L1) rather than as a scattered TS-side flag.

### L1 — Single decision core (the only scoring authority)
- **One model family, calibrated end-to-end**: a gradient-boosted ensemble per instrument family, predicting a **distribution over net-R at a fixed horizon**, not a binary direction plus hand-blended confidence:
  - `p(win)` — isotonic-calibrated on purged chronological inner windows; the calibrator is serialized **into the artifact bundle**, SHA-pinned and verified at load (same discipline as the existing manifest pinning).
  - `E[netR]` with an explicit dispersion estimate (predictive uncertainty).
- One confidence semantics exists in the whole system: **calibrated `p(win)`**, declared with its calibration state (`CALIBRATED`/`UNCALIBRATED`/`UNKNOWN`). Uncalibrated scores are provenance-only and can never drive sizing (invariant C1 of `v2-decision-record-contract.cjs`).
- The V1 hand-tuned M1 composite, the frozen v8 logistic and the 12-expert TS lattice are **not ported**. The Python engine becomes the single owner of scoring (TS consumes via the existing internal challenger endpoints), eliminating the TS/Python duplication.

### L2 — Abstention and uncertainty layer
- The six-slot taxonomy from PR #836 (`directionalConfidence`, `predictiveUncertainty`, `thresholdDistance`, `outcomeProbability`, `missingEvidence`, `mandatoryRiskRestriction`) becomes the decision record's uncertainty block — filled or explicitly null, never collapsed (invariant C2).
- **Abstention semantics** (refined from the M1 abstention research): an abstention records *why* (each slot) and *what would have had to be true* (the threshold distance), which is exactly the evidence the corpus repeatedly demanded.
- OOD/missing-evidence abstentions are never re-labelled; OOD execution requires explicit drift-rescue provenance recorded at decision time (invariant C5).

### L3 — Entry and exit intelligence, separated
- **Entry module**: consumes L1/L2; emits `EXECUTE` only when the after-cost economics gate (L4) passes. Route labels (Confirmed Reversal / Early Transition / Trend Continuation) are retained **as analysis dimensions only**, not as separate rule ladders — the corpus's route-conditioned divergence is treated as a feature/regime input, not as three hand-tuned policy stacks.
- **Exit module**: an explicit, versioned exit policy state machine with a **single** precedence order, replacing the 8-classifier emergent lattice:
  1. hard risk stop (broker-native, minimum-distance rules preserved),
  2. time-stop,
  3. profit-retention ladder (the measured +0.42R class),
  4. thesis-invalidation cut (the measured −0.88R/−0.76R classes, governed by calibrated p(adverse continuation)),
  5. no profit lock may arm below the level at which its historical retention tier actually protected net expectancy (the retired-0.30R-arm lesson is encoded as a gate, not a comment).
- **Partial closes become representable**: scale-in/scale-out is a first-class exit action (V1 cannot express it).
- Exit policy variants are evaluated by **pre-registered counterfactual shadow on the same observed paths** (hold-vs-close at +1/+15/+60 min, first-touch bracket replay), never by retrospective threshold fitting.

### L4 — Cost-first economics
- Every executable decision carries `expectedNetR` produced by a **commission-inclusive cost model** (spread + P90 commission/lot + slippage estimate) with a version hash (invariant C4).
- Cost-model calibration is itself monitored: predicted vs realized cost per trade is a reported series; a 3× understatement would be visible within a day, not discovered by a research audit a week later.

### L5 — Governance and risk (reuse V1's, simplified)
- The existing fail-closed risk chain (authority binding, kill switch, daily-loss, drawdown, margin, stop-distance, grant TTL, final dispatch boundary) is **preserved as-is** — it is V1's strongest asset.
- All permissions (owner scopes, lot ceilings, pilots, instrument scope) move to a **versioned policy layer** referenced by hash (invariant C6); no inline identity checks.
- Route reliability/brake logic collapses into the policy layer with a single threshold registry instead of ≥10 services with conflicting floors.

### L6 — Evidence ledger (the learning loop)
- Decision records follow the **V2 decision-record contract** (C1–C6, executable as `v2-decision-record-contract.cjs`): one confidence, six uncertainty slots, as-of provenance with supersede counter, commission-inclusive economics, explicit drift state, policy reference.
- Append-only with **supersede counting** (never first-write-wins); reconstructed evidence flagged `reconstructed: true`.
- Outcome linkage: each settled broker fill joins back to the exact decision SHA (see the attribution ledger in the DEMO design) — the calibration loop finally closes.

---

## 4. What V2 removes, keeps, and adds

| Removes | Keeps | Adds |
|---|---|---|
| Hand-tuned M1 composite weights; frozen v8 logistic; 12-expert TS lattice; three Plan-B scorers; route rule ladders; 8-classifier exit lattice; inline owner checks; version treadmill | Risk gates; as-of/provenance discipline; append-only fill ledger; broker-native data rules; promotion-gate refusal discipline; qualification gateway | Calibrated outcome model as a load-verified artifact; six-slot uncertainty record; exit state machine with single precedence; commission-inclusive cost model with version hash; supersede-counting evidence; runtime drift gate; paired DEMO evaluation with immutable attribution |

**Explicit non-assumption:** V2 is not asserted to be profitable. The corpus shows win rates of 50–67% with destroyed payoff distributions; V2's hypothesis is that a calibrated, cost-honest, exit-focused architecture can at least **measure** whether an edge exists, and only then be judged by the published gates.

---

## 5. Evaluation criteria (encoded in `v2-evaluation-metrics.cjs`)

Reported per engine, per stage: settled trades, net after-cost R, mean R ± dispersion, risk-normalized expectancy (per-trade Sharpe analogue), profit factor, max drawdown (R), calibration (Brier, ECE, reliability bins, AUC with SE), predicted-vs-realized gap, chronological segment stability, sample sufficiency (required n for the pre-registered MDE), overlap/bias warnings. **Win rate is descriptive and is never a gate.** Thresholds are caller-supplied pre-registered policy; defaults restate the published project gates (PF ≥ 1.15, Sharpe ≥ 1, DD ≤ 12%, 100 trades).

Stages (detailed in the DEMO design doc):
- **Stage 0 — offline replay** on chronological synthetic/authorized-anonymized data, purged walk-forward, no future leakage;
- **Stage 1 — shadow paper** on the live feed (no orders);
- **Stage 2 — paired isolated DEMO accounts** (broker-confirmed outcomes, actual costs, execution quality, drawdown, consistency);
- **Stage 3 — independent review** against the pre-registered protocol; manual, explicit, DEMO-only promotion decisions only.

---

## 6. Research experiments bundled with this branch (synthetic fixtures only)

1. `v2-evaluation-metrics.cjs` (+8 tests) — the evaluation criteria engine; proves: win-rate-alone cannot qualify; optimistic predictions fail ECE; overlap reporting; sufficiency gating; exact metric recomputation against independent formulas (PF, drawdown, Brier, Mann-Whitney AUC with ties).
2. `v2-champion-challenger-attribution.cjs` (+7 tests) — DEMO isolation invariants: engine identity, equivalent starting conditions, append-only attribution, engine-account binding, cross-engine close rejection, no cross-account netting, dashboard only under equivalence+sufficiency with no winner declared.
3. `v2-decision-record-contract.cjs` (+8 tests) — the C1–C6 decision-record contract over synthetic records (each V1 defect class has a rejecting test).

---

## 7. Boundaries and limitations

- This proposal is **documentation + synthetic-fixture research scripts**; no runtime code was touched. Implementing V2 is a separate, individually-reviewed, pre-registered effort (see the execution backlog).
- No private datasets, account identifiers or credentials appear in this branch; all fixtures are synthetic and deterministic.
- Broker-connected DEMO testing (Stage 2) requires separately provisioned Pepperstone cTrader DEMO accounts and explicit owner authorization; nothing in this branch contacts a broker.
- The corpus's own unresolved questions (profit-protection timing, 5m-guard value, evening admission scarcity, hour harmonics) are inherited as open hypotheses with pre-registered experiments — not silently fixed by the redesign.
- Champion economics are historically negative after costs; V2's first obligation is honest measurement, not a profitability claim.

## 8. Coordination with open research PRs

- **#834** (M1 decision-evidence coverage): V2's L6 ledger supersedes the coverage gap catalog; the abstention evidence contract is adopted verbatim.
- **#836** (M1 abstention intelligence, mine): the six-slot taxonomy is promoted into L2; the "no scalar strength" conclusion is an invariant (C2).
- **#837** (taxonomy integration review): margin semantics (`scoreEdge` vs persisted `governance.routeDecision`) resolved in favor of the persisted route decision; unknown blocker codes preserved.
- **#838** (combined CI candidate): this branch is stacked on its head (`55c11626`) and adds only research files; retarget to `main` after the M1 stack merges.
