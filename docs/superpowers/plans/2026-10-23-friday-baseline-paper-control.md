# Friday Baseline PAPER Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a clean forward PAPER control using the proven Friday core entry path while retaining the current profit-protection improvements and keeping all exploratory execution shadow-only.

**Architecture:** Preserve current `main` model scoring, risk, sizing, entry-alignment, stop/target, early-loss and 1-second profit-protection behavior. Keep route classification intact for research/evidence, then add a final execution-authority boundary before adaptive ranking/dispatch so only `NORMAL_PAPER` may create an order; canary, research-throughput, extension-exhaustion and paired-reversal remain fully scored and persisted but cannot execute.

**Tech Stack:** NestJS/TypeScript, Jest, GitHub Actions, PostgreSQL-backed release gates.

**Spec:** User-approved Friday-baseline control experiment in this conversation.

## Global Constraints

- PAPER only; do not widen DEMO/LIVE authority.
- Do not lower confidence, expected-R, drift, event-risk, risk, sizing, or broker safety thresholds.
- Retain current 1-second PAPER protection heartbeat and 70/75/80/85/90% profit-retention ladder.
- Retain current entry-market alignment and early thesis-failure/time-to-work protection.
- Research scorers/evidence remain active; only their execution authority is quarantined.

## Review Focus

- `NORMAL_PAPER=true` must still execute as `NORMAL_PAPER`.
- Explicit rejected-edge canary enablement must not bypass the control.
- Research-throughput eligibility must not create a PAPER order.
- Extension-exhaustion research eligibility must not create a PAPER order.
- Paired-reversal research eligibility must not create a PAPER order.

---

### Task 1: Pin the control with a failing route regression

**Files:**
- Create: `apps/api/src/modules/ai/friday-baseline-paper-control.spec.ts`

**Interfaces:**
- Consumes: `selectPaperExecutionRoute()`.
- Produces: regression proof that only `NORMAL_PAPER` may execute during the control.

- [x] **Step 1: Write the failing test** covering normal PAPER and all four non-normal execution routes.
- [x] **Step 2: Run the regression against current behavior and confirm RED (4 failures / 1 pass).**

### Task 2: Quarantine non-normal PAPER execution routes

**Files:**
- Modify: `apps/api/src/modules/ai/paper-research-throughput.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`

**Interfaces:**
- Consumes: existing route classification and research-evidence pipeline unchanged.
- Produces: a final pure authority predicate where only `NORMAL_PAPER` may enter adaptive execution ranking/dispatch; all other routes stay shadow-only.

- [x] **Step 1: Implement the minimal final-dispatch authority boundary without disabling scoring/evidence.**
- [x] **Step 2: Run focused trading verification (164/164) and protection verification (113/113).**
- [ ] **Step 3: Verify build, lint, PostgreSQL concurrency and release security.**

### Task 3: Release and forward-test the exact candidate

**Files:**
- No further production files unless verification finds a root-cause defect.

**Interfaces:**
- Consumes: exact green PR head.
- Produces: exact-main staging deployment and runtime evidence for the clean baseline cohort.

- [ ] **Step 1: Merge only after exact-head required gates are green.**
- [ ] **Step 2: Verify Main Staging Release Gate and exact-SHA staging deployment/health.**
- [ ] **Step 3: Inspect runtime diagnostics and confirm non-normal research routes do not execute while protection remains healthy.**
