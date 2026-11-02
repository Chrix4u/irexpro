# Calibration ↔ Bidirectional Conflict Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a shadow-only, causality-safe diagnostic that records disagreement between calibration blocking and the current bidirectional direction probabilities.

**Architecture:** A pure evaluator classifies the conflict from the existing calibration decision and paired-direction probabilities. The collector persists the result as a JSONB component on each evaluated ensemble shadow row after paired-direction scoring, without feeding it back into any execution decision.

**Tech Stack:** TypeScript, NestJS, Jest, PostgreSQL JSONB.

**Spec:** `docs/superpowers/specs/2026-11-02-calibration-bidirectional-conflict-shadow-design.md`

## Global Constraints
- `executionAuthority` must always be `NONE`.
- `modifiesExecution` must always be `false`.
- The new diagnostic must not be read by execution, sizing, routing, governance, or risk code.
- Classification uses only decision-time calibration and bidirectional probabilities.

## Review Focus
- Exact 0.50/0.50 paired probability must classify as balanced.
- Invalid/non-finite probabilities must fail safe to balanced/unavailable telemetry, never execution.
- Calibration not blocked must never be mislabeled as a conflict.
- Persistence must update only the matching user/engine/opportunity row.
- Existing execution counts and route selection must remain unchanged in collector tests.
- Diagnostic persistence failure must be fail-open and leave signal dispatch unchanged.

---

### Task 1: Shadow conflict evaluator and persistence

**Files:**
- Create: `apps/api/src/modules/ai/calibration-bidirectional-conflict.ts`
- Create: `apps/api/src/modules/ai/calibration-bidirectional-conflict.spec.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`

**Interfaces:**
- Consumes: `AdaptivePredictionCalibrationDecision`, `PairedDirectionReversalDecision`, candidate direction, strategy route, adaptive state.
- Produces: `evaluateCalibrationBidirectionalConflict(input)` returning a shadow-only decision; collector persistence under `components.calibrationBidirectionalConflict`.

- [ ] **Step 1: Write failing evaluator tests** for no-block, current-side-favored, opposite-side-favored, balanced, and invalid-probability cases.
- [ ] **Step 2: Run evaluator test and verify RED** because the production module does not exist.
- [ ] **Step 3: Implement the minimal pure evaluator** with immutable `executionAuthority='NONE'` and `modifiesExecution=false`.
- [ ] **Step 4: Run evaluator test and verify GREEN**.
- [ ] **Step 5: Write failing collector persistence test** proving the component is written while signal dispatch behavior is unchanged.
- [ ] **Step 6: Run collector test and verify RED** because persistence is absent.
- [ ] **Step 7: Add minimal collector annotation persistence** immediately after paired-direction scoring.
- [ ] **Step 8: Run focused evaluator + collector tests and verify GREEN**.
- [ ] **Step 9: Run API lint/build and the relevant adaptive/calibration/paired-direction suites**.
- [ ] **Step 10: Commit the branch change** with the design and plan.
