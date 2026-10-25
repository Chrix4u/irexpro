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
- [x] Commit and push the isolated branch only after all gates are green.
- [x] Do not merge/deploy until verification shows no regression in PAPER scanner startup and the change is limited to continuation normal-PAPER authority.

## Verification Evidence — 2026-10-25

- Focused reliability + collector suites: **143/143 tests passed**.
- API build: **PASS** (`nest build`).
- Targeted ESLint: **PASS**.
- Repository-wide ESLint: **0 errors** (422 pre-existing warnings).
- `git diff --check`: **PASS**.
- Full API regression: **330 passed suites / 4,831 passed tests / 0 failures**; 2 suites / 13 tests skipped by the repository configuration.
- Independent verified-worktree source SHA-256 guard: **PASS**; all four changed source/test files were byte-identical before and after the full suite.
- Read-only forward audit snapshot: `2026-10-25T18:23:19.011Z`.
- Overall PAPER champion: 100 trades, +63.89 realised PnL, PF 1.2482225417, 5/6 positive instruments, status `PROVISIONAL_FORWARD_CHAMPION`.
- Current policy-compatible `TREND_CONTINUATION`: 30 trades, gross profit 45.20, gross loss 64.37, net -19.17, PF 0.7021904614.
- New realised-route policy decision on that frozen snapshot: `RESEARCH_ONLY`, `fullSizeEligible=false`, reason `REALISED_ROUTE_PROFIT_FACTOR_BELOW_ONE`.
- `CONFIRMED_REVERSAL` and `EARLY_TRANSITION` are not subject to this realised continuation brake.
- Research fallback remains available because reliability demotion is an explicitly safe input to `PAPER_RESEARCH_THROUGHPUT`; normal PAPER demotion therefore does not erase qualifying research evidence.

- Feature commit pushed and remote-verified: `86560d5731f2fe61b1c9b0c4b9ca701d4542ea5a`.
