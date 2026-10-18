# iRexPro M1 Tactical Expert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class, separately measured M1 tactical PAPER sleeve that evaluates each completed M1 bar, scores BUY and SELL symmetrically, reuses existing safety/execution authority, and leaves the M5 engine independent.

**Architecture:** Keep M1 candidate generation and route logic in pure focused modules. Read completed M1/Higher-TF evidence from the existing provider quote candle store rather than adding six-pair one-minute REST polling; feed admitted M1 candidates through the existing `AiSignalService`/risk/execution path, with dedicated M1 evidence persistence and route+pair+side reliability. Failed-move rescue ships shadow-only until close-then-reverse idempotency is proven.

**Tech Stack:** TypeScript, NestJS 10, Jest, TypeORM/PostgreSQL, existing iRexPro broker/risk/execution modules.

**Spec:** `docs/superpowers/specs/2026-10-18-m1-tactical-expert-design.md`

## Global Constraints

- Initial authority is exactly `PAPER_ONLY_RESEARCH`; no DEMO/LIVE execution path may be enabled by this work.
- Use completed candles only; incomplete current-minute bars and incomplete higher-timeframe aggregates must not influence a decision.
- Keep H4 -> H1 -> M15 -> M5 -> M1 context; M1 is the trigger layer, not the only context layer.
- Score BUY and SELL from the same snapshot before selecting a side; `ABSTAIN` is a normal outcome.
- Reuse existing spread/cost, event-risk, drift, portfolio, margin, risk, idempotency, reconciliation, and execution controls; do not lower those gates for M1.
- Keep M1 outcome/reliability identities separate from M5; reliability key is route + instrument + direction + compatible policy lineage.
- M5 scheduling must continue if the M1 lane fails.
- Do not add six-pair one-minute Twelve Data REST polling. Initial M1 PAPER history comes from `ProviderQuoteCandleStoreService`; missing/stale/gapped data fails closed.
- `M1_FAILED_MOVE_RESCUE` is shadow-only in this plan; no close-then-reverse order authority is enabled.
- Threshold changes are versioned policy changes, not ad-hoc environment tuning.

## Review Focus

1. Missing/gapped M1 sequences: feature/scheduler tests must prove the lane abstains rather than aggregating across a gap.
2. Stale spread or unverified event risk: governance/integration tests must prove an otherwise strong candidate cannot execute.
3. Restart/retry duplication: scheduler/execution tests must prove the same route+pair+side+bar+policy cannot create a second durable intent.
4. BUY/SELL symmetry and ties: candidate tests must prove both sides see identical source data and no arbitrary side wins a non-material tie.
5. M1 exception isolation: scheduler integration tests must prove an M1 failure does not stop or mutate M5 scheduling state.

## File Structure

- Create `apps/api/src/modules/ai/m1-tactical-features.ts` + `.spec.ts`: causal M1 and higher-timeframe feature snapshot.
- Create `apps/api/src/modules/ai/m1-tactical-candidate.ts` + `.spec.ts`: symmetric BUY/SELL candidate construction and expected payoff geometry.
- Create `apps/api/src/modules/ai/m1-tactical-route.ts` + `.spec.ts`: continuation/reversal/transition/abstain classification.
- Create `apps/api/src/modules/ai/m1-tactical-governance.ts` + `.spec.ts`: M1 policy/admission adapter over generic ensemble governance.
- Create `apps/api/src/modules/ai/m1-tactical-reliability.ts` + `.spec.ts`: route+pair+side evidence and compatible-policy carry-forward.
- Create `apps/api/src/modules/ai/m1-tactical-market-data.service.ts` + `.spec.ts`: completed M1/M5/M15/H1/H4 read model over `ProviderQuoteCandleStoreService`.
- Create `apps/api/src/database/migrations/1792342000000-CreateM1TacticalDecisionStore.ts`: dedicated M1 decision/evidence table and uniqueness fence.
- Create `apps/api/src/modules/ai/m1-tactical-evidence.service.ts` + `.spec.ts`: persist/query M1 decisions and outcomes.
- Create `apps/api/src/modules/ai/m1-failed-move-rescue.ts` + `.spec.ts`: pure shadow rescue decision.
- Create `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts` + `.spec.ts`: completed-minute orchestration, shadow/PAPER routing, exception isolation.
- Modify `apps/api/src/modules/ai/ai.module.ts`: register M1 services.
- Modify `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts` and `.spec.ts` only where needed to expose M5 status/independence assertions; do not move M1 logic into this 5,000+ line file.

---

