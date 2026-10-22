# M1 Shadow Outcome Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn eligible M1 SHADOW decisions into prospective, causal, episode-level 15-minute outcome evidence without enabling M1 PAPER/DEMO/LIVE execution.

**Architecture:** Reuse the existing M1 scheduler, decision store, and 60-bar M1 market-data window. First extract the existing 15-bar causal settlement rules into a pure resolver, then derive independent episode leaders from persisted decision chronology, persist versioned shadow outcomes inside `governance.shadowOutcome15mV1`, expose R-multiple metrics, and finally let the scheduler settle only mature SHADOW leaders. Real execution fields and rollout authority remain untouched.

**Tech Stack:** NestJS, TypeScript, TypeORM/PostgreSQL, Jest, existing M1 tactical services.

**Spec:** `docs/superpowers/specs/2026-10-21-m1-shadow-outcome-ledger-design.md`

## Global Constraints

- Keep `M1_TACTICAL_ROLLOUT_POLICY_V1` in `SHADOW` with execution authority `NONE`.
- Do not create signals, trade intents, trades, broker orders, or realised P&L from shadow outcomes.
- Do not change M5 thresholds, M1 thresholds, sizing, risk, event-risk, drift, consensus, or execution gates.
- Count episode leaders, not raw minute decisions; same pair/side/route/policy stays one episode while gaps are `<= 5 minutes`.
- Settlement requires exactly 15 contiguous future completed M1 bars beginning one minute after `evaluated_at`.
- Same-bar stop/target contact is `AMBIGUOUS` with no invented R result.
- Missing causal history is never inferred; after the 60-bar observability boundary it becomes `UNOBSERVABLE_DATA_GAP`.
- Persist shadow evidence only under `governance.shadowOutcome15mV1`; do not reuse real execution outcome/link columns.
- Every persisted artifact must contain `modifiesExecution: false`.

## Review Focus

- A candidate carrying any blocker beyond `M1_PHASE_SHADOW` must never become an episode leader.
- A restart/data gap that removes part of the 15-bar future window must never be scored as TP, SL, or MTM.
- Multiple consecutive minute decisions for the same state must collapse to one leader; a gap `> 5 minutes` must start another episode.
- Repeated scheduler cycles must be idempotent and must not overwrite a finalized `shadowOutcome15mV1`.
- Shadow metrics must exclude `AMBIGUOUS` and `UNOBSERVABLE_DATA_GAP` from P&L-style calculations while retaining them in coverage counts.

---

### Task 1: Extract the generic causal M1 outcome resolver

**Files:**
- Create: `apps/api/src/modules/ai/m1-causal-outcome.ts`
- Create: `apps/api/src/modules/ai/m1-causal-outcome.spec.ts`
- Modify: `apps/api/src/modules/ai/m1-drift-counterfactual.ts`
- Test: `apps/api/src/modules/ai/m1-drift-counterfactual.spec.ts`

**Interfaces:**
- Produces: `evaluateM1CausalOutcome15m(input: M1CausalOutcomeInput): M1CausalOutcomeResult | null`
- `M1CausalOutcomeResult.outcome`: `'TP' | 'SL' | 'MTM' | 'AMBIGUOUS'`
- `M1CausalOutcomeResult` includes entry/terminal bar times, entry/stop/target/terminal prices, execution-cost R, gross R, net R, and source `COMPLETED_M1_OHLC`.
- Existing `evaluateM1DriftCounterfactual15m()` delegates candle resolution to this function and preserves its current public artifact contract unchanged.

- [ ] **Step 1: Write failing pure-resolver tests**

Add tests for BUY TP, SELL TP, BUY/SELL SL, MTM, first-causal-open entry, same-bar TP+SL => `AMBIGUOUS`, missing/non-contiguous 15 bars => `null`, and non-positive/invalid prices => `null`.

- [ ] **Step 2: Run the new resolver test and verify RED**

Run: `pnpm --filter @irexpro/api exec jest --runInBand src/modules/ai/m1-causal-outcome.spec.ts`
Expected: FAIL because `m1-causal-outcome.ts` / `evaluateM1CausalOutcome15m` does not exist.

- [ ] **Step 3: Implement the pure resolver**

Create `m1-causal-outcome.ts` with the exact 15-bar causal rules from the spec. Keep it pure: no database, scheduler, service, logger, or execution dependencies.

- [ ] **Step 4: Refactor drift counterfactual to delegate to the resolver**

Preserve `M1_DRIFT_COUNTERFACTUAL_ARTIFACT`, `modifiesExecution: false`, and the existing `M1DriftCounterfactualResult` output shape.

- [ ] **Step 5: Run resolver + drift tests**

