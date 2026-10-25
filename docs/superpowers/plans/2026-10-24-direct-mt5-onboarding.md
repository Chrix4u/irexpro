# Direct MT5 Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Add a user-facing Direct MT5 pairing flow that never asks for an MT5 password and exposes truthful connector health.

**Architecture:** Extend the existing Direct MT5 pairing service with BrokerConnection account-id fencing. Add typed client/types for pairing and health. Add a Direct MT5 method branch to the broker onboarding page while leaving cTrader OAuth and the optional MetaApi path intact.

**Tech Stack:** NestJS/TypeScript/PostgreSQL; Next.js/React; shared TypeScript types/API client; Jest.

**Spec:** `docs/superpowers/specs/2026-10-24-direct-mt5-onboarding-design.md`

## Global Constraints
- DEMO-only in this phase.
- Never accept/store MT5 password in this flow.
- Direct pairing requires exact BrokerConnection ownership and exact terminal login match.
- Existing cTrader OAuth behavior remains unchanged.
- Pairing never grants LIVE or bypasses DEMO validation/trading authority.

## Review Focus
- Wrong MT5 account logged into terminal must not consume/activate the pairing.
- Pair code expiry/replay remains fail-closed.
- UI must not render API-key/password inputs for Direct MT5.
- Stale heartbeat/trading-disabled states must be visible and non-ready.
- Generic MetaApi/cTrader paths must not regress.

---

### Task 1: Fence pairing to BrokerConnection account identity
**Files:** pairing service + spec.
- [ ] RED test: redeem with terminal login different from BrokerConnection `account_id` fails.
- [ ] Implement join/fence in redemption without consuming valid pair code on mismatch.
- [ ] GREEN focused pairing suite; commit.

### Task 2: Add typed owner pairing/health client contract
**Files:** `packages/types/src/index.ts`, `packages/api-client/src/index.ts` and focused tests if present.
- [ ] Define pairing result and health types.
- [ ] Add create/health/revoke Direct MT5 API client methods.
- [ ] Typecheck/build package; commit.

### Task 3: Add Direct MT5 onboarding UI
**Files:** `apps/web/src/app/onboarding/broker/page.tsx` plus focused onboarding test.
- [ ] RED UI test: Direct MT5 method hides credential secrets and exposes pairing action/status.
- [ ] Implement method chooser, connection creation, pairing code display, health polling/refresh, revoke/re-pair.
- [ ] Preserve cTrader OAuth and generic/MetaApi flows.
- [ ] GREEN focused web tests; commit.

### Task 4: Stacked verification
- [ ] Prettier + changed-file lint + diff-check.
- [ ] Direct MT5 API tests + relevant broker onboarding web tests.
- [ ] Push stacked branch based on exact #509 head; open draft PR targeting the Direct MT5 branch until #509 merges.
