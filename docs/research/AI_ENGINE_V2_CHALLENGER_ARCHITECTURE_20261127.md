# iRexPro AI Engine V2 — Challenger architecture and evaluation design

Status: research-only design. The V1 engine is the preserved Champion
baseline and continues to run unchanged; V2 is a research-only Challenger.
This document defines what V2 is, how Champion and Challenger are compared,
and the architecture that satisfies the six DEMO-isolation requirements of
the amended directive. Offline/historical replay are preliminary stages
only; the final measures are broker-confirmed DEMO outcomes on isolated
Pepperstone cTrader DEMO accounts.

Companion artifacts in this branch:
`AI_ENGINE_V2_AUDIT_FINDINGS_20261127.md` (findings),
`AI_ENGINE_V2_EXECUTION_BACKLOG_20261127.md` (backlog), and three executable
research contracts: `apps/api/scripts/research/v2-challenger-attribution.cjs`,
`v2-statistical-evaluation.cjs`, `v2-entry-exit-decomposition.cjs`
(synthetic-fixture tests pin their semantics; none grants order authority).

---

## 1. Champion and Challenger definitions

### 1.1 Champion (V1, preserved)

The Champion is the entire existing pipeline as at `main` @ `9ec10e40`:
M1 tactical scheduler → strategy orchestrator → risk → execution, with its
current heuristic candidate stack (L0–L8 per the audit map), current exits
and current brakes, on its current Pepperstone cTrader DEMO account, under
current policy (`M1_TACTICAL_ROLLOUT_POLICY_V8_FOCUSED_FOUR_FEE_SHADOW`,
4-pair allowlist, volume ceiling 4.0). Nothing about V1 changes for the
comparison. No Champion code is edited, redeployed, or re-tuned during V2
research.

### 1.2 Challenger (V2, research-only)

The Challenger is a *reduced, consolidated, calibrated* engine with the
following architecture decisions, each traceable to an audit finding:

| # | V2 decision | Audit driver |
| --- | --- | --- |
| V2-1 | **One direction scorer** (single feature contract, one output: calibrated win probability per direction per bar) | A1, B6 |
| V2-2 | **One reversal definition** (single predicate used by admission and by all shadows) | A2 |
| V2-3 | **One reliability layer** (single samples/PF/netR evidence service with shared floors) | A3 |
| V2-4 | **One calibration service** (one Bayesian/reliability surface, proper scoring rule, persisted pre-outcome) | A4, B4, E3 |
| V2-5 | **Cost-gated admission**: predicted cost participates in admission for V2 (not shadow) with recorded predicted-vs-realized ledger | E2, G2 |
| V2-6 | **One exit specification** (parameterized retention/force-close policy with one implementation; identical constants across environments) | A7 |
| V2-7 | **One prediction scoreboard**: every live V2 prediction registered before outcome, scored after settlement (Brier, reliability) | E3, B6 |
| V2-8 | **Pre-registered evaluation**: primary specification, family count, and stopping rule fixed before any comparative DEMO minute; multiplicity counted | D2 |
| V2-9 | **Entry and exit assessed separately**: attribution decomposes realized R into entry contribution, exit contribution, and cost drag | E1, G1, directive |
| V2-10 | **Stays fail-closed**: V2 reuses the unchanged risk pipeline, execution-control plane, authority generations, reconciliation, and brake semantics (F3: identical brake semantics on both engines) | directive boundary |

V2 is *not* a claim of a better model; it is a controlled experiment to
determine whether a more robust, statistically defensible, economically
sustainable architecture is buildable on this platform. Its first
falsifiable claim under test is the audit's null statements (G3): current
entry discrimination indistinguishable from zero; exit management dominant.

## 2. Six DEMO-isolation requirements — architectural mapping

Each requirement is mapped to existing platform capability (verified in
code on `main`), the V2 research contract that enforces it, and the open
gap. Isolation is at the *broker-connection* level throughout — the
platform's native isolation unit.

| # | Requirement | Platform capability (existing code) | V2 enforcement | Gap to close before broker-connected testing |
| --- | --- | --- | --- | --- |
| R1 | Independent Pepperstone cTrader DEMO account isolation | One `broker_connections` row per account (`broker.broker_connections`, provider identity `pepperstone-ctrader` VERIFIED `HARNESS_CERTIFIED`); per-connection credential envelope; execution-control plane scoping `GLOBAL → PROVIDER → USER → BROKER_CONNECTION` | Separate connection per engine; a V2 row must never reference the Champion connection id; `assertAccountIsolation()` in the attribution contract refuses any shared connection id | Two DEMO accounts must be provisioned by the owner (out of research reach) |
| R2 | Separate engine identities | Identity tuple `(engine_code, model_version, strategy_code, generation)` — the pattern already used by `trading.ensemble_shadow_decisions.engine_code`; promoted-DEMO tuple allowlist in `strategy-orchestrator.service.ts` | `defineEngineIdentity()` contract: non-empty tuple, monotonic generation, authority restricted to `RESEARCH_SHADOW`/`NONE` until review passes; identity stamped on every attribution row | Registry of the V2 identity must be pre-declared (no mid-campaign renaming) |
| R3 | Independent position ownership | Positions are per broker account at the provider; `trading.orders`/`trades` rows are per `broker_connection_id`; `trade_intents.intent_key` unique per user | Attribution rows carry `tradeId` unique per engine; duplicate tradeId across engines = typed contamination error | None beyond R1 provisioning |
| R4 | Equivalent starting conditions | `broker_account_snapshots` records opening equity; risk-profile defaults apply per user/connection | `assertEquivalentStartingConditions()`: same starting balance, same leverage, same instrument allowlist, same cost basis (broker commission schedule), same session window and timezone, started within the declared alignment window | Balance equivalence requires owner provisioning; alignment window declared in the campaign pre-registration |
| R5 | Immutable performance attribution | Append-only evidence tables pattern (`m1_tactical_decisions` first-write-wins is the known defect class D1 — V2 avoids it by construction) | Attribution ledger: append-only, deep-frozen rows, duplicate tradeId refused, no mutation API, per-engine generation binding; broker-confirmed settlement fields (`realisedPnl`, `commission`, `swap`) copied from reconciliation, never re-derived | Final authority is broker statements; ledger records provenance of every field |
| R6 | Comparative dashboard | Existing dashboard reads per-connection trading data | Dashboard is a *read-only projection* of the attribution ledger; both engines' rows derive from the same code path so the comparison cannot diverge from the ledger | Dashboard build is a backlog phase, not part of this research branch |

