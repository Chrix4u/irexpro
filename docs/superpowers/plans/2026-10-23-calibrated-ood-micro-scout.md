# Calibrated OOD Micro Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Let strong locally calibrated OOD trend opportunities participate at 0.01-lot PAPER risk instead of being discarded before calibration.

**Architecture:** Run adaptive calibration before scout admission, evaluate a narrow calibrated-OOD rescue, then re-evaluate scout winners as NORMAL_PAPER before final ranking/risk.

**Tech Stack:** NestJS, TypeScript, Jest, PostgreSQL, GitHub Actions.

**Spec:** `docs/superpowers/designs/2026-10-23-calibrated-ood-micro-scout.md`

## Global Constraints
- PAPER only; no DEMO/LIVE authority changes.
- Research routes remain shadow-only.
- Hard safety gates remain authoritative.
- Micro rescue cap: 0.01 lots.

## Review Focus
- Scout sees calibrated evidence before admission.
- Opposite momentum stays blocked.
- `mtfStrength:HARD_LOW` stays blocked.
- Weak/non-local calibration stays blocked.
- Final sizing cannot exceed 0.01 lots for calibrated OOD micro scouts.

### Task 1: Calibrated OOD policy
- [x] Add exact GBPUSD regression and negative controls.
- [x] Implement calibrated OOD micro rescue.
- [x] Verify scout unit suite GREEN.

### Task 2: Collector ordering
- [x] Add regression requiring calibrated edge/provenance in scout call.
- [x] Move adaptive evidence pass before scout and re-run executable scout winners as NORMAL_PAPER.
- [x] Verify collector ordering regression GREEN.

### Task 3: Attribution and release verification
- [x] Version scout cohort as v3 and persist attribution metadata.
- [x] Verify scout + collector suites and static checks.
- [x] Compile API.
- [ ] Push PR; require exact-head API/concurrency/security/Required CI green before merge/deploy.
