# User-confirmed Risk Protection Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow an explicitly consenting user to reset daily-loss and max-drawdown protection and continue trading without altering historical P&L.

**Architecture:** Extend the existing reset flow with a server-verified confirmation flag. For suspended sessions, atomically resume authority while rebasing peak equity to fresh broker equity; for ended sessions, reset the daily-loss window and let normal session start establish the fresh drawdown baseline.

**Tech Stack:** NestJS, TypeORM, Jest, Next.js/React, TypeScript.

**Spec:** `docs/superpowers/designs/2026-10-29-user-confirmed-risk-reset.md`

## Global Constraints
- Historical P&L must remain unchanged.
- Reset applies only to DAILY_LOSS_LIMIT_REACHED or MAX_DRAWDOWN_REACHED.
- Explicit `confirmed: true` is required server-side.
- Broker/account scope remains exact and audited.
- Normal fresh risk/market checks still apply after reset.

## Review Focus
- Missing/false consent must fail closed.
- Stale/malformed broker equity must fail closed before drawdown baseline reset.
- Non-daily-loss/non-drawdown suspension must remain non-resettable.
- Authority generation fencing must survive resume.
- Ended-session reset must not invent or mutate historical P&L.

---

### Task 1: Atomic drawdown baseline resume
**Files:**
- Modify: `apps/api/src/modules/execution/execution.service.ts`
- Test: `apps/api/src/modules/execution/execution-session.authority.spec.ts`

- [ ] Add failing test proving `resumeRiskSuspendedSession(..., { resetPeakEquityTo })` rebases peak equity while reactivating and bumping authority.
- [ ] Implement optional peak reset in the existing CAS update.
- [ ] Run targeted execution authority tests.

### Task 2: User-confirmed risk reset service/API
**Files:**
- Modify: `apps/api/src/modules/trading/trading.service.ts`
- Modify: `apps/api/src/modules/trading/trading.controller.ts`
- Modify: `apps/api/src/common/enums/audit-action.enum.ts`
- Test: `apps/api/src/modules/trading/trading.service.spec.ts`

- [ ] Add failing tests for drawdown reset success, missing consent refusal, and ended-session drawdown reset.
- [ ] Implement explicit confirmation, fresh equity validation, daily-loss cutoff, drawdown rebase, and generic audit action.
- [ ] Run targeted trading tests.

### Task 3: Trader UI consent and reset/start flow
**Files:**
- Modify: `apps/web/src/lib/trader-session.ts`
- Test: `apps/web/src/lib/trader-session.spec.ts`
- Modify: `apps/web/src/app/trade/page.tsx`

- [ ] Add failing client/helper tests for max-drawdown reset eligibility and confirmed request bodies.
- [ ] Rename user-facing reset flow to risk protection and offer it for either hard-risk code.
- [ ] Run full web tests/build, API tests/build, then deploy staging.
