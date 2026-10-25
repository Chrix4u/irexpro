# PAPER Research Requalification Shadow v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect fresh, non-executing recovery evidence for quarantined PAPER research-throughput candidates without weakening any real execution brake.

**Architecture:** Add a pure shadow evaluator and informational evidence classifier, wire one JSON annotation into existing ensemble shadow decisions, then add a read-only audit runner over the existing first-hit outcomes. The portfolio brake is ignored only by the shadow observation decision; real route selection and the global Oct-19 control remain untouched.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL JSONB, existing ensemble outcome utilities, Node audit script.

**Spec:** `docs/superpowers/specs/2026-10-25-paper-research-requalification-shadow-v1-design.md`

## Global Constraints

- PAPER evidence collection only; no broker/order path changes.
- `executionAuthority` must always be `NONE` for the new artifact.
- `modifiesExecution`, `qualificationEvidence`, and `productionEligible` must always be false.
- Ignore only the realised portfolio brake for shadow collection; all local research gates and current cost-aware `ENTER_NOW` remain mandatory.
- Existing `isOct19ProvenM5PaperExecutionAllowed` behavior must remain unchanged.
- Informational recovery thresholds: 8 episodes, PF >=1.15, Sharpe >=1.0, max DD <=0.12, net R >0.

## Review Focus

- Portfolio brake blocked while all local gates pass: shadow candidate true, real execution still false.
- Missing/blocked cost-aware decision: shadow candidate false.
- Sparse pair/side or failed episode/calibration: shadow candidate false.
- Zero-loss positive evidence: PF-null handling must not falsely mark the cohort weak.
- Duplicate/overlapping decisions: audit must collapse them before counting episodes.

---

### Task 1: Pure shadow policy and evidence scorecard

**Files:**
- Create: `apps/api/src/modules/ai/paper-research-requalification-shadow.ts`
- Create: `apps/api/src/modules/ai/paper-research-requalification-shadow.spec.ts`

**Interfaces:**
- Produces: `evaluatePaperResearchRequalificationShadow(input)` and `evaluatePaperResearchRequalificationEvidence(input)`.

- [x] **Step 1:** Write failing tests for local-gate rejection, portfolio-brake diagnostic-only behavior, cost-aware rejection, immutable zero execution authority, collecting status, recovery signal, weak mature cohort, and zero-loss positive cohort.
- [x] **Step 2:** Run `pnpm test -- paper-research-requalification-shadow.spec.ts --runInBand` and confirm RED because the module/API does not exist.
- [x] **Step 3:** Implement the two pure evaluators with the exact constants and statuses from the spec.
- [x] **Step 4:** Run the focused test and confirm GREEN.
- [x] **Step 5:** Commit the pure policy.

### Task 2: Collector annotation wiring

**Files:**
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`
- Modify: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 evaluators.
- Produces: `components.paperResearchRequalificationShadow` annotation on the existing ensemble shadow row.

- [ ] **Step 1:** Add failing collector tests proving a portfolio-blocked but locally valid candidate is annotated as shadow recovery candidate while `isOct19ProvenM5PaperExecutionAllowed` still prevents order execution.
- [ ] **Step 2:** Add failing tests for pair/side, calibration, episode, and cost-aware blockers.
- [ ] **Step 3:** Confirm RED.
- [ ] **Step 4:** Reuse `loadPaperCostAwareEntryEvidence` for locally valid shadow candidates, evaluate the same PAPER_RESEARCH_THROUGHPUT cost policy, and annotate the decision before the global quarantine `continue`.
- [ ] **Step 5:** Reuse the loaded cost evidence for ordinary research route handling to avoid duplicate queries.
- [ ] **Step 6:** Run collector + shadow-policy focused tests and confirm GREEN.
- [ ] **Step 7:** Commit collector wiring.

### Task 3: Read-only requalification audit

**Files:**
- Create: `apps/api/scripts/audit-paper-research-requalification-shadow.cjs`
- Create: `apps/api/src/modules/ai/paper-research-requalification-shadow-runner.spec.ts`

**Interfaces:**
- Consumes: persisted Task 2 annotation, existing `components.outcome`, existing overlap-collapse and sleeve-summary helpers, Task 1 evidence classifier.
- Produces: one JSON read-only scorecard grouped overall and by pair/side.

- [ ] **Step 1:** Write failing runner tests for exact PAPER scope, artifact/outcome-version filters, overlap collapse, and zero execution/qualification authority in output.
- [ ] **Step 2:** Confirm RED.
- [ ] **Step 3:** Implement the repeatable-read/read-only runner and CLI script; do not write to the database.
- [ ] **Step 4:** Run runner tests and confirm GREEN.
- [ ] **Step 5:** Run the audit on staging; before the market creates new annotations, expect zero fresh episodes rather than backfilling legacy evidence.
- [ ] **Step 6:** Commit the audit.

### Task 4: Verification and delivery

- [ ] **Step 1:** Run the focused shadow, collector, and audit suites.
- [ ] **Step 2:** Run API build and targeted ESLint.
- [ ] **Step 3:** Run `git diff --check`.
- [ ] **Step 4:** Run the broader API regression suite with source-hash guard.
- [ ] **Step 5:** Push the isolated branch and use repository CI; do not merge if any required check is red.
- [ ] **Step 6:** After merge/CD, verify exact deployed SHA, API/AI health, PAPER mode, and run the read-only scorecard. No order-count increase is expected from this feature itself.
