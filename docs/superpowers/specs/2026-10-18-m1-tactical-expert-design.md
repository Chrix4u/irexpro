# iRexPro M1 Tactical Expert Design

Date: 2026-10-18
Status: Design approved in chat; implementation not yet authorized beyond planning
Target environment: PAPER first; no DEMO/LIVE authority in this design

## 1. Goal

Add a first-class M1 tactical strategy sleeve beside the existing M5 multi-model engine so iRexPro can identify and act on short-duration opportunities earlier without turning the platform into an unconstrained scalper.

The M1 sleeve must use higher-timeframe context, bidirectional scoring, execution-cost evidence, event-risk checks, drift checks, pair/side reliability, and the existing risk/execution stack. M1 may be faster, but it must not bypass the governance that protects the current PAPER engine.

Success means the system can evaluate each completed M1 bar, produce independently scored BUY and SELL candidates, abstain when edge is weak, execute only PAPER-authorized candidates, tag M1 outcomes separately from M5, and generate enough clean evidence to decide whether any M1 route deserves later DEMO promotion.

## 2. Non-goals

This design does not enable LIVE trading, reduce existing account-level risk limits, lower event-risk safeguards, remove spread/cost gates, guarantee a minimum trade count, or promote M1 results into the M5 sleeve. It also does not require sub-minute/tick execution authority.

## 3. Approaches considered

### A. Separate M1 Tactical Expert sleeve feeding existing governance — selected

Create a small M1 candidate engine with its own route identity and evidence tags, then feed qualified candidates into the existing ensemble governance, cost, event-risk, reliability, portfolio, and PAPER execution pipeline. This keeps M1 measurable and minimizes duplicated execution logic.

### B. Convert the whole multi-model engine from M5 cadence to M1

This would make the entire engine faster, but it would blur historical M5 evidence, increase provider and execution noise, and force every current model to be recalibrated at once. Rejected because it couples too many risks.

### C. Use M1 only as an entry-timing overlay on M5 signals

This is safer and simpler, but it cannot discover genuine M1-only continuation, reversal, or transition opportunities. It remains useful as one feature of the selected design, not the whole design.

## 4. Architectural position

The existing M5 engine remains the core strategy engine. A new M1 Tactical Expert runs once per completed M1 candle. It consumes the same causal market history and builds higher-timeframe context from M1 data where possible. It emits candidate decisions only; it does not place orders directly.

The execution path is:

M1 closed candle -> M1 feature snapshot -> BUY/SELL tactical candidates -> route classifier -> expected-R/cost evaluation -> event-risk/drift/reliability checks -> existing portfolio/risk engine -> PAPER broker -> isolated M1 outcome evidence.

## 5. Strategy routes

The first release contains three execution-capable PAPER research routes plus one management behavior:

1. `M1_TREND_CONTINUATION`
   - Requires short-horizon momentum, EMA structure, candle efficiency/pressure, acceptable extension, and agreement with broader context.
   - Favors continuation when M5/M15/H1/H4 context supports the direction.

2. `M1_CONFIRMED_REVERSAL`
   - Requires exhaustion/failure evidence plus a confirmed opposite-direction impulse.
   - Must not infer reversal from RSI or one candle alone.
   - Uses stricter direction-change confirmation than continuation.

3. `M1_EARLY_TRANSITION`
   - Targets the beginning of a regime change before M5 is fully confident.
   - PAPER-only research until it establishes its own evidence.
   - Uses a higher net-expected-R floor than ordinary continuation if empirical testing shows its false-start rate is materially higher.

4. `M1_FAILED_MOVE_RESCUE`
   - This is not an unconditional flip rule and must not close/reverse a position merely because one minute moves against it.
   - Re-evaluates both directions from fresh closed M1 evidence after entry.
   - A reversal action is eligible only when the original thesis has invalidated, the opposite direction has materially higher positive net expected R after costs, event risk is clear, portfolio/risk checks pass, and the trade is still in PAPER authority.
   - Initial release may run this as shadow-only if execution semantics cannot be isolated cleanly from existing post-entry protection.

## 6. Timeframe hierarchy and causal data

M1 is the tactical decision layer; it is not the only context layer.

- H4: dominant regime and structural direction.
- H1: trend/volatility context.
- M15: local structure and transition state.
- M5: setup quality and agreement with the core engine.
- M1: tactical trigger, timing, invalidation, and short-horizon momentum.

Only completed candles may influence a decision. Aggregated M5/M15/H1/H4 bars must be built from completed source bars or obtained as broker-native completed bars. No partial future bar may leak into a historical or live decision.

M1 features must be reproducible later with the intended broker path. Initial features include candle body/range ratio, upper/lower wick balance, close location in range, EMA separation and slope, ATR-normalized one- and multi-bar momentum, breakout distance, failed-breakout signal, local efficiency, recent volatility change, spread/cost, session, and higher-timeframe alignment.

