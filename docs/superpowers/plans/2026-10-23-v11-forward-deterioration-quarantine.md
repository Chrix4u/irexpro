# v11 Forward-Deterioration Quarantine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quarantine v11 PAPER research execution while preserving all of its shadow learning.

**Architecture:** Keep `selectPaperExecutionRoute()` and all research evaluators unchanged. Narrow the final authority predicate so only `NORMAL_PAPER` may enter executable ranking/dispatch. Update collector regressions to prove v11 remains eligible/evidenced but cannot call `receiveSignal`.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL shadow decision ledger.

**Spec:** `docs/superpowers/designs/2026-10-23-v11-forward-deterioration-quarantine.md`

## Global Constraints
- `NORMAL_PAPER` remains executable.
- v11 research scoring/evidence stays active.
- Extension-exhaustion, canary and paired-reversal remain shadow-only.
- No confidence, expected-R, drift, event, sizing, broker, DEMO or LIVE gate is loosened.

## Review Focus
- v11 eligibility must not call `receiveSignal`.
- v11 shadow evidence must still be persisted.
- calibrated spread/cost evidence must still be collected.
- NORMAL_PAPER execution remains unaffected.
- no quarantined route may become executable indirectly.

---

### Task 1: Final authority regression
- [x] Change v11 control expectation to shadow-only.
- [x] Verify RED: current authority returns true.
- [x] Narrow final authority to `NORMAL_PAPER` only.
- [x] Verify focused control suite GREEN (6/6).

### Task 2: Collector regression alignment
- [x] Update v11 collector cases to require zero dispatched signals while preserving eligibility/evidence assertions.
- [ ] Run exact-head GitHub API, concurrency, security and required CI.
- [ ] Merge with pinned head only after all required gates are green.
- [ ] Verify exact merged SHA staging deployment and runtime health.
