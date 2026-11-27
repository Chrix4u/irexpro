# iRexPro AI Engine V2 — P1-3 reliability-layer consolidation spec

Status: research-only specification for backlog item **P1-3** of
`AI_ENGINE_V2_EXECUTION_BACKLOG_20261127.md`. Proposal only: **no runtime
edit, no import into any runtime path, no model or threshold change.** The
Champion (V1) is preserved untouched as the comparison baseline.

Inputs consumed: `AI_ENGINE_V2_COMPONENT_MAP_20261127.md` §3 (nine
reliability gates, floor ladder 3→20 samples, PF 1.0→2.0) and §10;
`AI_ENGINE_V2_COMPONENT_MAP_PHASE2_20261127.md` §13 (the reliability gates
are invoked from one ≈ 3,693-line `runOnce` method — the consolidation spec
must define extraction seams, not only shared floors) and §14 edge E4;
`AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md` findings A3 and F4; the P1-1/P1-2
contracts whose refusal vocabulary and missing-value rules RL-1 inherits.
Coordinates with PRs #834/#836/#837/#838 (M1 abstention chain — conclusions
inherited by reference, no artifact duplicated) and PRs #846/#862 (the V2
line this spec stacks on).

Machine-readable mirror:
`apps/api/scripts/research/v2-reliability-gate-contract.cjs`
(+ test, CI step — the drift detector). Every numeric claim below is
verified against the sources on this branch with line references; the mirror
re-proves the file paths **and the pinned constants** (content anchors,
never bare line numbers), re-proves the scheduler/collector invocation
anchors, re-computes the corpus verdict matrix, and reconciles the
disagreement statistics on every CI run. The corpus verdicts are **computed
by faithful predicate mirrors, never hardcoded assertions**.

---

## 1. Scope and problem statement

The V1 engine answers one question — "has this sleeve accumulated enough
provably-good evidence to trade?" — with **nine different reliability
gates** (audit A3, severity high), and answers it in three different
grammars: binary ladders with ten (G1), six (G2/G3) and seven (G4) reason
codes; state machines with four to five states (G5/G6/G9); a two-blocker
composition veto (G7); and one continuous advisory multiplier that never
vetoes (G8). For the *same kind* of evidence the floors span sample minima
3→20, profit-factor minima 0.75→2.0 (five rungs: 0.75 / 1.0 / 1.15 / 1.5 /
2.0), average-R minima −0.1→0.2, positive-fraction minima 0.4→0.5, and age
windows 7-days→unbounded. Two gates even disagree on what "recent
degradation" means on the same window: G2 fires only when the last three
outcomes are **all** non-positive, G3/G4 when their **sum** is (corpus
RL-D05).

The structural constraint (phase-2 §13): the M1 gates are invoked from
inside one monolithic method — G7 at scheduler l.1699 and G8 at l.4020
inside `runOnce` (l.959→l.4652), G1-G4 clustered in the helper block
l.4785-4843 — and the paper gates from the collector (l.2472, l.3137,
l.4832-4892). A "single reliability service" therefore cannot be specified
as a constant table alone; it must specify **extraction seams** first. That
is what RL-1 does.

Out of scope: direction scoring (P1-1/DS-1), reversal predicates (P1-2/
RD-1), calibration containers (P1-4), exit policies (P1-5), dead-code
staging (P1-6). RL-1 consumes DS-1's calibrated probability only where the
audit's B-series confidence floors would otherwise leak in — none of the
nine gates consumes a confidence value today, and RL-1 keeps it that way
(win rate alone is never a decision criterion; corpus RL-D07 is the
exemplar).

## 2. The nine-gate inventory (verified on this branch)

