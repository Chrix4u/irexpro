# PAPER 0.10 Scout Tier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans and TDD.

**Goal:** Add a 0.10-lot PAPER scout tier while preserving the 0.20–2.00 normal conviction ladder.

**Architecture:** Scout policy emits RESEARCH/0.10 authority. Strategy orchestration passes a 0.10 minimum only for scout metadata; normal external PAPER keeps 0.20. PositionSizingService uses 0.10 as the absolute PAPER minimum, but honors an explicit 0.20 normal minimum and still validates actual stop risk before lifting any floor.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL/GitHub Actions.

**Spec:** `docs/superpowers/designs/2026-10-23-paper-scout-010-tier.md`

## Global Constraints
- PAPER only; no DEMO/LIVE authority changes.
- 0.10 is scout-only; normal BASE remains 0.20.
- Maximum remains 2.00 lots.
- Never bypass event/cost/reliability/post-loss/portfolio/margin/SL/TP/broker risk gates.

## Review Focus
- Scout metadata cannot accidentally lower normal trades to 0.10.
- 0.10 must still be rejected when its actual stop risk exceeds the durable risk ceiling.
- OOD direction quality below 0.08 stays blocked.
- OOD hard MTF disagreement/opposite momentum stays blocked.
- 2.00 maximum remains enforced.

### Task 1: Scout policy
- [ ] RED: scout decisions expect 0.10 / RESEARCH and calibrated OOD rescue.
- [ ] GREEN: implement policy and version semantics.

### Task 2: Central sizing contract
- [ ] RED: explicit scout minimum 0.10 is honored while normal explicit minimum remains 0.20.
- [ ] GREEN: implement absolute 0.10 floor + explicit normal/scout policy floors and 2.00 ceiling.

### Task 3: Orchestrator/collector wiring
- [ ] RED: scout signal passes 0.10 minimum; normal signal passes 0.20.
- [ ] GREEN: persist scout cohort metadata and keep downstream safety unchanged.

### Task 4: Verification/release
- [ ] Run focused scout/sizing/orchestrator/collector suites, build, lint and diff check.
- [ ] Push PR; merge only after exact-head required gates are green.
