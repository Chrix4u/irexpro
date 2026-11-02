# Direction Side-Selection Mirrored-Path Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run a read-only causal audit that labels executed trades as KEEP, FLIP, ABSTAIN or UNRESOLVED using same-entry mirrored price-path replay, then summarizes only pre-entry patterns.

**Architecture:** Add one CommonJS operational audit runner, following the existing shadow-audit pattern, and one Jest runner spec. The SQL loads executed trade geometry, pre-entry intent metadata, and the next 72 persisted M5 candles. JavaScript mirrors stop/target geometry and delegates first-hit resolution to the existing ensemble shadow outcome resolver.

**Tech Stack:** Node.js, CommonJS operational runner, PostgreSQL, Jest/ts-jest, existing API build artifacts, `resolveEnsembleShadowOutcome`, and DB TLS helper.

**Spec:** `docs/superpowers/specs/2026-11-02-direction-side-selection-audit-design.md`

## Global Constraints
- Audit is read-only and uses `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`.
- Post-entry candles are label-only; no post-entry quantity is emitted as a predictive feature.
- Mirrored trade uses the same fill price, risk distance, reward distance and execution-cost R as the original trade.
- `executionAuthority` is `NONE`; `modifiesExecution`, `qualificationEvidence`, and `productionEligible` are all false.
- No credentials or scope IDs in the report.

## Review Focus
- BUY and SELL geometry mirrors exactly around the original entry.
- Winners remain KEEP without unnecessary counterfactual replay.
- Losing trades become FLIP only when mirrored TP wins; mirrored SL becomes ABSTAIN.
- Missing geometry, ambiguous/expired results and insufficient candles remain UNRESOLVED.
- Missing metadata falls into stable `UNKNOWN`/`UNAVAILABLE` buckets.
- The audit rolls back on scope/query failure.

---

### Task 1: Mirrored-path label and pattern audit runner

**Files:**
- Create: `apps/api/scripts/audit-direction-side-selection.cjs`
- Create: `apps/api/src/modules/ai/direction-side-selection-audit-runner.spec.ts`

- [x] **Step 1: Write the failing runner tests** covering mirrored BUY/SELL geometry, KEEP/FLIP/ABSTAIN/UNRESOLVED labels, M5 SQL, metadata buckets, no scope leakage, and rollback.
- [x] **Step 2: Verify RED** against the previous opposite-shadow implementation.
- [x] **Step 3: Implement the minimal read-only runner** using 72 M5 candles and the existing first-hit resolver.
- [x] **Step 4: Run the new spec and verify GREEN.**
- [ ] **Step 5: Run relevant audit/shadow regressions plus lint/build/diff checks.**
- [ ] **Step 6: Commit Task 1.**

### Task 2: Operational evidence review

- [x] **Step 1: Run the audit against the current cTrader execution connection.**
- [x] **Step 2: Confirm the mirrored label coverage is sufficient for analysis.**
- [x] **Step 3: Review FLIP vs ABSTAIN by pair, route, reliability and trained-expert relation.**
- [ ] **Step 4: Record findings without changing execution authority.**
- [ ] **Step 5: Commit documentation/report adjustments.**

### Task 3: Next model phase (separate implementation)

- [ ] Build a larger shadow-opportunity dataset with the same KEEP/FLIP/ABSTAIN target semantics.
- [ ] Train/evaluate with purged walk-forward splits and a fresh future holdout.
- [ ] Require the existing profitability/robustness gates before any DEMO authority is proposed.