Sources: G1 `m1-tactical-reliability.ts`, G2
`m1-shadow-pair-side-reliability.ts`, G3 `m1-meaningful-scout-reliability.ts`,
G4 `m1-provisional-scout-reliability.ts`, G5 `paper-route-reliability.ts`
(six evaluators + two execution gates in one file), G6
`paper-scout-realised-payoff.ts`, G7 `demo-profitability-reliability-gate.ts`,
G8 `pepperstone-demo-advisory-quality-risk.ts`, G9
`paper-research-requalification-shadow.ts`. Call sites: G1-G4 at scheduler
l.4785/4806/4815/4843 (import block l.165-193), G7 at l.1699 (import
l.158), G8 at l.4020 (import l.53); G5/G6/G9 at collector l.4832-4892 /
l.3137 / l.2472 (import blocks l.111/l.161/l.147).

| # | Authority role | Floors (verified, lines on this branch) | Verdict grammar |
| --- | --- | --- | --- |
| G1 | ADMISSION_GATE — the only gate routing full-size V1 authority | min 5 (l.6); brake 3 / 2-early-transition (l.7-8); recent-5 payoff floor −0.1 (l.9-10); max 20 (l.11); window 7d (l.12); canary 180 min (l.15) | 10 reason codes; **asymmetric cold start**: `INSUFFICIENT_EVIDENCE` is eligible=true (l.290-308); mature evidence fail-closes without provable per-trade geometry (l.315-333) |
| G2 | SCOUT_TIER (shadow pair/side, EARLY_TRANSITION only) | min 3 (l.4), max 20 (l.5), age 7d (l.6), PF 1.5 (l.7), avgR 0.1 (l.8), posFrac 0.4 (l.9) | 6 reasons, fail-closed; degradation = **all** last-3 ≤ 0 (l.94) |
| G3 | SCOUT_TIER (meaningful rung) | min 6 (l.5), max 20 (l.6), age 7d (l.7), PF 1.5 (l.8), avgR 0.1 (l.9), posFrac 0.4 (l.10) | 6 reasons, fail-closed; degradation = recent-3 **sum** ≤ 0 (l.104) |
| G4 | SCOUT_TIER (provisional rung; lot cap 0.05) | min 3 (l.5), **mature floor 6** (l.6), age 7d (l.7), **PF 2.0** (l.8), avgR 0.2 (l.9), posFrac 0.5 (l.10), cap 0.05 (l.11) | 7 reasons, fail-closed; **refuses BECAUSE evidence matured** — `MATURE_EVIDENCE_AVAILABLE` (l.97-99); no max-sample cap on its window (l.85-95) |
| G5 | PAPER_TIER (route-wide + pair/side) | trend episodes 20 (l.4), PF 1.0 (l.5), maxDD 0.12 (l.6); reversal episodes 8 (l.8); pair-side episodes 8 (l.12); realised continuation 20 (l.369) | 4-5 states per evaluator; trend COLLECTING keeps fullSizeEligible=true, reversal demotion maps to RESEARCH_ONLY + fallback flag |
| G6 | PAPER_TIER (scout payoff state machine) | min trades 6 (l.2), reduce PF 1.0 (l.3), shadow PF 0.75 (l.4), cap 0.05 (l.5) | 4 states; the only gradual-authority ladder: PAPER → PAPER-capped-0.05 → SHADOW_ONLY |
| G7 | COMPOSITION_VETO | none — consumes G1/G3/G4 **reason codes** | binary blockers `M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK` (l.39) and `M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED` (l.41); veto covers 2 of G1's ten reasons and 4 of G3/G4's |
| G8 | ADVISORY_ONLY | inline `recent.samples >= 3` (l.138); losing ≥ 60% of samples (l.145); multiplier floor 0.2 (l.155) | continuous riskFraction ∈ [0.2, 1]; **can never veto or enlarge** (header l.1-6) |
| G9 | SHADOW_NONE (requalification) | episodes 8 (l.3), PF 1.15 (l.4), Sharpe 1.0 (l.5), maxDD 0.12 (l.6) | hard-coded `executionAuthority: 'NONE'`, `modifiesExecution: false` (l.59-62, l.118-121) |

