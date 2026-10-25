# AI Live Validation Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the real six-pair scanner/validation journey on the AI Trader page without changing execution authority or trading thresholds.

**Architecture:** Add a read-only status projection built from already-persisted `ensemble_shadow_decisions`, selecting the strongest candidate from each pair's latest market bar. The web cockpit validates that optional projection and renders a responsive gate matrix plus current scan summary; absence/malformed data degrades gracefully.

**Tech Stack:** NestJS, TypeORM/PostgreSQL, Next.js/React, TypeScript, Jest, Playwright.

**Spec:** User-approved Regime Portfolio direction; this phase is visibility-only and must not modify trading behavior.

## Global Constraints

- No changes to model thresholds, risk, sizing, execution routes, broker authority, or market-data authority.
- The pipeline is read-only telemetry derived from durable decisions.
- The existing scanner status remains backward-compatible during rolling deploys.
- UI must be responsive on mobile, tablet and desktop.
- Unknown/missing gate evidence must fail visually to WAITING/UNKNOWN, never imply execution readiness.

## Review Focus

- Rolling deploy with old API response: AI Trader still renders.
- Market paused/rollover: pipeline clearly reports protected inactivity rather than a fault.
- One or more pairs missing a current decision: remaining pairs render and missing evidence is explicit.
- Malformed optional pipeline payload: runtime shape validator rejects only the optional projection and preserves core controls.
- A strong candidate blocked at the final gate: UI never labels it execution-ready.

---

### Task 1: Read-only validation pipeline projection

**Files:**

- Create: `apps/api/src/modules/ai/validation-pipeline.ts`
- Test: `apps/api/src/modules/ai/validation-pipeline.spec.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`

**Interfaces:**

- Produces: `buildValidationPipelineCandidate(row, thresholds)` and `validationPipeline` on scanner status.
- Consumes: persisted ensemble decision rows only.

- [ ] Write failing pure projection tests for pass/block/waiting gates and blocker preservation.
- [ ] Implement minimal projection types/helpers.
- [ ] Add latest-bar strongest-candidate query and expose optional scanner status field.
- [ ] Run focused API tests, API build, and diff check.

### Task 2: AI Trader live validation journey

**Files:**

- Modify: `apps/web/src/lib/vps-scanner-status.ts`
- Test: `apps/web/src/lib/vps-scanner-status.spec.ts`
- Modify: `apps/web/src/app/trade/page.tsx`
- Modify: `apps/web/src/app/trade/ai-trader.css`
- Test: `apps/web/e2e/ai-trader-production.spec.ts`

**Interfaces:**

- Consumes: optional `validationPipeline` scanner status projection from Task 1.
- Produces: responsive live scan summary, six-pair rows, and gate-stage visualization.

- [ ] Write failing runtime-shape/derived-view tests.
- [ ] Extend scanner UI contract without breaking old responses.
- [ ] Render scan status and pair-by-pair validation gate matrix.
- [ ] Add responsive/mobile styles and accessibility labels.
- [ ] Run web unit/typecheck/build and focused Playwright validation.