### Task 1: Causal M1 feature snapshot

**Files:**
- Create: `apps/api/src/modules/ai/m1-tactical-features.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-features.spec.ts`

**Interfaces:**
- Consumes: `LivePaperCandleInput[]`-compatible completed bars for M1/M5/M15/H1/H4.
- Produces: `buildM1TacticalFeatures(input: M1TacticalFeatureInput): M1TacticalFeatureSnapshot | null`.

- [ ] **Step 1: Write failing tests** for completed-bar causality, body/range and wick balance, close location, EMA separation/slope, ATR-normalized 1/3/5-bar momentum, breakout/failed-breakout, efficiency, volatility change, session, and higher-timeframe alignment. Add a fixture with a one-minute timestamp gap and assert `null`.
- [ ] **Step 2: Run** `pnpm --filter @irexpro/api exec jest src/modules/ai/m1-tactical-features.spec.ts --runInBand` and confirm failures because the module is absent.
- [ ] **Step 3: Implement** `M1TacticalFeatureInput`, `M1TacticalFeatureSnapshot`, and `buildM1TacticalFeatures(...)`. Reject non-finite prices, non-monotonic timestamps, incomplete required context, and M1 gaps; use only bars whose close time is <= `decisionTime`.
- [ ] **Step 4: Re-run the focused suite** and require PASS.
- [ ] **Step 5: Commit** `feat(ai): add causal M1 tactical features`.

### Task 2: Bidirectional candidates and route classification

**Files:**
- Create: `apps/api/src/modules/ai/m1-tactical-candidate.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-candidate.spec.ts`
- Create: `apps/api/src/modules/ai/m1-tactical-route.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-route.spec.ts`

**Interfaces:**
- Consumes: `M1TacticalFeatureSnapshot` from Task 1.
- Produces: `buildM1TacticalCandidates(snapshot, policy): readonly [M1TacticalCandidate, M1TacticalCandidate]` and `classifyM1TacticalRoute(candidate, opposite, snapshot, policy): M1TacticalRouteDecision`.

- [ ] **Step 1: Write failing candidate tests** asserting exactly one BUY and one SELL are created from the same `decisionTime`, ATR, source snapshot and cost-neutral geometry; add a tie fixture that remains selectable only as `ABSTAIN` later.
- [ ] **Step 2: Run candidate tests** and confirm RED.
- [ ] **Step 3: Implement candidate construction** with volatility-aware stop distance, absolute pip floor, gross expected-R fields, direction quality, and policy version `m1-tactical-v1`; do not fetch data or place orders here.
- [ ] **Step 4: Write failing route tests** for `M1_TREND_CONTINUATION`, `M1_CONFIRMED_REVERSAL`, `M1_EARLY_TRANSITION`, higher-timeframe conflict, single-candle false reversal, and `ABSTAIN` on a non-material BUY/SELL edge.
- [ ] **Step 5: Implement** `classifyM1TacticalRoute(...)` as a pure deterministic classifier; reversal requires exhaustion/failure plus opposite impulse, never RSI or one candle alone.
- [ ] **Step 6: Run both focused suites** and require PASS.
- [ ] **Step 7: Commit** `feat(ai): add bidirectional M1 tactical routes`.

### Task 3: M1 governance and route reliability

**Files:**
- Create: `apps/api/src/modules/ai/m1-tactical-governance.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-governance.spec.ts`
- Create: `apps/api/src/modules/ai/m1-tactical-reliability.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-reliability.spec.ts`

**Interfaces:**
- Consumes: `M1TacticalCandidate`, `M1TacticalRouteDecision`, existing `evaluateEnsembleGovernance(...)`, event-risk state, spread evidence, and reliability rows.
- Produces: `evaluateM1TacticalGovernance(input): M1TacticalGovernanceDecision` and `evaluateM1RoutePairSideReliability(input): M1RoutePairSideReliabilityDecision`.

- [ ] **Step 1: Write failing governance tests** proving unusable spread, event risk != `CLEAR`, OOD drift, blocked sleeve, non-positive net expected R, and higher-timeframe conflict all block PAPER authority; prove no result contains DEMO/LIVE authority.
- [ ] **Step 2: Run governance tests** and confirm RED.
- [ ] **Step 3: Implement the governance adapter** by mapping M1 semantic routes to existing generic strategy semantics (`TREND_CONTINUATION`, `CONFIRMED_REVERSAL`, `EARLY_TRANSITION`) while retaining the M1 route identity separately. Return `PAPER_ONLY_RESEARCH` or `NONE` only.
- [ ] **Step 4: Write failing reliability tests** for cold start, 3-loss early brake, 5-sample expectancy decision, 7-day compatible-policy carry-forward, max 20 samples, expiry, self-sufficient current policy, and route isolation (e.g. reversal evidence cannot rehabilitate continuation).
- [ ] **Step 5: Implement reliability** with key `{route,instrument,direction}` and policy lineage `m1-tactical-v1` compatible only with explicitly listed successors.
- [ ] **Step 6: Run both suites** and require PASS.
- [ ] **Step 7: Commit** `feat(ai): govern M1 paper admission and reliability`.

