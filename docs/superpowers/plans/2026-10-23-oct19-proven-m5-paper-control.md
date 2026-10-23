# Oct 19 Proven M5 PAPER Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a clean forward PAPER control using the exact M5 route families that produced the verified 2026-10-19 10-trade, 9W/1L, +$34.02 cohort, while retaining the current stronger profit-protection and post-loss safeguards.

**Architecture:** Preserve current `main` model scoring, risk, sizing, entry-alignment, stop/target, early-loss and 1-second profit-protection behavior. Keep route classification intact. Permit the three verified M5 route families (`NORMAL_PAPER`, `PAPER_RESEARCH_THROUGHPUT` using the current v11 artifact, and `PAPER_EXTENSION_EXHAUSTION_RESEARCH`) to reach execution only after all current guards pass. Keep rejected-edge canary and paired-reversal shadow-only. M1 remains SHADOW under the already-merged M5-focus policy.

**Tech Stack:** NestJS/TypeScript, Jest, GitHub Actions, PostgreSQL-backed release gates.

**Spec:** User-approved Friday-baseline control experiment in this conversation.

## Global Constraints

- PAPER only; do not widen DEMO/LIVE authority.
- Do not lower confidence, expected-R, drift, event-risk, risk, sizing, or broker safety thresholds.
- Retain current 1-second PAPER protection heartbeat and 70/75/80/85/90% profit-retention ladder.
- Retain current entry-market alignment and early thesis-failure/time-to-work protection.
- Research scorers/evidence remain active; only their execution authority is quarantined.

## Review Focus

- `NORMAL_PAPER` must remain executable.
- Current v11 `PAPER_RESEARCH_THROUGHPUT` must remain executable only after calibration, pair-side, episode, portfolio-loss, cost, and post-loss guards pass.
- `PAPER_EXTENSION_EXHAUSTION_RESEARCH` must remain executable only through its existing guarded half-risk path.
- Explicit rejected-edge canary execution must not bypass the control.
- Paired-reversal research must remain shadow-only.
- M1 Tactical must remain SHADOW.

---

### Task 1: Pin the proven M5 cohort with an execution-authority regression

**Files:**
- Create: `apps/api/src/modules/ai/oct19-proven-m5-paper-control.spec.ts`

**Interfaces:**
- Consumes: `selectPaperExecutionRoute()`.
- Produces: regression proof that only the three provenance-verified Oct 19 M5 route families may execute during the control.

- [x] **Step 1: Write the failing test** covering normal PAPER and all four non-normal execution routes.
- [x] **Step 2: Confirm current main has no provenance boundary and permits paired-reversal execution outside the proven cohort.**

### Task 2: Enforce the provenance boundary without removing later safeguards

**Files:**
- Modify: `apps/api/src/modules/ai/paper-research-throughput.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`

**Interfaces:**
- Consumes: existing route classification and research-evidence pipeline unchanged.
- Produces: a final provenance predicate allowing `NORMAL_PAPER`, current v11 `PAPER_RESEARCH_THROUGHPUT`, and `PAPER_EXTENSION_EXHAUSTION_RESEARCH`; canary and paired-reversal stay shadow-only.

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
