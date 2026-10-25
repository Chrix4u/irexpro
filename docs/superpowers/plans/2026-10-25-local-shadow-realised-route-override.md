# High-Conviction Local Shadow Edge Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and TDD task-by-task.

**Goal:** Allow a high-conviction local shadow-edge PAPER scout to survive only the broad realised continuation-route demotion at micro size, while preserving every structural, pair-side, market, risk, post-loss, and broker veto.

**Architecture:** Keep broad realised route reliability unchanged for full-size authority. At final NORMAL_PAPER composition, add a narrow micro override only when the scout is a local-shadow reason, its local pocket meets the existing high-conviction definition, structural route and pair-side reliability remain eligible, the broad realised route is the sole demotion, and the scout cap is <=0.10 lots.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL-backed evidence, GitHub Actions.

**Spec:** User-requested higher qualified participation without blindly lowering hard safety gates.

## Global Constraints
- PAPER only; DEMO/LIVE authority unchanged.
- Do not change the local-pocket high-conviction thresholds.
- Do not bypass mature bad pair-side reliability.
- Do not bypass post-loss, event-risk, portfolio, entry-alignment, quote-freshness, SL/TP geometry, sizing, margin, or broker controls.
- Full-size execution remains governed by the existing broad realised-route reliability gate.

## Review Focus
- Low-conviction or ordinary scouts remain demoted.
- A 0.20-lot/full-size candidate cannot use the override.
- A structurally weak route cannot use the override.
- A mature bad pair-side cannot use the override.
- Telemetry must record when the micro override was used.

### Task 1: Pin the micro override policy
**Files:** Modify `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`; test `...service.spec.ts`.
- [x] RED: test missing pure override authority.
- [x] GREEN: implement micro-only helper with fail-closed inputs.

### Task 2: Wire the override at final reliability composition
**Files:** Modify collector service and spec.
- [x] Keep full-size reliability semantics unchanged.
- [x] Preserve scout only when the broad realised route is the sole demotion.
- [x] Persist/log override telemetry.
- [x] Run focused collector/reliability regressions and full collector suite (120/120).

### Task 3: Release verification
- [x] Run API build, changed-file lint, Prettier, and `git diff --check`.
- [ ] Push PR and require exact-head API, concurrency, security, strategy integrity, and Required CI.
- [ ] Merge/deploy only after exact-head gates pass; verify runtime after Deriv fast quotes reopen.
