# Direct MT5 Pairing Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate half-completed Direct MT5 pairing and tolerate the supported response envelope.

**Architecture:** Transactionally update connector + broker connection, then harden the Windows client parser. Preserve one-time pairing and identity checks.

**Tech Stack:** NestJS/TypeScript/PostgreSQL, Python requests/PyInstaller, Jest/Pytest.

**Spec:** `docs/superpowers/specs/2026-11-02-mt5-pairing-hardening-design.md`

## Global Constraints
- Pairing remains one-time and account-bound.
- Connector token never appears in logs/errors.
- No LIVE trading enablement.

## Review Focus
- Transaction rollback on second update failure.
- Top-level response works.
- Single `data` envelope works.
- Missing identity still fails safely.
- Re-pair resets orphaned connector state.

### Task 1: Server atomic redemption
**Files:** Modify/test `direct-mt5-pairing.service.ts` and `.spec.ts`.
- [ ] Add failing transaction/contract tests.
- [ ] Confirm RED.
- [ ] Implement transaction-scoped atomic redeem.
- [ ] Confirm GREEN and API build.
- [ ] Commit.

### Task 2: Windows response compatibility
**Files:** Modify/test `services/mt5-connector/irexpro_mt5_connector/client.py` and connector tests.
- [ ] Add failing nested-envelope test.
- [ ] Confirm RED.
- [ ] Implement one-level safe unwrapping.
- [ ] Run connector suite.
- [ ] Commit.
