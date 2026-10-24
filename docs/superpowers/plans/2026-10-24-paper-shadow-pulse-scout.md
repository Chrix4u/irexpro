# PAPER Shadow Pulse Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote only strongly supported causal shadow-direction evidence into the existing 0.10-lot PAPER scout lane.

**Architecture:** Extend `evaluatePaperOpportunityScout` with optional shadow-pulse evidence and a strict confidence-rescue path. Pass the already-causal adaptive shadow pulse from the collector into that policy and persist provenance. The result remains NORMAL_PAPER and all downstream hard-risk controls remain authoritative.

**Tech Stack:** TypeScript, NestJS, Jest, PostgreSQL, GitHub Actions.

**Spec:** `docs/superpowers/designs/2026-10-24-paper-shadow-pulse-scout.md`

## Global Constraints
- PAPER only; no DEMO/LIVE authority change.
- 0.10 lot RESEARCH sizing only for the rescue lane.
- No OOD or confirmed-reversal pulse rescue.
- No hard safety bypass.

## Review Focus
- Future/unresolved shadow outcomes cannot contribute to pulse evidence.
- Neutral/opposed/sparse pulse cannot rescue.
- Positive pulse cannot rescue negative/too-small post-cost edge.
- Strong pulse cannot bypass post-loss, reliability, portfolio or entry-alignment vetoes.
- Metadata identifies pulse-backed scouts unambiguously.

---

### Task 1: Pure pulse-backed scout policy
**Files:** Modify `apps/api/src/modules/ai/paper-opportunity-scout.ts`; test `paper-opportunity-scout.spec.ts`.
- [x] Write RED tests for strong pulse rescue and all negative boundaries.
- [x] Implement minimal optional pulse policy.
- [x] Run focused scout tests GREEN (16/16).

### Task 2: Collector wiring and provenance
**Files:** Modify `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts` and spec.
- [x] Write collector regression proving the already-causal pulse reaches scout evaluation.
- [x] Wire pulse and persist explicit metadata.
- [x] Prove downstream post-loss guard still blocks a forced-eligible pulse scout; existing reliability/entry controls remain downstream.

### Task 3: Verification and release
- [x] Run trading-critical tests (125/125), build, lint, prettier and `git diff --check`.
- [ ] Push PR and require exact-head API/concurrency/security/required-CI green.
- [ ] Merge exact head, verify exact-main release/staging deploy, then inspect runtime evidence.
