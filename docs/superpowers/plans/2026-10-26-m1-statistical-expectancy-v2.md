# M1 Statistical Expectancy V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fixed M1 target-R-as-expectancy with a conservative evidence-adjusted statistical expectancy used by governance and ranking.

**Architecture:** Add a pure expectancy module consuming the existing M1 candidate plus the existing route/pair/side reliability decision. Preserve the candidate's TP/SL geometry. Pass the expectancy decision into M1 governance, persist it for attribution, and leave every hard risk/safety gate unchanged.

**Tech Stack:** TypeScript, NestJS, Jest, PostgreSQL, GitHub Actions.

**Spec:** `docs/superpowers/designs/2026-10-26-m1-statistical-expectancy-v2.md`

## Global Constraints

- PAPER-only authority unchanged; no DEMO/LIVE expansion.
- `grossExpectedR` remains target geometry for backward-compatible audit fields.
- Route floors use new statistical expected R before execution cost.
- Existing reliability/drift/event/cost/exposure/post-loss/broker gates remain authoritative.
- Causal evidence only: no outcome resolved after the evaluated decision time may affect it.

## Review Focus

- Sparse evidence must not turn 1.6R target geometry into an automatic +1.6R edge.
- Mature negative realised R must lower expectancy despite high heuristic confidence.
- Mature positive realised R may raise expectancy but cannot bypass a reliability veto.
- Recent-five deterioration must reduce expectancy without double-counting into an optimistic value.
- Invalid/NaN evidence must fail conservative and never generate Infinity/NaN execution values.

---

### Task 1: Pure M1 expectancy estimator

**Files:**

- Create: `apps/api/src/modules/ai/m1-tactical-expectancy.ts`
- Create: `apps/api/src/modules/ai/m1-tactical-expectancy.spec.ts`

**Interfaces:**

- Consumes: `M1TacticalCandidate`, `M1RoutePairSideReliabilityDecision | null`.
- Produces: `evaluateM1TacticalExpectancy(input): M1TacticalExpectancyDecision` with `targetR`, `heuristicPriorExpectedR`, `statisticalExpectedR`, `impliedWinProbability`, evidence sample/value fields, source and artifact.

- [ ] **Step 1: Write RED tests** proving identical target geometry but different candidate quality yields different expectancy; neutral quality is near 0R; mature positive/negative realised evidence moves expectancy; recent-five decay lowers it; invalid evidence is finite/conservative.
- [ ] **Step 2: Run focused spec and confirm RED.**
- [ ] **Step 3: Implement the pure estimator exactly as the design specifies.**
- [ ] **Step 4: Run focused spec and confirm GREEN.**
- [ ] **Step 5: Commit.**

### Task 2: Governance and scheduler integration

**Files:**

- Modify: `apps/api/src/modules/ai/m1-tactical-governance.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- Modify: relevant M1 governance/scheduler specs.

**Interfaces:**

- Consumes: Task 1 expectancy decision.
- Produces: generic governance `expectedR` from `statisticalExpectedR`; decision governance + signal metadata include expectancy attribution.

- [ ] **Step 1: Write RED governance test** showing two candidates with same `grossExpectedR` but different supplied statistical expectancy get different `netExpectedR`.
- [ ] **Step 2: Write RED scheduler integration test** proving route payoff floor uses statistical expected R and persists expectancy metadata.
- [ ] **Step 3: Wire expectancy after `reliabilityFor()` and before `evaluateM1TacticalGovernance()`.**
- [ ] **Step 4: Run M1 governance/scheduler/reliability suites.**
- [ ] **Step 5: Commit.**

### Task 3: Release verification

**Files:**

- No behavior change beyond Tasks 1-2 unless verification finds a root cause defect.

**Interfaces:**

- Consumes: exact green branch head.
- Produces: merge/deploy candidate with exact-head evidence.

- [ ] **Step 1: Run API build, changed-file ESLint, Prettier and `git diff --check`.**
- [ ] **Step 2: Push branch and open PR with before/after semantic evidence.**
- [ ] **Step 3: Merge only after exact-head API CI, PostgreSQL concurrency, security, strategy integrity and Required CI are green.**
- [ ] **Step 4: Verify exact merged SHA deploys to staging and post-deploy M1 telemetry contains both target R and statistical expected R.**