Enrichment versus component map §3: G5's pair-side episode floor (8, l.12),
its realised-continuation variant (20, l.369) and the six-evaluator/two-gate
file structure are now pinned; G7's veto vocabulary is stated as *reason
codes consumed* (the composition gap RL-1 closes); G8's four inline literals
are anchored; G4's missing window cap is recorded.

## 3. The frozen disagreement corpus (the P1-3 acceptance artifact)

Twelve synthetic sleeve-evidence snapshots, committed in
`v2-reliability-gate-contract.cjs` as frozen fixtures (`RL-D01`..`RL-D12`).
Each record feeds only the gates whose evidence surface it carries; verdicts
are **computed** by faithful predicate mirrors and reconciled against
committed expectations on every run. Ten disagreement records + two
controls.

| Record | Scenario (divergence class) | Verdicts |
| --- | --- | --- |
| RL-D01 | scout sample-floor divergence: 4 strong outcomes — G2 (min 3) admits, G3 (min 6) refuses, G4 admits | G2 ✓ / G3 ✗ / G4 ✓ |
| RL-D02 | PF-rung divergence: PF exactly 1.5 clears G2, fails G4's 2.0; G3 never reaches the floors | G2 ✓ / G3 ✗ / G4 ✗ |
| RL-D03 | the mature handoff seam: 6 strong outcomes — G2+G3 admit, G4 refuses *because mature* | G2 ✓ / G3 ✓ / G4 ✗ |
| RL-D04 | authority divergence at route maturity (PF 0.97): G5 demotes to RESEARCH_ONLY, G6 keeps PAPER with a 0.05 cap, G9 records WEAK | G5 ✗ / G6 ✓ / G9 ✗ |
| RL-D05 | degradation-predicate divergence: last-3 sums to −0.4 but contains a winner — G2 (all ≤ 0) passes, G3 (sum ≤ 0) degrades, G4 hands off | G2 ✓ / G3 ✗ / G4 ✗ |
| RL-D06 | **CONTROL** — 2 outcomes: every scout gate refuses uniformly | G2 ✗ / G3 ✗ / G4 ✗ |
| RL-D07 | composition gap: G1 refuses (NEGATIVE_EXPECTANCY at a 60% win rate) while G7 reports executable — only 2 of G1's ten reasons veto | G1 ✗ / G7 ✓ |
| RL-D08 | provability asymmetry: same six economics — G1 fail-closes on one missing `riskAtStop`, G2 admits the identical netR surface | G1 ✗ / G2 ✓ |
| RL-D09 | the soft state only G1 has: one fresh giveback loss → eligible-but-flagged `PROFIT_GIVEBACK_CAUTION`; G7 passes the reason through without a blocker | G1 ✓ / G7 ✓ (reason divergence) |
| RL-D10 | intra-gate cooldown divergence: the same 3-loss streak is `EARLY_LOSS_STREAK` at +30 min and `EARLY_LOSS_STREAK_RECOVERY_CANARY` at +200 min | G1 ✗ / G1 ✗ (temporal) |
| RL-D11 | temporal composition: the same sleeve blocks twice before the canary window and executes after it | G7 ✗ / G7 ✓ (temporal) |
| RL-D12 | **CONTROL** (authority gradient): all approve — G6 HEALTHY (PAPER), G8 cuts risk to exactly 0.595 without vetoing, G9 records RECOVERY_SIGNAL (NONE) | G6 ✓ / G8 ✓ / G9 ✓ |

Statistics (validated, not asserted by hand): **10 disagreement records + 2
controls; confirmation counts G1=1, G2=5, G3=1, G4=1, G5=0, G6=2, G7=3,
G8=1, G9=1; 12 distinct verdict+reason patterns.** Every computed rejection
carries the source gate's own reason code. The corpus demonstrates the three
divergence modes the engine institutionalized: floor divergence (D01-D03),
authority divergence for the same number (D04, D12), and predicate
divergence inside one concept (D05, D07, D08, D09, D10, D11).

