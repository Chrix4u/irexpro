# Hosted MT5 Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a MetaAPI-free iRexPro-hosted MT5 mode so a DEMO user can connect once and trade while their own computer is off.

**Architecture:** Reuse the Direct MT5 adapter/queue/protocol. Add `IREXPRO_HOSTED` connector ownership, an encrypted-credential provisioning path, a leased infrastructure-worker API, and a Windows host-worker supervisor that runs one isolated portable MT5 child per account. Keep hosted LIVE fail-closed.

**Tech Stack:** NestJS/TypeORM/PostgreSQL, shared TypeScript packages, Next.js/React, Python 3.10+, MetaQuotes `MetaTrader5`, Windows portable MT5, existing Direct MT5 connector runtime/SQLite journal.

**Spec:** `docs/superpowers/specs/2026-11-01-hosted-mt5-execution-design.md`

## Global constraints

- No MetaAPI dependency on the new hosted path.
- No customer-PC runtime dependency in hosted mode.
- No hosted LIVE enablement in this plan.
- No cTrader behavior changes.
- No plaintext MT5 password/token in DB columns, logs, config JSON, journal, tests, or UI responses.
- Existing Direct MT5 PERSONAL_PC/WINDOWS_VPS flows must remain green.
- Every behavior change follows RED -> GREEN TDD.

## Task 1: Extend Direct MT5 host ownership model

**Files:**
- Modify: `apps/api/src/modules/broker/direct-mt5/direct-mt5-pairing.service.ts`
- Modify: `apps/api/src/modules/broker/direct-mt5/direct-mt5-connector.controller.ts`
- Modify: `packages/types/src/index.ts`
- Create: `apps/api/src/database/migrations/1793520000000-AddHostedMt5WorkerLease.ts`
- Tests: `apps/api/src/modules/broker/direct-mt5/direct-mt5-pairing.service.spec.ts`

- [ ] Add failing tests proving `IREXPRO_HOSTED` is a valid typed host mode but cannot be created through the customer pairing-code endpoint.
- [ ] Add failing migration/source assertions for worker lease columns.
- [ ] Implement the host-mode type extension and migration.
- [ ] Keep customer pairing DTO restricted to PERSONAL_PC/WINDOWS_VPS.
- [ ] Run Direct MT5 pairing/controller tests and typecheck.
- [ ] Commit.

## Task 2: Hosted provisioning and worker lease API

**Files:**
- Create: `apps/api/src/modules/broker/direct-mt5/hosted-mt5.service.ts`
- Create: `apps/api/src/modules/broker/direct-mt5/hosted-mt5.controller.ts`
- Create: `apps/api/src/modules/broker/direct-mt5/hosted-mt5.service.spec.ts`
- Create: `apps/api/src/modules/broker/direct-mt5/hosted-mt5.controller.spec.ts`
- Modify: `apps/api/src/modules/broker/broker.module.ts`
- Modify: `apps/api/src/config/configuration.ts`
- Modify: `apps/api/src/config/validation.schema.ts`
- Modify: `apps/api/.env.example`

- [ ] Write failing tests: owner-only provisioning; DEMO-only; required encrypted password/server; idempotent hosted row creation; no raw secret in customer response.
- [ ] Implement `provision()` using stored encrypted broker credentials and `host_mode=IREXPRO_HOSTED`; broker connection becomes CONNECTING.
- [ ] Write failing tests for worker auth: absent/short/wrong token rejects; correct token allowed.
- [ ] Write failing tests for atomic lease: new hosted assignment; lease exclusion; stale heartbeat + expired lease reclaim; healthy lease prevents takeover; command safety on token rotation.
- [ ] Implement constant-time worker authentication and lease claim, returning secrets only to the worker.
- [ ] Write/implement worker lease heartbeat with exact worker-owner check and sanitized error storage.
- [ ] Register controller/service and config.
- [ ] Run hosted + Direct MT5 API tests and API build.
- [ ] Commit.

## Task 3: Add shared/frontend contracts

**Files:**
- Modify: `packages/types/src/index.ts`
- Modify: `packages/api-client/src/index.ts`
- Modify: `packages/api-client/scripts/test-contracts.cjs`

