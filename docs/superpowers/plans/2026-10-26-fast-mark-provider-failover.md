# Fast-Mark Provider Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-symbol Deriv→Twelve Data fast-mark failover without claiming coverage for unentitled symbols.

**Architecture:** Run Twelve Data as an optional secondary while Deriv remains primary. Arbitration stays inside `LivePaperMarketDataService`: fresh Deriv wins; a fresh Twelve Data mark can replace Deriv only after Deriv is stale; Deriv reclaims priority on recovery.

**Tech Stack:** NestJS, TypeScript, Jest.

**Spec:** `docs/superpowers/designs/2026-10-26-fast-mark-provider-failover.md`

## Global Constraints

- PAPER fast-mark availability only.
- No trading thresholds, sizing, risk, SL/TP, DEMO/LIVE authority changes.
- Rejected Twelve Data symbols remain fail-closed.

## Review Focus

- Fresh primary is never displaced by secondary jitter.
- Stale primary permits entitled secondary takeover.
- Primary recovery reclaims the symbol.
- Secondary service starts only when failover is enabled.
- Existing single-provider behavior remains available when failover is disabled.

---

### Task 1: Provider arbitration

**Files:**

- Modify: `apps/api/src/modules/broker/services/live-paper-market-data.service.ts`
- Test: `apps/api/src/modules/broker/services/live-paper-market-data.service.spec.ts`

- [ ] Write RED tests for fresh Deriv priority, stale Deriv→Twelve Data takeover, and Deriv recovery.
- [ ] Implement minimal per-symbol arbitration.
- [ ] Run focused tests GREEN and commit.

### Task 2: Secondary service enablement

**Files:**

- Modify: `apps/api/src/config/configuration.ts`
- Modify: `apps/api/src/modules/broker/services/twelve-data-fast-mark-stream.service.ts`
- Test: `apps/api/src/modules/broker/services/twelve-data-fast-mark-stream.service.spec.ts`

- [ ] Write RED test: DERIV primary + failover enabled starts Twelve Data secondary; failover disabled preserves exclusive mode.
- [ ] Add `FAST_MARK_STREAM_FAILOVER_ENABLED` configuration and service enablement.
- [ ] Run focused tests GREEN and commit.

### Task 3: Verification

- [ ] Run broker fast-mark/provider suites.
- [ ] Run API build, touched-file lint/format, `git diff --check`.
- [ ] Push PR and require exact-head API/concurrency/security/Required CI before merge/deploy.
