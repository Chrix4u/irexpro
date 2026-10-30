# Execution Spread Observation Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Count actual broker quote observations for execution-spread maturity while preserving the five-minute stale-quote veto.

**Architecture:** Change only the SQL aggregation in `loadExecutionSpreadEvidence()`. No governance constant, spread percentile, freshness threshold, execution authority, or risk rule changes.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL.

**Spec:** `docs/superpowers/designs/2026-10-30-execution-spread-sample-count.md`

## Global Constraints
- Preserve `ENSEMBLE_EXECUTION_SPREAD_MIN_SAMPLES=10`.
- Preserve `ENSEMBLE_EXECUTION_SPREAD_MAX_AGE_MS=5 minutes`.
- Stale broker quotes remain fail-closed regardless of accumulated sample count.
- Historical OHLC rows with null spread remain excluded by `spread_close > 0`.

## Review Focus
- Do not count historical cTrader trendbars as live spread observations.
- Do not use database `updated_at` as market freshness; provider `last_sample_at` stays authoritative.
- Do not change P90 cost calculation.
- Do not alter any PAPER/DEMO/LIVE authority.

---

### Task 1: Use live observation counts in spread evidence

**Files:**
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`

- [ ] Add a failing SQL-shape assertion requiring `SUM(positive.sample_count)` and rejecting row-count maturity.
- [ ] Run the focused test and verify RED.
- [ ] Add `sample_count` to the positive CTE and sum it in the final select.
- [ ] Run collector and governance focused tests.
- [ ] Run relevant AI regression and API build.
- [ ] Review diff, commit, deploy API only, and verify post-deploy telemetry/source control.
