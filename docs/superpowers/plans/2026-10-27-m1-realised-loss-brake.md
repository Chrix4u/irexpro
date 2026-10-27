# M1 Realised-Loss Brake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Stop provisional M1 pair-sides from repeatedly spending PAPER capital after realised deterioration while preserving cross-pair trade frequency.

**Architecture:** Reuse existing M1 realised pair-side reliability and active-intent persistence. Make early-transition's consecutive-loss floor route-specific at two, then add a same-instrument/same-direction active M1 intent veto immediately before submission.

**Tech Stack:** TypeScript, NestJS, Jest, PostgreSQL.

**Spec:** `docs/superpowers/designs/2026-10-27-m1-realised-loss-brake.md`

## Global Constraints
- M1_EARLY_TRANSITION: two most recent compatible realised losses => `EARLY_LOSS_STREAK` and no execution.
- M1_TREND_CONTINUATION / M1_CONFIRMED_REVERSAL keep the existing three-loss early brake.
- Same instrument + same direction CREATED intent or OPEN M1 trade blocks a new M1 execution.
- Other instruments remain independently executable.
- No confidence, expected-R, event-risk, spread, sizing, SL/TP, or broker safety threshold is loosened.

### Task 1: Route-specific realised-loss brake
**Files:** `apps/api/src/modules/ai/m1-tactical-reliability.ts`, `m1-tactical-reliability.spec.ts`
- [ ] Write RED tests: early-transition 0W/2L brakes; trend-continuation 0W/2L remains collecting.
- [ ] Implement route-specific early-loss sample floor.
- [ ] Run reliability spec GREEN.

### Task 2: Same pair-side active-intent veto
**Files:** `apps/api/src/modules/ai/m1-tactical-evidence.service.ts`, `m1-tactical-evidence.service.spec.ts`, `m1-tactical-scheduler.service.ts`, `m1-tactical-scheduler.service.spec.ts`
- [ ] Add RED evidence-service test for generic active M1 intent lookup.
- [ ] Add RED scheduler test proving otherwise executable same-side candidate is blocked.
- [ ] Implement generic lookup and scheduler veto; keep existing opposite-rescue lookup behavior.
- [ ] Run focused specs GREEN.

### Task 3: Verification
- [ ] Run reliability + scheduler + evidence + governance + expectancy specs.
- [ ] Run changed-file lint and `git diff --check`.
- [ ] Run API build.
- [ ] Push/open PR only after local verification is green.
