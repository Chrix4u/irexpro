# PAPER Confirmed-Reversal Pair-Side Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing PAPER pair-side reliability execution gate to mature weak CONFIRMED_REVERSAL sleeves without changing other execution authority.

**Architecture:** Reuse `paper-route-reliability.ts` thresholds and decision types. Parameterize the collector's exact pair-side shadow-evidence loader by strategy route, and evaluate pair-side reliability for TREND_CONTINUATION plus CONFIRMED_REVERSAL while keeping route-wide reliability authoritative only as existing trend diagnostics.

**Tech Stack:** TypeScript, NestJS, Jest, PostgreSQL evidence queries, pnpm workspace.

**Spec:** `docs/superpowers/designs/2026-10-23-paper-reversal-pair-side-reliability.md`

## Global Constraints
- Pair-side maturity remains 8 independent episodes.
- Profit-factor floor remains 1.0.
- Max drawdown boundary remains 12%.
- EARLY_TRANSITION stays unconstrained by this gate.
- No LIVE/DEMO authority, model admission, risk, sizing, broker permission, or quarantined-route changes.
- Do not modify or close the currently open PAPER trade.

## Review Focus
- Mature weak confirmed-reversal pair-side must demote NORMAL_PAPER.
- Insufficient confirmed-reversal evidence must remain executable.
- Mature healthy confirmed-reversal evidence must remain executable.
- TREND_CONTINUATION behavior must remain unchanged.
- SQL evidence must be scoped to the candidate's exact strategy route, instrument, direction, policy versions, and outcome model version.

---

### Task 1: Generalize pair-side reliability applicability

**Files:**
- Modify: `apps/api/src/modules/ai/paper-route-reliability.ts`
- Modify: `apps/api/src/modules/ai/paper-route-reliability.spec.ts`

**Interfaces:**
- Consumes: existing `EnsembleSleeveEvidence` and pair-side thresholds.
- Produces: pair-side reliability decisions that apply to `TREND_CONTINUATION` and `CONFIRMED_REVERSAL` only.

- [ ] **Step 1: Write failing tests** proving mature weak confirmed-reversal evidence becomes `RESEARCH_ONLY`, while insufficient and healthy reversal evidence remain executable.
- [ ] **Step 2: Run** `pnpm --filter @irexpro/api exec jest src/modules/ai/paper-route-reliability.spec.ts --runInBand` and verify the new reversal test fails because reversal is currently `NOT_APPLICABLE`.
- [ ] **Step 3: Implement minimal applicability change** in `paper-route-reliability.ts` without changing thresholds or route-wide trend logic.
- [ ] **Step 4: Re-run the focused test** and verify it passes.
- [ ] **Step 5: Commit** `test/fix(ai): gate weak reversal pair-sides`.

### Task 2: Wire exact strategy-route evidence into the collector

**Files:**
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`

**Interfaces:**
- Consumes: generalized pair-side reliability decision from Task 1.
- Produces: `loadPaperTrendPairSideReliabilityEvidence(userId, connectionId, instrument, direction, strategyRoute)` and NORMAL_PAPER demotion for mature weak confirmed-reversal sleeves.

- [ ] **Step 1: Write failing collector tests** proving the evidence query binds the supplied strategy route and a confirmed-reversal candidate enters the pair-side reliability gate.
- [ ] **Step 2: Run** the focused collector spec cases and verify RED for fixed `TREND_CONTINUATION` SQL / missing reversal wiring.
- [ ] **Step 3: Parameterize the loader and collector gate** for `TREND_CONTINUATION` and `CONFIRMED_REVERSAL`; keep trend route-wide evidence unchanged and snapshot telemetry continuation-only.
- [ ] **Step 4: Re-run focused collector and reliability specs** and verify GREEN.
- [ ] **Step 5: Commit** `fix(ai): apply pair-side reliability to reversals`.

### Task 3: Whole-branch verification

**Files:**
- No new production scope unless verification exposes a defect.

**Interfaces:**
- Consumes: Tasks 1-2.
- Produces: merge-ready branch evidence.

- [ ] **Step 1: Run** `pnpm --filter @irexpro/api test -- --runInBand`.
- [ ] **Step 2: Run** `pnpm --filter @irexpro/api build`.
- [ ] **Step 3: Run** changed-file ESLint and `git diff --check`.
- [ ] **Step 4: Review the diff for authority expansion, stale SQL parameters, and unintended route changes.
- [ ] **Step 5: Commit plan/design docs if not already included and push the branch for CI only after all local checks pass.