### Task 4: Completed-bar M1 market-data reader

**Files:**
- Create: `apps/api/src/modules/ai/m1-tactical-market-data.service.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-market-data.service.spec.ts`
- Modify: `apps/api/src/modules/market-data/services/provider-quote-candle-store.service.ts`
- Test: `apps/api/src/modules/market-data/services/provider-quote-candle-store.service.spec.ts`

**Interfaces:**
- Consumes: `ProviderQuoteCandleStoreService.getCandles(connectionId, instrument, timeframe, count)` and `getLatestPositiveSpreadQuote(...)`.
- Produces: `M1TacticalMarketDataService.loadSnapshot(connectionId, instrument, decisionTime): Promise<M1TacticalMarketSnapshot | null>` containing completed M1, M5, M15, H1, H4 bars plus spread evidence/source metadata.

- [ ] **Step 1: Add failing store tests** proving `getM1Candles` excludes the current incomplete minute, `getCandles` excludes incomplete aggregate buckets, and timestamp gaps do not get silently bridged into a complete higher-timeframe bar.
- [ ] **Step 2: Run** `pnpm --filter @irexpro/api exec jest src/modules/market-data/services/provider-quote-candle-store.service.spec.ts --runInBand` and confirm the new gap/closure assertions fail where behavior is missing.
- [ ] **Step 3: Harden the store minimally** so aggregation requires contiguous constituent M1 buckets and exposes source/sample metadata needed by M1 research without changing existing callers' semantics.
- [ ] **Step 4: Write failing reader tests** for valid complete snapshot, insufficient H4/H1 history, stale M1 close, stale positive-spread evidence, source mismatch, and Sunday-open warm-up.
- [ ] **Step 5: Implement** `loadSnapshot(...)`; require a latest fully closed M1 bar aligned to `decisionTime`, sufficient contiguous history for each timeframe, and usable spread evidence. Read only the existing candle store in this task—no one-minute Twelve Data REST call. Return `null` on incomplete/stale evidence instead of fabricating bars.
- [ ] **Step 6: Run store + reader suites** and require PASS.
- [ ] **Step 7: Commit** `feat(ai): add completed-bar M1 market reader`.

### Task 5: Durable M1 decision/evidence store

**Files:**
- Create: `apps/api/src/database/migrations/1792342000000-CreateM1TacticalDecisionStore.ts`
- Create: `apps/api/src/modules/ai/m1-tactical-evidence.service.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-evidence.service.spec.ts`

**Interfaces:**
- Consumes: route/candidate/governance results from Tasks 2-3 and execution outcome linkage when present.
- Produces: `recordDecision(input): Promise<M1TacticalDecisionRecord>`, `loadRoutePairSideEvidence(input): Promise<M1RoutePairSideEvidenceRow[]>`, `markExecutionLink(decisionId, signalId, tradeIntentId?): Promise<void>`, and `loadOutcomeMetrics(filter): Promise<M1TacticalOutcomeMetrics>`; outcome reads join authoritative closed trades rather than inventing a second PnL source.

- [ ] **Step 1: Write the migration contract test/service failing tests** around a table `trading.m1_tactical_decisions` with decision identity, user/connection/instrument/direction, route, bar time, policy version, authority, candidate/governance JSON, blockers, signal/trade linkage, timestamps, and outcome fields. Require a unique fence on `(user_id, broker_connection_id, instrument, direction, route, bar_time, policy_version)`.
- [ ] **Step 2: Run the evidence suite** and confirm RED because storage/migration is absent.
- [ ] **Step 3: Implement the migration** with indexes for `(route,instrument,direction,bar_time)`, `(policy_version,bar_time)`, and execution linkage; down migration removes only this table/indexes.
- [ ] **Step 4: Implement the evidence service** with parameterized queries. Reliability reads must filter the exact user, connection, route, pair, side, closed/evaluable outcomes and bounded compatible policies; break-even outcomes do not consume the 20-sample reliability cap.
- [ ] **Step 5: Add query tests** proving route isolation, user/account isolation, 7-day carry-forward window, current-policy priority, 20-sample cap and duplicate decision conflict behavior.
- [ ] **Step 6: Run the focused suite** and require PASS.
- [ ] **Step 7: Commit** `feat(ai): persist isolated M1 tactical evidence`.