- [ ] Write failing API-client contract test for `provisionHostedMt5()` and updated hosted health typing.
- [ ] Add frontend-safe hosted provisioning view; never include password/connector token.
- [ ] Implement client method.
- [ ] Run shared types/client typechecks and contract tests.
- [ ] Commit.

## Task 4: Make terminal port support iRexPro-owned explicit login

**Files:**
- Modify: `services/mt5-connector/irexpro_mt5_connector/mt5_terminal.py`
- Modify/Create tests under `services/mt5-connector/tests/`

- [ ] Write failing tests proving default Direct Connector still calls `initialize()` without credentials and hosted terminal calls `initialize(path, login=int(...), password=..., server=..., portable=True)`.
- [ ] Implement optional explicit-login constructor parameters without changing current default behavior.
- [ ] Test identity mismatch remains fatal through existing connector fences.
- [ ] Run full connector pytest suite.
- [ ] Commit.

## Task 5: Build the iRexPro hosted MT5 worker supervisor

**Files:**
- Create: `services/mt5-connector/irexpro_mt5_connector/host_worker.py`
- Create: `services/mt5-connector/tests/test_host_worker.py`
- Modify: `services/mt5-connector/pyproject.toml`
- Modify: `services/mt5-connector/README.md` or hosted worker docs

- [ ] Write failing tests for HTTPS-only API, worker-token header, 204 no-work, assignment parsing without logging secrets.
- [ ] Write failing tests for isolated session directory preparation from a clean MT5 template.
- [ ] Write failing tests for child-session construction: in-memory connector token; password not written to config/journal paths; explicit-login terminal factory.
- [ ] Write failing tests for supervisor capacity, lease heartbeat, child failure reporting, and clean shutdown.
- [ ] Implement `irexpro-mt5-host-worker` CLI with env/config validation and per-assignment child processes.
- [ ] Keep the worker Windows-only in this pilot and fail clearly elsewhere; Linux/Wine remains a separate certified worker target.
- [ ] Run full connector pytest suite and frozen connector self-test regression where available.
- [ ] Commit.

## Task 6: Make hosted MT5 the default user experience

**Files:**
- Modify: `apps/web/src/app/onboarding/broker/page.tsx`
- Modify: `apps/web/src/app/onboarding/broker/direct-mt5-onboarding.spec.tsx`
- Potentially modify broker catalog copy in `apps/api/src/modules/broker/registry/broker-catalog.ts`

- [ ] Update failing onboarding tests: default method is iRexPro Hosted; password/server/login fields shown; “computer can be off”; hosted LIVE disabled; Direct PC/VPS remain selectable.
- [ ] Hide legacy MetaAPI route from new-MT5 onboarding while leaving existing backend connections intact.
- [ ] Submit `direct-mt5` connection with password/server in encrypted credential payload then call hosted provision.
- [ ] Clear password state after submission.
- [ ] Render `IREXPRO_HOSTED` health as “iRexPro hosted execution”.
- [ ] Run onboarding tests, web typecheck and full web unit suite.
- [ ] Commit.

## Task 7: Operational docs and readiness probe

**Files:**
- Create: `docs/brokers/hosted-mt5-worker.md`
- Create/Modify worker readiness script/test as appropriate.

- [ ] Document Windows worker prerequisites, clean portable MT5 template, service account, HTTPS API URL, worker token, max sessions, journal/session directories, firewall rules, password-handling rules and restart behavior.
- [ ] Add a no-secret readiness command that verifies OS, template executable, writable session root and API reachability without leasing work.
- [ ] Document Linux/Wine as future/certification path, not the initial production assertion.
- [ ] Commit.

## Task 8: Whole-branch verification

- [ ] `pnpm --filter @irexpro/api test -- --runInBand` (record all existing skips/failures).
- [ ] `pnpm --filter @irexpro/api build`.
- [ ] `pnpm --filter @irexpro/web test -- --runInBand` and web typecheck.
- [ ] shared types/api-client typechecks and contract tests.
- [ ] `cd services/mt5-connector && python -m pytest`.
- [ ] `git diff --check`.
- [ ] Search diff/worktree for accidental plaintext test/runtime MT5 credentials and secret logging.
- [ ] Review migration up/down compatibility.
- [ ] Request whole-branch review; fix Important/Critical findings with RED -> GREEN.
- [ ] Push feature branch and open PR only after local verification is green.
