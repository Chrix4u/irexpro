# PAPER Realised Route Brake v1 — Implementation Plan

> Execute test-first. Keep all changes isolated from the deployed checkout until verification is complete.

## Task 1 — Pure realised-route reliability policy

- [x] Add failing unit tests for insufficient evidence, PF below one, PF at/above one, all-loss and no-loss cases.
- [x] Confirm RED.
- [x] Implement `evaluatePaperRealisedContinuationRouteReliability` with fixed 20-trade / PF-1.0 policy.
- [x] Add execution-composition tests for pair/side override behavior.
- [x] Confirm focused GREEN and lint.

## Task 2 — Read-only realised evidence loader

- [x] Add failing collector tests for exact PAPER/user/connection/model/timeframe/route/policy scoping.
- [x] Confirm RED.
- [x] Implement a 30-second cached aggregate loader over closed realised PAPER trades.
- [x] Return neutral/collecting evidence on unavailable data source; log query failures without fabricating weakness.
- [x] Confirm focused collector tests GREEN.

## Task 3 — Wire the brake into normal PAPER continuation

- [x] Add failing collector test: mature weak realised continuation + immature pair/side => normal PAPER demoted.
- [x] Add failing collector test: mature weak realised continuation + mature healthy pair/side => permitted override.
- [x] Add regression tests confirming reversal and early-transition behavior is unchanged.
- [x] Implement composition after existing route/pair-side diagnostics and before research fallback evaluation.
- [x] Persist/log the realised-route decision in diagnostics where the current reliability payload permits without schema expansion.
- [x] Confirm focused GREEN.

## Task 4 — Verification and evidence

- [x] Run relevant Jest suites.
- [x] Run API typecheck/lint/build checks used by this repository.
- [x] Run broader API test suite if resource budget permits.
- [x] Run `git diff --check`.
- [x] Re-run the read-only champion audit and document the current compatible route metrics.
- [ ] Commit and push the isolated branch only after all gates are green.
- [ ] Do not merge/deploy until verification shows no regression in PAPER scanner startup and the change is limited to continuation normal-PAPER authority.

## Verification Evidence — 2026-10-25

- Stable isolated verification worktree created from `origin/main` at `e7f61b4a4b6e7197f340659a22391b199041354b` after detecting concurrent edits in the earlier research worktree.
- Affected suites: 143/143 tests passed.
- Nest API build: passed.
- Canonical policy definition count: exactly one realised-route evaluator and one execution-composition gate.
- Fresh read-only PAPER audit: overall champion 100 trades, +63.89 USD, PF 1.2482225, positive instrument fraction 5/6.
- Compatible route evidence: CONFIRMED_REVERSAL 16 trades, +34.17, PF 1.9710; EARLY_TRANSITION 12 trades, +16.39, PF 1.6913; TREND_CONTINUATION 30 trades, -19.17, PF 0.70219046.
- Expected current classification: continuation `RESEARCH_ONLY` unless an exact pair/side has mature `HEALTHY` reliability evidence.

- Full API regression: 330/330 executed suites passed (2 suites intentionally skipped); 4,831 tests passed, 13 intentionally skipped, 0 failed. Jest emitted the final passing summary but retained an open handle afterward; source SHA-256 values were rechecked unchanged before terminating the idle test process.
