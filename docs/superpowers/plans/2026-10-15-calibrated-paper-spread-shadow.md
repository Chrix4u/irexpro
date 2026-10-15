# Calibrated PAPER Spread Shadow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a shadow-only calibrated PAPER spread observer that compares fixed simulator spread/cost with conservative broker-history-derived spread/cost, without changing any execution or qualification authority.

**Architecture:** A pure calibrator consumes broker spread history statistics and returns a conservative per-pair/session estimate with artifact/version, confidence state, and fixed-vs-calibrated delta. The collector loads only historical broker-native spread observations, computes the shadow estimate, and persists it inside each ensemble shadow decision. Existing `paperSimulationSpreadPrice` remains authoritative for PAPER execution and governance.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL JSONB, existing `provider_quote_candles` and `ensemble_shadow_decisions` tables.

**Spec:** Approved in-chat on 2026-10-15: shadow-first calibrated PAPER spread model; compare against current fixed-spread baseline; zero execution authority; DEMO/LIVE unchanged.

## Global Constraints
- The calibrated spread observer must never alter `paperSimulationSpreadPrice`, `estimatedExecutionCostR`, route admission, lot sizing, risk gates, or execution.
- DEMO/LIVE market-data and execution behavior remain unchanged.
- Historical broker spread observations must be positive and broker-native; stale history may inform shadow calibration but never promotion/execution evidence.
- The observer must be conservative: use at least P95 and a minimum sample floor; sparse evidence falls back to the current fixed PAPER spread for comparison only.
- Persist explicit `executionAuthority: NONE`, `modifiesExecution: false`, and `qualificationEvidence: false`.

## Review Focus
- Sparse/invalid history cannot create optimistic spread estimates.
- Outlier-heavy history cannot collapse spread below a conservative floor.
- Session bucketing must be deterministic from evaluated UTC time.
- Fixed PAPER spread remains the only executed simulation spread.
- Stored shadow metadata is sufficient to compare cost rejection rates prospectively.

---

### Task 1: Pure calibrated spread observer
**Files:** Create `apps/api/src/modules/ai/paper-spread-calibration-shadow.ts`; create matching spec.
**Interfaces:** `evaluatePaperSpreadCalibrationShadow(input)` returns calibrated spread, fixed spread, sample count, source percentile, session bucket, cost delta inputs, and immutable no-authority flags.
- [x] Write failing tests for healthy evidence, sparse evidence fallback, invalid evidence fallback, conservative minimum floor, and deterministic session bucket.
- [x] Verify RED.
- [x] Implement minimal evaluator.
- [x] Verify GREEN.

### Task 2: Historical broker spread loader + shadow persistence
**Files:** Modify `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`; modify collector spec.
**Interfaces:** Load per-pair/session historical positive broker spreads from `market_data.provider_quote_candles`; compute P95 with sample count; persist observer in `components.paperSpreadCalibrationShadow` without touching governance input.
- [x] Add failing integration tests proving persisted observer metadata and unchanged authoritative `paperSimulationSpreadPrice` behavior.
- [x] Verify RED.
- [x] Implement loader, observer call, and persistence only.
- [x] Verify GREEN.

### Task 3: Verification
- [x] Run observer + collector tests, API typecheck/build, `git diff --check`.
- [x] Review authority boundaries and commit.
