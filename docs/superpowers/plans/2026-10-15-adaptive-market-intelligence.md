# Adaptive Market Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make iRexPro's six-pair PAPER engine actively classify market state, rank all executable opportunities across the scan, account for shared-currency concentration, learn pair/direction/session/state edge from resolved PAPER outcomes, and pass a bounded adaptive risk multiplier into the existing authoritative position-sizing engine.

**Architecture:** Add five small deterministic/adaptive units around the existing Plan-B + ensemble-governance pipeline, plus one cached evidence service over the existing durable ledgers. The collector evaluates all pair winners first, persists adaptive evidence, ranks scan-level executable winners, then dispatches them in adaptive-score order while preserving every existing hard gate. `PositionSizingService` remains final lot authority.

**Tech Stack:** NestJS, TypeScript, TypeORM/DataSource, PostgreSQL JSONB ledgers, Jest, ExactDecimal, existing PM2/GitHub Actions deployment pipeline.

**Spec:** `docs/superpowers/specs/2026-10-15-adaptive-market-intelligence-design.md`

## Global Constraints

- Active authority is PAPER-only; no DEMO/LIVE execution authority is added.
- Existing hard risk, event-risk, cost/spread, post-loss, margin, broker, episode and promotion gates remain authoritative.
- PAPER research lot ceiling remains 1.0 lot.
- Research routes cannot receive an adaptive multiplier above `1.00x`.
- Normal PAPER multiplier bands are exactly `0.50x`, `0.75x`, `1.00x`, `1.10x`, `1.25x`.
- Upsize above `1.00x` requires mature positive evidence, PF >= 1.15, max drawdown <= 12%, no degradation, positive current net expected R, valid cost evidence, non-rollover/non-dislocated state and clear portfolio capacity.
- No future candle, revised future state, later trade result, or post-decision macro outcome may enter a pre-trade feature.
- Existing qualification gates remain unchanged, including >=100 qualifying closed trades.
- No fixed trade cadence is introduced; every closed M5 scan must persist the best opportunity and abstention reason.

## Review Focus

- **Timestamp leakage:** evidence rows at or after `evaluatedAt` must never affect the current decision; Task 3 pins this with a cutoff test.
- **Sparse-history optimism:** an unseen or low-sample cell must stay neutral/downside-only and never produce `>1.00x`; Tasks 3 and 5 pin this.
- **Partial portfolio evidence:** missing risk-at-stop on an existing position must prevent upsize rather than being treated as zero exposure; Task 2 pins this.
- **Retry/idempotency:** reprocessing the same M5 opportunity must not duplicate evidence or TradeIntents; Task 6 pins this.
- **Adaptive-store outage:** evidence query/persistence failure must fail closed to no upsize and must not invent an edge; Tasks 3 and 6 pin this.

---

### Task 1: Canonical Adaptive Market State

**Files:**
- Create: `apps/api/src/modules/ai/adaptive-market-state.ts`
- Create: `apps/api/src/modules/ai/adaptive-market-state.spec.ts`

**Interfaces:**
- Consumes: current candidate features, Plan-B legacy regime/route, governance drift/cost state, scan timestamp.
- Produces: `classifyAdaptiveMarketState(input: AdaptiveMarketStateInput): AdaptiveMarketStateDecision`.

- [ ] **Step 1: Write failing unit tests**

Cover `TREND_HEALTHY`, `TREND_EXTENDED`, `TREND_WEAK`, `TRANSITION`, `REVERSAL`, `HIGH_VOLATILITY`, `DISLOCATED`, `ROLLOVER_RISK`, `UNKNOWN`; stale/incomplete input cannot up-authorize; state confidence is separate from trading confidence.

- [ ] **Step 2: Run the new spec and verify RED**