Tick/activity features are optional only if they have a stable causal source in both PAPER research and cTrader DEMO/LIVE. PAPER-only provider metadata must not become a promotion-critical feature.

## 7. Candidate and direction model

Each completed M1 snapshot creates both BUY and SELL counterfactual candidates from the same data. The candidate builder must not discard the opposite side before scoring.

Each candidate carries at least:

- instrument and direction;
- M1 route;
- decision/bar time;
- entry, stop, target, ATR and stop distance;
- confidence and direction quality;
- gross expected R and estimated cost R;
- net expected R;
- M1 momentum and structure features;
- M5/M15/H1/H4 alignment evidence;
- adaptive market state and session;
- policy/artifact version;
- evidence authority (`PAPER_ONLY_RESEARCH` initially).

The two sides are compared only after both have gone through the same feature and cost calculations. `ABSTAIN` remains a normal result.

## 8. Governance and PAPER authority

M1 candidates reuse the existing downstream controls wherever semantics match:

- execution-cost evaluation using broker-observed spread when available and conservative PAPER fallback otherwise;
- net expected R after cost;
- event-risk state;
- drift diagnostics;
- adaptive market state;
- pair/side reliability and early-loss brake;
- portfolio exposure, margin, account risk, and order lifecycle controls;
- durable idempotency keyed by route/instrument/direction/bar/policy.

M1 must have route-specific evidence identities so its outcomes cannot silently improve or degrade M5 sleeve qualification. M1 reliability keys must include route + instrument + direction, with bounded compatible-policy carry-forward analogous to the existing calibration-memory rule.

The first implementation authority is `PAPER_ONLY_RESEARCH`. M1 candidates cannot become DEMO or LIVE executable simply because the generic broker adapter supports those modes. Promotion requires an explicit later policy change backed by prospective evidence.

## 9. Scheduling and provider behavior

The existing 15-second service timer may remain the wake-up mechanism, but M1 collection/execution is keyed to a completed one-minute slot. A slot can be evaluated only once unless a documented pre-intent retry-safe condition proves no durable execution intent was created.

M5 collection remains on its current five-minute slot. M1 should share fetched market data when possible instead of multiplying provider calls. If Twelve Data quota or freshness cannot support safe one-minute evaluation across six pairs, the system must fail closed or use an already-authorized broker-native fallback; it must not synthesize missing closes.

At Sunday open, holiday gaps, reconnects, and provider cooldowns, the M1 lane must wait for a valid completed bar sequence before producing candidates.

## 10. Stops, targets, and holding horizon

M1 stops and targets are volatility- and cost-aware, with an absolute pip floor so spread cannot dominate tiny stops. The initial route should start from conservative ATR-derived stops and expected-R floors rather than optimizing for maximum trade count.

M1 is a decision timeframe, not a forced one-minute holding period. Positions may remain open for several minutes or longer while their original risk bounds and post-entry protection remain valid.

A trade must never widen its initial protective stop merely to survive noise. Existing protective-order guarantees remain authoritative.

## 11. Failed-move rescue semantics

For an open M1 PAPER position, a rescue checkpoint may run on each newly completed M1 bar. The engine computes the current thesis score and the opposite-direction score from the same fresh snapshot.

The opposite side can become a rescue candidate only if all of the following are true:

- the original thesis is explicitly invalidated by route-specific evidence;
- opposite net expected R is positive and exceeds the original side by a configurable minimum delta;
- the opposite direction passes cost, event-risk, drift, reliability, exposure, and risk checks;
- no duplicate opposite intent exists;
- reversal is allowed by the active PAPER policy.

The action sequence must be atomic at the application level: close/flatten the original PAPER position, confirm terminal state, then create the opposite intent. A failed close must never result in both directions being opened accidentally.

The first implementation should default rescue to shadow-only until close-then-reverse idempotency tests are complete.

## 12. Evidence and analytics

Every M1 decision and trade must be queryable separately by:

- route;
- pair and direction;
- session;
- adaptive market state;
- higher-timeframe alignment bucket;
- confidence and net-expected-R bucket;
- spread/cost bucket;
- holding-time bucket;
- policy version;
- execution route and close reason.

Primary evaluation metrics are closed trades, win rate, realised PnL/R, profit factor, Sharpe, max drawdown, positive-window fraction, average net expected R, calibration error, average holding time, and cost as a fraction of gross expected R.

M1 must not be promoted from a handful of favorable trades. The later promotion decision will define minimum prospective sample sizes and instrument coverage separately from this implementation design.

## 13. Failure handling and fail-closed behavior

