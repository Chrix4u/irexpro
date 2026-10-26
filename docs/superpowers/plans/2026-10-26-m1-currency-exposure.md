# M1 Currency Exposure Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans task-by-task. Steps use checkbox syntax.

**Goal:** Preserve high-frequency M1 PAPER participation while preventing repeated same-thesis entries from exceeding an aligned-currency stop-risk budget.

**Architecture:** Keep raw trade counts unbounded. Convert each open M1 position and candidate to USD stop-risk, decompose that risk into base/quote currency exposure, then reduce new M1 size at 2% of the explicit allocated PAPER pool and block additional aligned exposure at 3%. Existing positions are never force-closed; M5, DEMO and LIVE authority are unchanged.

**Tech Stack:** NestJS/TypeScript, PostgreSQL, Jest.

**Global Constraints**
- PAPER M1 new exposure only.
- No trade-count cap.
- REDUCED at projected aligned currency stop-risk >= 2% allocation.
- BLOCKED at >= 3% allocation.
- Missing allocation or stop-risk evidence fails closed for new M1 exposure.
- Existing M1 event, governance, reliability, SL/TP, allocation, risk and broker controls remain authoritative.

### Task 1: Pure M1 currency-risk policy
- [ ] Write RED tests for USD stop-risk conversion and CLEAR/REDUCED/BLOCKED thresholds.
- [ ] Implement `m1-tactical-currency-exposure.ts`.
- [ ] Run focused tests GREEN.

### Task 2: Durable open M1 risk evidence
- [ ] Add RED evidence-service test for all open M1 positions with fill/SL/lot stop-risk.
- [ ] Implement `loadOpenPaperRiskPositions`.
- [ ] Run evidence tests GREEN.

### Task 3: Scheduler execution boundary
- [ ] Add RED scheduler tests: reduced size at 2%, block at 3%, diversification allowed below block.
- [ ] Inject AllocationService and evaluate exposure before `receiveSignal`.
- [ ] Persist exposure diagnostics in M1 decision/signal metadata.
- [ ] Run scheduler + exposure + risk-critical suites, build, lint, diff-check.
