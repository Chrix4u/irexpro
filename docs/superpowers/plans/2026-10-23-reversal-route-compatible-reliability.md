# Confirmed-Reversal Compatible Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an evidence-compatible route reliability brake for NORMAL_PAPER confirmed reversals without changing trend or research execution authority.

**Architecture:** Use a reversal-only evidence lineage containing the pre-calibration/current dmw2 policies. Evaluate route health after 8 independent episodes. Combine it with existing exact pair-side reliability so a mature healthy local sleeve can override a weak route, while an immature local sleeve cannot.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL shadow outcome ledger.

**Spec:** `docs/superpowers/designs/2026-10-23-reversal-route-compatible-reliability.md`

## Global Constraints
- Preserve TREND_CONTINUATION behavior.
- Preserve 8-episode pair-side maturity, PF >= 1.0 and max-DD <= 12% boundaries.
- Reversal route evidence must use only dmw2-compatible policy versions.
- Do not widen PAPER, DEMO or LIVE execution authority.

## Review Focus
- Weak reversal route + immature pair-side must be blocked.
- Mature healthy reversal pair-side must be able to override weak aggregate route.
- Trend continuation must retain pair-side-only execution authority.
- Older incompatible reversal policies must not enter the evidence query.
- EARLY_TRANSITION remains unaffected.

---

### Task 1: Reversal route policy
**Files:** `paper-route-reliability.ts`, `paper-route-reliability.spec.ts`
- [x] Write RED tests for 8-episode maturity, weak-route demotion, immature-local block and healthy-local override.
- [x] Implement reversal route evaluator and composite execution gate.
- [x] Verify focused reliability suite GREEN.

### Task 2: Compatible policy lineage
**Files:** `plan-b-multimodel-shadow.ts`, `plan-b-multimodel-shadow.spec.ts`
- [x] Write RED test pinning reversal evidence to pre-calibration/current dmw2 versions.
- [x] Add the immutable compatible version list.
- [x] Verify focused lineage test GREEN.

### Task 3: Collector integration
**Files:** `vps-forex-signal-collector.service.ts`, `vps-forex-signal-collector.service.spec.ts`
- [x] Write RED integration proving the collector requires reversal-route evidence.
- [x] Add compatible reversal-route loader and strategy-specific pair-side lineage.
- [x] Apply composite reliability authority to confirmed reversals while preserving trend behavior.
- [x] Verify ranked-scan integration GREEN.
- [ ] Run GitHub exact-head CI and release only if all required gates pass.
