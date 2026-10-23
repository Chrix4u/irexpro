# Friday Baseline PAPER Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a clean forward PAPER control using the proven Friday core entry path while retaining the current profit-protection improvements and keeping all exploratory execution shadow-only.

**Architecture:** Preserve current `main` model scoring, risk, sizing, entry-alignment, stop/target, early-loss and 1-second profit-protection behavior. Narrow only final PAPER route selection so `NORMAL_PAPER` is the sole route permitted to create an order; canary, research-throughput, extension-exhaustion and paired-reversal remain available for scoring/evidence but cannot execute.

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
- [ ] **Step 2: Run CI to verify current behavior fails the new quarantine assertions.**

### Task 2: Quarantine non-normal PAPER execution routes

**Files:**
- Modify: `apps/api/src/modules/ai/paper-research-throughput.ts`

**Interfaces:**
- Consumes: existing route eligibility inputs unchanged.
- Produces: `NORMAL_PAPER` when normal admission passes; otherwise `NONE`.

- [ ] **Step 1: Implement the minimal selector change without touching scoring/evidence functions.**
- [ ] **Step 2: Run focused and full API verification.**
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
