# iRexPro AI Engine V2 — execution backlog extension

Status: research-only extension of `AI_ENGINE_V2_EXECUTION_BACKLOG_20261127.md`
(P0/P1 numbering continues there; this file adds items, it never rewrites
them). Extends the backlog on the V2 research line
`research/ai-engine-v2-champion-challenger-20261127` (PR #846 head
`6407c1c6`); the working branch for this extension is
`research/ai-engine-v2-backlog-enginemap-20261127`, stacked directly on the
PR #846 head so the delta is additive only. No runtime edit, no model or
threshold change, no DB access, no broker call, no deployment; the
deployment hold stays intact. `executionAuthority: NONE` on every artifact.

Coordinates with PRs #834/#836/#837/#838 (M1 abstention research chain,
consumed by reference), PR #839 (parallel independent audit line under
`docs/research/v2/`), and the accounting/reconciliation PR stream (#851 and
successors) which is explicitly out of V2 scope.

---

## 0. Coordination snapshot (verified 2026-11-27 via GitHub API + git)

- `main` advanced `80c316fe` → `2f59fc74` (pushed 2026-11-27T14:20Z, PR #851
  "Identify unsettled closing records and gross P&L in history" merged).
  **Drift verdict: zero.** The 64-component map v1 drift detector was re-run
  against the current `main` tree (worktree at `2f59fc74`): 11/11 tests pass,
  every mapped path still exists, audit-count reconciliation intact (see
  `AI_ENGINE_V2_COMPONENT_MAP_PHASE2_20261127.md` §16).
- M1 stack unchanged and open: #834 (`research/m1-decision-evidence-coverage-20261126`
  @ `5e51898e`) ← #836 (`research/m1-abstention-intelligence-20261127` @
  `17497c8d`) ← #837 (`research/m1-taxonomy-integration-review-20261126` @
  `55c11626`) ← #838 (`research/m1-integration-ci-only-20261126` @
  `55c11626`, CI mirror to `main`). All four are drafts; merge order is the
  stack order; #839 stacks on #838's head.
- PR #846 head verified = remote branch tip of
  `research/ai-engine-v2-champion-challenger-20261127` @ `6407c1c6` — no
  divergence between the PR and its branch. (An earlier session note that
  misread the branch tip as a merged `research/actionable-label-v2` commit
  `82e89def` was a transcription error; corrected here.)
- PR #839 (`research/ai-v2-challenger-architecture-20261127` @ `a640b255`,
  32 files, +4,459) is a **separate, independent** full-engine audit line
  that produced its own backlog (`docs/research/v2/V2_EXECUTION_BACKLOG.md`,
  `V2_EXECUTION_BACKLOG_EXTENSION.md`), architecture proposal, and DEMO
  evaluation design. It duplicates scope with #846 by intent (independent
  replication), not by accident.
- **C-3 drift re-verification (2026-11-27, later the same day, before the
  P1-3 delivery):** `main` re-checked via `git ls-remote` — still
  `2f59fc74`, no new advance since the snapshot above. Verdict: **zero
  drift**; the P1-3 spec cites line anchors from the branch tree
  (`31c4e862` + the P1-3 delta) whose gate-file constants and
  scheduler/collector seam anchors are content-verified on every CI run by
  `verifyReliabilityGatePaths` / `verifyOrchestrationSeams`.

## 1. New backlog items

### P1-0.5 — Engine mapping phase 2 (delivered on this branch)

