# PAPER Participation Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Expose a combined read-only M5/M1 participation snapshot that explains low PAPER cadence without changing trade authority.

**Architecture:** Add a pure diagnostics aggregator with blocker classification, then add a user-scoped service query and controller endpoint under the existing external-provider diagnostics surface. Reuse current persisted evidence only.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL.

**Spec:** `docs/superpowers/designs/2026-10-25-paper-participation-diagnostics.md`

## Global Constraints
- Read-only; `modifiesExecution=false`.
- 30-minute observation window.
- No execution gate, lot size, route, SL/TP, DEMO or LIVE changes.
- User-scoped queries only.

## Review Focus
- Hard-safety blockers must never be mislabeled as soft evidence.
- A recent executable M1/M5 opportunity must dominate idle status.
- Repeated blockers are counted, not duplicated in output rows.
- No recent rows returns NO_RECENT_EVIDENCE rather than a false healthy state.
- Invalid/missing timestamps fail to null diagnostics instead of producing negative ages.

---

### Task 1: Pure participation diagnostics
**Files:**
- Create: `apps/api/src/modules/ai/paper-participation-diagnostics.ts`
- Create: `apps/api/src/modules/ai/paper-participation-diagnostics.spec.ts`

**Interfaces:**
- Produces: `buildPaperParticipationDiagnostics(input)` and blocker classification.

- [x] Write failing policy/aggregation tests.
- [x] Run focused test and confirm RED.
- [x] Implement the pure aggregator.
- [x] Run focused test and confirm GREEN.
- [x] Commit.

### Task 2: Read-only API integration
**Files:**
- Modify: `apps/api/src/modules/ai/external-signal-performance.service.ts`
- Modify: `apps/api/src/modules/ai/external-signal-performance.controller.ts`
- Modify corresponding specs.

**Interfaces:**
- Consumes: `buildPaperParticipationDiagnostics`.
- Produces: `GET /ai/external/providers/participation?providerCode=...`.

- [x] Write failing service/controller tests for user scoping and response shape.
- [x] Confirm RED.
- [x] Implement read-only queries and endpoint.
- [x] Run service/controller/pure tests GREEN.
- [x] Run API build, lint, formatting and diff checks.
- [x] Commit and push exact head for CI.
