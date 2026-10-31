# Persistent Sleeve Payoff Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve severe exact pair/side/route negative payoff evidence across the FX weekend without suppressing profitable sleeves.

**Architecture:** Extend `M1TacticalEvidenceService.loadMultimodelLossStreakBrake` so one 14-day, last-eight authoritative trade sample supports both the existing short-term loss-streak brake and a new persistent payoff quarantine. Short-term loss streaks still use the 12-hour cooldown; persistent payoff uses an independent 96-hour relevance horizon and PF < 0.65 with all 8 samples present.

**Tech Stack:** TypeScript, NestJS service, PostgreSQL query, Jest.

**Spec:** `docs/superpowers/designs/2026-10-31-persistent-sleeve-payoff-memory.md`

## Global Constraints
- Exact tenant/account/instrument/direction/route isolation is mandatory.
- Use authoritative `trading.trades.status='CLOSED'` realised P&L only.
- Persistent sample count is exactly 8; horizon is 14 days; PF threshold is strictly below 0.65; latest evidence age is at most 96 hours.
- Existing 3-loss/12-hour brake behavior must remain unchanged.
- Do not alter sizing, SL/TP geometry, execution, LIVE gates, or global confidence thresholds.

## Review Focus
- Weekend gap: Friday negative sleeve remains blocked Sunday open.
- Profitable/marginal sleeve: PF >= 0.65 stays clear even with negative net.
- Sparse evidence: fewer than 8 observations cannot trigger persistent quarantine.
- Stale evidence: latest observation older than 96 hours cannot trigger persistent quarantine.
- Short-term three-loss streak still works independently of persistent payoff.

---

### Task 1: Extend exact-sleeve realised-payoff memory

**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-evidence.service.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-evidence.service.spec.ts`

**Interfaces:**
- Consumes: `loadMultimodelLossStreakBrake(input: M1MultimodelLossStreakBrakeQuery)`.
- Produces: existing decision plus `PERSISTENT_NEGATIVE_PAYOFF` reason and `persistentNegativePayoff` diagnostic.

- [ ] **Step 1: Write failing weekend persistence tests**
  Add cases proving an 8-trade PF 0.41 sleeve remains active about 58 hours after the latest close, while PF 0.728, 7-sample, and >96-hour sleeves remain clear.

- [ ] **Step 2: Run the focused Jest file and verify RED**
  Run: `pnpm --filter @irexpro/api exec jest src/modules/ai/m1-tactical-evidence.service.spec.ts --runInBand`
  Expected: new weekend persistence assertion fails because current SQL is 24 hours/current cooldown clears.

- [ ] **Step 3: Implement minimal persistent payoff rule**
  Change the evidence horizon to 14 days while retaining `LIMIT 8`. Add constants for 8 samples, PF 0.65, 96 hours, and the new reason. Evaluate the existing 3-loss brake with its existing 12-hour cooldown; evaluate persistent payoff separately with the 96-hour relevance horizon.

- [ ] **Step 4: Run focused tests and API type/build verification**
  Run the focused Jest file, related scheduler tests, `pnpm --filter @irexpro/api exec tsc --noEmit`, and `pnpm --filter @irexpro/api build`.

- [ ] **Step 5: Commit**
  Commit only the evidence service/tests and the design/plan docs.