- [x] **P1-0.5** Deepen the P1-0 component map where v1 explicitly stopped:
  the Python ML core (L4), the orchestration scan-cycle internals (L5), and
  the verified cross-layer data-flow edges. Delivered →
  `AI_ENGINE_V2_COMPONENT_MAP_PHASE2_20261127.md` + executable mirror
  `apps/api/scripts/research/v2-engine-component-map-phase2.cjs` (+ test,
  CI step). Acceptance: 47 phase-2 components across 10 families, every
  entry path-verified; Python training-domain inventory reconciled by
  directory read (67 research/ops scripts, 6 committed test suites, 7
  readonly SQL probes — refining the audit's "~30 families" estimate);
  orchestration `runOnce` span asserted ≥ 3,000 lines as a structural fact;
  TS↔Python edge pinned by content anchors (5 HTTP endpoints + base URL);
  evidence edge pinned by SQL table anchors (4 tables); tampering is a
  typed refusal.

### P1-3..P1-6 (carried from the base backlog, inputs now extended)

- [x] **P1-3** Reliability-layer consolidation spec (A3). Inputs: map v1
  §3 (floor ladder 3→20 samples, PF 1.0→2.0) **plus** phase-2 §13 finding
  that the reliability gates are invoked from one ~3,693-line `runOnce`
  method — the consolidation spec must define extraction seams, not only
  shared floors. Delivered (2026-11-27, stacked on this branch) →
  `AI_ENGINE_V2_P1_3_RELIABILITY_CONSOLIDATION_SPEC_20261127.md` +
  `apps/api/scripts/research/v2-reliability-gate-contract.cjs` (+ test, CI
  step): nine-gate inventory, RL-1 ladder (COLD < 3 / SCOUT 3-5 / MEANINGFUL
  ≥ 6 / cap 20) with the mature handoff as a ladder rule, pre-registered
  floor slots (strictest observed V1 value per concept), verdict vocabulary
  + authority gradient, extraction seams SEAM-1/2/3 with CI-verified
  anchors, frozen corpus `RL-D01..RL-D12` (10 divergence + 2 controls;
  21-test suite, typed refusals, constant-anchor drift detection).
- [ ] **P1-4** Calibration-service consolidation spec (A4/B4) with the
  pre-outcome prediction registration format (V2-7 scoreboard). Inputs:
  map v1 §4 + §6 unchanged. Not started.
- [ ] **P1-5** Exit-specification consolidation spec (A7/G1). Inputs: map v1
  §5 unchanged; phase-2 adds the write-path edge (§14 E3) showing exits read
  settled evidence produced by the same scheduler cycle. Not started.
- [ ] **P1-6** Dead-code removal list (A6/A9/D4). Phase-2 §12 refines the
  Python side: the `domain/training/` tree holds 66 scripts of which the
  v10→v39 single-pair series is the largest dead-candidate block; proposal
  only, staged for a separately reviewable cleanup PR. Not started.

### C — Coordination items (new family, non-code)

- [ ] **C-1** M1-stack merge-order watch. When #834 merges to `main`,
  retarget #836 to `main`; repeat down the stack (#836 → #837 → #838);
  after #838 merges, retarget #839 and this line's artifacts referencing
  the M1 chain. Acceptance: each retarget is a no-content-change merge
  (delta identical), recorded in the retargeted PR body.
- [ ] **C-2** Parallel audit line reconciliation (#839 vs #846). Both lines
  delivered a full-engine audit, a challenger architecture, and a backlog.
  After both merge (or both are withdrawn), produce one reconciled V2 map +
  backlog: intersect findings (independent agreement = highest-confidence
  findings), keep exactly one backlog document, archive the other by
  pointer. Acceptance: a single canonical V2 entry point under
  `docs/research/`; the reconciliation note lists which findings both
  audits agree on (candidate: uncalibrated confidence, exit-side loss
  dominance, duplicate scorers/reversals/gates/calibration layers — both
  audits report these independently).
- [ ] **C-3** Drift watch protocol. Every time `main` moves, re-run the two
  component-map drift detectors on the new `main` tree before any V2
  artifact cites fresh line numbers; record the verdict in the extension
  doc's coordination snapshot (today's verdict: 11/11 + 47/47 paths valid on
  `2f59fc74`). Acceptance: no V2 doc cites line numbers from a tree its
  detectors have not verified.
- [ ] **C-4** Working-copy hygiene. Local worktrees used for main-tree drift
  checks (`/tmp/v2main` and equivalents) are disposable and never pushed;
  the local mistaken branch `ai-engine-v2-cc` (reset to `82e89def` during
  verification) was deleted; local branch
  `fix/partial-fill-accounting-evidence-ledger-20261125` was pre-existing
  and left untouched. Acceptance: no force-push to any shared branch; the
  V2 line only ever moves forward from `6407c1c6`.

## 2. Standing constraints (inherited, unchanged)

- V1 Champion untouched; no production credentials/DB/broker access; no
  LIVE activation; no deployment; deployment hold intact.
- No private datasets in the public repo; synthetic fixtures only in-repo.
- All V2 artifacts carry research-only authority semantics
  (`executionAuthority: NONE`).
- Coordinate with #834/#836/#837/#838 per C-1; PR #818 stays stacked on
  #810 as before; the accounting/reconciliation stream (#851+) is out of
  V2 scope and consumes nothing from this line.