The M1 lane returns `ABSTAIN` or an explicit blocker instead of degrading silently when market data is stale/incomplete, cost evidence is unusable, event risk is unverified, higher-timeframe aggregation is invalid, drift evidence is out of policy, or reliability/risk controls reject the pair-side-route.

Provider failures before any durable execution intent may use the existing retry-safe pattern. Failures after intent creation must follow existing reconciliation/idempotency rules and must not blindly retry order placement.

If M1 fails internally, M5 must continue operating independently. The first release should isolate M1 exceptions so a tactical-lane defect cannot stop the core multi-model scheduler.

## 14. Implementation boundaries

Prefer new focused modules over further expanding the 5,000+ line collector service. Expected units are:

- `m1-tactical-features.ts` — pure causal feature extraction;
- `m1-tactical-candidate.ts` — bidirectional candidate construction;
- `m1-tactical-route.ts` — continuation/reversal/transition classification;
- `m1-tactical-governance.ts` — M1-specific admission rules that compose existing generic governance;
- `m1-tactical-reliability.ts` — route+pair+side evidence adapter/carry-forward policy;
- `m1-tactical-scheduler.service.ts` — completed-M1-slot orchestration and handoff into existing execution services;
- `m1-failed-move-rescue.ts` — pure rescue decision first, execution integration later;
- associated DTO/evidence serialization and tests.

Existing shared execution, risk, event-risk, broker, reconciliation, and portfolio services remain authoritative. The M1 lane must call them rather than copy them.

## 15. Testing strategy

Testing is layered and deterministic.

### Pure unit tests

- completed-candle causality and no look-ahead leakage;
- M1 feature calculations for BUY and SELL symmetry;
- continuation, confirmed reversal, transition, and abstain route fixtures;
- cost-aware expected-R decisions;
- higher-timeframe conflict handling;
- pair/side/route reliability cold-start, early-loss brake, compatible-policy carry-forward, expiry, and self-sufficiency;
- failed-move rescue delta/invalidation logic;
- slot idempotency and duplicate-intent prevention.

### Integration tests

- scheduler consumes one completed M1 slot exactly once;
- M1 and M5 can run concurrently without duplicate orders;
- existing event-risk/risk/portfolio gates can block an otherwise strong M1 signal;
- provider failure before intent is retry-safe while post-intent failure is reconciled rather than replayed;
- evidence rows retain M1 route/policy/timeframe identity;
- restart restores durable state without replaying old M1 bars.

### Regression/full gates

Run focused M1 suites first, then full API Jest, PAPER broker harness, lint, formatting/diff checks, production build, and the repository-required GitHub workflows before merge.

## 16. Rollout sequence

Phase 1: shadow candidate generation only. Record BUY/SELL M1 candidates and blockers; no M1 orders.

Phase 2: PAPER research execution for `M1_TREND_CONTINUATION` only after shadow output is structurally valid and cost/event-risk data is available.

Phase 3: add `M1_CONFIRMED_REVERSAL` and `M1_EARLY_TRANSITION` as separately tagged PAPER research sleeves.

Phase 4: enable `M1_FAILED_MOVE_RESCUE` in shadow mode, then PAPER execution only after close-then-reverse idempotency/reconciliation tests pass.

Phase 5: evidence review. No DEMO promotion is part of this implementation plan. A separate promotion decision must review prospective M1 results against profitability, drawdown, calibration, cost, coverage, and reliability criteria.

## 17. Acceptance criteria

The M1 implementation is ready for PAPER rollout only when all of these are true:

- each completed M1 bar is evaluated at most once per instrument/policy unless a proven pre-intent retry is safe;
- BUY and SELL are independently scored from the same causal snapshot;
- M1 has explicit route identity and separate evidence from M5;
- all existing mandatory cost, event-risk, portfolio, margin, risk, and execution safety gates still apply;
- M1 cannot acquire DEMO/LIVE authority through configuration fallthrough;
- higher-timeframe context uses completed data only;
- M1 failures do not stop M5 collection;
- duplicate/replayed order intents are prevented across restart/retry paths;
- the full verification gate passes before merge;
- staging smoke tests show healthy API/runtime behavior after deployment.

## 18. Initial configuration stance

The first implementation should prefer constants/policy objects with conservative defaults rather than a large matrix of environment variables. Tunable thresholds must be versioned as part of the M1 policy artifact so historical decisions remain explainable.

Do not optimize initial thresholds to maximize trade frequency. Start with conservative research bounds, collect prospective evidence, and adjust only through versioned policy changes backed by outcome analysis.

## 19. Security and release constraints

No broker credentials are added to source or logs. No cTrader activation/authentication requirement is weakened by M1. PAPER data collection remains separate from later cTrader DEMO/LIVE authorization.

LIVE remains fail-closed throughout this design. Nothing in the M1 implementation may bypass the existing execution-authority checks or make a PAPER research artifact promotable by default.
