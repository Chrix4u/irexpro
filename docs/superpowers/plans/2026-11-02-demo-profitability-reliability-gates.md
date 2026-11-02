# DEMO Profitability Reliability Gates — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-02-demo-profitability-reliability-gates-design.md`

## Global constraints

- DEMO-only; no LIVE behavior changes.
- TDD for every production change: test must fail for the intended reason before implementation.
- Preserve trend-continuation execution.
- Preserve shadow telemetry for vetoed entries.
- Do not introduce automatic direction flipping, pair bans, tighter universal stops, or larger lot sizes.

## Task 1 — Pure profitability reliability gate

**Files:**
- Create `apps/api/src/modules/ai/demo-profitability-reliability-gate.ts`
- Create `apps/api/src/modules/ai/demo-profitability-reliability-gate.spec.ts`

**RED:** Add tests proving:
1. `EARLY_LOSS_STREAK` returns a hard execution veto.
2. Weak/degraded meaningful/provisional pair-side states veto `M1_EARLY_TRANSITION`.
3. Healthy/eligible early-transition evidence remains executable.
4. `M1_TREND_CONTINUATION` ignores the early-transition pair-side veto.
5. Missing reliability evidence does not invent a blocker.

Run: `pnpm --filter @irexpro/api exec jest apps/api/src/modules/ai/demo-profitability-reliability-gate.spec.ts --runInBand`
Expected RED: module missing / new assertions fail before production helper exists.

**GREEN:** Implement the smallest pure helper satisfying the spec. Re-run the same test; expected PASS.

**Commit:** `feat(ai): add demo profitability reliability gate`

## Task 2 — Wire gate into professional DEMO scheduler

**Files:**
- Modify `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- Modify `apps/api/src/modules/ai/m1-tactical-scheduler.service.spec.ts`

**RED:** Add scheduler tests proving:
1. A candidate whose multimodel primary authority is executable does **not** call `receiveSignal` when M1 reliability is `EARLY_LOSS_STREAK`.
2. An executable early-transition candidate does **not** call `receiveSignal` when pair-side reliability is degraded.
3. The vetoed decision is still recorded and includes the explicit blocker and gate telemetry.
4. Healthy early-transition evidence still permits normal execution.
5. Trend continuation remains executable when it would have executed before.

Run targeted scheduler tests. Expected RED: current scheduler still submits the blocked candidates.

**GREEN:** Evaluate the pure gate after M1 reliability, pair-side reliability, and multimodel evaluation are available. Apply the hard loss-streak veto to all professional DEMO execution alternatives so fallback/rescue cannot bypass it. Apply the degraded pair-side veto to early-transition broker execution. Include blocker and governance telemetry while retaining decision persistence/shadow eligibility.

Re-run targeted scheduler tests; expected PASS.

**Commit:** `feat(ai): enforce demo reliability veto before execution`

## Task 3 — Regression and safety verification

Run:
- targeted gate tests
- targeted multimodel authority tests
- targeted scheduler tests
- API lint on changed TypeScript files
- `git diff --check`
- API build
- full API Jest suite (capture any known environment/baseline failures separately)

Expected: all targeted behavior and build/lint checks pass. Any full-suite failure must be proven baseline/environmental before branch completion.

Review the branch for accidental LIVE changes and confirm none exist.

**Commit only if verification requires a corrective change.**

## Task 4 — Delivery

Push the feature branch and open a PR against `main`. Do not merge or deploy LIVE as part of this plan. If CI is green and the user’s standing ownership instruction permits normal project integration, proceed with DEMO deployment only after branch review; otherwise leave the PR ready with exact validation evidence.