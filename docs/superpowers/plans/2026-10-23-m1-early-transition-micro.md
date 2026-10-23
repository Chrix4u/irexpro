# M1 Early-Transition Micro PAPER Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 0.01-lot PAPER-only M1 early-transition lane qualified by causal exact pair/side shadow outcomes.

**Architecture:** Reuse `trading.m1_tactical_decisions` and `shadowOutcome15mV1`; add a pure reliability evaluator and evidence query, then a dedicated rollout phase. Only a drift-only generic governance block may be rescued, and all downstream risk/execution controls remain unchanged.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL.

**Spec:** `docs/superpowers/designs/2026-10-23-m1-early-transition-micro.md`

## Global Constraints
- PAPER only; no DEMO/LIVE authority.
- M1_EARLY_TRANSITION only; trend and reversal remain shadow-only.
- Maximum suggested volume 0.01 lots.
- Minimum 3 causal outcomes; PF >=1.50; avg net R >=0.10R; positive fraction >=0.40; latest three must not all be non-positive.
- Rescue only `DRIFT_OUT_OF_DISTRIBUTION`; never event/cost/HTF/reliability/session/risk blockers.

## Review Focus
- Future outcome leakage: observedAt must be <= evaluation time.
- Duplicate adjacent M1 decisions: use already-settled episode leaders only.
- Weak pair/side: must remain shadow-only.
- Three recent non-positive outcomes: must brake micro execution.
- Other M1 routes: must never execute in the new phase.

---

### Task 1: Causal shadow pair/side reliability
**Files:** Create `m1-shadow-pair-side-reliability.ts`; create spec; modify evidence service/spec.
- [ ] Write failing evaluator tests for qualified, insufficient, weak-PF, and three-loss-streak sleeves.
- [ ] Implement evaluator.
- [ ] Add causal evidence query and test exact route/instrument/direction/policy/as-of filters.
- [ ] Run focused tests and commit.

### Task 2: M1 micro rollout authority
**Files:** Modify scheduler/service spec and ai.module/module wiring spec.
- [ ] Write failing tests for new phase, 0.01 cap, qualified drift-only rescue, and hard-block preservation.
- [ ] Implement `PAPER_EARLY_TRANSITION_MICRO` and v4 rollout policy.
- [ ] Wire exact shadow reliability into scheduler metadata and execution decision.
- [ ] Select v4 in AiModule.
- [ ] Run scheduler/governance/evidence focused tests, lint/build, commit and push.
