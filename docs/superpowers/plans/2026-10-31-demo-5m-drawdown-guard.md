# cTrader DEMO 5-Minute Drawdown Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce severe cTrader DEMO losers that remain open five minutes after entry, using broker-native causal evidence and the existing idempotent close path.

**Architecture:** Add an AI-module service that scans only OPEN cTrader DEMO multimodel trades in a narrow 5–7 minute action window, obtains the existing v8.5 broker-native 5-minute checkpoint, and closes only when `current_r <= -0.40`. Persist a dedicated observation artifact for explainability and idempotent terminal handling.

**Tech Stack:** NestJS, TypeScript, PostgreSQL, existing AiEngineClient and ExecutionService, Jest.

**Spec:** `docs/superpowers/designs/2026-10-31-demo-5m-drawdown-guard.md`

## Global Constraints
- DEMO-only account filter is mandatory in the candidate SQL.
- Only cTrader-family broker IDs are eligible.
- Only `external_provider_code=irexpro-multimodel-ensemble-v1` OPEN trades are eligible.
- Five-minute checkpoint only; action deadline is seven minutes after open.
- Threshold is exactly `current_r <= -0.40`.
- All closes flow through `ExecutionService.closeTrade(..., AI_CLOSE_SIGNAL)`.
- LIVE must be impossible even if environment configuration is wrong.

### Task 1: Add pure timing/threshold policy
**Files:**
- Create: `apps/api/src/modules/ai/post-entry-demo-drawdown-guard.service.ts`
- Create: `apps/api/src/modules/ai/post-entry-demo-drawdown-guard.service.spec.ts`

- [ ] Write RED tests for 5–7 minute eligibility and -0.40R threshold.
- [ ] Implement pure functions/constants and rerun focused tests.

### Task 2: Add DEMO candidate/scoring/close orchestration
**Files:**
- Modify same service/spec.
- Modify: `apps/api/src/modules/ai/ai.module.ts`

- [ ] Test candidate SQL contains cTrader broker and `account_type='DEMO'`, OPEN, multimodel, narrow timing window, and terminal observation exclusion.
- [ ] Test READY currentR above threshold persists NO_ACTION and never calls ExecutionService.
- [ ] Test READY currentR <= -0.40 calls `closeTrade` once with `AI_CLOSE_SIGNAL` and persists closed audit evidence.
- [ ] Test WAITING/ERROR score cannot close.
- [ ] Test close failure is recorded fail-closed and does not mark a successful close.
- [ ] Register service in AiModule.

### Task 3: Verify and deploy
- [ ] Focused drawdown-guard tests.
- [ ] Existing v8.5 shadow + minute1 telemetry tests.
- [ ] Execution close-path focused tests.
- [ ] `pnpm --filter @irexpro/api exec tsc --noEmit`.
- [ ] `pnpm --filter @irexpro/api build`.
- [ ] Merge to staging only after fresh verification, push, restart API only, verify health and startup authority log.
