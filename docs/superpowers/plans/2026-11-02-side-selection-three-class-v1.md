# Side Selection Three-Class v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a leak-free non-overlapping KEEP/FLIP/ABSTAIN dataset and evaluate a research-only three-class side-selection model.

**Architecture:** A read-only Node audit/exporter pairs simultaneous BUY/SELL ensemble shadow decisions and converts their resolved first-hit outcomes into labeled JSONL rows with pre-entry features. A Python research evaluator performs fold-local preprocessing, purged walk-forward training, untouched chronological holdout scoring, and produces a non-executable report.

**Tech Stack:** TypeScript/Jest + CommonJS operational script, PostgreSQL, Python 3.11, pandas, scikit-learn, XGBoost.

**Spec:** `docs/superpowers/specs/2026-11-02-side-selection-three-class-v1-design.md`

## Global Constraints
- No execution, sizing, risk or broker behavior changes.
- Future/post-entry information may construct labels only, never predictors.
- `executionAuthority=NONE`, `modifiesExecution=false`, `approvedForDemo=false`, `approvedForLive=false`.
- Confidence floor remains 0.60.
- Use chronological/purged validation only.

## Review Focus
- Missing/invalid nested metadata must become null/UNKNOWN without leaking outcome data.
- Pairing must require identical instrument, market bar and policy version and must choose the earliest observation per side.
- De-overlap must operate per instrument across paired BUY/SELL episodes.
- Categorical encoding must be fitted on training folds only; unseen validation categories must not fail.
- Insufficient future holdout must fail closed with an evidence-sufficiency result.

---

### Task 1: Shadow side-selection dataset exporter

**Files:**
- Create: `apps/api/scripts/export-side-selection-three-class-dataset.cjs`
- Create: `apps/api/src/modules/ai/side-selection-dataset-exporter.spec.ts`

**Interfaces:**
- Produces `runSideSelectionDatasetExport(input)` returning summary plus rows and optionally writes JSONL.
- Each row has `decision_time`, `instrument`, `direction`, `policy_version`, `label`, `original_net_r`, `mirrored_net_r`, and only pre-entry feature fields.

- [ ] Write failing tests for label semantics, simultaneous-side pairing, per-instrument de-overlap, missing metadata, read-only transaction, and no post-entry feature keys.
- [ ] Run targeted Jest and confirm RED for missing exporter.
- [ ] Implement the minimal exporter with injected outcome resolver for tests and compiled resolver for CLI.
- [ ] Run targeted Jest and confirm GREEN.
- [ ] Commit Task 1.

### Task 2: Three-class research evaluator

**Files:**
- Create: `services/ai-engine/app/domain/training/side_selection_three_class.py`
- Create: `services/ai-engine/tests/test_side_selection_three_class.py`

**Interfaces:**
- Consumes exporter JSONL.
- Produces JSON report containing data coverage, fold metrics, qualification scorecard, future holdout, feature names and explicit non-execution flags.

- [ ] Write failing tests for target mapping, fold-local preprocessing/unseen categories, confidence-to-ABSTAIN behavior, chronological holdout split and insufficient-evidence fail closed.
- [ ] Run pytest and confirm RED.
- [ ] Implement minimal loader, preprocessing, XGBoost evaluation and research scorecard.
- [ ] Run pytest and confirm GREEN.
- [ ] Commit Task 2.

### Task 3: Real-data research run and documentation

**Files:**
- Create: `docs/research/2026-11-02-side-selection-three-class-v1.md`

**Interfaces:**
- Uses Task 1 exporter and Task 2 evaluator against staging read-only data.
- Produces no committed user dataset/model binary.

- [ ] Export 14-day scanner dataset to `/tmp/irexpro-side-selection-v1.jsonl` and record counts/class balance/current-policy subset.
- [ ] Run the evaluator and save report under `/tmp`.
- [ ] Document observed walk-forward and untouched-holdout metrics, failure modes and next action.
- [ ] Run targeted Node/Python tests, API build/lint, Python test suite subset, and `git diff --check`.
- [ ] Commit Task 3 and push PR.
