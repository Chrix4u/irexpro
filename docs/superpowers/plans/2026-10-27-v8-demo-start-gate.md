# V8 DEMO Start Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permit the scanner-owned V8 user to start an exact validated real-provider DEMO session in FULL_AUTO while keeping LIVE and unintended broker/mode combinations fail-closed.

**Architecture:** `TradingController` resolves mode and delegates. `TradingService` enforces the scanner-specific execution authority after resolving the exact broker connection, because only the service has authoritative broker environment and validation state. Existing V8 scheduler/model/risk gates remain unchanged.

**Tech Stack:** NestJS, TypeScript, Jest, TypeORM/PostgreSQL

**Spec:** `docs/superpowers/specs/2026-10-27-v8-demo-start-gate.md`

## Global Constraints
- LIVE remains disabled for this promotion.
- No direct database mutation to grant execution authority.
- Generic non-scanner users retain current behavior.
- Exact PAPER_ONLY research binding remains valid.
- DEMO FULL_AUTO requires non-paper DEMO + validated + ACTIVE authorization + liveTradingEnabled=false.

## Review Focus
- Scanner user attempts FULL_AUTO on LIVE: must reject before session creation.
- Scanner user attempts FULL_AUTO on unvalidated/inactive DEMO: must reject.
- Scanner user uses exact configured PAPER connection in PAPER_ONLY: must pass.
- Ordinary user starts existing supported mode: must remain unchanged.
- Scanner user chooses another connection in PAPER_ONLY: must reject.

---

### Task 1: Service-level V8 execution authority

**Files:**
- Modify: `apps/api/src/modules/trading/trading.service.ts`
- Modify: `apps/api/src/modules/trading/trading.service.spec.ts`

**Interfaces:**
- Consumes: resolved `BrokerConnection`, `ExecutionMode`, `vpsForexScanner.*` configuration.
- Produces: private scanner authority guard called by `startTradingSession` before allocation/session creation.

- [ ] **Step 1: Write failing tests** for scanner-owned validated DEMO FULL_AUTO acceptance and LIVE/unvalidated DEMO rejection.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement the minimal service-level scanner authority guard.**
- [ ] **Step 4: Run focused tests and verify GREEN.**
- [ ] **Step 5: Commit.**

### Task 2: Remove obsolete controller-only start lock

**Files:**
- Modify: `apps/api/src/modules/trading/trading.controller.ts`
- Modify: `apps/api/src/modules/trading/trading.controller.paper-authority.spec.ts`

**Interfaces:**
- Consumes: `TradingService.startTradingSession` authority enforcement from Task 1.
- Produces: controller start path that delegates exact connection/mode authority to the service.

- [ ] **Step 1: Update controller tests** so the promoted DEMO FULL_AUTO request delegates to the service while PAPER_ONLY exact binding remains unchanged.
- [ ] **Step 2: Verify tests fail with the legacy controller lock.**
- [ ] **Step 3: Remove only the obsolete start-time scanner lock; retain mode-change safety behavior.**
- [ ] **Step 4: Run controller/service tests and verify GREEN.**
- [ ] **Step 5: Commit.**

### Task 3: Release verification and staging promotion

**Files:**
- No new production files.

- [ ] **Step 1: Run changed-file ESLint and `git diff --check`.**
- [ ] **Step 2: Run trading, strategy-orchestrator, M1 scheduler and cTrader validation focused suites.**
- [ ] **Step 3: Build API.**
- [ ] **Step 4: Push branch and deploy exact verified commit to staging.**
- [ ] **Step 5: Call `enableDemoTrading` through `BrokerService`, start FULL_AUTO through `TradingService`, and verify active session is DEMO/cTrader with LIVE disabled.**
- [ ] **Step 6: Verify V8 scheduler logs use the active FULL_AUTO cTrader connection and no new validation exposure exists.**
