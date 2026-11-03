# Execution Spread Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist fresh entry spread evidence for new trades and report an estimated account-currency spread cost without changing execution behavior or double-counting P&L.

**Architecture:** Reuse the BrokerPrice already validated by MarketSafetyGateService, carry it through the FILLED provider outcome, persist raw quote telemetry at OPEN, and calculate spread-cost telemetry best-effort after the durable transition. Reporting aggregates only measured rows and exposes coverage; net P&L formulas remain unchanged.

**Tech Stack:** NestJS, TypeScript, TypeORM/PostgreSQL, React/Next.js, Jest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-03-execution-spread-telemetry-design.md`

## Global Constraints
- No extra broker quote call on NEW_EXPOSURE execution.
- No market quote call before CLOSE_POSITION.
- No changes to model/risk/admission/sizing/SL/TP/exit authority.
- Telemetry failures never block or regress a filled trade.
- Estimated spread cost is reporting-only and must never be subtracted from net realised P&L.
- Historical rows without quote evidence remain unmeasured.

## Review Focus
- Entry quote is propagated only from a market-safety-proven new-exposure quote.
- Invalid/crossed quote evidence produces no estimate and never throws into trade state handling.
- Third-currency conversion failure leaves estimated cost null while raw quote evidence remains durable.
- Mixed-currency report does not sum incompatible currencies.
- Net P&L/expectancy remain commission/swap-aware but spread estimate-neutral.

---

### Task 1: Quote provenance contract

**Files:**
- Modify: `apps/api/src/modules/execution/orchestration/market-safety-gate.service.ts`
- Modify: `apps/api/src/modules/execution/orchestration/market-safety-gate.spec.ts`
- Modify: `apps/api/src/modules/execution/orchestration/execution-intent.interface.ts`
- Modify: `apps/api/src/modules/execution/orchestration/execution-orchestrator.service.ts`
- Test: `apps/api/src/modules/execution/orchestration/execution-orchestrator.spec.ts`

**Interfaces:**
- Produces: `assertMarketSafeForDispatch(...): Promise<BrokerPrice>` for successful NEW_EXPOSURE checks.
- Produces: optional `executionQuote: BrokerPrice` on FILLED provider outcomes.

- [ ] Write tests that a fresh gate returns the exact quote and a FILLED new-exposure outcome carries that same quote.
- [ ] Run focused tests and observe RED.
- [ ] Implement quote return/propagation with zero additional broker reads.
- [ ] Run focused tests GREEN.
- [ ] Commit.

### Task 2: Durable spread telemetry and estimator

**Files:**
- Create: `apps/api/src/modules/execution/services/trade-spread-telemetry.service.ts`
- Create: `apps/api/src/modules/execution/services/trade-spread-telemetry.service.spec.ts`
- Create: `apps/api/src/database/migrations/1793700000000-AddTradeEntrySpreadTelemetry.ts`
- Modify: `apps/api/src/modules/execution/entities/trade.entity.ts`
- Modify: `apps/api/src/modules/execution/execution.module.ts`
- Modify: `apps/api/src/modules/execution/execution.service.ts`

**Interfaces:**
- Consumes: `executionQuote` from Task 1.
- Produces: best-effort raw entry quote persistence plus estimated account-currency spread cost.

- [ ] Test USD-quote direct cost: EURUSD spread 0.00020 × 100000 × 0.20 = 4.00 USD.
- [ ] Test base-currency conversion by entry midpoint and third-currency cached conversion.
- [ ] Test missing/invalid evidence returns null rather than throwing.
- [ ] Run estimator tests RED.
- [ ] Add nullable schema/entity fields and implement estimator with ExactDecimal.
- [ ] Persist raw quote at PENDING→OPEN and perform estimate enrichment only after OPEN is durable.
- [ ] Run estimator and execution focused tests GREEN.
- [ ] Commit.

### Task 3: API/report aggregation

**Files:**
- Modify: `apps/api/src/modules/execution/execution-read.service.ts`
- Modify: `apps/api/src/modules/execution/execution-read.trading-costs.spec.ts`
- Modify: `apps/api/src/modules/execution/dto/trade-execution-response.dto.ts`
- Modify: `packages/types/src/execution.ts`

**Interfaces:**
- Produces: `totalEstimatedSpreadCost` and `spreadCostEstimatedTradeCount` in currency/report summaries.
- Produces: per-trade entry spread evidence and estimated spread cost in frontend-safe DTO.

- [ ] Extend report regression to assert estimated spread sum/coverage and unchanged net P&L.
- [ ] Run focused test RED.
- [ ] Add aggregate SQL/DTO/type fields without touching net formula.
- [ ] Run focused test GREEN and API typecheck/build.
- [ ] Commit.

### Task 4: History UI and fallback contracts

**Files:**
- Modify: `apps/web/src/app/trade/history/page.tsx`
- Modify: `apps/web/src/lib/trader-execution.ts`
- Modify: `apps/web/src/lib/trader-execution.spec.ts`

**Interfaces:**
- Consumes: Task 3 report/type fields.
- Produces: Estimated spread cost card with measured-trade coverage and mixed-currency breakdown.

- [ ] Add/update frontend tests for new report contract and runtime validation.
- [ ] Run focused web tests RED.
- [ ] Replace placeholder Spread Impact card with estimated spread cost + coverage copy; show no-measurement state honestly.
- [ ] Run web tests, typecheck, and production build GREEN.
- [ ] Commit.

### Task 5: Whole-branch verification

- [ ] Run API CI, Risk Execution Concurrency, Release Security, Mobile CI/APK, UI E2E, and Required CI Gate on the exact final head.
- [ ] Review branch diff for unrelated paths and confirm net P&L formula did not acquire spread subtraction.
- [ ] Promote PR to review-ready only after exact-head green evidence.
