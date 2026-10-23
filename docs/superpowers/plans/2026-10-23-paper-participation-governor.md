# PAPER Participation Governor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Add a 30-minute soft PAPER participation target through idle-aware reduced-risk scout tiers without weakening hard safety gates.

**Architecture:** Extend the pure opportunity-scout policy with idle-aware BASE/ACTIVE/RECOVERY modes, then pass durable PAPER idle state from the collector and persist telemetry. Existing execution/risk/reliability gates remain downstream and unchanged.

**Tech Stack:** TypeScript, NestJS, Jest, pnpm.

**Spec:** `docs/superpowers/designs/2026-10-23-paper-participation-governor.md`

## Global Constraints
- BASE: 0.60 confidence, 0.08 net R, 0.30 quality, 4 consensus, 0.05 lot cap.
- ACTIVE at >=30m: 0.58 confidence, 0.06 net R, 0.25 quality, 4 consensus, >=0.15 ATR momentum, 0.03 lot cap.
- RECOVERY at >=60m: 0.56 confidence, 0.04 net R, 0.20 quality, 4 consensus, >=0.15 ATR momentum, 0.02 lot cap.
- OOD thresholds remain 0.62 confidence, 0.12 net R and 5/6-equivalent consensus.
- Event risk, cost usability, portfolio quality, route/regime safety and all downstream risk controls remain unchanged.

## Review Focus
- Idle time missing/invalid must fall back to BASE, never RECOVERY.
- 3/6 consensus must remain rejected at every idle tier.
- OOD must not use relaxed idle thresholds.
- HIGH_IMPACT_BLOCK/UNVERIFIED event risk and unusable execution costs remain hard rejects.
- Relaxed tiers must require aligned momentum.

---

### Task 1: Idle-aware scout policy
**Files:** Modify `apps/api/src/modules/ai/paper-opportunity-scout.ts`; Test `apps/api/src/modules/ai/paper-opportunity-scout.spec.ts`.

- [ ] Write failing tests for ACTIVE, RECOVERY, invalid idle fallback, 3/6 rejection, OOD no-relaxation, and hard event/cost vetoes.
- [ ] Run scout spec and verify RED due missing idle-aware behavior.
- [ ] Implement `idleMinutes`, `mode`, `targetWindowMinutes` and tier thresholds/caps in `evaluatePaperOpportunityScout`.
- [ ] Run scout spec and verify GREEN.
- [ ] Commit.

### Task 2: Collector integration and telemetry
**Files:** Modify `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts`; Test `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`.

- [ ] Write failing collector test proving idle minutes are passed to scout and metadata/model version reflect v2 mode.
- [ ] Run targeted collector test and verify RED.
- [ ] Pass `paperIdleState.idleMinutes`, log/persist mode and target, bump scout model artifact to v2.
- [ ] Run collector spec and verify GREEN.
- [ ] Commit.

### Task 3: Branch verification
- [ ] Run changed-file lint and `git diff --check`.
- [ ] Run scout + collector + PAPER broker lifecycle suites.
- [ ] Run API build and full API test suite.
- [ ] Push branch and open PR only after local verification is green.

## PAPER execution size invariant

- Executable external-provider PAPER trades use an overall product lot band of **0.10 to 2.00 lots**; **0.10 is reserved for explicitly eligible opportunity scouts**, while normal PAPER starts at 0.20.
- Opportunity-scout idleness may relax only soft predictive floors and may size an eligible scout at 0.10 lots; it must never lower normal PAPER below 0.20 or bypass hard safety.
- `PositionSizingService` remains authoritative for stop-distance risk and margin. It honors an explicit 0.10 scout floor or the 0.20 normal floor only when the actual stop-loss risk fits the durable ceiling; otherwise execution fails closed with `POSITION_SIZE_BELOW_POLICY_MINIMUM`.
- Calibrated OOD ideas may execute only through the evidence-backed 0.10 scout tier; legacy 0.01/0.02/0.03/0.05 execution remains disabled.
- M1 tactical V4 remains an immutable historical 0.01-lot cohort, but active wiring uses `m1-tactical-rollout-v5-meaningful-size-shadow`: M1 continues observing at one-minute cadence and cannot execute until it qualifies for the 0.20-lot product floor.
