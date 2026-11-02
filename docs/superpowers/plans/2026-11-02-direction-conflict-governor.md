# Direction Conflict Governor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent contradictory promoted-DEMO entries and coordinate confirmed direction flips.

**Architecture:** Add a pure trained-expert conflict veto to multimodel authority, then add an execution-stage open-opposite guard that closes the old thesis only for a fully qualified confirmed reversal and defers the new entry until closure is durable.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL/cTrader DEMO.

**Spec:** `docs/superpowers/specs/2026-11-02-direction-conflict-governor-design.md`

## Global Constraints
- DEMO-only; LIVE authority unchanged.
- Expert veto threshold is 0.70 with >=3 unanimous broker-native votes.
- Never open a new opposite position while an older opposite M1 trade remains OPEN.
- Preserve all existing risk/economics gates.

## Review Focus
- Opposite expert unanimity must block primary Plan-B, not only rescue.
- Same-direction experts must not block.
- Weak/non-unanimous experts must not block.
- Confirmed reversal closes old side and defers new entry.
- Early-transition/continuation conflict waits without closing the old side.

### Task 1: Expert direction conflict veto
**Files:** Modify/test `apps/api/src/modules/ai/multimodel-demo-authority.ts` and `.spec.ts`.
- [ ] Add failing primary-path opposite-unanimous test.
- [ ] Run focused test and confirm RED.
- [ ] Add minimal blocker logic.
- [ ] Run focused tests and confirm GREEN.
- [ ] Commit.

### Task 2: Opposite-position direction-flip coordination
**Files:** Modify/test `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts` and `.spec.ts` plus evidence helper only if required.
- [ ] Add failing tests for conflict waiting and confirmed-reversal close-first behavior.
- [ ] Run focused tests and confirm RED.
- [ ] Implement minimal DEMO-only guard using existing open-position evidence and `ExecutionService.closeTrade`.
- [ ] Run scheduler/authority suites and build.
- [ ] Commit.
