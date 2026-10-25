# M1 Provisional Scout v7 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax.

**Goal:** Add a 0.05-lot provisional early-transition PAPER scout for exceptionally strong 3-5 sample sleeves while preserving the mature v6 0.10 tier.

**Architecture:** Add a pure provisional reliability evaluator, add rollout v7, evaluate mature and provisional evidence from the same pair-side outcome set, and select the execution cap by reliability tier. No M1 trend/reversal authority changes.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL.

**Spec:** `docs/superpowers/designs/2026-10-25-m1-provisional-scout-v7.md`

## Global Constraints

- PAPER only.
- M1_EARLY_TRANSITION only.
- Mature >=6 uses existing v6 evaluator and 0.10 cap.
- Provisional 3-5 requires PF>=2.0, avg>=0.20R, positive fraction>=0.50, recent3 R>0; 0.05 cap.
- M1 trend/reversal remain shadow-only.

## Review Focus

- 6+ samples cannot fall back to provisional when mature evidence is weak.
- A 3-sample strong sleeve uses 0.05, never 0.10.
- Recent degradation blocks provisional.
- Generic governance/net-R floor remains authoritative.
- Execution metadata clearly identifies provisional vs mature tier.

---

### Task 1: Provisional reliability policy

Create evaluator + tests; prove RED then GREEN. **Complete.**

### Task 2: Rollout v7 and dynamic sizing

Add phase/policy v7; wire mature/provisional tier selection and 0.10/0.05 caps with scheduler tests. **Complete.**

### Task 3: Verification and release

Run reliability, scheduler, API build/lint/format/diff checks; exact-head PR CI before merge/deploy. **Local verification complete; exact-head PR CI pending.**
