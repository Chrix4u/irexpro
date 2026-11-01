# Hosted MT5 Phone-Only Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hosted MT5 truthfully available to phone-only customers whenever an iRexPro-owned Windows worker is online and has capacity.

**Architecture:** Add a durable worker-presence registry and fresh-capacity readiness overlay to the existing Hosted MT5 control plane. Package a dedicated Windows Host Worker executable with secure token loading and a PowerShell bootstrap; keep LIVE and rollout fail-closed until Windows DEMO UAT.

**Tech Stack:** NestJS/TypeScript/PostgreSQL, Python 3.11, MetaTrader5 Python package, PyInstaller, PowerShell, Windows Task Scheduler, keyring/Credential Manager, Jest/pytest/GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-01-hosted-mt5-phone-only-readiness-design.md`

## Global Constraints

- No MetaAPI.
- Hosted MT5 customer path cannot require a customer-owned PC.
- Hosted LIVE remains blocked.
- Worker token/password/token material never enters argv or normal logs.
- Existing Direct Connector and cTrader behavior remain unchanged.
- Hosted readiness requires a fresh ready worker with spare capacity.

## Review Focus

- API restart with only stale worker rows must stay fail-closed.
- Multiple workers where one is stale/full and another is fresh/available must report ready.
- Worker token absence/mismatch must not reveal which check failed.
- Worker presence must continue with zero assignments and survive transient API errors.
- Bootstrap/config files must not persist the worker token in plaintext.

---

### Task 1: Durable worker-presence schema and API

**Files:**
- Create: `apps/api/src/database/migrations/1793530000000-AddHostedMt5WorkerPresence.ts`
- Create: `apps/api/src/database/hosted-mt5-worker-presence.schema.spec.ts`
- Modify: `apps/api/src/modules/broker/direct-mt5/hosted-mt5.controller.ts`
- Modify: `apps/api/src/modules/broker/direct-mt5/hosted-mt5.service.ts`
- Modify tests in the same module.

**Interfaces:**
- Produces `heartbeatWorkerPresence(workerId, token, presence)` and `getWorkerPoolReadiness()`.

- [ ] Write RED tests for auth, upsert, freshness, readiness and capacity.
- [ ] Add migration/table and minimal service/controller implementation.
- [ ] Run focused API tests and build.
- [ ] Commit.

### Task 2: Registry readiness uses live worker pool

**Files:**
- Modify: `apps/api/src/modules/broker/registry/broker-provider-registry.service.ts`
- Modify: `apps/api/src/modules/broker/registry/broker-provider-registry.spec.ts`
- If needed create a small presence cache/service to keep the existing synchronous registry contract.

**Interfaces:**
- Consumes worker pool snapshot from Task 1.
- Produces `hostedMt5Readiness` codes for offline/full/ready states.

- [ ] Write RED registry tests for no worker, stale worker, full worker and available worker.
- [ ] Implement fail-closed readiness overlay.
- [ ] Verify registry/API tests and typecheck.
- [ ] Commit.

### Task 3: Worker sends independent presence heartbeat

**Files:**
- Modify: `services/mt5-connector/irexpro_mt5_connector/host_worker.py`
- Modify: `services/mt5-connector/tests/test_host_worker.py`

**Interfaces:**
- `HostWorkerApi.heartbeat_worker_presence(...)` posts only non-secret worker metadata.
- Supervisor sends it even with zero active sessions.

- [ ] Write RED tests for zero-assignment heartbeat, capacity counts and transient failure behavior.
- [ ] Implement presence heartbeat and version reporting.
- [ ] Run connector tests.
- [ ] Commit.

### Task 4: Secure Windows Host Worker executable and token storage

**Files:**
- Create: `services/mt5-connector/packaging/host_worker_entry.py`
- Create: `services/mt5-connector/packaging/irexpro-mt5-host-worker.spec`
- Modify: `services/mt5-connector/irexpro_mt5_connector/host_worker.py`
- Modify: `services/mt5-connector/tests/test_packaging_contract.py`
- Modify: `.github/workflows/mt5-connector-windows-release.yml`

**Interfaces:**
- Frozen `iRexPro-MT5-Host-Worker.exe` supports `--self-test`, `--readiness-check`, and normal supervisor mode.
- Worker token loads from env or Windows Credential Manager; no token CLI argument.

- [ ] Write RED packaging/token-loading tests.
- [ ] Implement entry/spec/credential lookup.
- [ ] Extend Windows CI to build/smoke-test/upload the host worker.
- [ ] Verify connector suite.
- [ ] Commit.

### Task 5: One-command Windows bootstrap

**Files:**
- Create: `services/mt5-connector/packaging/install-host-worker.ps1`
- Create/modify packaging contract tests.
- Modify: `docs/brokers/hosted-mt5-worker.md`

**Interfaces:**
- PowerShell bootstrap accepts non-secret paths/IDs/URL and reads worker token securely from prompt/stdin flow.
- Stores token through Host Worker credential-store command, writes non-secret config, creates scheduled task, runs readiness.

- [ ] Write RED text/contract tests proving no token argument/plaintext config.
- [ ] Implement bootstrap.
- [ ] Verify PowerShell syntax in Windows CI and packaging tests.
- [ ] Commit.

### Task 6: Full verification and integration

- [ ] Run connector full suite.
- [ ] Run hosted/API registry focused tests and full API suite/build/lint.
- [ ] Run web onboarding suite/typecheck and shared contracts.
- [ ] Secret/argv/diff containment audit.
- [ ] Push PR and require Windows connector, DB migration, security, API, UI and required CI gates.
- [ ] Merge only when exact-head gates are green.
- [ ] Keep `HOSTED_MT5_ENABLED=false` on staging until a real Windows worker passes DEMO UAT.
