# M1 Durable PAPER Spread Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make M1 PAPER spread calibration restart-stable and independent of M5 candidate ordering while keeping existing conservative calibration and promotion rules.

**Architecture:** Extract the durable same-session spread-history query into a shared helper. M1 resolves the existing calibration rule directly from durable history, caches it per source/instrument/session, and seeds the PAPER execution cache before returning its market snapshot. M5 reuses the same helper with no intended semantic change.

**Tech Stack:** NestJS/TypeScript, TypeORM `DataSource`, Jest, PostgreSQL.

**Spec:** `docs/superpowers/designs/2026-10-26-m1-durable-paper-spread-calibration.md`

## Global Constraints
- Keep `PAPER_SPREAD_CALIBRATION_MIN_SAMPLES = 100` unchanged.
- Keep `PAPER_SPREAD_CALIBRATION_MIN_FIXED_FRACTION = 0.25` unchanged.
- Keep DEMO/LIVE spread evidence and promotion authority unchanged.
- Sparse/invalid durable history must fall back to static `PAPER_MARKET_SPECS` spread.
- Admission spread and PAPER execution fallback spread must match.

## Review Focus
- API restart with mature history must immediately restore the calibrated spread for every M1 pair on first snapshot.
- Sparse history must not receive an optimistic calibration.
- Cache keys must separate source connection, instrument, and UTC spread session.
- No configured broker-expert source must preserve static PAPER behavior.
- M5 calibration semantics must remain unchanged after query extraction.

---

### Task 1: Shared durable calibration-history loader

**Files:**
- Create: `apps/api/src/modules/ai/paper-spread-calibration-history.ts`
- Test: `apps/api/src/modules/ai/paper-spread-calibration-history.spec.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`

**Interfaces:**
- Produces: `loadPaperSpreadCalibrationHistory(dataSource, sourceConnectionId, instrument, evaluatedAt): Promise<PaperSpreadCalibrationHistory>`.

- [ ] Write tests proving same-session/21-day query parameters and fail-closed normalization.
- [ ] Run the new spec and verify RED.
- [ ] Implement the shared loader using the existing SQL semantics.
- [ ] Replace the collector's duplicated SQL body with the shared loader.
- [ ] Run loader + spread-calibration + relevant collector tests and verify GREEN.

### Task 2: Deterministic M1 PAPER calibration and execution-cache seeding

**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-market-data.service.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-market-data.binding.spec.ts`

**Interfaces:**
- Consumes: shared loader from Task 1 and existing `evaluatePaperSpreadCalibrationShadow()`.
- Produces: M1 PAPER snapshots whose `paperSimulationSpreadPrice` equals the value seeded into `LivePaperMarketDataService`.

- [ ] Add failing tests for mature P95 calibration, sparse-history static fallback, and per-pair/session query caching.
- [ ] Run the binding spec and verify RED.
- [ ] Add optional `DataSource`, source-connection lookup, calibration cache, and async PAPER snapshot resolution.
- [ ] Seed `setPaperFallbackSpread()` before returning the snapshot.
- [ ] Run binding + governance + live PAPER market tests and verify GREEN.

### Task 3: Verification and integration

**Files:**
- Modify only if formatting requires it: changed TypeScript files above.

- [ ] Run changed-file ESLint with zero errors.
- [ ] Run affected AI/market-data/PAPER broker suites.
- [ ] Run full `@irexpro/api` suite and build.
- [ ] Commit, push, open PR, and require all existing CI/security gates green.
- [ ] Merge only if merge-tree equals tested head tree; deploy merge SHA to staging.
- [ ] Verify `/health/live`, `/health/ready`, and post-restart M1 spread decisions from durable records.
