# M1 Early-Transition 0.10 PAPER Scout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote only mature profitable M1 early-transition pair/sides into a separate 0.10-lot PAPER scout sleeve.

**Architecture:** Add a stricter causal shadow reliability evaluator, a V6 early-transition-only rollout phase, and an explicit M1 scout sizing marker. Reuse the normal M1 governance/risk pipeline; no drift rescue or M5 threshold relaxation.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL, GitHub Actions.

**Spec:** `docs/superpowers/designs/2026-10-24-m1-early-transition-scout-010.md`

## Global Constraints
- PAPER only; DEMO/LIVE unchanged.
- Only `M1_EARLY_TRANSITION` may execute in V6.
- Cap requested PAPER volume at 0.10 lots.
- Require >=6 causal shadow episodes, PF >=1.50, avg net R >=+0.10R, positive fraction >=40%, latest-three net R >0.
- Keep route net expected-R floor at +0.20R.
- No OOD/drift-only rescue at 0.10 lots.
- Normal external PAPER minimum remains 0.20; M5 scout authority remains separate.

## Review Focus
- Sparse but impressive 3-sample sleeves must remain shadow-only.
- Mature evidence with recent deterioration must remain shadow-only.
- M1 trend-continuation/reversal must remain shadow-only.
- A forged M1 scout metadata flag on the wrong timeframe/strategy must not get the 0.10 sizing floor.
- Event/drift/cost/session/risk gates must still veto qualified evidence.

---

### Task 1: Meaningful M1 shadow reliability
**Files:** Create `apps/api/src/modules/ai/m1-meaningful-scout-reliability.ts`; create spec.
**Produces:** `evaluateM1MeaningfulScoutReliability()` and artifact/threshold constants.
- [ ] Write RED tests for 6-sample profitable qualification, 3-sample rejection, weak PF rejection, recent-three degradation, wrong route, future evidence exclusion.
- [ ] Implement the evaluator and run focused GREEN tests.
- [ ] Commit.

### Task 2: V6 rollout and collector authority
**Files:** Modify `m1-tactical-scheduler.service.ts`, `ai.module.ts`, scheduler specs.
**Consumes:** Task 1 evaluator.
**Produces:** `PAPER_EARLY_TRANSITION_SCOUT_010` / `M1_TACTICAL_ROLLOUT_POLICY_V6`.
- [ ] Write RED tests proving V6 does not exist / cannot execute.
- [ ] Add V6 with 0.10 cap; only early-transition route executable.
- [ ] Require meaningful reliability + standard governance; do not allow micro drift rescue.
- [ ] Persist evidence provenance and `m1_evidence_qualified_scout_eligible` metadata.
- [ ] Prove 3-sample pair remains shadow and mature healthy pair dispatches 0.10.
- [ ] Prove trend/reversal and hard governance blockers remain shadow.
- [ ] Commit.

### Task 3: Central 0.10 sizing authority
**Files:** Modify `strategy-orchestrator.service.ts` and specs.
**Consumes:** Task 2 metadata flag.
**Produces:** audited 0.10 minimum only for exact M1 tactical scout identity.
- [ ] Write RED tests: valid M1 flag gets 0.10; wrong timeframe/strategy stays 0.20.
- [ ] Implement exact identity check alongside existing M5 scout flag.
- [ ] Run sizing/orchestrator regressions and commit.

### Task 4: Release verification
- [ ] Run M1 scheduler/evidence/reliability, strategy orchestrator, position sizing and risk critical suites.
- [ ] Run API build, Prettier, ESLint and `git diff --check`.
- [ ] Push PR and require exact-head API CI, PostgreSQL concurrency, Release Security/CodeQL, Strategy Promotion Integrity and Required CI.
- [ ] Merge only after exact-head green; verify exact merged SHA through Main Staging Release Gate and Staging Deploy.
