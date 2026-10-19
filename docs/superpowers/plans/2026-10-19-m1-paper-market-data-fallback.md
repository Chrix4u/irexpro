# M1 PAPER Market-Data Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate the existing M1 Tactical PAPER_ALL_ROUTES sleeve from a fresh, causal PAPER-only market-data path when broker-native cTrader M1 data is unavailable, without changing DEMO/LIVE evidence authority.

**Architecture:** Keep broker-native M1 as the first-choice source. For PAPER research only, seed the accepted Twelve Data fast-mark WebSocket symbol with completed M1 REST history, build later closed M1 candles from live price ticks inside the connection-scoped PAPER cache, and combine that M1 history with the existing causal M5/M15/H1/H4 PAPER cache. Pass the conservative PAPER fallback spread to governance as simulation cost evidence, never as broker-observed spread.

**Tech Stack:** NestJS, TypeScript, Jest, pnpm, Twelve Data REST/WebSocket, existing LivePaperMarketDataService and M1 Tactical services.

**Spec:** `docs/superpowers/specs/2026-10-18-m1-tactical-expert-design.md`

## Global Constraints

- PAPER_ONLY_RESEARCH authority only; no DEMO/LIVE authority or qualification evidence.
- Only completed candles may influence decisions; never synthesize missing M1 closes.
- Broker-native cTrader data remains authoritative when configured and usable.
- PAPER simulated spread must remain explicitly non-broker evidence.
- Existing event-risk, drift, reliability, portfolio, risk and idempotency controls remain unchanged.
- Do not increase Twelve Data steady-state REST usage beyond the existing Basic-plan budget; one bootstrap request per accepted WebSocket symbol is allowed.

## Review Focus

- Partial current M1 minute must never be exposed as closed.
- Restart bootstrap must end at the last completed minute and merge safely with streamed buckets.
- A rejected preferred WebSocket symbol followed by EUR/USD fallback must bootstrap only the accepted symbol.
- PAPER fallback must not run when an explicit broker-native M1 source is configured but temporarily lacks valid evidence.
- Simulated spread must permit PAPER governance while remaining promotion-ineligible.

---

### Task 1: Connection-scoped causal M1 candle cache

**Files:**
- Modify: `apps/api/src/modules/broker/services/live-paper-market-data.service.ts`
- Test: `apps/api/src/modules/broker/services/live-paper-market-data.service.spec.ts`

**Interfaces:**
- Produces: `updateClosedM1Candles(instrument, rows, connectionId?)`; `getOHLCV(..., 'M1', ...)` returning only completed M1 buckets.
- Consumes: existing `updateStreamingMidQuote`, connection-scoped PAPER state and instrument specs.

- [ ] Write failing tests proving bootstrap M1 rows are readable, stream ticks update OHLC within one bucket, current incomplete bucket is hidden, and connection caches remain isolated.
- [ ] Run focused Jest file and require the new tests to fail for missing M1 support.
- [ ] Implement minimal M1 storage/stream aggregation without changing M5 execution-candle semantics.
- [ ] Re-run focused Jest and require PASS.
- [ ] Commit Task 1.

### Task 2: Bootstrap the accepted Twelve Data fast-mark symbol

**Files:**
- Modify: `apps/api/src/modules/broker/services/twelve-data-fast-mark-stream.service.ts`
- Test: `apps/api/src/modules/broker/services/twelve-data-fast-mark-stream.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 `updateClosedM1Candles`.
- Produces: one completed-history bootstrap per successfully subscribed provider symbol, using `interval=1min`, UTC, ascending order, and an end boundary before the current incomplete minute.

- [ ] Write failing tests proving successful subscribe-status triggers one bootstrap, rejected symbols do not bootstrap, fallback EUR/USD bootstraps after acceptance, and partial/future rows are rejected.
- [ ] Run focused Jest and observe RED.
- [ ] Implement the bounded REST bootstrap using the existing API key and no credential logging.
- [ ] Re-run focused Jest and require PASS.
- [ ] Commit Task 2.

### Task 3: PAPER-only M1 fallback wiring

**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-market-data.service.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-market-data.binding.spec.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.spec.ts`

**Interfaces:**
- Consumes: Task 1 connection-scoped M1/M5/H1/H4 PAPER cache and conservative spread.
- Produces: `M1TacticalMarketSnapshot` that distinguishes broker-native spread evidence from `paperSimulationSpreadPrice`; scheduler forwards both to existing governance.

- [ ] Write failing binding tests: broker-native source remains first choice; when no explicit M1 source exists, fresh PAPER M1 plus M5 context creates a snapshot with simulated spread and no broker spread evidence; stale/incomplete M1 fails closed.
- [ ] Write scheduler regression test proving simulated spread can reach PAPER governance/decision metadata but cannot become production evidence.
- [ ] Run focused tests and observe RED.
- [ ] Implement minimal fallback and metadata wiring.
- [ ] Re-run focused tests and require PASS.
- [ ] Commit Task 3.

### Task 4: Full verification and delivery

**Files:** no new production scope unless verification finds a defect.

- [ ] Run combined focused M1/PAPER tests.
- [ ] Run changed-file ESLint and `git diff --check`.
- [ ] Run `pnpm --filter @irexpro/api build`.
- [ ] Run relevant broader API tests if focused changes touch shared PAPER market-data behavior.
- [ ] Review diff for DEMO/LIVE authority leakage, secrets, quota regressions and partial-bar leakage.
- [ ] Push feature branch, open PR, require protected CI, merge only when green, deploy merged main SHA, verify readiness and M1 decision creation on staging.
