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