### Task 6: Shadow-only M1 scheduler and exception isolation

**Files:**
- Create: `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-scheduler.service.spec.ts`
- Modify: `apps/api/src/modules/ai/ai.module.ts`
- Test: `apps/api/src/modules/ai/vps-forex-signal-collector.service.spec.ts`

**Interfaces:**
- Consumes: Tasks 1-5, `MacroEventRiskService`, existing configuration/user/connection binding, and market-session utility.
- Produces: one durable M1 shadow decision per completed slot/pair/side/route/policy; no signal submission in this task.

- [ ] **Step 1: Write failing scheduler tests** proving a 15-second wake-up evaluates a completed minute only once, skips closed FX session, waits for warm history, evaluates all configured pairs independently, persists BUY/SELL + blockers, and does not call `AiSignalService.receiveSignal` in shadow mode.
- [ ] **Step 2: Add restart/idempotency test** where an existing unique decision for the slot causes no duplicate work and no exception loop.
- [ ] **Step 3: Add exception-isolation regression test** by forcing the M1 scheduler to throw during an M5 collector cycle/module runtime and assert the M5 collector's slot state/calls remain unaffected.
- [ ] **Step 4: Run** `pnpm --filter @irexpro/api exec jest src/modules/ai/m1-tactical-scheduler.service.spec.ts src/modules/ai/vps-forex-signal-collector.service.spec.ts --runInBand` and confirm RED.
- [ ] **Step 5: Implement scheduler lifecycle** with its own timer/slot key and a top-level per-cycle catch. Define `M1TacticalExecutionPhase = 'SHADOW' | 'PAPER_CONTINUATION' | 'PAPER_ALL_ROUTES'` in the versioned policy object, defaulting to `SHADOW`; do not expose an environment escape hatch.
- [ ] **Step 6: Register services in `AiModule`** without changing M5 collector ownership.
- [ ] **Step 7: Re-run focused suites** and require PASS.
- [ ] **Step 8: Commit** `feat(ai): add isolated M1 tactical shadow scheduler`.

### Task 7: PAPER execution for M1 trend continuation

**Files:**
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-scheduler.service.spec.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-evidence.service.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-evidence.service.spec.ts`

**Interfaces:**
- Consumes: admitted `M1_TREND_CONTINUATION` decision with `PAPER_ONLY_RESEARCH`, active PAPER session, `AiSignalService.receiveSignal(...)`, and existing risk/execution pipeline.
- Produces: M1 signal with `timeframe='M1'`, dedicated `strategyCode='external-irexpro-m1-tactical'`, model/policy version, M1 route metadata, and evidence linkage.

- [ ] **Step 1: Write failing execution tests** asserting only `M1_TREND_CONTINUATION` can execute in phase 2; reversal/transition remain shadow, and no M1 candidate executes without an active exact-bound PAPER session.
- [ ] **Step 2: Add safety tests** proving `eventRisk !== CLEAR`, unusable spread, reliability brake, generic risk rejection, or duplicate signal identity prevents a second order path.
- [ ] **Step 3: Add signal-shape test** asserting `timeframe='M1'`, `external_provider_paper_only=true`, `production_eligible=false`, `m1_tactical_route`, `m1_policy_version`, expected/cost/net-R fields and decision id are present in metadata.
- [ ] **Step 4: Run scheduler/evidence tests** and confirm RED.
- [ ] **Step 5: Implement phase-2 submission** by calling the existing `AiSignalService.receiveSignal(...)`; never call broker adapters directly. Derive durable `signalId` from decision identity so retry/restart is naturally idempotent.
- [ ] **Step 6: Persist signal/trade linkage and terminal blocker/rejection reason** back to the M1 evidence store.
- [ ] **Step 7: Re-run focused tests** and require PASS.
- [ ] **Step 8: Commit** `feat(ai): execute governed M1 continuation in paper`.

### Task 8: Reversal/transition PAPER lanes and failed-move rescue shadow

**Files:**
- Create: `apps/api/src/modules/ai/m1-failed-move-rescue.ts`
- Test: `apps/api/src/modules/ai/m1-failed-move-rescue.spec.ts`
- Modify: `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- Test: `apps/api/src/modules/ai/m1-tactical-scheduler.service.spec.ts`

