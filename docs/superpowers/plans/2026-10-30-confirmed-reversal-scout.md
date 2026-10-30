# Confirmed-Reversal Adaptive PAPER Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a PAPER-only confirmed-reversal scout that admits strong 5+/6 setups and exceptional 4/6 setups without lowering the normal ensemble threshold.

**Architecture:** Extend the pure `evaluatePaperOpportunityScout()` decision function with a route-specific confirmed-reversal branch before the existing trend-continuation branch. Reuse the collector's realised-payoff authority, adaptive ranking, entry-alignment and final risk sizing, but isolate reversal payoff evidence under a new v11 scout model identity; no collector execution bypass is added.

**Tech Stack:** NestJS, TypeScript, Jest.

**Spec:** `docs/superpowers/designs/2026-10-30-confirmed-reversal-scout.md`

## Global Constraints
- PAPER only; no DEMO/LIVE authority change.
- Normal 6-of-7 ensemble admission stays unchanged.
- Exact `CONFIRMED_REVERSAL` / `REVERSAL_CONFIRMED` route only.
- Event risk must be CLEAR; execution cost usable; portfolio quality >= 0.35; OOD drift always blocks.
- Confidence >= 0.64 and aligned momentum 0.5-1.5 ATR for every reversal scout.
- 5+ consensus: net R >= 0.10, qualities >= 0.35, cap 0.20.
- Exactly 4 consensus: NORMAL drift, confidence >= 0.70, net R >= 0.18, momentum 0.60-1.20 ATR, qualities >= 0.40, cap 0.10.
- Downstream realised-payoff, calibration, entry-alignment, position-sizing and risk controls remain unchanged.
- Confirmed-reversal scouts use a new v11 scout model identity; existing trend scouts retain the v10 identity and payoff history.

## Review Focus
- A 3/6 reversal must never execute.
- OOD drift must block even an otherwise exceptional reversal.
- Momentum outside the confirmed-reversal band must block.
- Trend scout behavior must remain byte-for-behavior compatible.
- The 0.20/0.10 values are ceilings, not forced lots; final risk sizing must retain authority.

---

### Task 1: Confirmed-reversal scout decision lane

**Files:**
- Modify: `apps/api/src/modules/ai/paper-opportunity-scout.ts`
- Modify: `apps/api/src/modules/ai/paper-opportunity-scout.spec.ts`

**Interfaces:**
- Consumes: existing `PaperOpportunityScoutInput` fields.
- Produces: new reasons `CONFIRMED_REVERSAL_SCOUT` and `CONFIRMED_REVERSAL_MICRO_SCOUT` through `PaperOpportunityScoutDecision`.

- [ ] Write failing tests for 5/6 strong admission, 4/6 premium micro admission, 3/6 rejection, OOD rejection, low/high momentum rejection, and unchanged trend behavior.
- [ ] Run focused tests and verify the new tests fail on current behavior.
- [ ] Implement the minimal route-specific branch and constants.
- [ ] Run `paper-opportunity-scout.spec.ts` and verify all tests pass.
- [ ] Commit the behavior and tests.

### Task 2: Evidence isolation, integration verification and deployment

**Files:**
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`
- Verify: `plan-b-multimodel-shadow.spec.ts`.

**Interfaces:**
- Consumes: scout decisions from Task 1.
- Produces: existing `NORMAL_PAPER` scout route, existing scout realised-payoff cap and final adaptive sizing.

- [ ] Run focused collector + ensemble + scout regression tests.
- [ ] Build the API from the worktree.
- [ ] Inspect diff and `git diff --check`.
- [ ] Cherry-pick the verified commit(s) to `deploy/daily-loss-reset-20261028`.
- [ ] Build the deployment tree, restart only `irexpro-api-staging`, verify PM2/startup/scanner telemetry, and push the deployment branch.