Corpus design decisions, recorded for reproducibility: (a) the G8 mirror
consumes the broker-completed M5/H1 momentum *verdict* as frozen evidence —
the bar-path computation (`brokerCompletedMomentum`, l.23-53) is market-data
scope, not reliability scope; (b) G1's policy lineage is frozen to the three
versions the source declares (l.17-21) and its smoothed expectancy to the
policy targetR 1.6; (c) all inputs are synthetic; no private data, no
production tables (audit C11 discipline).

## 4. RL-1 — the single V2 reliability contract

### 4.1 One question, five surfaces, one ladder

RL-1 answers exactly one question per **surface** (`EXECUTED`,
`SCOUT_SHADOW`, `PAPER_SLEEVE`, `ADVISORY`, `COMPOSITION`) over one
evaluation record: assembled evidence in, verdict out. The sample ladder is
one table, not five floors: **COLD < 3 → SCOUT 3-5 → MEANINGFUL ≥ 6 →
window cap 20**, with G4's mature handoff promoted from a per-gate accident
to the ladder rule (`HANDOFF_MATURE` — scouts stop answering at n ≥ 6).

### 4.2 Pre-registered constant slots (proposals, frozen at P5-4)

| Slot | Value | Provenance (strictest observed V1 value) |
| --- | --- | --- |
| `scoutFloors` | PF 2.0 / avgR 0.2 / posFrac 0.5 / lotCap 0.05 | G4's constellation — the strictest scout rung; G2/G3's PF 1.5 / avgR 0.1 / posFrac 0.4 retire |
| `meaningfulFloors` | PF 1.5 / avgR 0.1 / posFrac 0.4 | G2/G3 shared (the scout-tier witness, folded into one rung) |
| `executedFloor` | averageRealizedR > 0 **with provable geometry** | G1's fail-closed `PAYOFF_EVIDENCE_INCOMPLETE` kept verbatim — the provability requirement is a feature (RL-D08), not noise |
| `routeFloors` | PF 1.0 / maxDD 0.12; episodes 20/8/8 | G5/G6 shared pair; G9's PF 1.15 recorded as the **requalification stratifier**, not a separate ladder |
| `streakRules` | loss streak 3 (2 early-transition), canary 180 min, recent window 3, degradation = **sum ≤ 0** | G1's brake + cooldown; the G3/G4 sum rule is proposed as the single degradation predicate (G2's all-≤ 0 retires — the corpus shows it is the weaker witness) |
| `ageWindowDays` / `windowCap` | 7 / 20 | G1-G4 shared; route-level evidence stays unbounded as today |
| `smoothingPrior` | wins 1 / losses 1 | G1's Laplace prior, now explicit |
| `recentPayoffWindow/Floor` | 5 / −0.1 | G1's decay window |
| `advisoryFloor` | 0.2 | G8's clamp |

No slot is looser than the Champion's tightest gate for the same concept.

### 4.3 One verdict vocabulary and one authority gradient

Verdicts: `ELIGIBLE | ELIGIBLE_FLAGGED | COLD_START | DEGRADED | REFUSED |
HANDOFF_MATURE | RISK_REDUCED`. The authority gradient is explicit and
ordered — **NONE (G9) → SHADOW_ONLY (G6) → REDUCED_LOT_0_05 (G6/G4) →
PROVISIONAL_LOT_0_05 (scout tier) → ADVISORY_MULTIPLIER (G8) → PAPER_FULL →
FULL (G1)** — with `advisory` defined as *reduces requested risk, never
vetoes or enlarges*. Every RL-1 output carries `executionAuthority: NONE`;
`proposedAuthority` is a recommendation tier, never an order grant.

### 4.4 Extraction seams (the phase-2 §13 requirement)

- **SEAM-1 context assembly** — one assembly point per surface: the
  scheduler helper cluster (l.4785-4843) for G1-G4, the runOnce call sites
  (l.1699 G7, l.4020 G8) and the collector (l.2472, l.3137, l.4832-4892)
  for the rest. Gates never read tables themselves; the assembled record is
  what RL-1 consumes. The seam anchors are CI-verified
  (`verifyOrchestrationSeams`) so the cut lines cannot drift silently.