## 3. Three-stage verification hierarchy

```
Stage S (synthetic)     : contracts + fixtures, deterministic, CI-run
                          (this branch: attribution, statistics, decomposition)
Stage H (historical)    : authorized anonymized per-trade exports only,
                          chronological separation, no future-data leakage,
                          realistic transaction costs, entry/exit separated
                          → PRELIMINARY. Gate: provenance + chronology verified,
                          leakage checklist passed, detection limits stated.
Stage D (DEMO connected) : isolated broker-connected DEMO accounts (R1–R6),
                          Champion vs Challenger simultaneously provisioned,
                          pre-registered primary specification,
                          broker-confirmed after-cost outcomes
                          → FINAL MEASURE. Gate: independent review sign-off
                          BEFORE first broker-connected minute.
```

Stage H is blocked on the separately authorized anonymized per-trade export
(the 192-trade dataset and successors) which is not present in the repo
(audit C11); Stage D is blocked on independent review plus owner account
provisioning. Nothing in this branch accesses either gate.

## 4. Statistical evaluation framework (implemented in
`v2-statistical-evaluation.cjs`, synthetic fixtures only)

Primary endpoint: **after-cumulative-cost net expectancy per trade, in R
units, with a two-sided uncertainty interval** — never a bare win rate.
The framework computes, per engine and paired across engines:

1. **After-cost performance**: net return, win rate with Wilson 95% CI,
   profit factor with CI, mean and median R, payoff ratio
   (average win R / average loss R), trade count, total lots.
2. **Risk-normalized expectancy**: mean net R per trade divided by its
   standard deviation (per-trade Sharpe analogue) and max drawdown of the
   cumulative net-R curve in R units.
3. **Calibration**: Brier score, binned reliability (ECE), and calibration
   slope/intercept of the engine's registered pre-outcome probabilities vs
   settled outcomes.
4. **Stability**: split-half agreement of expectancy sign and magnitude
   (block halves by time), and per-session consistency flags.
5. **Sample sufficiency and uncertainty**: Hanley–McNeil SE for AUC-scale
   detection; minimum detectable effect at 80% power; explicit statement
   when a comparison is underpowered (typed `INSUFFICIENT_SAMPLE` refusal —
   the same discipline as PR #836 §3.3, extended to paired engine deltas).
6. **Correlation hygiene**: instruments and overlapping minutes are treated
   as clusters; the framework refuses naive iid comparisons on clustered
   inputs (typed `CLUSTERED_INPUT`) and requires the campaign
   pre-registration to declare the cluster unit (session × instrument).
7. **Entry vs exit separation** (also `v2-entry-exit-decomposition.cjs`):
   realized R decomposed into design payoff, exit-management delta
   (win truncation R / loss extension R) and cost drag R; cohort-level
   classification of the dominant deficit; entry quality measured on
   fixed-exit counterfactuals, exit quality on fixed-entry counterfactuals.

Win rate alone is explicitly insufficient and never a decision criterion.

## 5. Research boundaries honored

- No production credentials or database access; no broker orders; no LIVE
  activation; no deployment; no production service modification; V1 code
  untouched (this branch adds docs and offline scripts only).
- No private datasets in the public repo: fixtures in the tests are
  synthetic and deterministic; the owner-generated coefficients issue (B3)
  is flagged for the review gate rather than reproduced.
- No guaranteed-profit or production-readiness claim is possible from
  retrospective performance — every artifact here carries
  `executionAuthority: NONE` semantics and synthetic-only evidence.
- Deployment hold and existing PRs #834/#836/#837/#838 remain coordinated:
  this branch depends on main only, references the M1 chain's conclusions,
  and duplicates none of its artifacts.

## 6. Review readiness checklist (for Stage D authorization)

1. Attribution contract tests green in CI (this branch).
2. Statistical framework reference values cross-verified (this branch).
3. Historical-replay protocol pre-registered (backlog phase H, blocked on
   authorized exports).
4. Independent reviewer sign-off recorded for: identity registry,
   equivalence plan, brake-semantics equality (F3), cost-basis equality,
   stopping rule, detection-limit statement.
5. Owner provisions two isolated DEMO accounts; connection ids registered.
6. Only then: broker-connected DEMO minutes, Champion and Challenger under
   identical conditions, dashboard projection live.
