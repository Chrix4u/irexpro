# PAPER Research Lot Cap Enforcement Plan

**Goal:** Make PAPER RESEARCH sizing honor the collector-provided lot upper bound while preserving allocation-aware sizing for normal/high-conviction PAPER trades.

**Architecture:** Keep `PositionSizingService` as the authoritative sizing engine. Change only the PAPER allocation policy so `RESEARCH` does not remove the AI lot ceiling. Profile ceiling removal and allocation-based risk budgeting remain unchanged for PAPER; non-PAPER behavior is untouched.

## Tasks
1. Add/modify policy and sizing tests so RESEARCH expects `removeAiLotCeiling=false` and a 0.01 requested upper bound produces 0.01 lots; verify tests fail on current code.
2. Implement the minimal policy change and documentation update.
3. Verify targeted position-sizing/policy suites, strategy-orchestrator sizing regressions, API build/typecheck/lint where applicable, and `git diff --check`.
4. Commit, push, open a PR, and require CI before deployment.
