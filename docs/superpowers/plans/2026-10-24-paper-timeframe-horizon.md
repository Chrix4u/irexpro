# PAPER Timeframe Horizon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Preserve the originating AI strategy timeframe through risk and execution so PAPER time-to-work lifecycle uses M1=15 minutes and M5/default=20 minutes.

**Architecture:** Carry an optional `strategyTimeframe` from Strategy → ProposedTrade → ValidatedOrder/RiskGrant → ExecutionIntent → BrokerOrderRequest. The PAPER adapter maps only M1 to 15 minutes; all other/unknown timeframes fail safely to the existing 20-minute M5 hold and persist the resolved hold on working orders/positions.

**Tech Stack:** NestJS/TypeScript, Jest, durable PAPER broker state.

**Spec:** User-approved horizon alignment from the USDJPY premature-exit investigation and newly deployed M1 scout.

## Global Constraints
- PAPER lifecycle only; no DEMO/LIVE execution-authority widening.
- Hard SL/TP and profit protection remain authoritative during the minimum hold.
- Unknown timeframe falls back to 20 minutes.
- Timeframe is bound into risk-grant payload lineage because it changes PAPER execution lifecycle.

## Review Focus
- M1 adverse trade remains open before 15m and may time-close after 15m.
- M5 behavior remains 20m.
- Old durable PAPER state without the new field restores as 20m.
- Working orders preserve the horizon through later fill.
- Other broker adapters tolerate the optional field without behavior changes.

### Task 1: Broker lifecycle horizon
- [x] RED: live-PAPER M1 regression cannot compile without timeframe provenance.
- [x] GREEN: map M1→15m; default→20m; persist on working orders and positions.
- [x] Verify live PAPER and full PAPER broker suites.

### Task 2: End-to-end propagation
- [x] RED: Strategy/Risk/Execution interfaces do not carry timeframe.
- [x] GREEN: propagate timeframe through all typed seams and bind it into RiskGrant digests.
- [x] Verify Strategy, Risk, Execution, provider dispatch and broker lifecycle suites.

### Task 3: Release verification
- [x] Prettier, ESLint (0 errors), diff-check.
- [x] Production API build.
- [ ] Exact-head GitHub CI/security/concurrency.
- [ ] Merge/deploy exact green SHA and verify runtime health.
