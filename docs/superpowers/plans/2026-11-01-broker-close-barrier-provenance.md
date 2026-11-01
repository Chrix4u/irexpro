# Broker Close Barrier Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclassify broker-generic closes as SL/TP only when authoritative exit price and valid barrier geometry prove the outcome, including an idempotent historical backfill.

**Architecture:** Keep explicit provider reasons authoritative in `ReconciliationResolutionService`. Add a pure barrier-inference helper used only as fallback for generic provider reasons, then mirror those rules in a data migration for existing rows.

**Tech Stack:** TypeScript, NestJS, TypeORM migrations, Jest, PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-11-01-broker-close-barrier-provenance-design.md`

## Global Constraints
- Explicit provider SL/TP/PROFIT_LOCK/TIME_TO_WORK reasons override inference.
- Inference requires valid entry/SL/TP geometry and a positive provider close price.
- One-pip tolerance: 0.01 for JPY pairs; 0.0001 otherwise.
- Ambiguous or between-barrier closes remain BROKER_CLOSE.
- No P&L, price, execution or trading-policy mutation.

## Review Focus
- BUY and SELL stop-loss inference at and just inside one-pip tolerance.
- BUY and SELL take-profit inference at and just inside one-pip tolerance.
- Explicit provider reason must override contradictory price geometry.
- Missing/invalid barrier geometry must remain BROKER_CLOSE.
- Historical migration must be idempotent and leave unprovable rows unchanged.

---

### Task 1: Future reconciliation classification

**Files:**
- Modify: `apps/api/src/modules/execution/reconciliation/reconciliation-resolution.service.ts`
- Modify: `apps/api/src/modules/execution/reconciliation/reconciliation-resolution.service.spec.ts`

**Interfaces:**
- Produces: generic provider close -> proven `STOP_LOSS_HIT` / `TAKE_PROFIT_HIT` or conservative `BROKER_CLOSE`.

- [ ] Write failing tests for BUY/SELL SL, BUY/SELL TP, explicit-reason precedence, invalid geometry, and between-barrier fallback.
- [ ] Run focused Jest and verify RED.
- [ ] Implement a pure barrier-provenance helper and call it only when provider reason is generic and there is no app-close-intent fallback.
- [ ] Run focused Jest and verify GREEN.
- [ ] Commit.

### Task 2: Historical idempotent backfill

**Files:**
- Create: `apps/api/src/database/migrations/1793495100000-BackfillBrokerCloseBarrierReasons.ts`
- Create: `apps/api/src/database/broker-close-barrier-provenance-migration.spec.ts`

**Interfaces:**
- Produces: SQL migration that changes only provable `BROKER_CLOSE` rows.

- [ ] Write migration-contract tests for SL, TP, valid geometry, one-pip tolerance, and idempotent `close_reason = 'BROKER_CLOSE'` scoping.
- [ ] Run focused migration test and verify RED.
- [ ] Implement the migration with two guarded UPDATE statements; `down()` is a no-op because provenance cannot safely be erased once corrected.
- [ ] Run focused migration test and verify GREEN.
- [ ] Commit.

### Task 3: Verification and staging rollout

- [ ] Run reconciliation, migration, execution and reporting regressions.
- [ ] Run API TypeScript check and production build.
- [ ] Run `git diff --check`.
- [ ] Apply migration on staging and verify the current 53 generic broker closes become 50 STOP_LOSS_HIT, 2 TAKE_PROFIT_HIT and 1 BROKER_CLOSE without P&L changes.
- [ ] Restart API only if required by code deployment; verify health and logs.
