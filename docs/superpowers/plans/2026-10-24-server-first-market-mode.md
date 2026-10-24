# Server-first AI Market Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render the correct FX market mode in the first `/trade` HTML response so weekend users never see the normal AI trading workspace flash first.

**Architecture:** Put the DST-aware FX weekly schedule in a shared pure module. Convert `/trade/page.tsx` into a dynamic Server Component and move the current client workspace into `AiTradingClient.tsx`, initialized from the server schedule and refreshed by scanner status after hydration.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Jest, shared `@irexpro/types` workspace package.

**Spec:** `docs/superpowers/designs/2026-10-24-server-first-market-mode.md`

## Global Constraints
- Sunday 17:00 America/New_York through Friday 17:00 America/New_York.
- Five-minute scan cadence.
- Do not change execution/risk authority.
- Route must be dynamic per request.
- Scanner polling may update initial schedule but transient scanner failure must not erase it.

## Review Focus
- DST boundaries in October and December.
- Weekend first render while auth is still restoring.
- Market-open first render stays on normal loading/workspace path.
- Client scanner refresh can transition CLOSED→OPEN without reload.
- Scanner refresh failure preserves last schedule.

---

### Task 1: Shared FX schedule
**Files:**
- Create: `packages/types/src/market-schedule.ts`
- Create: `packages/types/src/market-schedule.spec.ts`
- Modify: `packages/types/package.json`

- [x] Write DST/weekend schedule tests and prove RED.
- [x] Implement shared schedule functions and export path.
- [x] Run shared schedule tests and typecheck; keep trading API behavior unchanged.

### Task 2: Server-first `/trade`
**Files:**
- Move: `apps/web/src/app/trade/page.tsx` → `AiTradingClient.tsx`
- Create: `apps/web/src/app/trade/page.tsx`
- Modify: `apps/web/src/app/trade/AiTradingClient.tsx`
- Create: `apps/web/src/app/trade/AiTradingClient.spec.tsx`

- [x] Write failing test that WEEKEND initial schedule renders `market-closed-state` before auth restoration.
- [x] Add `initialMarketSchedule` prop and durable schedule state.
- [x] Render weekend closed state before generic auth-restoring UI.
- [x] Create dynamic server wrapper that computes the schedule per request.
- [x] Run web focused tests, typecheck and build.

### Task 3: Release proof
- [x] Run web production build and relevant test suites; trading API is unchanged.
- [ ] Commit/push PR and require exact-head CI.
- [ ] Merge only when required gates are green.
- [ ] Verify staging deploy exact SHA.
- [ ] Fetch weekend `/trade` HTML and confirm closed-state markup is present before client hydration.
