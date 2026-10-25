# M1 Readiness Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every silent M1 market-data skip explainable without changing trading authority.

**Architecture:** Keep `loadSnapshot()` and all execution gates unchanged. Record the latest market-data readiness reason per connection/instrument inside `M1TacticalMarketDataService`; surface the result through `M1TacticalSchedulerService.getStatus()` and concise logs when a snapshot is unavailable.

**Tech Stack:** NestJS, TypeScript, Jest.

## Global Constraints
- No changes to M1/M5 execution eligibility, thresholds, sizing, SL/TP, or risk authority.
- Preserve PAPER fallback behavior when no dedicated M1 source is configured.
- Never fabricate market data.

### Task 1: Market-data readiness reasons
- Test broker-ready, stale-M1, missing-spread, insufficient-feature-context, and PAPER-cache paths.
- Implement `getLastReadiness(connectionId, instrument)` with structured reason + authority.

### Task 2: Scheduler status integration
- Test unavailable snapshot appears in scheduler status without creating decisions.
- Implement per-instrument readiness in `getStatus()` and concise diagnostic logging.

### Task 3: Verification
- Run focused M1 market-data + scheduler suites, API build/lint, and exact-head CI before merge.