Run: `pnpm --filter @irexpro/api exec jest --runInBand apps/api/src/modules/ai/adaptive-market-state.spec.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the classifier**

Define:

```ts
export type AdaptiveMarketState =
  | 'TREND_HEALTHY' | 'TREND_EXTENDED' | 'TREND_WEAK' | 'RANGE'
  | 'TRANSITION' | 'REVERSAL' | 'HIGH_VOLATILITY' | 'DISLOCATED'
  | 'ROLLOVER_RISK' | 'UNKNOWN';

export function classifyAdaptiveMarketState(
  input: AdaptiveMarketStateInput,
): AdaptiveMarketStateDecision;
```

Reuse existing Plan-B route semantics and drift diagnostics; do not invent a second future-looking regime model.

- [ ] **Step 4: Run the spec and verify GREEN**

- [ ] **Step 5: Commit**

`git commit -m "feat(ai): classify adaptive forex market state"`

### Task 2: Shared-Currency Portfolio Exposure

**Files:**
- Create: `apps/api/src/modules/ai/adaptive-currency-exposure.ts`
- Create: `apps/api/src/modules/ai/adaptive-currency-exposure.spec.ts`

**Interfaces:**
- Consumes: candidate instrument/direction/risk-at-stop and open-position currency-risk snapshots.
- Produces: `analyzeAdaptiveCurrencyExposure(input: AdaptiveCurrencyExposureInput): AdaptiveCurrencyExposureDecision`.

- [ ] **Step 1: Write failing tests**

Pin all six pair BUY/SELL sign mappings; EURUSD BUY + GBPUSD BUY increases USD-short concentration; USDCHF SELL also increases USD-short; economically opposing risk offsets only proven risk; ticket splitting is invariant; missing risk-at-stop marks evidence incomplete and cannot return `CLEAR` for upsize.

- [ ] **Step 2: Run and verify RED**

- [ ] **Step 3: Implement the pure exposure analyzer**

Return currency risk map, candidate increments, largest aligned concentration, same-instrument exposure, diversification quality and capacity `CLEAR | REDUCED | BLOCKED`.

- [ ] **Step 4: Run and verify GREEN**

- [ ] **Step 5: Commit**

`git commit -m "feat(ai): add currency-risk portfolio intelligence"`

### Task 3: Pair × Direction × Session × State Edge Evidence

**Files:**
- Create: `apps/api/src/modules/ai/adaptive-edge-matrix.service.ts`
- Create: `apps/api/src/modules/ai/adaptive-edge-matrix.service.spec.ts`
- Modify: `apps/api/src/modules/ai/ai.module.ts`

**Interfaces:**
- Consumes: durable `trade_intents` metadata + authoritative `trades`, bounded by `evaluatedAt`, PAPER execution only, exact policy version.
- Produces:

```ts
getEvidence(input: AdaptiveEdgeEvidenceRequest): Promise<AdaptiveEdgeEvidence>;
```

with maturity `SPARSE | COLLECTING | MATURE | DEGRADED`, hierarchical fallback and metrics from the spec.

- [ ] **Step 1: Write failing service tests**

Mock `DataSource.query` and prove: query excludes rows `>= evaluatedAt`; policy versions are isolated; research/qualification-excluded cohorts are not silently merged; sparse exact cell shrinks toward broader pair/route evidence; 20+ resolved outcomes with wins/losses can mature; degraded recent evidence is flagged; DB failure returns an explicit unavailable result rather than positive evidence.

- [ ] **Step 2: Run and verify RED**

- [ ] **Step 3: Implement the service**

Use existing ledgers only—no destructive migration. Cache bounded evidence briefly with a key containing user, connection, instrument, direction, session, state, route and policy version. The cache cannot increase authority when unavailable/stale.

- [ ] **Step 4: Register the service in `AiModule`**

- [ ] **Step 5: Run and verify GREEN**

- [ ] **Step 6: Commit**

`git commit -m "feat(ai): build adaptive edge evidence matrix"`

### Task 4: Adaptive Opportunity Score

**Files:**
- Create: `apps/api/src/modules/ai/adaptive-opportunity-score.ts`
- Create: `apps/api/src/modules/ai/adaptive-opportunity-score.spec.ts`

**Interfaces:**
- Consumes: authoritative governance net-R/cost, Plan-B quality components, adaptive state, edge evidence and currency exposure.
- Produces: `scoreAdaptiveOpportunity(input: AdaptiveOpportunityInput): AdaptiveOpportunityDecision`.

- [ ] **Step 1: Write failing tests for the exact weights**

Assert 25/15/12/10/8/10/8/7/5 weights sum to 1; higher net-R cannot reduce score with other inputs equal; worse cost cannot improve score; degraded edge and concentration lower score; unavailable evidence is neutral/downside-only; hard blocker list is carried through and never cleared.

- [ ] **Step 2: Run and verify RED**

- [ ] **Step 3: Implement the scorer**

Persist component scores and reason codes; use only existing authoritative `netExpectedR` and cost values.

- [ ] **Step 4: Run and verify GREEN**

- [ ] **Step 5: Commit**

`git commit -m "feat(ai): rank adaptive forex opportunities"`

### Task 5: Bounded Adaptive Risk Multiplier

**Files:**
- Create: `apps/api/src/modules/ai/adaptive-risk-multiplier.ts`
- Create: `apps/api/src/modules/ai/adaptive-risk-multiplier.spec.ts`
- Modify: `apps/api/src/modules/execution/services/position-sizing.service.ts`
- Modify: `apps/api/src/modules/execution/services/position-sizing.service.spec.ts`
- Modify: `apps/api/src/modules/execution/services/position-sizing.paper-allocation.spec.ts`

**Interfaces:**
- Produces: `selectAdaptiveRiskMultiplier(input: AdaptiveRiskMultiplierInput): AdaptiveRiskMultiplierDecision`.
- `PositionSizingService.sizePosition()` accepts optional `paperAllocationSizing.adaptiveRiskMultiplier` and persists base vs adjusted risk values.

- [ ] **Step 1: Write RED multiplier tests**

Prove research never exceeds `1.00x`; sparse/OOD/rollover/invalid-cost/degraded evidence never upsizes; mature PF >=1.15 and DD <=0.12 with clear capacity can produce `1.10x`/`1.25x`; weaker permitted evidence returns `0.50x`/`0.75x`.

- [ ] **Step 2: Write RED sizing tests**

Prove `0.50x` halves the risk budget, `1.25x` scales risk before broker/lot ceilings, requested/profile/broker/margin limits still constrain final lots, and existing callers with no multiplier remain byte-for-byte equivalent in sizing semantics.

- [ ] **Step 3: Implement multiplier and ExactDecimal sizing integration**

Persist `baseRiskPercent`, `adaptiveRiskMultiplier`, `adaptiveRiskPercent`, `baseRiskAmount`, and final `riskAmount` in `PositionSizingInputs`.

- [ ] **Step 4: Run targeted sizing + multiplier specs and verify GREEN**

- [ ] **Step 5: Commit**

`git commit -m "feat(ai): apply bounded adaptive PAPER risk"`

### Task 6: Active Scan-Level Adaptive Execution

**Files:**
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`
- Modify: `apps/api/src/modules/ai/ai.module.ts` only if constructor wiring requires it.

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: active PAPER candidate ranking, adaptive metadata on decision + TradeIntent, classified `marketRegime`, scan-level best-opportunity/abstention diagnostics.