Run: `pnpm --filter @irexpro/api exec jest --runInBand src/modules/ai/m1-causal-outcome.spec.ts src/modules/ai/m1-drift-counterfactual.spec.ts`
Expected: all tests PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/api/src/modules/ai/m1-causal-outcome.ts apps/api/src/modules/ai/m1-causal-outcome.spec.ts apps/api/src/modules/ai/m1-drift-counterfactual.ts apps/api/src/modules/ai/m1-drift-counterfactual.spec.ts
git commit -m "refactor(ai): extract causal M1 outcome resolver"
```

### Task 2: Derive episode leaders and persist versioned shadow outcomes

**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-evidence.service.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-evidence.service.spec.ts`

**Interfaces:**
- Produces: `loadMatureShadowEpisodeLeaders(input: M1ShadowEpisodeLeaderQuery): Promise<M1ShadowEpisodeLeader[]>`
- Produces: `markShadowOutcome15mV1(decisionId: string, outcome: M1ShadowOutcome15mV1): Promise<void>`
- `M1ShadowEpisodeLeader` includes decision id, route, instrument, direction, policy version, evaluated/bar time, stop distance, target distance, estimated execution cost R, and source/authority metadata needed by the stored artifact.
- `M1ShadowOutcome15mV1.outcome`: `'TP' | 'SL' | 'MTM' | 'AMBIGUOUS' | 'UNOBSERVABLE_DATA_GAP'`.

- [ ] **Step 1: Write failing episode-leader query tests**

Pin these behaviors: route is not `ABSTAIN`; authority is `NONE`; blockers are empty or exactly `['M1_PHASE_SHADOW']`; active policy only; existing `shadowOutcome15mV1` excluded; same user/connection/pair/side/route/policy with gaps `<= 5 minutes` collapses to the earliest leader; gap `> 5 minutes` creates a new leader; drift/edge/event blockers are excluded.

- [ ] **Step 2: Run evidence-service tests and verify RED**

Run: `pnpm --filter @irexpro/api exec jest --runInBand src/modules/ai/m1-tactical-evidence.service.spec.ts`
Expected: FAIL on missing leader-query/persistence methods.

- [ ] **Step 3: Implement leader derivation in `M1TacticalEvidenceService`**

Use persisted chronology; do not add a second decision table and do not mutate raw candidate rows. Query only matured leaders for the requested pair/policy/as-of time and return enough evidence for settlement.

- [ ] **Step 4: Implement idempotent `shadowOutcome15mV1` persistence**

Use `jsonb_set` only when `governance -> 'shadowOutcome15mV1' IS NULL`. The stored object must include `artifact: 'm1-shadow-outcome-15m-v1'` and `modifiesExecution: false`.

- [ ] **Step 5: Add explicit idempotency and semantic-separation tests**

Assert a second write cannot overwrite the first artifact and that `outcome_state`, `outcome_reason`, `signal_id`, and `trade_intent_id` are not written by the shadow method.

- [ ] **Step 6: Run evidence-service tests**

Run: `pnpm --filter @irexpro/api exec jest --runInBand src/modules/ai/m1-tactical-evidence.service.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add apps/api/src/modules/ai/m1-tactical-evidence.service.ts apps/api/src/modules/ai/m1-tactical-evidence.service.spec.ts
git commit -m "feat(ai): persist M1 shadow episode outcomes"
```

### Task 3: Add episode-level SHADOW performance metrics

**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-evidence.service.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-evidence.service.spec.ts`

**Interfaces:**
- Produces: `loadShadowOutcomeMetrics(filter: M1ShadowOutcomeMetricsFilter): Promise<M1ShadowOutcomeMetrics>`
- Filters: user, broker connection, optional route/instrument/direction/policy version, `from`, `to`.
- Result: total episode leaders, evaluable, ambiguous, unobservable, positive, negative, flat, cumulative net R, average net R, gross positive R, absolute gross negative R, profit factor, maximum drawdown R.

- [ ] **Step 1: Write failing metric tests**

Use chronological fixtures containing TP, SL, MTM, `AMBIGUOUS`, and `UNOBSERVABLE_DATA_GAP`. Assert coverage counts include every leader, P&L calculations include only TP/SL/MTM with finite net R, and max drawdown is computed from chronological cumulative net R.

- [ ] **Step 2: Run the metrics tests and verify RED**

Run: `pnpm --filter @irexpro/api exec jest --runInBand src/modules/ai/m1-tactical-evidence.service.spec.ts`
Expected: FAIL because `loadShadowOutcomeMetrics` is missing.

- [ ] **Step 3: Implement metrics query + calculation**

Read only `governance.shadowOutcome15mV1` from episode leaders. Return `profitFactor: null` when there is no defined denominator unless positive gross R with zero losses follows the service's existing infinity convention consistently.

- [ ] **Step 4: Run evidence-service tests**

Run: `pnpm --filter @irexpro/api exec jest --runInBand src/modules/ai/m1-tactical-evidence.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add apps/api/src/modules/ai/m1-tactical-evidence.service.ts apps/api/src/modules/ai/m1-tactical-evidence.service.spec.ts
git commit -m "feat(ai): measure M1 shadow episode performance"
```

### Task 4: Settle mature SHADOW episodes in the existing scheduler

**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.spec.ts`

