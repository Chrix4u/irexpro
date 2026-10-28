# Broker-Native FX Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make cross-currency position sizing and final risk validation consume fresh same-broker cached FX evidence before falling back to a new provider quote request.

**Architecture:** Add `BrokerFxConversionService` in MarketDataModule. It resolves a conservative quote-currency-per-account-currency bid from direct, inverse, or USD-bridged persisted cTrader/MetaAPI bid/ask evidence. Existing BrokerService direct quoting remains fallback when the cache cannot prove a conversion.

**Tech Stack:** NestJS, TypeScript, TypeORM/PostgreSQL, Jest, ExactDecimal.

**Spec:** `docs/superpowers/specs/2026-10-28-broker-native-fx-conversion-design.md`

## Global Constraints
- Same broker connection for all evidence.
- Freshness <= 60 seconds; future skew <= 5 seconds.
- No external-provider conversion authority.
- Preserve all existing risk limits and fail-closed behavior.

## Review Focus
- Direct cached pair freshness and conservative bid.
- Inverse pair conversion uses `1 / ask`, never `1 / bid`.
- USD bridge uses two fresh same-connection legs and conservative bids.
- One stale/missing leg causes cache resolution to return null.
- Callers retain existing broker-direct fallback when cache cannot prove a rate.

---

### Task 1: Broker-native conversion evidence
**Files:**
- Create: `apps/api/src/modules/market-data/services/broker-fx-conversion.service.ts`
- Create: `apps/api/src/modules/market-data/services/broker-fx-conversion.service.spec.ts`
- Modify: `apps/api/src/modules/market-data/market-data.module.ts`

**Interfaces:**
- Produces: `resolveCachedBid(connectionId, accountCurrency, quoteCurrency, evaluatedAt?)` returning rate/path/source or null.

- [ ] Write direct/inverse/USD-bridge/stale RED tests.
- [ ] Run focused spec and confirm RED.
- [ ] Implement ExactDecimal conservative conversion and module registration.
- [ ] Run focused spec and confirm GREEN.
- [ ] Commit.

### Task 2: Position sizing integration
**Files:**
- Modify: `apps/api/src/modules/execution/services/position-sizing.service.ts`
- Modify: `apps/api/src/modules/execution/services/position-sizing.service.spec.ts`

**Interfaces:**
- Consumes: `BrokerFxConversionService.resolveCachedBid(...)` through app-wide `ModuleRef` lookup.

- [ ] Add RED test proving cache conversion avoids a broker spot request.
- [ ] Implement cache-first conversion with existing broker fallback unchanged.
- [ ] Run sizing specs GREEN.
- [ ] Commit.

### Task 3: Final risk integration and verification
**Files:**
- Modify: `apps/api/src/modules/risk/risk.service.ts`
- Modify: `apps/api/src/modules/risk/risk.service.spec.ts`

**Interfaces:**
- Consumes the same broker-native conversion evidence immediately before risk grant issuance.

- [ ] Add RED test proving final risk validation accepts fresh cached same-broker conversion when direct broker spot is unavailable.
- [ ] Implement cache-first conversion; preserve direct fallback and fail-closed rejection.
- [ ] Run risk + sizing + conversion suites GREEN.
- [ ] Build API and run full regression.
- [ ] Deploy API only, verify runtime, push branch.
