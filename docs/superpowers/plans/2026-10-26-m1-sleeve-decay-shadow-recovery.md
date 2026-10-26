# M1 Sleeve Decay + Shadow Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Demote freshly deteriorating M1 sleeves before a full loss streak while restoring causal shadow outcome collection during active rollout.

**Architecture:** Extend the existing exact route/pair/side reliability boundary with a latest-five realized-R decay check. Separately mark structurally valid non-executed decisions as shadow-outcome eligible so the existing 15-minute causal resolver keeps current sleeve evidence fresh.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL.

**Spec:** `docs/superpowers/designs/2026-10-26-m1-sleeve-decay-shadow-recovery.md`

## Global Constraints
- PAPER only; no DEMO/LIVE authority change.
- Preserve three-loss brake and mature full-window payoff.
- Preserve hard governance, event, cost, HTF, drift, exposure and broker controls.
- No M1 entry/SL/TP/lot-cap changes.

## Review Focus
- Mixed recent loss/win sequences can decay before three straight losses.
- Missing risk-at-stop must not fabricate R evidence.
- Reliability-demoted sleeves must still learn in shadow.
- Hard-risk rejects must not enter promotion evidence.
- Legacy SHADOW rows must remain resolvable.

### Task 1: Recent payoff decay
- [x] RED regression for positive full-window / negative latest-five payoff.
- [x] Implement a 5-sample window that demotes only when the recent average is strictly worse than -0.10R, with all five stop-risk values present.
- [x] Preserve reason precedence.
- [x] Verify reliability/governance behavior.

### Task 2: Fresh shadow recovery
- [x] RED scheduler helper + evidence SQL assertions.
- [x] Persist `shadowOutcomeEligible`.
- [x] Allow active-rollout reliability/phase demotions to settle counterfactually while hard failures remain excluded.
- [x] Preserve backward-compatible legacy SHADOW selection.
- [x] Focused scheduler/evidence tests green.

### Task 3: Release
- [ ] Build/lint/format/diff verification.
- [ ] Push PR and require exact-head CI/security/concurrency/integrity gates.
- [ ] Merge only if green and verify exact-main staging deployment/runtime evidence.
