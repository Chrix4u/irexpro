# PAPER Shadow Local-Edge Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let mature, recently profitable local shadow pockets unlock a 0.10-lot PAPER scout even when global soft-model gates disagree.

**Architecture:** Add a pure local-pocket evaluator and a causal exact-cell evidence loader. Feed the pocket decision into the existing PAPER opportunity scout before global drift/net-R/calibration soft vetoes, then preserve all downstream reliability, post-loss, entry-alignment, portfolio and broker/risk gates.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL, existing ensemble shadow ledger.

**Spec:** `docs/superpowers/designs/2026-10-25-paper-shadow-local-edge-scout.md`

## Global Constraints
- PAPER only; DEMO/LIVE authority unchanged.
- 0.10 lot maximum for local-edge scout.
- Active model policy only; no cross-policy evidence mixing.
- Causal: evaluated/resolved timestamps must be strictly before current evaluation.
- Hard safety gates remain fail-closed.

## Review Focus
- Sparse historical pocket must never execute.
- Mature but recently deteriorated pocket must never execute.
- Event/cost/portfolio hard veto must still win.
- Local pocket authority must not reopen CONFIRMED_REVERSAL/research routes.
- Current global negative net-R/calibration may be overridden only when exact pocket support is mature and recent.

---

### Task 1: Local pocket evidence policy
**Files:**
- Create: `apps/api/src/modules/ai/paper-shadow-local-edge-pocket.ts`
- Create: `apps/api/src/modules/ai/paper-shadow-local-edge-pocket.spec.ts`

**Interfaces:**
- Produces `evaluatePaperShadowLocalEdgePocket(evidence)` and `PaperShadowLocalEdgePocketDecision`.

- [ ] Write RED tests for supported, sparse, low-PF, low-average-R, and recent-deterioration evidence.
- [ ] Implement minimal evaluator.
- [ ] Run focused test GREEN.
- [ ] Commit.

### Task 2: Causal exact-pocket loader and scout authority
**Files:**
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Modify: `apps/api/src/modules/ai/paper-opportunity-scout.ts`
- Modify: corresponding specs.

**Interfaces:**
- Consumes exact `instrument + direction + session + adaptive state + TREND_CONTINUATION + active policy` resolved shadows.
- Produces `LOCAL_SHADOW_EDGE_SCOUT` qualification at 0.10 lots.

- [ ] Write RED loader test proving active-policy, exact-cell, pre-evaluation SQL constraints.
- [ ] Write RED scout test proving supported pocket can override negative global edge/calibration at >=4 consensus.
- [ ] Implement loader and collector wiring.
- [ ] Preserve downstream reliability/post-loss/alignment/risk gates.
- [ ] Run collector + scout suites GREEN.
- [ ] Commit.

### Task 3: Release verification
- [ ] Run changed-file lint/format/diff check.
- [ ] Run API build and trading-critical suites.
- [ ] Push PR and require exact-head API/concurrency/security/Required CI.
- [ ] Merge only after green, then verify exact-main staging release/deploy and runtime attribution.
