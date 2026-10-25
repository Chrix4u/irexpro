# High-Conviction Local-Edge Consensus Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Increase qualified PAPER participation by letting exceptionally strong local M5 payoff pockets execute at 3/6 consensus without lowering global gates.

**Architecture:** Extend local-pocket evidence with a high-conviction classifier, use it only inside the existing local shadow-edge scout, and preserve empirical pocket R through collector ranking/re-evaluation.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL evidence, GitHub Actions.

**Spec:** `docs/superpowers/designs/2026-10-25-local-edge-consensus-scout.md`

## Global Constraints
- PAPER only, 0.10 lot scout cap.
- Never allow <3/6 consensus.
- Ordinary supported local pockets remain >=4/6.
- Hard event/cost/portfolio/entry/risk/broker/rollover controls remain unchanged.

### Task 1: High-conviction pocket policy
- [x] Add failing policy tests for exceptional 3/6, ordinary 3/6, 2/6, rollover and event risk.
- [x] Add explicit high-conviction evidence floors and classifier.
- [x] Make exceptional 3/6 return `LOCAL_SHADOW_EDGE_CONSENSUS_SCOUT`.
- [x] Verify focused policy tests.

### Task 2: Collector authority plumbing
- [x] Treat both local-edge scout reasons as empirical local-edge authority.
- [x] Preserve pocket average R through adaptive ranking and re-evaluation.
- [x] Verify collector + policy suites.

### Task 3: Release verification
- [x] Run formatting, lint, API build and diff checks.
- [ ] Push PR and require exact-head API/concurrency/security/Required CI.
- [ ] Merge and verify exact-main staging deployment before forward testing.
