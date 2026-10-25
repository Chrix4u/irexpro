# Friday Champion 100k Replay v1 Implementation Plan

**Goal:** Reuse the original ~100k-per-pair frozen Dukascopy corpus to stress the exact current deployed M5 Plan-B architecture without training a new model.

**Spec:** `docs/superpowers/specs/2026-10-25-friday-champion-100k-replay-v1-design.md`

### Task 1: Causal M5 corpus reconstruction
- [ ] Write RED tests for de-duplication, availability-at causality, ordering, and malformed rows.
- [ ] Implement pure MTF-row -> closed-M5 reconstruction.
- [ ] Verify GREEN and commit.

### Task 2: Production-exact candidate/scorer wiring
- [ ] Write RED tests proving replay candidates equal direct `buildDirectionalCandidates()` results and scorer outputs equal `scorePlanBMultimodelShadow()`.
- [ ] Implement intrinsic side selection with fail-closed ties.
- [ ] Verify GREEN and commit.

### Task 3: PAPER lifecycle economics
- [ ] Write RED tests for BUY/SELL executable entry, spread-adjusted candle sides, SL-before-TP ambiguity, profit lock, time-to-work, and non-overlap.
- [ ] Implement replay episode engine using exported production lifecycle functions and PAPER market specs.
- [ ] Verify GREEN and commit.

### Task 4: Metrics and fold report
- [ ] Write RED tests for R metrics, PF, episode Sharpe, max R drawdown, six-pair denominator, and chronological three-fold evaluation.
- [ ] Implement deterministic report builder with all promotion flags false.
- [ ] Verify GREEN and commit.

### Task 5: CLI + full frozen replay
- [ ] Add CLI that reads all six frozen MTF CSVs with fixed paths/explicit overrides and writes sanitized JSON.
- [ ] Run a small smoke subset first.
- [ ] Run full six-pair replay on current main SHA.
- [ ] Verify report integrity/hash, focused tests, lint, build, and relevant full API tests.
- [ ] Freeze evidence, push branch, and open PR; merge only if CI is green.
