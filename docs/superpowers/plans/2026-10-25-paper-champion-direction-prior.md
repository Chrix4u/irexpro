# PAPER Champion Direction Prior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give mature profitable PAPER pair+direction sleeves immediate reduced-risk scout access without globally loosening gateways.

**Architecture:** Add a pure directional-prior evaluator, load a cached 100-trade `paper-only-v1` snapshot once per scan, and pass the decision into the existing opportunity-scout evaluator. The scout reuses current RECOVERY soft floors while every downstream safety gate remains unchanged.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL, GitHub Actions.

**Spec:** `docs/superpowers/designs/2026-10-25-paper-champion-direction-prior.md`

## Global Constraints
- PAPER only; DEMO/LIVE unchanged.
- No symbol hard-coding.
- >=8 trades, positive net P/L, PF >=1.15 (or no gross losses) for prior support.
- 0.10-lot scout cap.
- Never relax 4/6 consensus, OOD calibration, event/cost, entry alignment, post-loss, portfolio or central risk controls.

## Review Focus
- Sparse/negative/PF<1.15 evidence must not accelerate.
- Supported prior must not bypass OOD rules.
- Supported prior must not scout confirmed reversal or early transition in v1.
- Current mature weak reliability must still veto downstream.
- DB/query failure must fail closed to normal scout behavior.

---

### Task 1: Pure directional prior
**Files:** Create `apps/api/src/modules/ai/paper-champion-direction-prior.ts`; create spec.
**Produces:** `evaluatePaperChampionDirectionPrior()` and typed decision.
- [ ] RED tests for supported, sparse, negative and low-PF evidence.
- [ ] Implement evaluator and GREEN tests.

### Task 2: Scout acceleration semantics
**Files:** Modify `paper-opportunity-scout.ts` and spec.
**Consumes:** prior decision from Task 1.
- [ ] RED tests showing a supported prior gets RECOVERY floors before 30 idle minutes while unsupported behavior is unchanged.
- [ ] Prove consensus, OOD and event/cost vetoes remain.
- [ ] Implement and GREEN.

### Task 3: Cached DB snapshot + collector wiring
**Files:** Modify `vps-forex-signal-collector.service.ts` and spec.
- [ ] RED query/collector tests for last-100 champion grouping and exact candidate prior propagation.
- [ ] Implement cached 12-sleeve snapshot and pass decision to scout.
- [ ] Verify downstream pair-side reliability can still demote the candidate.

### Task 4: Release verification
- [ ] Focused trading suites, build, lint, formatting, diff-check.
- [ ] Push PR; require exact-head API, concurrency, security, strategy integrity and Required CI green before merge/deploy.
