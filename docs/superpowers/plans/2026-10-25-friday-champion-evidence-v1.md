# Friday Champion Evidence v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reproducible, read-only evidence scoreboard for the Friday normal-M5 PAPER champion and frozen research baselines without changing trading authority.

**Architecture:** Add a pure TypeScript summarizer for sanitized realised-trade rows, then a read-only CJS audit runner that queries PAPER data and loads frozen research reports. Freeze one sanitized evidence artifact from the VPS run. No trading-path code is modified.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL read-only audit, Node.js CJS, frozen JSON research artifacts.

**Spec:** `docs/superpowers/specs/2026-10-25-friday-champion-evidence-v1-design.md`

## Global Constraints
- No PAPER/DEMO/LIVE authority change.
- Compatible policy lineage comes from `PLAN_B_ROUTE_RELIABILITY_EVIDENCE_POLICY_VERSIONS`; never duplicate the list.
- Champion checks: closed trades >= 50, PnL > 0, PF >= 1.15, positive instrument fraction >= 0.67.
- Compatible sleeve maturity: >= 8 closed normal-M5 trades; weak when PF < 1.0 or gross profit is zero with losses.
- Generated evidence must contain no user, connection, account, credential, order, trade, or signal identifiers.

## Review Focus
- Zero-loss cohorts must not fabricate an infinite numeric PF; expose `null` while still preserving positive PnL.
- Break-even trades must not count as wins or losses.
- Old incompatible policy generations may appear in descriptive totals but cannot create a mature compatible veto diagnostic.
- Missing frozen research files must fail explicitly rather than silently inventing evidence.
- The audit SQL must execute in a repeatable-read read-only transaction.

---

### Task 1: Pure champion evidence summarizer

**Files:**
- Create: `apps/api/src/modules/ai/paper-champion-evidence.ts`
- Create: `apps/api/src/modules/ai/paper-champion-evidence.spec.ts`

**Interfaces:**
- Consumes: sanitized trade rows and the compatible policy-version list.
- Produces: `buildPaperChampionEvidence(...)` with champion checks and grouped realised metrics.

- [x] **Step 1: Write failing tests** for champion qualification, grouping, zero-loss PF, and stale-policy exclusion.
- [x] **Step 2: Run focused Jest and verify RED.**
- [x] **Step 3: Implement the minimum pure summarizer.**
- [x] **Step 4: Run focused Jest and verify GREEN.**
- [x] **Step 5: Commit the pure summarizer.**

### Task 2: Read-only evidence audit runner

**Files:**
- Create: `apps/api/scripts/audit-paper-champion-evidence.cjs`
- Create: `apps/api/src/modules/ai/paper-champion-evidence-runner.spec.ts`

**Interfaces:**
- Consumes: PostgreSQL PAPER rows, `buildPaperChampionEvidence`, frozen six-pair summary JSON, frozen v84 prospective JSON.
- Produces: one sanitized `friday-champion-evidence-v1` JSON object.

- [x] **Step 1: Write failing runner tests** with an injected fake client and frozen fixture-shaped objects.
- [x] **Step 2: Run focused Jest and verify RED.**
- [x] **Step 3: Implement repeatable-read read-only runner and explicit research-file validation.**
- [x] **Step 4: Run focused Jest and verify GREEN.**
- [x] **Step 5: Commit the runner.**

### Task 3: Freeze current VPS evidence

**Files:**
- Create: `apps/api/reports/friday-champion-evidence-v1-20261025.json`
- Create: `apps/api/reports/friday-champion-evidence-v1-20261025.json.sha256`
- Modify: `docs/superpowers/plans/2026-10-25-friday-champion-evidence-v1.md`

**Interfaces:**
- Consumes: exact clean branch code plus read-only VPS data and frozen research artifacts.
- Produces: immutable sanitized evidence for the next market-open decision.

- [x] **Step 1: Build the API and run the read-only audit against VPS data.**
- [x] **Step 2: Validate that the JSON contains no prohibited identifiers/secrets.**
- [x] **Step 3: Freeze the JSON and SHA-256.**
- [x] **Step 4: Run focused tests, `git diff --check`, and API build.**
- [x] **Step 5: Commit the frozen evidence and mark this plan complete.**

## Verification Record

- Focused champion/control verification: 4 suites, 34 tests passed.
- Full API verification: 327 executed suites passed; 4,775 executed tests passed; 2 suites / 13 tests intentionally skipped; exit code 0 with Jest `--forceExit` after an existing open-handle shutdown issue.
- API build passed.
- ESLint passed for the new TypeScript evidence files.
- `node --check` passed for the read-only CJS runner.
- `git diff --check` passed.
- Frozen JSON contains no UUID-like values or identifier-like keys and its SHA-256 verifies.
- A fresh-worktree sqlite3 native binary required a newer glibc than the VPS; verification used the same sqlite3 6.0.1 native binary from the working staging install. This touched only untracked `node_modules`, not source or evidence.
- Trading authority remains unchanged.
