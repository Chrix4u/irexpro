# Profit Protection Exit Quality Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the durable profit-protection counterfactual evidence as a tenant-safe user report with server-owned calculations and a filterable web view.

**Architecture:** Add a dedicated read-only trading report service/controller that joins authoritative trades to research-only counterfactual observations. The web page calls that API and formats the server response without recomputing trading metrics.

**Tech Stack:** NestJS, TypeORM/DataSource SQL, Jest, Next.js/React, existing iRexPro API client, CSS.

**Spec:** `docs/superpowers/designs/2026-10-31-profit-protection-exit-quality-report.md`

## Global Constraints
- Read-only; no execution or policy mutation.
- Every SQL query must require the authenticated `userId`.
- Monetary totals may be combined only inside one proven account currency.
- Counterfactual R is theoretical research evidence, never realised P&L.
- Page size is capped at 100.

## Review Focus
- Cross-user leakage: tests must prove `t.user_id = $userId` is mandatory.
- Cross-currency rows: aggregate realised P&L must be null while per-currency totals remain available.
- Invalid or zero stop distance: theoretical counterfactual R/R delta must be null.
- Ambiguous/data-gap/neither outcomes: no invented counterfactual R.
- Filter/pagination changes: summary must continue to cover the whole filtered set, not only the current page.

---

### Task 1: Backend report contract and calculations

**Files:**
- Create: `apps/api/src/modules/trading/profit-protection-exit-quality.service.ts`
- Create: `apps/api/src/modules/trading/profit-protection-exit-quality.service.spec.ts`

**Interfaces:**
- Produces `getReport(userId, query)` returning `{ summary, routes, items, page, pageSize, total, totalPages }`.

- [ ] Write failing tests for mandatory user scoping, filters, currency handling, R calculations, and pagination.
- [ ] Run focused Jest and verify RED.
- [ ] Implement parameterized SQL + pure calculation helpers.
- [ ] Run focused Jest and verify GREEN.
- [ ] Commit.

### Task 2: Authenticated report endpoint

**Files:**
- Create: `apps/api/src/modules/trading/trading-reports.controller.ts`
- Create: `apps/api/src/modules/trading/trading-reports.controller.spec.ts`
- Modify: `apps/api/src/modules/trading/trading.module.ts`

**Interfaces:**
- Produces `GET /trading/reports/profit-protection-exit-quality`.

- [ ] Write failing controller/module tests proving CurrentUserId is passed to the report service and no public/internal guard bypass is introduced.
- [ ] Run focused Jest and verify RED.
- [ ] Implement controller registration and query forwarding.
- [ ] Run focused Jest and verify GREEN.
- [ ] Commit.

### Task 3: Web API adapter

**Files:**
- Create: `apps/web/src/lib/profit-protection-exit-quality.ts`
- Create: `apps/web/src/lib/profit-protection-exit-quality.spec.ts`

**Interfaces:**
- Produces `loadProfitProtectionExitQuality(query)` and frontend-safe report types.

- [ ] Write failing tests for query serialization and response validation.
- [ ] Run web Jest and verify RED.
- [ ] Implement adapter against shared authenticated `api` client.
- [ ] Run web Jest and verify GREEN.
- [ ] Commit.

### Task 4: Exit Quality report page

**Files:**
- Create: `apps/web/src/app/trade/history/profit-protection/page.tsx`
- Create: `apps/web/src/app/trade/history/profit-protection/profit-protection.css`
- Create: `apps/web/src/app/trade/history/profit-protection/page.spec.tsx`
- Modify: `apps/web/src/app/trade/history/page.tsx`

**Interfaces:**
- Consumes `loadProfitProtectionExitQuality(query)`.
- Produces `/trade/history/profit-protection` and a link from Closed Trade History.

- [ ] Write failing rendering/interaction tests for summary cards, research disclaimer, filters, route table, detail rows and pagination.
- [ ] Run web Jest and verify RED.
- [ ] Implement the page using existing DashboardShell/UI components and history formatting conventions.
- [ ] Add the Closed Trade History navigation link.
- [ ] Run web Jest and verify GREEN.
- [ ] Commit.

### Task 5: Release verification

- [ ] Run backend report/controller tests plus counterfactual tracer/profit-protection regressions.
- [ ] Run API TypeScript and production build.
- [ ] Run web focused tests, TypeScript/build.
- [ ] Run `git diff --check`.
- [ ] Review the diff for read-only authority, tenant isolation, currency correctness and no browser-side metric recomputation.
