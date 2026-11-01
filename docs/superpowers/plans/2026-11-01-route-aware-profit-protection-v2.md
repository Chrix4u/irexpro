# Route-Aware Profit Protection v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise only Confirmed Reversal profit-lock arming to 1.00R while preserving the existing Early Transition and Trend Continuation behavior.

**Architecture:** Keep `evaluatePaperProfitLock()` as the single policy function shared by PAPER and cTrader DEMO. Add route-specific arming floors inside that function, then pin the behavior in both direct policy tests and live-demo reconciliation tests.

**Tech Stack:** TypeScript, NestJS, Jest.

**Spec:** `docs/superpowers/specs/2026-11-01-route-aware-profit-protection-v2-design.md`

## Global Constraints
- Confirmed Reversal arm floor: 1.00R.
- Early Transition arm floor: 0.75R.
- Trend Continuation / unknown: existing 0.395R M1 rescue and 0.50R standard behavior.
- Existing retention ladder is unchanged after arming.
- Stop-loss catch-up and adverse-thesis protection are unchanged.
- No LIVE-account promotion.

## Review Focus
- Boundary at exactly 1.00R for Confirmed Reversal must arm.
- Confirmed Reversal at 0.99R must remain disarmed even when current P&L is below the ordinary protected floor.
- Early Transition must still arm at 0.75R.
- Trend Continuation must still use existing lower rescue/standard floors.
- Both PAPER policy and cTrader DEMO integration must consume the same behavior.

---

### Task 1: Route-specific arming floor

**Files:**
- Modify: `apps/api/src/modules/broker/adapters/paper-broker.adapter.spec.ts`
- Modify: `apps/api/src/modules/broker/adapters/paper-broker.adapter.ts`
- Modify: `apps/api/src/modules/execution/reconciliation/live-demo-profit-protection.service.spec.ts`

**Interfaces:**
- Consumes: `evaluatePaperProfitLock(input)`.
- Produces: Confirmed Reversal 1.00R floor; Early Transition 0.75R floor; all other behavior unchanged.

- [ ] Add failing direct policy tests for Confirmed Reversal 0.99R disarmed and 1.00R armed, plus regression assertions for Early Transition and Trend Continuation.
- [ ] Run focused paper-broker tests and verify RED on the 0.99R Confirmed Reversal case.
- [ ] Add failing live-demo integration coverage proving Confirmed Reversal below 1.00R does not close while Early Transition at 0.75R still can close.
- [ ] Run focused live-demo tests and verify RED.
- [ ] Implement the minimal route-specific arming floors in `evaluatePaperProfitLock()` with the retention ladder unchanged.
- [ ] Run both focused suites and verify GREEN.
- [ ] Commit.

### Task 2: Regression verification

- [ ] Run profit-protection counterfactual, exit-quality report, live-demo protection, paper broker, and post-entry drawdown guard suites.
- [ ] Run API TypeScript check.
- [ ] Run API production build.
- [ ] Run `git diff --check`.
- [ ] Review diff to confirm no changes to stop-loss, adverse-thesis, sizing, entries, or LIVE authority.
