# Direct MT5 Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Build the secure pairing and command protocol foundation for a subscription-free iRexPro ↔ local MetaTrader 5 connector, then wire the existing MetaTrader broker adapter to that transport in a later phase.

**Architecture:** A Windows Python agent uses MetaQuotes' official `MetaTrader5` package against the local terminal. It authenticates outbound to the iRexPro API using a one-time pairing code exchanged for a revocable token. Server commands are leased, idempotent and journaled; connector responses are authoritative provider evidence.

**Tech Stack:** NestJS/TypeScript/PostgreSQL for server; Python 3.10+ for Windows connector; MetaQuotes `MetaTrader5` Python package; Jest + pytest.

**Spec:** `docs/superpowers/specs/2026-10-24-direct-mt5-connector-design.md`

## Global Constraints
- No MetaApi token/account is required by the direct connector path.
- No MT5 password is sent to or stored by iRexPro.
- Pair codes are single-use and short-lived; connector tokens are hashed, revocable secrets.
- Commands are idempotent by immutable command id and never blindly redelivered after uncertain dispatch.
- Connector is bound to exact MT5 login + broker server + one BrokerConnection.
- DEMO-before-LIVE and all existing risk/execution authority remain unchanged.
- Connector-offline or account-identity mismatch fails closed for NEW exposure.

## Review Focus
- Replayed pairing code must fail.
- Duplicate command id must not produce a second execution.
- Stale heartbeat must mark connector unhealthy.
- Connector account/server change must suspend execution.
- Command lease expiry/recovery must reconcile before any retry.

---

### Task 1: Define protocol contracts
**Files:**
- Create `apps/api/src/modules/broker/direct-mt5/direct-mt5.protocol.ts`
- Create `apps/api/src/modules/broker/direct-mt5/direct-mt5.protocol.spec.ts`

- [ ] Write RED tests for protocol version, command ids, supported command/event kinds, and payload validation.
- [ ] Implement typed protocol v1 contracts and validators.
- [ ] Run focused Jest spec GREEN.
- [ ] Commit.

### Task 2: Secure pairing/token primitives
**Files:**
- Create `apps/api/src/modules/broker/direct-mt5/direct-mt5-pairing.service.ts`
- Create `apps/api/src/modules/broker/direct-mt5/direct-mt5-pairing.service.spec.ts`
- Create migration/entity only if required by the existing persistence conventions.

- [ ] RED: pair code is single-use, expires, token is returned once, stored representation is hashed.
- [ ] Implement cryptographic code/token generation and constant-time hash verification.
- [ ] GREEN focused tests.
- [ ] Commit.

### Task 3: Command queue/lease semantics
**Files:**
- Create `apps/api/src/modules/broker/direct-mt5/direct-mt5-command.service.ts`
- Create `apps/api/src/modules/broker/direct-mt5/direct-mt5-command.service.spec.ts`

- [ ] RED: duplicate idempotency key reuses prior command; one connector cannot lease another connector's command; uncertain/expired lease does not auto-execute a duplicate.
- [ ] Implement queue state machine (`PENDING`, `LEASED`, `SUCCEEDED`, `FAILED`, `UNCERTAIN`, `CANCELLED`).
- [ ] GREEN tests.
- [ ] Commit.

### Task 4: Connector HTTP surface
**Files:**
- Create `apps/api/src/modules/broker/direct-mt5/direct-mt5-connector.controller.ts`
- Create controller specs.
- Modify `broker.module.ts` to register direct-MT5 providers/controller.

- [ ] RED auth/isolation/replay tests for pair, hello/heartbeat, lease-next, result.
- [ ] Implement routes with connector-token auth and account identity fencing.
- [ ] GREEN tests and API build.
- [ ] Commit.

### Task 5: Windows connector agent foundation
**Files:**
- Create `services/mt5-connector/pyproject.toml`
- Create `services/mt5-connector/irexpro_mt5_connector/{config.py,protocol.py,mt5_terminal.py,journal.py,client.py,main.py}`
- Create `services/mt5-connector/tests/`
- Create `services/mt5-connector/README.md`

- [ ] RED pytest tests for config secret handling, command journal idempotency, account identity mismatch and duplicate command replay.
- [ ] Implement terminal abstraction; production implementation imports `MetaTrader5`, tests use a fake terminal.
- [ ] Implement pairing, heartbeat, polling and command dispatch skeleton.
- [ ] GREEN pytest.
- [ ] Commit.

### Task 6: Phase-1 verification and draft PR
- [ ] Run changed-file lint/format and API build.
- [ ] Run direct-MT5 Jest suites plus broker contract/regression suites.
- [ ] Run connector pytest suite.
- [ ] Push exact head and open draft PR.
- [ ] Do not switch production MetaTrader execution away from MetaApi in Phase 1; transport cutover occurs only after pairing/command path has exact-head CI and DEMO UAT evidence.
