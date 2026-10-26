# M5 Scout Realised-Payoff Governor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact-generation live payoff feedback to M5 PAPER scouts without reducing the participation improvements.

**Architecture:** A pure payoff evaluator classifies exact scout model-version evidence. The collector loads only closed PAPER M5 trades for the chosen scout model version at final dispatch, then either preserves the existing cap, reduces it to 0.05, or keeps the candidate shadow-only.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL.

**Spec:** `docs/superpowers/designs/2026-10-26-m5-scout-realised-payoff.md`

## Global Constraints
- PAPER only; DEMO/LIVE unchanged.
- Exact model-version evidence only.
- Minimum 6 closed trades before payoff can reduce authority.
- Hard entry/risk gates remain authoritative.
- No threshold relaxation is introduced.

## Review Focus
- Zero-loss profitable cohorts are healthy, not division-by-zero failures.
- Invalid evidence stays COLLECTING.
- A weak scout generation cannot affect normal `paper-only-v1` entries.
- Reduced state caps at 0.05 even when upstream scout cap is 0.10.
- Shadow-only state never calls `receiveSignal`.

---

### Task 1: Pure realised-payoff policy
**Files:** Create `apps/api/src/modules/ai/paper-scout-realised-payoff.ts`; create spec.
- [ ] Write RED tests for COLLECTING, HEALTHY, REDUCED, SHADOW_ONLY and zero-loss evidence.
- [ ] Implement the minimal evaluator.
- [ ] Run the focused spec GREEN.

### Task 2: Exact-model collector integration
**Files:** Modify `vps-forex-signal-collector.service.ts` and its spec.
- [ ] Add exact-model closed-trade evidence loader.
- [ ] Apply decision only to eligible scout winners before signal dispatch.
- [ ] Persist decision metadata and log the action.
- [ ] Prove reduced cap and shadow-only dispatch behavior.
- [ ] Run trading-critical tests, build, lint, diff-check; push for exact-head CI.
