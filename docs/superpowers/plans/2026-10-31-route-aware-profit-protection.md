# Route-Aware Profit Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop cTrader DEMO profit protection from harvesting sub-0.75R Early Transition and Confirmed Reversal winners while preserving Trend Continuation protection.

**Architecture:** Extend the pure profit-lock evaluator with an optional strategy route. The live Demo manager loads the route from trade-intent metadata and passes it to the evaluator. Unknown routes preserve the current policy.

**Tech Stack:** TypeScript, NestJS, Jest, PostgreSQL.

**Spec:** `docs/superpowers/designs/2026-10-31-route-aware-profit-protection.md`

## Global Constraints
- Demo behavior only; no LIVE authority changes.
- EARLY_TRANSITION and CONFIRMED_REVERSAL arm floor = 0.75R.
- TREND_CONTINUATION and unknown route behavior unchanged.
- Existing retention fractions at >=0.75R unchanged.

## Review Focus
- Missing metadata must retain conservative legacy behavior.
- Confirmed Reversal below 0.75R must not close from profit protection.
- Early Transition below 0.75R must not close from profit protection.
- Trend Continuation rescue/standard bands must remain unchanged.
- >=0.75R route-aware trades must still use existing 75%+ retention tiers.

---

### Task 1: Pure route-aware profit-lock policy
**Files:**
- Modify: `apps/api/src/modules/broker/adapters/paper-broker.adapter.ts`
- Test: existing paper broker adapter spec containing `evaluatePaperProfitLock`

- [ ] Add RED tests for route-aware 0.75R arm floor and legacy fallback.
- [ ] Run focused tests and observe expected failures.
- [ ] Add optional `strategyRoute` input and minimal route-specific arm-floor logic.
- [ ] Run focused tests green.

### Task 2: cTrader Demo route propagation
**Files:**
- Modify: `apps/api/src/modules/execution/reconciliation/live-demo-profit-protection.service.ts`
- Test: `apps/api/src/modules/execution/reconciliation/live-demo-profit-protection.service.spec.ts`

- [ ] Add RED tests proving route is loaded/passed and Confirmed Reversal below 0.75R is held.
- [ ] Extend open-trade query with Plan-B route metadata.
- [ ] Pass route to `evaluatePaperProfitLock`.
- [ ] Run focused tests green.

### Task 3: Verification and deployment
- [ ] Run paper broker, live Demo profit protection, post-entry drawdown guard, scheduler, and execution regressions.
- [ ] Run TypeScript compiler and Nest production build.
- [ ] Diff check.
- [ ] Merge to deployment branch only if all gates pass.
- [ ] Restart only API and verify health/startup markers.