**Interfaces:**
- Consumes: separately tagged M1 route decisions/outcomes and open M1 PAPER position snapshots.
- Produces: PAPER submissions for `M1_CONFIRMED_REVERSAL` and `M1_EARLY_TRANSITION` only after their route-specific governance passes; `evaluateM1FailedMoveRescue(input): M1FailedMoveRescueDecision` remains observational.

- [ ] **Step 1: Write failing route-execution tests** proving reversal and transition use separate evidence/reliability keys and cannot borrow continuation qualification.
- [ ] **Step 2: Write failing rescue tests** for: original thesis still valid -> no rescue; opposite edge delta below floor -> no rescue; event/cost/reliability blocker -> no rescue; invalidated thesis + materially stronger positive opposite net R -> `SHADOW_RESCUE_CANDIDATE`.
- [ ] **Step 3: Add explicit no-order test** asserting a rescue candidate never calls `AiSignalService.receiveSignal`, close-position, or broker methods in this plan.
- [ ] **Step 4: Implement reversal/transition phase-3 PAPER routing** through the same signal/risk/execution authority as continuation with route-specific metadata and conservative route-specific policy floors.
- [ ] **Step 5: Implement pure rescue classifier** with configurable versioned minimum opposite-edge delta and output `{eligible, reason, originalInvalidated, originalNetExpectedR, oppositeNetExpectedR, edgeDelta, executionAuthority:'NONE', modifiesExecution:false}`.
- [ ] **Step 6: Persist rescue observations** in decision metadata/evidence without changing positions.
- [ ] **Step 7: Run focused suites** and require PASS.
- [ ] **Step 8: Commit** `feat(ai): add M1 reversal lanes and rescue shadow`.

### Task 9: End-to-end regression, migration, release gates, and staging readiness

**Files:**
- Modify tests only as required by integration discoveries; no new scope.
- Verify: all files above plus repository workflows.

**Interfaces:**
- Consumes: completed Tasks 1-8.
- Produces: a merge-ready branch with PAPER-only M1 authority and no M5 regression.

- [ ] **Step 1: Run focused M1 suites**: `pnpm --filter @irexpro/api exec jest src/modules/ai/m1- --runInBand` (or enumerate exact M1 spec files if Jest path matching does not accept the prefix).
- [ ] **Step 2: Run market-data + collector regression suites**: `pnpm --filter @irexpro/api exec jest src/modules/market-data/services/provider-quote-candle-store.service.spec.ts src/modules/ai/vps-forex-signal-collector.service.spec.ts --runInBand`.
- [ ] **Step 3: Run full API Jest**: `pnpm --filter @irexpro/api exec jest --runInBand --forceExit`; require 0 failing suites/tests beyond existing intentional skips.
- [ ] **Step 4: Run PAPER broker harness** using the repository's current harness command and require all harness cases PASS.
- [ ] **Step 5: Run formatting/diff/lint/build**: Prettier on touched files, `git diff --check`, `pnpm --filter @irexpro/api lint:check`, and `pnpm --filter @irexpro/api build`; require 0 lint errors and build exit 0.
- [ ] **Step 6: Migration smoke** against an isolated/staging-equivalent PostgreSQL database: migrate up, verify unique fence/indexes, migrate down/up if supported by the repository migration harness, and confirm no existing trading table changes.
- [ ] **Step 7: Security/release review**: grep touched code for credentials/secrets, verify no DEMO/LIVE authority strings are reachable from M1 execution, and verify rescue has `executionAuthority:'NONE'`/`modifiesExecution:false`.
- [ ] **Step 8: Open PR and require repository workflows** (API CI, Risk Execution Concurrency, Strategy Promotion Integrity, Release Security, Required CI Gate) to pass before merge.
- [ ] **Step 9: After merge, deploy staging through the established release path**; verify commit alignment, PM2 process state, `/health/live`, `/health/ready`, M5 remains active, M1 scheduler reports shadow/PAPER phase as configured, and no duplicate replay occurs across one controlled API restart.
- [ ] **Step 10: Commit any verification-only fixture/documentation adjustments** as `test(ai): verify M1 tactical paper rollout` before PR finalization.

## Implementation Order Rationale

Tasks 1-3 make the decision engine deterministic before any I/O. Task 4 proves the data is causal before scheduling. Task 5 creates durable idempotency/evidence before the scheduler can run. Task 6 launches shadow only. Tasks 7-8 add PAPER authority progressively and keep failed-move rescue observational. Task 9 is the release gate; no DEMO/LIVE promotion is part of this plan.
