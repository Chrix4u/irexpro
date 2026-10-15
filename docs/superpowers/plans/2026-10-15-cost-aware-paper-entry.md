# Cost-Aware PAPER Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Add a PAPER-only cost-aware research entry gate that can enter now, defer to a later closed-bar reevaluation, or stay shadow-only without weakening existing eligibility/risk gates.

**Architecture:** A pure evaluator consumes current gross/net expected R plus 24-hour pair/direction cost-flip evidence. The collector loads the evidence only after a route has already passed all existing governance, reliability, episode and post-loss gates; only `PAPER_RESEARCH_THROUGHPUT` can be execution-modified. Every decision is annotated onto the already-persisted ensemble shadow row so its eventual immediate-entry outcome remains the comparison baseline.

**Tech Stack:** NestJS/TypeScript, Jest, PostgreSQL JSONB, existing ensemble shadow ledger.

**Spec:** Approved in-chat design on 2026-10-15: cost-aware PAPER entry quality, pair/direction specific, no DEMO/LIVE authority, no threshold weakening, measurable against immediate-entry counterfactual.

## Global Constraints
- Never add execution authority that did not already exist.
- Never lower netExpectedR, event-risk, drift, reliability, episode, post-loss, sizing, margin, or risk gates.
- Execution modification is limited to PAPER_RESEARCH_THROUGHPUT; other PAPER routes are diagnostic only.
- Qualification evidence remains false and DEMO/LIVE behavior is unchanged.
- A deferred candidate may only be reconsidered on a later normal closed-bar evaluation; no synthetic order chasing.

## Review Focus
- Missing/invalid cost evidence must fail safely without creating eligibility.
- Sparse cohort evidence must not overfit or block by itself.
- High current cost burden must defer marginal research entries.
- Persisted action must keep the immediate-entry shadow row available as baseline.
- Non-research and DEMO/LIVE authority must remain unchanged.

---

### Task 1: Pure cost-aware entry evaluator
**Files:** Create `apps/api/src/modules/ai/paper-cost-aware-entry.ts`; create `apps/api/src/modules/ai/paper-cost-aware-entry.spec.ts`.
**Interfaces:** Produces `evaluatePaperCostAwareEntry(input)` returning ENTER_NOW/DEFER/SHADOW_ONLY with reason, metrics, `modifiesExecution`, `qualificationEvidence:false`.
- [x] Write failing unit tests for sparse evidence, moderate flip-rate defer, severe flip-rate shadow-only, marginal cost-burden defer, healthy enter-now, and non-research diagnostic-only behavior.
- [x] Run tests and verify RED.
- [x] Implement minimal evaluator.
- [x] Run tests and verify GREEN.

### Task 2: Pair/side cost evidence and collector wiring
**Files:** Modify `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`; modify its spec.
**Interfaces:** Loads last-24h pair/direction gross-positive sample count, cost-flipped count and net-positive count from `trading.ensemble_shadow_decisions`; consumes Task 1 evaluator after existing route selection.
- [x] Add failing collector tests proving a deferred research candidate is not submitted while normal PAPER remains unchanged and metadata is annotated.
- [x] Run targeted tests and verify RED.
- [x] Add evidence loader, evaluator call, annotation, log, and research-only execution reduction.
- [x] Run targeted tests and verify GREEN.

### Task 3: Verification and branch review
**Files:** No new production scope.
- [x] Run cost-aware unit tests + collector suite + API typecheck/build.
- [x] Run `git diff --check` and review authority boundaries.
- [ ] Commit, push, open PR, and require CI before merge.
