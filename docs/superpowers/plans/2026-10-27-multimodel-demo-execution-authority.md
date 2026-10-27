# Multi-Model DEMO Execution Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing multi-model ensemble, not the M1 route rollout, the primary cTrader DEMO execution authority while retaining M1 as a timing specialist and all downstream risk controls.

**Architecture:** Keep `M1TacticalSchedulerService` as the single broker dispatcher. Add a reusable broker-native trained-expert adapter and a pure multi-model DEMO authority function; in the V8 DEMO phase, score Plan-B + trained three-expert consensus + generic governance and use that quorum instead of `m1RouteExecutableInPhase`.

**Tech Stack:** NestJS/TypeScript, Jest, Python FastAPI/XGBoost scorer (existing), PostgreSQL evidence, cTrader broker adapter.

**Spec:** `docs/superpowers/specs/2026-10-27-multimodel-demo-execution-authority-design.md`

## Global Constraints
- DEMO only; LIVE execution policy must remain unchanged.
- One broker dispatcher per active session.
- Exact active broker connection for both market evidence and order dispatch.
- Frozen Plan-B v4 128-feature model contract and thresholds are unchanged.
- Existing risk, spread, drift, macro-event, allocation, sizing, margin and currency-exposure gates remain authoritative.
- Fail closed when trained-model or broker-native evidence is unavailable.

## Review Focus
- Trained scorer unavailable/stale/mixed-source must block DEMO execution.
- Trained scorer direction conflict must block even when Plan-B admits.
- M1 trend/reversal route must no longer be rejected solely by rollout phase when multi-model quorum passes.
- PAPER phases must retain their historical route-specific behavior.
- LIVE sessions must never gain authority from this DEMO promotion.

---

### Task 1: Pure DEMO multi-model authority

**Files:**
- Create: `apps/api/src/modules/ai/multimodel-demo-authority.ts`
- Create: `apps/api/src/modules/ai/multimodel-demo-authority.spec.ts`

**Interfaces:**
- Consumes: `PlanBEnsembleScore`, `EnsembleGovernanceDecision`, `HighConvictionOverlay`.
- Produces: `evaluateMultimodelDemoAuthority(input): MultimodelDemoAuthorityDecision` and `m1CandidateToPlanBInput(...)`.

- [ ] Write failing tests for CONFIRM/admitted/governance pass, trained conflict, trained unavailable, Plan-B rejection, governance rejection, and M1 trend/reversal routes not being phase-blocked.
- [ ] Run the focused test and verify RED.
- [ ] Implement the pure conversion/quorum functions without changing model thresholds.
- [ ] Run the focused test and verify GREEN.

### Task 2: Broker-native trained expert adapter

**Files:**
- Create: `apps/api/src/modules/ai/high-conviction-broker-expert.service.ts`
- Create: `apps/api/src/modules/ai/high-conviction-broker-expert.service.spec.ts`
- Modify: `apps/api/src/modules/ai/ai.module.ts`

**Interfaces:**
- Consumes: `AiEngineClient.scorePlanBV4ChallengerBroker`, exact user/connection/instrument/direction/decision time.
- Produces: `evaluate(...) -> Promise<HighConvictionOverlay>` with no broker-family restriction.

- [ ] Write failing tests proving cTrader connection IDs are accepted and response provenance/freshness is still classified fail-closed.
- [ ] Run and verify RED.
- [ ] Implement and register the service.
- [ ] Run and verify GREEN.

### Task 3: Promote ensemble quorum inside the single M1 dispatcher

**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 authority helper and Task 2 trained expert adapter.
- Produces: DEMO candidate execution eligibility based on multi-model quorum; PAPER behavior unchanged.

- [ ] Add failing tests: V8 Trend Continuation executes when Plan-B + trained expert + governance pass; conflict/unavailable blocks; exact FULL_AUTO connection enforced; PAPER route phases unchanged.
- [ ] Run and verify RED.
- [ ] Wire broker-native Plan-B scoring, portfolio snapshot, trained overlay and generic governance into the DEMO path.
- [ ] Keep M1 route/reliability evidence in decision metadata but remove `M1_PHASE_ROUTE_SHADOW` as the V8 DEMO authority blocker.
- [ ] Send model metadata as `irexpro-multimodel-ensemble-v1` with M1 timing details preserved.
- [ ] Run and verify GREEN.

### Task 4: Truthful runtime status/UI contract

**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.controller.ts` if endpoint mapping needs fields.
- Modify: `apps/web/src/lib/vps-scanner-status.ts`
- Modify: `apps/web/src/app/trade/page.tsx`
- Tests: matching API/web specs.

**Interfaces:**
- Produces: primary engine code, authority mode, latest trained-expert state/votes, Plan-B score, M1 timing route.

- [ ] Write failing contract/UI tests for `Multi-model ensemble · ACTIVE` and current quorum fields.
- [ ] Run and verify RED.
- [ ] Implement additive status fields and customer-facing labels without exposing credentials/internal identifiers.
- [ ] Run and verify GREEN.

### Task 5: Full verification and deployment

**Files:** no product changes unless verification exposes a defect.

- [ ] Run relevant API suites plus TypeScript typecheck and production build.
- [ ] Run relevant web suites plus typecheck and production build.
- [ ] Run Python high-conviction challenger/model-route tests.
- [ ] Verify no LIVE execution policy files were changed.
- [ ] Commit the isolated branch.
- [ ] Integrate verified files into the staging checkout, build/restart API and web, and verify HTTP health.
- [ ] Inspect fresh cTrader scheduler decisions to confirm primary engine is multi-model and there is only one dispatch owner.
