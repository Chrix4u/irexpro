# Shadow Directional Pulse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a causal recent shadow-outcome ranking signal so iRexPro can choose the currently paying direction faster without bypassing PAPER safety gates.

**Architecture:** A pure pulse scorer consumes causally resolved BUY/SELL shadow outcomes. The collector loads recent pair-side outcomes from `trading.ensemble_shadow_decisions`, and adaptive opportunity scoring gives the pulse a small ranking weight. Execution eligibility remains controlled only by existing hard blockers.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL, GitHub Actions.

**Spec:** `docs/superpowers/designs/2026-10-24-shadow-directional-pulse.md`

## Global Constraints

- PAPER ranking only; DEMO/LIVE authority unchanged.
- `resolvedAt < evaluatedAt` is mandatory; unresolved/future outcomes never contribute.
- Minimum 4 resolved samples on each side; otherwise neutral quality `0.5`.
- Latest 10 per side, decay `0.65`.
- Pulse cannot clear hard blockers, alter net expected R, SL/TP, or independently increase size.

## Review Focus

- Future-resolved outcome leakage must be impossible.
- Sparse evidence must stay neutral, not optimistic.
- Opposite-side deterioration must improve only ranking, not execution authority.
- Existing hard blockers must remain byte-for-byte preserved in decision output.
- DB/query failure must fail to neutral pulse rather than block or promote execution.

---

### Task 1: Pure causal directional pulse

**Files:**
- Create: `apps/api/src/modules/ai/adaptive-shadow-directional-pulse.ts`
- Create: `apps/api/src/modules/ai/adaptive-shadow-directional-pulse.spec.ts`

**Interfaces:**
- Produces: `buildAdaptiveShadowDirectionalPulse(input)` returning candidate/opposite samples, weighted R, advantage, quality and status.

- [ ] Write failing causality, strong-side and insufficient-evidence tests.
- [ ] Prove RED.
- [ ] Implement the minimal pure scorer.
- [ ] Prove GREEN and commit.

### Task 2: Adaptive ranking integration

**Files:**
- Modify: `apps/api/src/modules/ai/adaptive-opportunity-score.ts`
- Modify: `apps/api/src/modules/ai/adaptive-opportunity-score.spec.ts`

**Interfaces:**
- Consumes: pulse `quality` in `[0,1]`, neutral `0.5`.
- Produces: a 5%-weighted ranking component while preserving hard blockers.

- [ ] Write failing tests that a supported side outranks neutral/opposed, while hard blockers remain uncleared.
- [ ] Prove RED.
- [ ] Add the pulse component and rebalance weights to exactly 1.0.
- [ ] Prove GREEN and commit.

### Task 3: Causal database loader and collector plumbing

**Files:**
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`

**Interfaces:**
- Loads recent resolved shadow outcomes for both sides of one instrument with `resolvedAt < evaluatedAt`.
- Passes pulse quality into `scoreAdaptiveOpportunity` and stores pulse evidence in adaptive metadata.

- [ ] Write a failing loader/integration test with a future outcome that must be excluded.
- [ ] Prove RED.
- [ ] Implement fail-neutral loader, per-scan caching, scoring plumbing and metadata.
- [ ] Run collector + pulse + opportunity suites, build/lint, commit.

### Task 4: Exact-head release verification

- [ ] Push branch and open PR.
- [ ] Require API CI, PostgreSQL concurrency, Release Security, Strategy Promotion Integrity and Required CI on exact head.
- [ ] Merge only after exact-head green.
- [ ] Verify exact merged SHA through Main Staging Release Gate and Staging Deploy before treating it as live.
