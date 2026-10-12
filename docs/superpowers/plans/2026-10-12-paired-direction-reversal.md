# Paired Direction Reversal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a complementary BUY-vs-SELL directional engine and a strictly PAPER-only paired-reversal research route without weakening existing qualification gates.

**Architecture:** Preserve current independent scores as absolute evidence, derive pairwise direction by logit comparison, and gate a tiny research-only reversal route with spread/event/post-loss/risk controls. DEMO/LIVE and normal PAPER governance remain unchanged.

**Tech Stack:** TypeScript, NestJS, Jest, PostgreSQL-backed existing execution pipeline.

**Spec:** `docs/superpowers/specs/2026-10-12-paired-direction-reversal-design.md`

## Global Constraints
- Pairwise probabilities sum to 1.
- No direct BUY-negative => SELL execution rule.
- Missing/stale broker spread evidence fails closed.
- OUT_OF_DISTRIBUTION never executes via paired reversal research.
- Research route max lot is 0.01 and `qualificationEvidence=false`.
- Existing normal PAPER, DEMO, LIVE thresholds and promotion metrics are unchanged.

## Review Focus
- Near-equal BUY/SELL probabilities must abstain.
- Strong relative direction but negative post-cost paired R must abstain.
- Swapping BUY/SELL scores must swap preferred direction exactly.
- STRESSED may be research-observable; OUT_OF_DISTRIBUTION must remain blocked.
- Post-loss guard and downstream risk/margin controls remain authoritative.

### Task 1: Pairwise directional scorer
**Files:**
- Create: `apps/api/src/modules/ai/paired-direction-reversal.ts`
- Create: `apps/api/src/modules/ai/paired-direction-reversal.spec.ts`

- [ ] Write failing tests for complementary probabilities, swap symmetry, minimum edge, reversal evidence, cost-aware expected R, and fail-closed invalid inputs.
- [ ] Run the focused Jest spec and confirm RED.
- [ ] Implement the minimal pure scorer/evaluator.
- [ ] Run the focused Jest spec and confirm GREEN.

### Task 2: PAPER-only route composition
**Files:**
- Modify: `apps/api/src/modules/ai/paper-research-throughput.ts`
- Test: `apps/api/src/modules/ai/paper-research-throughput.spec.ts`

- [ ] Write failing tests proving 0.01-only paired reversal research, STRESSED allowance, OOD/spread/event/cost blocks, and no qualification authority.
- [ ] Run focused specs and confirm RED.
- [ ] Implement route selection additively without changing existing normal route precedence.
- [ ] Run focused specs and confirm GREEN.

### Task 3: Collector integration and provenance
**Files:**
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Test: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`

- [ ] Write failing integration tests showing both sides are evaluated as one pair and only the pairwise reversal winner may enter the research route.
- [ ] Verify RED.
- [ ] Wire paired evaluation after both counterfactual scores exist; keep normal governance authoritative; preserve post-loss/risk/margin gates.
- [ ] Persist/log paired decision provenance and `qualificationEvidence=false`.
- [ ] Verify GREEN.

### Task 4: Verification
- [ ] Run API lint, focused AI suite, full API tests, build, and `git diff --check`.
- [ ] Review diff for any normal PAPER/DEMO/LIVE threshold changes; expected: none.
- [ ] Commit and push the branch only after fresh green evidence.