- **SEAM-2 pure evaluation** — the nine predicates collapse to the RL-1
  ladder as a pure function over the assembled record; this contract's
  mirrors are the reference implementation.
- **SEAM-3 verdict application** — admission composition consumes RL-1
  verdicts and reason codes; G7's string-matching of 2 of G1's ten reasons
  plus 4 of G3/G4's generalizes to the whole verdict vocabulary, closing the
  RL-D07 composition gap by construction.

### 4.5 Migration map (proposal only — no runtime edit)

| V1 gate | V2 disposition |
| --- | --- |
| G1 | becomes the EXECUTED surface of RL-1; the asymmetric cold start is preserved as `COLD_START` (recorded, still eligible) — it is the engine's exploration budget, not a bug; geometry provability stays fail-closed |
| G2 | folded into the SCOUT tier as the shadow-pair witness; its all-≤ 0 degradation predicate retires to the sum rule |
| G3 | becomes the MEANINGFUL rung of the ladder (floors unchanged) |
| G4 | its strict floors become `scoutFloors`; its mature refusal becomes the ladder-wide `HANDOFF_MATURE`; the 0.05 lot cap survives as `PROVISIONAL_LOT_0_05` |
| G5 | route floors keep the 20/8/8 episode split as recorded stratifiers; the six evaluators collapse behind the PAPER_SLEEVE surface |
| G6 | its three-state authority machine becomes the PAPER_SLEEVE portion of the gradient (SHADOW_ONLY / REDUCED / FULL) |
| G7 | becomes SEAM-3: composition consumes verdicts, not reason substrings; the canary branch (`RECOVERY_CANARY` non-veto) is preserved |
| G8 | stays an advisory multiplier behind the ADVISORY surface; `vetoCapable: false` is contractual |
| G9 | stays strictly NONE; its PF 1.15 / Sharpe / maxDD become the requalification stratifier reported alongside the route verdict |

## 5. Acceptance criteria (backlog P1-3)

- [x] Reliability-layer inventory with predicates, floors, constants, line
  references and invocation sites, code-verified (§2, mirrored in
  `v2-reliability-gate-contract.cjs`).
- [x] One-service spec with **shared floors and explicit sample-count
  ladders**: one sample ladder (§4.1), one floor set per tier (§4.2), one
  verdict vocabulary and authority gradient (§4.3).
- [x] **Extraction seams defined**, not only floors: SEAM-1/2/3 with
  CI-verified scheduler/collector anchors (§4.4) — the phase-2 §13
  requirement.
- [x] Frozen disagreement corpus committed as synthetic fixtures: twelve
  borderline records, verdicts computed by faithful predicate mirrors and
  reconciled against committed expectations on every run (§3); 10
  disagreement + 2 controls, 12 distinct patterns (validated).
- [x] Typed refusals (`RELIABILITY_INPUT_REQUIRED`,
  `RELIABILITY_UNSUPPORTED_SURFACE`, `RELIABILITY_INPUT_OUT_OF_RANGE`) and
  drift detection: CI re-proves the nine source paths **and their pinned
  constants**, the seam anchors, the verdict matrix, and all corpus
  statistics; tampering with inputs, expectations, records, gates or
  statistics is a typed refusal (21-test suite).
- [x] No runtime edit: nothing in this change imports or modifies any
  production module; all nine sources are untouched.

## 6. Boundaries

Research-only: no runtime import, no production data, no DB or broker
access, no deployment; deployment hold intact; V1 Champion untouched.
Every artifact carries `executionAuthority: NONE`. The corpus is synthetic
and in-repo — no private datasets (audit C11 discipline). Coordination: M1
chain conclusions (#834/#836/#837/#838) inherited by reference; DS-1 (P1-1)
and RD-1 (P1-2) are consumed as sibling contracts — RL-1 consumes no
confidence value, and RD-1's conviction gate stays a separate layer; the
calibration container and scoreboard belong to P1-4 and are referenced, not
duplicated.