- [ ] **Step 1: Add failing collector tests**

Cover: every candidate receives adaptive state/evidence/score; emitted signal no longer hard-codes `TRENDING`; current BUY/SELL ambiguity logic remains; pair winners are accumulated for the scan then ordered by adaptive score; multiple independent pairs may execute; later candidates see updated/recomputed portfolio capacity; evidence failure prevents upsize but does not invent a blocker bypass; retries remain idempotent; research route multiplier <=1.00x and lot <=1.0; hard governance blockers still prevent execution.

- [ ] **Step 2: Run collector spec and verify RED**

- [ ] **Step 3: Refactor evaluation from dispatch**

Keep per-pair BUY/SELL counterfactual evaluation intact, but return a scan-level evaluated winner object instead of immediately dispatching inside the pair loop. Preserve existing route priority and ambiguity rules.

- [ ] **Step 4: Compute and persist adaptive metadata before dispatch**

Persist `adaptiveMarketIntelligence` inside `ensemble_shadow_decisions.components` and copy the same versioned object into TradeIntent metadata for executed signals.

- [ ] **Step 5: Make adaptive score the active scan ordering authority**

Sort only candidates that already passed existing route/governance eligibility. Do not turn blocked candidates into executable ones.

- [ ] **Step 6: Apply adaptive multiplier to the PAPER sizing seam**

