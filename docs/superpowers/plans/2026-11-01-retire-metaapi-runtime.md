# Retire MetaAPI Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove iRexPro's runtime dependence on MetaAPI while preserving PAPER valuation/protection through the configured broker-native source.

**Architecture:** Keep legacy MetaAPI classes dormant for backward compatibility, but decouple `PaperPositionMarkBridgeService` from `METAAPI_QUOTE_COLLECTION_ENABLED`. Staging will then set `METAAPI_QUOTE_COLLECTION_ENABLED=false` and clear `METAAPI_TOKEN`, while the active cTrader source continues populating `provider_quote_candles` for PAPER marks.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL, PM2.

**Spec:** User decision: no MetaAPI paid dependency; MT5 connectivity must use iRexPro Hosted MT5 or Direct MT5.

## Global Constraints

- Do not change AI models, risk logic, cTrader execution, or Hosted MT5 behavior.
- PAPER protection must remain server-side and fail closed on stale quote evidence.
- No new secrets in Git, logs, or command-line arguments.
- MetaAPI runtime calls must be disabled on staging after deployment.

## Review Focus

- PAPER provider marks still refresh when MetaAPI is disabled but a configured source connection exists.
- Fast PAPER protection remains active independently of provider refresh.
- Missing source connection still disables provider-mark refresh fail-closed.
- MetaAPI collector stays independently disabled by its existing flag.
- API starts successfully with `METAAPI_TOKEN` blank.

---

### Task 1: Decouple PAPER provider bridge from MetaAPI flag

**Files:**
- Modify: `apps/api/src/modules/market-data/services/paper-position-mark-bridge.service.ts`
- Test: `apps/api/src/modules/market-data/services/paper-position-mark-bridge.service.spec.ts`

- [ ] Add RED test proving cTrader/provider marks work with `METAAPI_QUOTE_COLLECTION_ENABLED=false` when scanner + paper/source IDs are configured.
- [ ] Remove MetaAPI flag from provider-bridge enablement and make logs/comments provider-neutral.
- [ ] Run focused bridge + MetaAPI collector tests and API build.
- [ ] Commit.

### Task 2: Retire staging MetaAPI runtime

**Operational changes only; no secrets committed.**

- [ ] Deploy merged code through normal PR/CI/main pipeline.
- [ ] Set staging `METAAPI_QUOTE_COLLECTION_ENABLED=false`.
- [ ] Clear staging `METAAPI_TOKEN` so MetaAPI SDK stays unavailable and cannot make outbound calls.
- [ ] Restart API and verify live/ready health.
- [ ] Confirm logs say MetaAPI quote collection disabled and MetaAPI token unavailable, while PAPER provider bridge remains enabled from the configured source.
- [ ] Retire the single stale `metatrader5` DEMO connection from reconciliation without touching cTrader, Direct MT5, or paper records.
