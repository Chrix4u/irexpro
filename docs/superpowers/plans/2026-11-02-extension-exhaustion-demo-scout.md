# Extension Exhaustion DEMO Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a DEMO-only, dynamically evidence-qualified 0.10-lot extension-exhaustion scout without weakening global Plan-B/drift controls.

**Architecture:** Add a pure qualification module, a read-only evidence loader over settled ensemble shadow outcomes, and one new fallback authority branch in `M1TacticalSchedulerService`. Reuse all existing downstream execution/risk controls.

**Tech Stack:** TypeScript, NestJS, PostgreSQL/TypeORM DataSource, Jest.

**Spec:** `docs/superpowers/specs/2026-11-02-extension-exhaustion-demo-scout.md`

## Global Constraints
- DEMO only; never LIVE.
- Lot cap exactly 0.10.
- Evidence: >=6 resolved 15-minute-deduplicated episodes, avg R >=0.10, PF >=1.15, recent-3 R >0.
- Current setup: TREND_EXTENDED, NORMAL drift, CLEAR event risk, usable spread/cost evidence, M1 trend continuation confidence >=0.70 and direction quality >=0.65.
- Strong trained-expert opposition blocks this scout.

## Review Focus
- Duplicate minute decisions must not create duplicate same-side intents.
- Missing/invalid outcome R values must fail closed.
- Zero-loss evidence must compute PF safely without division errors.
- Evidence deterioration must automatically dequalify a previously qualified sleeve.
- Existing Plan-B/M5/fallback authority must retain priority over the scout.

---

### Task 1: Pure scout qualification
**Files:**
- Create: `apps/api/src/modules/ai/extension-exhaustion-demo-scout.ts`
- Create: `apps/api/src/modules/ai/extension-exhaustion-demo-scout.spec.ts`

**Interfaces:**
- Produces `evaluateExtensionExhaustionDemoScout(input)` returning eligibility, reason, lotCap and evidence snapshot.

- [x] Write RED tests for all numeric thresholds, event risk, M1 route/timing, specialist candidate, expert opposition, and 0.10 lot cap.
- [x] Run focused Jest and confirm RED.
- [x] Implement minimal pure evaluator.
- [x] Run focused Jest and confirm GREEN.

### Task 2: Shadow reliability loader
**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-evidence.service.ts`
- Modify/Test: `apps/api/src/modules/ai/m1-tactical-evidence.service.spec.ts`

**Interfaces:**
- Produces `loadExtensionExhaustionShadowReliability({ userId, instrument, direction, asOf })`.

- [x] Write RED SQL-contract/aggregation tests: compatible policy family, 7-day window, 15-minute dedupe, settled outcome only, recent-three R.
- [x] Implement loader and safe PF calculation.
- [x] Run focused tests GREEN.

### Task 3: Scheduler authority integration
**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.spec.ts`

**Interfaces:**
- Consumes Task 1 evaluator and Task 2 reliability.
- Records `extensionExhaustionDemoScout` in governance and may grant `BROKER_NATIVE` when higher-priority paths are unavailable.

- [x] Write RED scheduler tests: eligible scout executes at <=0.10; negative recent evidence blocks; opposite expert blocks; existing Plan-B/M5 path wins priority; active same-side intent prevents duplicate.
- [x] Implement minimal integration while reusing existing downstream brakes/position conflict logic.
- [x] Run scheduler tests GREEN.

### Task 4: Verification and deployment
- [x] Run scout/evidence/scheduler/authority/execution regression suites.
- [x] Run `pnpm --filter @irexpro/api build`.
- [x] Run `git diff --check`.
- [ ] Commit and push main.
- [ ] Deploy exact SHA; restart API.
- [ ] Verify PM2 online/unstable=0 and inspect fresh decisions for explicit scout artifact/authority; do not claim a trade opened unless one actually does.