**Interfaces:**
- Consumes: `loadMatureShadowEpisodeLeaders()`, `evaluateM1CausalOutcome15m()`, `markShadowOutcome15mV1()`.
- Produces no new execution interface and no rollout-policy mutation.

- [ ] **Step 1: Write failing scheduler tests**

Pin: mature leader settles to TP/SL/MTM/AMBIGUOUS from the already-loaded `market.m1`; leader inside the recoverable history window remains pending when the 15-bar window is incomplete; a matured leader older than the 60-bar recoverability boundary finalizes as `UNOBSERVABLE_DATA_GAP`; finalized leaders are not rewritten; scheduler remains on `M1_TACTICAL_ROLLOUT_POLICY_V1`/`SHADOW`; `AiSignalService.receiveSignal()` is never called because of shadow evidence.

- [ ] **Step 2: Run scheduler tests and verify RED**

Run: `pnpm --filter @irexpro/api exec jest --runInBand src/modules/ai/m1-tactical-scheduler.service.spec.ts`
Expected: FAIL on missing SHADOW settlement path.

- [ ] **Step 3: Implement `settleMatureShadowEpisodes(...)`**

Call it after raw candidate persistence using the existing current 60-bar `market.m1` window. Observable outcomes use `evaluateM1CausalOutcome15m`; unreconstructable mature leaders beyond the 60-minute boundary persist `UNOBSERVABLE_DATA_GAP`; transient/incomplete-but-recoverable windows stay pending.

- [ ] **Step 4: Add the no-execution safety assertions**

Assert no code path changes rollout phase or invokes signal/trade dispatch from shadow settlement. Keep existing real PAPER execution tests unchanged.

- [ ] **Step 5: Run focused M1 suite**

Run: `pnpm --filter @irexpro/api exec jest --runInBand src/modules/ai/m1-causal-outcome.spec.ts src/modules/ai/m1-drift-counterfactual.spec.ts src/modules/ai/m1-tactical-evidence.service.spec.ts src/modules/ai/m1-tactical-scheduler.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Run API build/lint and regression suites**

Run:
```bash
pnpm --filter @irexpro/api build
pnpm --filter @irexpro/api exec eslint src/modules/ai/m1-causal-outcome.ts src/modules/ai/m1-drift-counterfactual.ts src/modules/ai/m1-tactical-evidence.service.ts src/modules/ai/m1-tactical-scheduler.service.ts
git diff --check
```
Expected: exit code 0 for every command.

Then run the existing strategy-promotion / risk-execution suites required by repository CI before opening a PR.

- [ ] **Step 7: Commit Task 4**

```bash
git add apps/api/src/modules/ai/m1-tactical-scheduler.service.ts apps/api/src/modules/ai/m1-tactical-scheduler.service.spec.ts
git commit -m "feat(ai): settle prospective M1 shadow episodes"
```

### Task 5: Whole-branch verification and release boundary

**Files:**
- No product-code changes expected; verification only unless a failing test exposes a real defect.

**Interfaces:**
- Produces a PR whose observable behavior is evidence collection only.

- [ ] **Step 1: Verify exact branch/base SHAs and clean working tree**

Run: `git fetch origin main && git merge-base origin/main HEAD && git status --short --branch`
Expected: branch is based on current `origin/main` (rebase if main advanced), and only intended commits are present.

- [ ] **Step 2: Run the focused M1 evidence suite fresh on the final SHA**

Run the four Jest files from Task 4 again.
Expected: PASS with zero failures.

- [ ] **Step 3: Run API production build, relevant lint, and `git diff --check` fresh on the final SHA**

Expected: all exit 0.

- [ ] **Step 4: Review the final diff against the spec safety boundary**

Confirm no change to M1 rollout policy injection, no new call to `receiveSignal()` from shadow settlement, no M5 execution changes, and no reuse of real execution outcome/link fields for shadow evidence.

- [ ] **Step 5: Open a dedicated PR and require repository CI**

Do not merge until Required CI Gate, API CI, Risk Execution Concurrency, Release Security, Strategy Promotion Integrity, and any affected UI workflow are green for the exact head SHA.
