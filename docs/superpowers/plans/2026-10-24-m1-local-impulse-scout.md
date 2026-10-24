# M1 Local Impulse Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Add a bounded M1 local-impulse early-transition scout that can participate despite moderate HTF conflict while retaining all existing PAPER safety and reliability gates.

**Architecture:** Reuse `M1_EARLY_TRANSITION` and the existing V6 0.10 PAPER scout. Add one explicit route reason for local impulse, exempt only that reason from the secondary HTF conflict blocker, and leave scheduler reliability/net-R/risk authority unchanged.

**Tech Stack:** NestJS, TypeScript, Jest.

**Spec:** `docs/superpowers/designs/2026-10-24-m1-local-impulse-scout.md`

## Global Constraints
- PAPER only.
- No threshold changes to DEMO/LIVE.
- Existing reliability, net-R, event/cost and risk checks remain authoritative.

### Task 1: Route classification
- [x] Add RED tests for Friday-like strong local impulse and severe/weak conflict.
- [x] Add `LOCAL_IMPULSE_AGAINST_HTF` reason and bounded local-impulse classifier.
- [x] Run `m1-tactical-route.spec.ts` GREEN.

### Task 2: Governance
- [x] Add RED test proving the tagged local-impulse route is not re-blocked by `M1_HIGHER_TIMEFRAME_CONFLICT`.
- [x] Preserve the blocker for ordinary routes.
- [x] Run `m1-tactical-governance.spec.ts` GREEN.

### Task 3: Scheduler integration and verification
- [x] Add/adjust scheduler test proving V6 still requires pair/side reliability and route net-R floor.
- [x] Run route + governance + scheduler suites, build, lint and diff-check.
- [ ] Push PR and require exact-head CI before merge.