Pass the multiplier through signal metadata/route sizing into `PositionSizingService` without changing DEMO/LIVE callers.

- [ ] **Step 7: Persist a scan summary even when no trade executes**

Log/persist best candidate, best post-cost net-R, adaptive score, state, and exact abstention blockers so a five-hour no-trade window is explainable without reading raw logs.

- [ ] **Step 8: Run collector tests and verify GREEN**

- [ ] **Step 9: Commit**

`git commit -m "feat(ai): activate adaptive PAPER execution intelligence"`

### Task 7: Performance/Diagnostics Exposure

**Files:**
- Modify: `apps/api/src/modules/ai/external-signal-performance.service.ts`
- Modify: `apps/api/src/modules/ai/external-signal-performance.service.spec.ts`
- Modify: existing VPS forex status DTO/controller only where necessary for additive fields.

**Interfaces:**
- Consumes: persisted adaptive metadata and resolved outcomes.
- Produces: operational distributions and adaptive-vs-prior comparison; no new execution authority.

- [ ] **Step 1: Write failing diagnostics tests**

Assert score/multiplier/state distributions, adaptive-rank vs prior-rank counts, realised outcomes by multiplier/state where available, and explicit adaptive evidence availability. Existing qualification checks remain unchanged.

- [ ] **Step 2: Implement additive diagnostics**

Do not alter existing qualification calculations or promotion eligibility.

- [ ] **Step 3: Run and verify GREEN**

- [ ] **Step 4: Commit**

`git commit -m "feat(ai): expose adaptive market intelligence diagnostics"`

### Task 8: Full Verification, Review, Merge, Deployment

**Files:**
- No product-code additions unless verification finds a defect.

- [ ] **Step 1: Run targeted suites**

Include adaptive modules, collector, Plan-B ensemble, ensemble governance, paper research throughput, calibrated-cost rescue, route/pair-side reliability, PositionSizingService, RiskService and execution tests.

- [ ] **Step 2: Run TypeScript, lint and Nest build**

Expected: zero TypeScript/build errors; lint zero errors (existing warnings tolerated only if unchanged).

- [ ] **Step 3: Run full API regression**

Expected: all non-skipped suites pass.

- [ ] **Step 4: Review the complete branch diff for authority leaks**

Specifically confirm no DEMO/LIVE enablement, no weakened hard gates, no forced cadence and no >1.0 research multiplier/lot authority.

- [ ] **Step 5: Push PR and require normal CI/security/release gates**

Do not bypass Required CI Gate, Release Security, Strategy Promotion Integrity, Risk Execution Concurrency or deployment safety gates that apply to the diff.

- [ ] **Step 6: Merge and deploy exact verified main SHA through the existing protected production-facing deployment path**

If the repository only exposes the current staging deployment workflow, deploy through that exact protected path rather than inventing an unreviewed production mechanism; verify which public environment the workflow serves before describing it as production.

- [ ] **Step 7: Runtime verification**

Verify exact SHA, PM2/API/AI health, current scan activity, adaptive metadata appearing in new decisions, classified regimes replacing hard-coded `TRENDING`, and active PAPER selection/risk multiplier fields.

- [ ] **Step 8: No-trade acceptance check**

From deployment onward, prove each M5 scan is producing decisions and a scan summary. If no trade occurs, report the top post-cost edge and blockers; never count scheduler inactivity as market abstention.
