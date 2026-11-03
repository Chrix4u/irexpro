# z.ai Independent Model/Productivity Review — iRexPro

**Branch:** `zai/model-productivity-review-20261102` (child of `review/zai-model-productivity-20261102`, base commit `09a25ce7`, review-brief commit `c2dc177f`)
**Date:** 2026-11-03
**Scope:** End-to-end independent study of the AI/model architecture, M1 tactical engine, multi-model/Plan-B ensemble, trained challengers, admission/governance gates, risk & execution boundaries, entry/exit economics, and the cTrader market-data pipeline — with the explicit goal of improving **profitability, expectancy, profit factor, and drawdown**, not win rate.
**Companion artifacts (this branch):**

- `docs/research/2026-11-03-zai-expectancy-exit-scenario-model.md` — reproducible expectancy decomposition + scenario ladder
- `scripts/research/zai-expectancy-decomposition.sql` — P&L segmentation query set for the staging DB
- `scripts/research/zai-exit-autopsy-counterfactual.sql` — profit-protection exit autopsy (TP/SL/neither replay)
- `scripts/research/zai-blocker-cooccurrence.sql` — blocker frequency/co-occurrence/root-cause dedup audit

**Review posture:** No production code, thresholds, admission logic, risk gates, or execution authority were modified on this branch. All changes are read-only research artifacts. Every proposal below specifies a shadow/DEMO/LIVE posture and the evidence required before promotion, per the review brief.

---

## 1. Issues Found (ranked summary)

| # | Issue | One-line statement | Severity |
|---|-------|--------------------|----------|
| F1 | **Exit engine truncates the right tail** | Designed R:R is 1.6R (M1) / 1.667R (M5) but the realized payoff ratio is **0.93** — 58% of design — because the profit-lock retention ladder harvests wins at 0.35–1.35R while losses still run to ≈ −1R. | **Critical** |
| F2 | **Transaction-cost drag consumes the designed M1 edge** | `costR = 1.25 × spread / stopDistance` evaluates to ≈ **0.15–0.19R** on M1 candidates (1.1×ATR stops with a 5-pip floor, ~1-pip spreads) versus a 0.08R net-expectancy floor — the cost model is honest, the geometry makes the edge structurally thin. | **Critical** |
| F3 | **Two incompatible confidence scales flow through one field** | M1 candidate confidence (heuristic, capped 0.738), Plan-B ensemble score (weighted average, typically 0.40–0.55), and trained-expert confidence (0.7+) are written to the same outbound `confidenceScore` depending on execution path; downstream consumers (sizing tiers, bootstrap windows, M5-handoff bar) assume a different scale. | High |
| F4 | **One root cause surfaces as up to 5 blockers; two floors disagree** | A confidence < 0.64 simultaneously emits `CONFIDENCE_FLOOR`, `MULTIMODEL_PLAN_B_NOT_ADMITTED`, `MULTIMODEL_GOVERNANCE_BLOCKED` (with nested duplicates), `ENSEMBLE_NOT_PAPER_ADMITTED`, and `DRIFT_OUT_OF_DISTRIBUTION`; the early-transition 0.2R net floor is silently downgraded to 0.08R by an override; the route floor named "net" is applied to a gross quantity. | High |
| F5 | **Drift envelope is a stale, global OR-veto that rejects legitimate regimes** | Any single feature outside a frozen 4,599-event envelope (corpus of unknown vintage) vetoes the whole candidate; the envelope's confidence hard-low (0.640079) sits exactly at the Plan-B admission floor (0.64), so the lower third of the M1 confidence range is permanently out-of-distribution. | High |
| F6 | **Early-transition route is structurally suppressed and economically weakest** | Highest expectancy floor (0.2R), thinnest evidence requirements inverted (PF ≥ 2.0 at 3 samples), a demo veto on degraded cohorts, and a recovery probe that is structurally inert (it requires exactly the conditions that trigger the veto); realized ET cohorts are negative per in-repo comments. | Medium |
| F7 | **Side-selection three-class model is research-promising but unqualified — and its signal is unused** | 973 paired episodes; holdout PF 1.436 (pass) but balanced accuracy 0.363 (fail); 75% of resolved losses were flippable in the mirrored audit; no runtime consumer of the delta features as a meta-feature. | Medium |
| F8 | **Validation methodology is good but incomplete** | Purged walk-forward, nested selection, and an untouched holdout exist; **no Deflated Sharpe, no PBO/CSCV, no multi-day embargo, no confidence intervals on gate metrics, no cost-stressed qualification gate, trial ledger not enforced**. | Medium |
| F9 | **Champion/challenger promotion is accuracy-keyed, not economics-keyed** | `_broad_improvement_flag` requires balanced-accuracy uplift ≥ 0.002 and Brier delta ≤ 0.002 with economics only "not both worse" — precisely the pattern the review brief warns against. | Medium |
| F10 | **Market-data readiness has intermittent starvation paths (the 12–18 meter incident)** | M5 context rotates on a ~6-minute cycle against a 10-minute freshness window (two deferred refreshes breach); >10-minute data gaps reset the feature grid and require 30 fresh M1 bars (~30 minutes) to re-arm; there is no gap-targeted backfill; spread sampling is single-path. The fail-closed states themselves are correct. | Medium |
| F11 | **Dead/decorative control surfaces create false confidence** | `trailingStopPips` is recorded, digested into grants, and enforced by nothing; sizing tiers ELITE ≥ 0.88 / VERY_STRONG ≥ 0.80 are unreachable (confidence cap 0.738); `MULTIMODEL_TRAINED_EXPERT_DIRECTION_CONFLICT` is checked but never emitted; `STRATEGY_CUTOVER`/`RECONCILIATION` close reasons have no producer; `TIME_TO_WORK` closes are mapped to `AI_CLOSE_SIGNAL`, making exit autopsies lossy. | Medium |
| F12 | **No breakeven-stop, no session-close exit, no classical trailing stop** | The only mid-trade defenses are the profit lock, the DEMO thesis/adverse guards, the v8.9 5-minute drawdown guard, and the paper time-to-work stop (PAPER-only). Loss-side management relies almost entirely on the initial stop. | Medium |

---

## 2. Exact Code / Data Evidence

### 2.1 F1 — Exit truncation (the dominant issue)

**Designed geometry.**

- M1: `stopDistance = max(atr14 * 1.1, pip * 5)`, `targetDistance = stopDistance * 1.6` — `apps/api/src/modules/ai/m1-tactical-candidate.ts:112-116`, policy `:24-26` (`stopAtrMultiplier: 1.1`, `targetR: 1.6`, `minStopPips: 5`).
- M5: `STOP_ATR_MULTIPLIER = 1.5`, `TARGET_ATR_MULTIPLIER = 2.5`, `targetDistance = stopDistance * (2.5/1.5)` ⇒ 1.667R — `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts:285-286, 970-974`.

**The profit lock.** `apps/api/src/modules/broker/adapters/paper-broker.adapter.ts:705-749`:

- Arm floor: peak ≥ **0.50R** (standard), **1.00R** CONFIRMED_REVERSAL, **0.75R** EARLY_TRANSITION, **0.395R** M1-rescue (`:711-726`).
- Retention ladder: 0.50–<0.75R peak → keep **70%**; 0.75–<1.0R → **75%**; 1.0–<1.5R → **80%**; 1.5–<2.0R → **85%**; ≥2.0R → **90%** (`:728-738`).

The code's own comment states the pathology (`:705-707`): *"arming at 0.30R repeatedly harvested tiny wins while full SL losses remained ~1R. The default floor therefore stays at +0.50R."* The 0.50R floor still caps most winners: a trade that peaks at 0.6R is closed at 0.42R; only a trade that first reaches ≥2R can keep 90%, and the TP at 1.6R is reachable only for trades whose peak crosses the ladder before any 5-second sampling tick closes them earlier. There is **no breakeven stop, no trailing stop enforcement** (`trailingStopPips` is persisted on trades and intents but never included in any `BrokerOrderRequest`), and no session-close exit.

**Staging aggregate (from the review brief, reproduced):** 588 closed trades — 271 wins / 313 losses / 4 flat; gross +1,420.85 vs −1,761.82; net −340.97; PF ≈ 0.81. Derived (see `docs/research/2026-11-03-zai-expectancy-exit-scenario-model.md`):

- Avg win **5.2430**, avg loss **5.6288**, realized payoff **0.9315**, expectancy **−0.584** units/trade.
- Realized payoff / designed R:R = **0.582** (M1) / **0.559** (M5) → exit-engine truncation factor.
- Breakeven win rate at the realized payoff = **51.8%** > observed 46.4% → structurally negative expectancy.
- At the *designed* 1.6R payoff and the observed win rate, gross expectancy would be **+0.207R/trade** → direction selection is not the primary problem; the exit engine and costs are.

**Counterfactual evidence channel already exists but is unconsumed:** `apps/api/src/modules/ai/profit-protection-counterfactual.service.ts` replays, for every `close_reason = 'PROFIT_PROTECTION'` DEMO trade, the following 4 hours of broker-native M1 bars against the original TP/SL and stores `TP_FIRST | SL_FIRST | NEITHER_4H | AMBIGUOUS_SAME_M1 | DATA_GAP` into `trading.post_entry_shadow_observations` (artifact `profit-protection-counterfactual-v1`, 240-minute checkpoint, `:6, 37-120, 280-290`). No report/telemetry consumes these outcomes today. The companion SQL `scripts/research/zai-exit-autopsy-counterfactual.sql` queries them.

**Offline A/B harness already exists:** `apps/api/src/modules/ai/paper-payoff-shadow-audit.ts:359-363` benchmarks giveback-lock policies (`CLOSE_LOCK_050_GIVEBACK_040`, `CLOSE_LOCK_075_GIVEBACK_050`, `CLOSE_LOCK_100_GIVEBACK_050`) against baseline with a 1.25×max(broker,paper) spread cost model (`:262-285`) — the correct tool for tuning F1 without touching LIVE behavior.

### 2.2 F2 — Cost drag on M1 geometry

`apps/api/src/modules/ai/ensemble-governance.ts:395-402`:

```ts
costR = (1.25 * spread) / stopDistance   // spread = P90 broker spread, +25% slippage haircut
```

- Fixed PAPER spreads: EURUSD/USDJPY/AUDUSD 1.0 pip; GBPUSD/USDCAD/USDCHF 1.2 pips — `apps/api/src/modules/broker/services/paper-market-spec.ts:10-15`.
- M1 stop = max(1.1×ATR14, 5 pips). For EURUSD with ATR14 ≈ 6 pips (typical M1), stop ≈ 6.6 pips → costR ≈ **0.19R**; at ATR14 ≈ 9 pips → ≈ **0.15R**. On M5 (1.5×ATR ≈ 12–18 pips) → ≈ **0.07R**.
- Floors the cost must fit under: `ENSEMBLE_NET_EXPECTED_R_FLOOR = 0.08` (`ensemble-governance.ts:7`); M1 route floors 0.08/0.12/0.2 (`m1-tactical-scheduler.service.ts:391-395`). A 0.19R cost against a heuristic prior capped at ≈ +0.52R (`m1-tactical-expectancy.ts:53-62`) leaves almost no admissible band in low-volatility regimes — consistent with the observed blocker mix.
- Costs are consistently subtracted (`netExpectedR = grossExpectedR − estimatedExecutionCostR`, `ensemble-governance.ts:408-411`; outcome settlement `netR = grossR − costR`, `ensemble-shadow-outcome.ts:284,304`) — the model is honest; the geometry is the problem.

### 2.3 F3 — Confidence-scale switching

Three producers, one field:

- M1 candidate: `confidence = min(0.738, clamp01(0.5 + 0.3*dq + 0.08*eff5 − 0.08*vol))` — `m1-tactical-candidate.ts:27, 157-162` (heuristic bar-strength score, hard cap 0.738, **not** a calibrated probability).
- Plan-B: `ensembleScore = clamp01(0.22*meta.probability + 0.15*direction + 0.12*quality + 0.11*exit + 0.1*pairSide + 0.08*session + 0.1*economicQuality + 0.12*portfolio.quality)` with `pairSide ≡ 0.5` hard-coded (`plan-b-multimodel-shadow.ts:280-284, 401-410`) — a weighted average typically landing 0.40–0.55.
- Trained expert: `ensemble_confidence = 0.5*agreement + 0.3*mean_direction_confidence + 0.2*mean_opportunity` (`services/ai-engine/app/domain/models/high_conviction_challenger.py:262-266`) — typically ≥ 0.7 when unanimous.

The submitted signal's `confidenceScore` is chosen by execution path — `m1-tactical-scheduler.service.ts:1733-1743` (M5-handoff → Plan-B score; multimodel primary → Plan-B score; rescue → trained-expert confidence; M1 fallback → candidate confidence). Consumers that assume a 0.6–0.9 probability band:

- Sizing tiers: `if (confidence >= 0.88) return 'ELITE'; if (confidence >= 0.8) return 'VERY_STRONG'` (`m1-tactical-scheduler.service.ts:488-495`) — **unreachable** under the 0.738 cap (dead tiers).
- Bootstrap window: `M1_PROFESSIONAL_BOOTSTRAP_MIN_CONFIDENCE = 0.72` vs cap 0.738 → a **0.018-wide** admissible band (`m1-tactical-scheduler.service.ts:139`).
- M5 handoff: `MIN_M5_ENSEMBLE_SCORE = 0.6` (`m5-early-transition-handoff.ts:40`) sits **above** the Plan-B score's typical 0.40–0.55 operating range → `M5_ENSEMBLE_SCORE_TOO_LOW` rejects dominate by construction.
- High-conviction rescue: `HIGH_CONVICTION_RESCUE_CONFIDENCE_FLOOR = 0.7` (`multimodel-demo-authority.ts:43`) — meaningful only against the trained-expert scale.

### 2.4 F4 — Blocker inflation and floor mismatch

- One root cause, up to five strings: `plan-b-multimodel-shadow.ts:414` (`CONFIDENCE_FLOOR` reason) → `plan-b:449` `MULTIMODEL_PLAN_B_NOT_ADMITTED`… actually emitted by `multimodel-demo-authority.ts:154-159` (`MULTIMODEL_PLAN_B_NOT_ADMITTED` + `MULTIMODEL_GOVERNANCE_BLOCKED` + nested `paperExecutionBlockers`), `ensemble-governance.ts:439-444` (`ENSEMBLE_NOT_PAPER_ADMITTED`, `PAPER_NET_EXPECTED_R`, `DRIFT_*`), and the drift envelope `:113` (confidence `hardLow: 0.640079`). Verified in code; see `scripts/research/zai-blocker-cooccurrence.sql` to quantify on staging.
- ET floor downgrade: `m1-tactical-governance.ts:127` passes `paperNetExpectedRFloorOverride: ENSEMBLE_NET_EXPECTED_R_FLOOR` (0.08), which per `ensemble-governance.ts:416-419` **replaces** the ET-specific `ENSEMBLE_EARLY_TRANSITION_PAPER_NET_EXPECTED_R_FLOOR = 0.2` (`:9`) inside the generic governance — the 0.2 floor survives only in the Plan-B scorer and the scheduler's route floor.
- Naming mismatch: `routePayoffEligible = governance.expectancy.statisticalExpectedR >= routeNetExpectedRFloors[route]` (`m1-tactical-scheduler.service.ts:1053-1061`) compares the **pre-cost statistical** expectancy against floors literally named "net" (`:391-395`). For fresh pairs the statistical expectancy is the gross heuristic prior (`m1-tactical-expectancy.ts:53-62`).

### 2.5 F5 — Drift envelope

`ensemble-governance.ts:6, 106-141`: `ENSEMBLE_DRIFT_MODEL_VERSION = 'triple-route-direction-aligned-momentum-v4'`, static frozen bounds from a 4,599-event development corpus. Any single hard breach → `OUT_OF_DISTRIBUTION` (quality 0.1) → paper blocker (`:444`). Confidence hard band `[0.640079, 0.751451]` — given the M1 confidence range [0.57, 0.738], the band below 0.640 is permanently OOD, and it coincides exactly with `PLAN_B_CANDIDATE_CONFIDENCE_FLOOR = 0.64` (`plan-b-multimodel-shadow.ts:50`). `driftDiagnostics` names the offending feature/bound (`:164-217, 425`) but the veto is global. There is no refresh policy for the envelope and no retraining trigger. Route-specific envelopes (reversal/early-transition, `:219-285`) add further fail-closed bounds (e.g. reversal directional momentum must be ∈ [0.5, 1.5]).

### 2.6 F6 — Early-transition suppression

- ET is the most demanding route: gross floor 0.3 (`plan-b-multimodel-shadow.ts:55`), net floor 0.2 (`ensemble-governance.ts:9`, downgraded at the M1 boundary — F4), extension ≤ 0.9, emaSep ∈ [0.12, 0.5], mtfStrength < 0.12 (`:56-58`).
- Scout ledger: per route/instrument/**direction**/policy shadow outcomes, `execution_authority = 'NONE'` only, 7-day window, LIMIT 20 (`m1-tactical-evidence.service.ts:1179-1186`); tiers require PF ≥ 1.5 & avgR ≥ 0.1 (meaningful, ≥6 samples — `m1-meaningful-scout-reliability.ts:5-11`) or **PF ≥ 2.0 & avgR ≥ 0.2** (provisional, ≥3 samples — `m1-provisional-scout-reliability.ts:5-11`).
- Demo veto: `M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED` for reasons ∈ {WEAK_MEANINGFUL_EXPECTANCY, RECENT_MEANINGFUL_DEGRADATION, WEAK_PROVISIONAL_EXPECTANCY, RECENT_PROVISIONAL_DEGRADATION} (`demo-profitability-reliability-gate.ts:22-50`).
- Structural inertness of the recovery probe: `RECOVERY_PROBE` requires a shadow reason of WEAK_*_EXPECTANCY with recent netR > 0 (`m1-tactical-scheduler.service.ts:161-164, 329-341`) — but those exact reasons fire the demo veto (`demo-profitability-reliability-gate.ts:22-27`), and the fallback executor only executes continuation tiers anyway ("Realized early-transition fallback cohorts are currently negative" — `:147-150`).
- Policy-version reset risk: the ledger matches `policy_version` exactly with no lineage carry (contrast `POLICY_LINEAGE` in `m1-tactical-reliability.ts:14-18`), so any policy bump zeroes scout evidence per pair/side until ≥3 fresh shadow outcomes accrue.
- Executed trades never rehabilitate a suppressed pair/side: the ledger ingests only `execution_authority = 'NONE'` episodes.

### 2.7 F7 — Side-selection three-class

- Model: KEEP/FLIP/ABSTAIN XGBoost (`multi:softprob`, 450 trees, depth 4) over primary/opposite/delta features (`services/ai-engine/app/domain/training/side_selection_three_class.py:170-184, 450-466`), research-only (`mode: "RESEARCH_ONLY"`, `:622-624`).
- Results doc: `docs/research/2026-11-02-side-selection-three-class-results.md` — 18,016 shadow decisions → 8,650 paired → 973 independent episodes; qualification balanced accuracy **0.347 FAIL**, PF 1.113 FAIL; holdout PF **1.436 PASS**, Sharpe 1.037 PASS, BA **0.363 FAIL**; verdict "research-promising, not qualified for DEMO execution."
- Mirrored audit: `docs/research/2026-11-02-direction-side-selection-mirrored-audit.md` — 136 resolved trades: KEEP 72 / FLIP 48 / ABSTAIN 16; **75% of resolved losses were flippable**; "the target problem is genuinely three-class."
- Telemetry exists (`side-selection-pattern-telemetry.ts:135-214`, `executionAuthority: 'NONE'`) but the delta features are **not** consumed as a meta-feature by any admission path.

### 2.8 F8/F9 — Validation and promotion

- Present: purged expanding walk-forward with `purge = embargo = horizon_bars`, max 5 folds (`services/ai-engine/app/domain/training/validation.py:48-170`); nested selection with 3 purges (`model_qualification.py:488-588`); untouched 20% holdout gate (`run_first_six_pair.py:181-295`); PSR + E[max Sharpe] utilities (`robustness_audit.py:84-154`); locked research gate `{min_balanced_accuracy: 0.52, min_sharpe: 1.0, min_pf: 1.15, max_dd: 0.12, min_positive_fold_fraction: 0.60, min_positive_instrument_fraction: 0.67}` (`run_first_six_pair.py:181-188`).
- Missing: DSR never computed from an enforced trial ledger (`robustness_audit.py:186-196` defaults to `"TRIAL_LEDGER_REQUIRED"`); no PBO/CSCV anywhere; no multi-day embargo; no CIs on gate metrics; no cost-stressed qualification; side-selection walk-forward uses 3 folds with **no embargo** between validation windows (`side_selection_three_class.py:547-572`); no per-instrument held-out generalization test for the pooled model.
- Promotion: `_broad_improvement_flag` (`model_qualification.py:2992-3083`) keys on accuracy/calibration uplift with economics merely "not both worse," and explicitly says it is "not a promotion gate" — yet no economics-first scorecard exists downstream. The champion evidence gates that DO exist (`paper-champion-evidence.ts:2-6`: ≥50 trades, PF ≥ 1.15, positive-instrument fraction ≥ 0.67) are applied to M5 cohorts, not to model promotion. `strategy-artifacts/` contains only a README — nothing has ever cleared the full ladder.

### 2.9 F10 — Market-data readiness

- Architecture: bars come from **polling `ProtoOAGetTrendbarsReq` (2137)** on a 15 s rotation (`ctrader-quote-collector.service.ts:10-23, 56-68`); spread evidence from a separate 1 s one-shot SUBSCRIBE_SPOTS→SpotEvent→UNSUBSCRIBE cycle (`ctrader.adapter.ts:1633-1706`); history priority rule protects quote freshness (`:102-106`).
- Readiness gates: M1 close ≤ **90 s** (`BROKER_M1_STALE`), M5 ≤ **10 min**, M15 ≤ **20 min** (`BROKER_FEATURE_CONTEXT_UNAVAILABLE`), spread > 0 with ≥ **10** samples ≤ **5 min** old (`BROKER_SPREAD_UNUSABLE`) — `m1-tactical-market-data.service.ts:27-29, 176-219`.
- Starvation paths: (a) context rotation gives each pair's M5 one refresh slot per ~6 min; two deferred/failed refreshes (12 min) breach the 10-min window — failures are warn-throttled, never retried in-cycle (`ctrader-quote-collector.service.ts:161-170, 199-204, 386-392`); (b) any >10-min gap resets the feature grid and requires 30 fresh M1 bars (~30 min) to re-arm (`m1-tactical-features.ts:66-70, 141-146, 293-301`); (c) spread sampling is single-path (1 s poll) and requires `connection.status === CONNECTED`; auto-suspension (3 failed health checks, 60 s cadence) stops spread samples → `BROKER_SPREAD_UNUSABLE` after 5 min; (d) steady-state M1 refresh requests only the latest 60 bars — **no gap-targeted backfill exists**.
- Meter mapping (the 12–18 incident): `apps/web/src/lib/vps-scanner-status.ts:324-360` maps `BROKER_M1_STALE` → 8, `BROKER_FEATURE_CONTEXT_UNAVAILABLE` → 12, `BROKER_SPREAD_*` → 15, other → 10. The fail-closed states are correct; the starvation paths above are the root cause.

### 2.10 F11/F12 — Dead surfaces and missing exits

- `trailingStopPips`: persisted on trades (`trade.entity.ts:166`), digested into grants (`risk.interface.ts`, `risk.service.ts`), never sent to any broker nor enforced by any adapter; the payoff audit even skips `TRAILING_STOP` rows (`paper-payoff-shadow-audit.ts:212`).
- Exit-reason mapping loss: `TIME_TO_WORK → AI_CLOSE_SIGNAL`, `MANUAL/SYSTEM/UNKNOWN → BROKER_CLOSE` (`reconciliation-resolution.service.ts:208-218`) — DEMO time-stops are indistinguishable from engine exits in the durable taxonomy (the raw provider reason survives only in audit metadata, `:164`).
- `STRATEGY_CUTOVER` and `RECONCILIATION` close reasons have no producer in current code.
- `MULTIMODEL_TRAINED_EXPERT_DIRECTION_CONFLICT` is checked at `m1-tactical-scheduler.service.ts:1130-1134` but never emitted by the authority — dead path; expert opposition is only a 0.2-lot cap (`multimodel-demo-authority.ts:184`).
- PAPER commission/swap are hard-coded `'0'` (`paper-broker.adapter.ts:2746-2747`); the payoff audit quarantines cost-accounting ambiguity via `NET_COSTS_UNPROVEN` (`paper-payoff-shadow-audit.ts:186-189`).
- MAE/MFE, by contrast, is **first-class** everywhere (`trade.entity.ts:215-241`; paper `recordPathObservation` `paper-broker.adapter.ts:1494-1543`; DEMO 5-second loop `live-demo-profit-protection.service.ts:296-317`) — the data needed for exit optimization already exists.

---

## 3. Root Causes

1. **RC1 — Exit policy predates the current trade population and is tuned by intuition, not by MAE/MFE distributions.** The retention ladder (70–90% of peak) mathematically caps the average win far below the designed TP: with peak P, exit ≈ retention(P)×P ≤ 0.9P, and most trades never reach the higher tiers. The in-code comment (`paper-broker.adapter.ts:705-707`) documents that the floor was raised from 0.30R to 0.50R after observing exactly this pathology — i.e., the parameter was moved once by hand, then frozen. Nobody is consuming the counterfactual replay (`profit-protection-counterfactual-v1`) or the MAE/MFE columns to re-tune the ladder.
2. **RC2 — Timeframe/geometry/cost mismatch.** M1 candidates carry M5-designed cost models against M1-sized stops. The 1.1×ATR stop with a 5-pip floor produces costR ≈ 0.15–0.19R at ~1-pip spreads — larger than the net floor the same candidate must clear (0.08R). The system's own expectancy gate then correctly rejects most low-ATR M1 setups; the observed high blocker volume is partly the gates *working* on a geometry that cannot pay for itself.
3. **RC3 — Confidence is a heuristic, consumed as if it were a calibrated probability.** The M1 confidence is a fixed linear function of bar features with an arbitrary 0.738 cap (chosen so that drift-envelope and Plan-B floors bind), while the trained challenger's ensemble confidence and the Plan-B blend are different statistics entirely. All downstream thresholds (tiers, bootstrap, M5 handoff bar, rescue floors) were presumably chosen against *some* scale, but not the same one — hence dead tiers, a 0.018-wide bootstrap window, and a handoff bar above the score's operating range.
4. **RC4 — Layered governance accreted without a root-cause contract.** Five independent layers (route → scout ledger → Plan-B consensus → generic governance → demo authority) each push their own blocker strings, and several re-check the same underlying quantity (confidence floor / drift / spread / event risk appear in 2–4 layers each). The ET floor override (`m1-tactical-governance.ts:127`) is a seam between layers that silently changes policy. Diagnosis now reads tea leaves: the brief's own observation list shows 5+ blockers per decision with no primary-cause attribution.
5. **RC5 — The drift envelope is frozen archaeology.** It was computed once from a 4,599-event development corpus and never refreshed; its confidence band lower bound coincides with the admission floor by construction, making `DRIFT_OUT_OF_DISTRIBUTION` a near-duplicate of `CONFIDENCE_FLOOR` rather than an independent regime signal. The OR-combination across 6 features maximizes false rejections (any single feature breach vetoes).
6. **RC6 — Promotion and validation gates measure classification, the business measures P&L.** The challenger screen keys on balanced accuracy and Brier; the research gate includes PF/Sharpe/DD but at the *variant-selection* level, not the *promotion* level; the trial ledger that would power DSR is optional and unwired. Result: model churn can be justified by accuracy while expectancy never improves — precisely the staging outcome (PF 0.81).
7. **RC7 — The highest-information datasets are write-only.** The counterfactual replay, the shadow-outcome ledger, side-selection telemetry, MAE/MFE columns, and the payoff-shadow audit all collect the right data, but no closed loop turns them into parameter updates or promotion decisions. The system measures everything and acts on almost nothing.

---

## 4. Improvement Proposals

Each proposal lists: change → mechanism → validation → rollout posture (details in chapters 5–9).

### P1 — Re-tune the exit engine from MAE/MFE evidence (highest leverage)

- **Change:** Replace the fixed 0.50R arm floor + fixed retention ladder with an MFE-conditional policy: (a) partial scale-out of 50% at ≈ 1.0R (measured, not assumed); (b) trail the remainder at 2.5×ATR instead of a fixed giveback fraction; (c) keep the 0.50R arm floor only for trades whose 20-trade MFE percentile shows the current ladder outperforms the trail; (d) leave SL/TP geometry untouched.
- **Mechanism:** `paper-payoff-shadow-audit.ts` already benchmarks giveback policies offline against baseline with honest cost modeling; extend its policy grid with `PARTIAL_50_AT_1R + TRAIL_2.5ATR` variants and rank by net expectancy and max giveback, not win rate. Use `trading.trades.max_favorable_pnl/max_adverse_pnl/profit_giveback` as the fitting dataset and `profit-protection-counterfactual-v1` outcomes as the ground truth for "would the original TP have been hit after a protected close?"
- **Explicitly preserved invariants:** initial SL, mandatory SL/TP, all RiskService gates, the kill switch. Nothing here touches admission.
- **Posture:** offline study → shadow replay → DEMO A/B (profit lock is PAPER/DEMO-scoped today; `PAPER_PROFIT_LOCK_ENABLED` gates replay only) — see chapter 8.

### P2 — Fix M1 cost geometry (raise the floor, not the thresholds)

- **Change:** For M1 candidates, enforce `stopDistance ≥ max(1.1×ATR14, costBreakEvenStop)` where `costBreakEvenStop = 1.25×P90spread / 0.10R` (i.e., a stop size that keeps costR ≤ 0.10R), instead of the flat 5-pip floor. Additionally prefer the M5-anchored geometry (1.5×ATR) for continuation routes whose HTF agreement is strong.
- **Mechanism:** this *narrows* the admissible set to trades whose edge can clear costs — the opposite of lowering thresholds; it converts the current silent failure mode (0.19R cost vs 0.08R floor) into explicit geometry. Validate with the expectancy-decomposition SQL segmented by ATR bucket.
- **Posture:** shadow computation + telemetry first (log `costR` and `costBreakEvenStop` per candidate); DEMO-only enforcement after 4+ weeks of shadow evidence.

### P3 — Single calibrated probability surface

- **Change:** Introduce one canonical field, `calibratedWinProbability` (empirical-Bayes shrinkage already implemented in `adaptive-prediction-calibration.service.ts:290-297`), attached to every decision; keep raw scales internal. Re-key the dead consumers: sizing tiers (0.80/0.88 → calibrated-probability tiers fitted to realized P(win) quantiles), the M5-handoff bar (`MIN_M5_ENSEMBLE_SCORE = 0.6` → a calibrated-probability floor with the same empirical intent), and the bootstrap window.
- **Mechanism:** no behavior change until consumers are re-keyed; the calibration service already has causality guards, evidence hierarchy, and block/rescue semantics.
- **Posture:** shadow telemetry + report-only for ≥ 2 weeks; then DEMO consumer re-keying one consumer at a time.

### P4 — Root-cause blocker attribution + floor unification

- **Change:** (a) In `evaluateMultimodelDemoAuthority`, stop re-exporting nested blockers — emit exactly one `MULTIMODEL_BLOCKED:<primary>` with a single machine-readable `primaryCause` (CONFIDENCE_FLOOR | NET_EXPECTED_R | DRIFT | SPREAD | EVENT_RISK | SLEEVE | TIMING | PORTFOLIO); (b) fix the ET floor override so `ENSEMBLE_EARLY_TRANSITION_PAPER_NET_EXPECTED_R_FLOOR = 0.2` actually applies at the M1 governance boundary (delete the override or pass 0.2); (c) rename `routeNetExpectedRFloors` → `routeGrossExpectedRFloors` or apply it to the net quantity — pick one semantic.
- **Mechanism:** pure telemetry/clarity change; the SQL companion `zai-blocker-cooccurrence.sql` quantifies the current inflation for before/after comparison.
- **Posture:** safe to implement now (no admission semantics change in (a); (b)/(c) are DEMO-behavior changes and stay disabled-by-default behind flags until chapter 8 evidence).

### P5 — Drift envelope refresh + per-feature attribution

- **Change:** (a) recompute the 6-feature envelope on a rolling 30-day window of *shadow-resolved* decisions (the ledger already stores features per decision) with hard bands at P0.5/P99.5 and stressed bands at P2.5/P97.5; (b) keep the global veto only for hard breaches; convert stressed breaches into a `driftStressScore` meta-feature (0–1) surfaced to the meta-scorer instead of a veto; (c) persist per-feature breach telemetry (already in `driftDiagnostics`) into `ensemble_shadow_decisions.components` for the co-occurrence audit.
- **Mechanism:** addresses the brief's question — whether the envelope rejects legitimate post-regime-shift opportunities — with data instead of opinion. Fail-closed extremes are preserved.
- **Posture:** shadow-only (telemetry + report) until the counterfactual analysis in chapter 7 proves that DRIFT-blocked-then-continued episodes would have been net-positive.

### P6 — Meta-labeling loss filter (secondary model on shadow outcomes)

- **Change:** Train a secondary model (XGBoost, same purged-walk-forward tooling) whose target is `realized net R > 0` on the ~18k shadow-outcome ledger, using as features: primary candidate features + model-disagreement terms (Plan-B votes failed, expert opposition, drift stress) + side-selection delta features + session/regime. Use it to (a) filter the bottom-decile P(win) cohort and (b) scale size within the existing `adaptive risk multiplier [0.5, 1.25]` clamp — never to add trades.
- **Mechanism:** this is López de Prado-style meta-labeling on data that already exists; it monetizes F7's finding that 75% of losses were flippable and RC6's insight that disagreement is information.
- **Posture:** offline → shadow (its own artifact, `execution_authority: 'NONE'`) → DEMO gate only after it beats the "always take" baseline on untouched holdout net expectancy with DSR ≥ 0 and PBO ≤ 0.5 (chapter 6/7 standards).

### P7 — Early-transition route: keep shadow-only, stop spending on it

- **Change:** Freeze ET as a research lane (its `admitted` is already hard-false for promotion, `plan-b-multimodel-shadow.ts:453`); add the policy-lineage carry to the scout ledger so evidence survives version bumps; extend the ledger window from 7 days to 30 days for ET specifically; and re-purpose the inert RECOVERY_PROBE into a data-driven re-arming rule (re-allow ET execution on a pair/side when its 30-day ledger shows ≥ 20 episodes with net expectancy ≥ +0.1R and PF ≥ 1.15).
- **Mechanism:** no new risk; aligns capacity with the two economically viable routes (continuation/reversal) until ET proves itself on its own ledger.

### P8 — Wire the promotion scorecard to economics

- **Change:** Extend `_broad_improvement_flag` (or add a successor `economics_first_promotion_flag`) requiring, on the untouched holdout: net expectancy ≥ baseline × (1 + 0.05), PF ≥ 1.15, maxDD ≤ max(baseline, 0.12), positive-fold fraction ≥ 0.6, **and** DSR > 0 with an enforced trial ledger, **and** PBO ≤ 0.5. Keep `approved_for_live = False` everywhere (already forced).
- **Mechanism:** closes RC6; the PSR/E[max SR] utilities already exist in `robustness_audit.py` and only need the ledger wiring.

### P9 — Market-data resilience (fix starvation, keep fail-closed)

- **Change:** (a) add gap-targeted M1/M5 backfill: when the store detects a >10-min discontinuity or a failed context refresh, enqueue a 2137 backfill across the gap (provider rate limits already token-bucketed at 5 req/s historical); (b) add per-(instrument, timeframe) `lastSuccessfulCollectAt` telemetry to the collector's status output so "provider gap" and "rotation stall" are distinguishable in incidents; (c) retry failed context refreshes once within the same cycle before rotating.
- **Mechanism:** reduces dead minutes at the two thinnest margins (M5 rotation vs 10-min window; 30-bar re-arm after gaps) without weakening any freshness/spread check.

### P10 — Hygiene batch (dead surfaces, taxonomy, filters)

- (a) Either enforce `trailingStopPips` in the paper adapter + cTrader adapter (position-order type) or stop persisting it as if it were active; (b) re-map `TIME_TO_WORK` → a dedicated `TIME_TO_WORK` close reason (add enum value) so exit autopsies are exact; (c) surface `MULTIMODEL_TRAINED_EXPERT_DIRECTION_CONFLICT` or delete the dead check; (d) add a runtime reliability/Brier monitor (10-bin diagram per route) fed by `ensemble_shadow_decisions` — the offline tooling already exists (`qualification_diagnostics.py:20-78`); (e) consume `profit-protection-counterfactual-v1` outcomes in a weekly report (the companion SQL makes this one query).

---

## 5. Expected Impact (trade frequency / win rate / expectancy / PF / avg win-loss / drawdown)

Baseline (staging, 584 resolved trades): WR 46.4% · avg win 5.243 · avg loss 5.629 · payoff 0.932 · PF 0.807 · net −341 · E −0.584/trade.

| Proposal | Frequency | Win rate | Expectancy/trade | PF | Avg win / loss | Drawdown |
|---|---|---|---|---|---|---|
| **P1 exit re-tune** | ≈ unchanged (same admissions) | ↓ 1–4 pts (fewer tiny protected wins become full/partial wins) | **+0.10 to +0.25R** (restores part of the 0.67R win-truncation gap; scenario S1: avg win 5.24→6.50 alone → PF 1.00) | 0.81 → **1.00–1.15** | avg win +15–25%; avg loss ≈ unchanged | similar or lower (partial exits reduce giveback variance) |
| **P2 cost geometry** | ↓ 10–25% (fewer cost-doomed M1 entries) | ≈ +1–2 pts (adverse selection removed) | **+0.03 to +0.09R** on remaining trades | +0.03–0.06 | unchanged | lower via fewer trades |
| **P3 calibrated surface** | neutral | neutral (enabling change) | neutral direct; enables P6 sizing | neutral | neutral | ↓ later via P6 |
| **P4 blocker dedup** | neutral (telemetry) | neutral | neutral | neutral | neutral | neutral |
| **P5 drift refresh** | ↑ 10–30% while OOD share is real | unknown — must be *measured* (chapter 7 protocol) | could be ±; requires the shadow counterfactual before enabling | ± | ± | ↑ if bad re-entries allowed — gated by evidence |
| **P6 meta-filter** | ↓ 10–20% (bottom decile filtered) | ↑ 2–4 pts on executed set | **+0.05 to +0.12R** (scenario S3: +176 units from filtering alone on top of S2) | +0.05–0.10 | avg win ↑ (loser tail removed) | ↓ materially (fewer loss-streak cascades) |
| **P7 ET freeze** | ≈ neutral (ET is already ~never executed) | neutral | neutral direct; stops future negative-E ET cohorts | neutral | neutral | neutral |
| **P8 economics promotion** | neutral now; prevents future degradation | — | protects gains | — | — | protects |
| **P9 data resilience** | ↑ recovers suppressed minutes (incident-window frequency) | neutral | small positive | small | — | neutral |
| **P10 hygiene** | neutral | neutral | enables exact exit autopsies → feeds P1 | — | — | — |

**Combined realistic path (staged, all shadow-validated first):** frequency −10–20% (cost geometry + meta-filter), win rate roughly flat to −1 pt (deliberate trade-off), expectancy per executed trade +0.18 to +0.45R, PF 0.81 → **1.05–1.25**, avg win/loss ratio 0.93 → **1.10–1.35**, drawdown ↓ 10–25% (fewer trades × better loss hygiene). These are analytic scenario estimates (chapter 7 of the companion doc), not backtest claims; the SQL companions reproduce the decomposition from staging before any change.

**What deliberately does NOT move:** win rate is not a target of any proposal; two proposals accept a *lower* win rate in exchange for payoff (P1), which is the exact trade the current system refuses to make and the direct cause of PF 0.81.

---

## 6. Overfitting & Failure Risks

1. **P1 (exit re-tune) risks:** (a) fitting retention/trail parameters to one regime's MFE distribution — mitigate with purged walk-forward over ≥ 6 months and parameter neighborhoods (accept only plateaus, not point optima); (b) partial exits interact with the currency-exposure guard and min-lot floors (0.2-lot PAPER product minimum, `position-sizing.service.ts:135`) — at small account sizes a 50% scale-out may round to zero; (c) higher avg win ⇒ longer hold ⇒ more swap and overnight gap exposure — add swap-aware cost to the audit (today PAPER swap ≡ 0).
2. **P2 (cost geometry) risks:** raising stop floors widens per-trade risk in price terms; the RiskService per-trade risk % gate still binds (2% default), so lots shrink — net effect must be verified as risk-neutral in R terms, not just pip terms. Over-widening stops in genuinely low-volatility regimes converts cost savings into worse R multiples if ATR mean-reverts upward.
3. **P5 (drift refresh) risks:** a rolling envelope re-fitted during a quiet month will classify normal volatility as OOD again (the current failure mode) or — worse — widen bands during a crisis. Mitigations: hard bands pinned at P0.5/P99.5 of a ≥ 90-day window; envelope changes require a 2-window stability check; the stressed→meta-feature conversion must never feed back into the scorer before calibration evidence exists.
4. **P6 (meta-labeling) risks:** the shadow-outcome ledger is path-dependent (72-bar first-hit resolution, ambiguous same-bar cases) — label noise; the ledger over-represents regimes that produced shadow episodes (selection effect); disagreement features leak the ensemble's own biases. Mitigations: use the exporter's de-overlapped episode construction (`export-side-selection-three-class-dataset.cjs:289-329`), purge/embargo by horizon, and require out-of-sample *economic* superiority, not accuracy (P8 gate).
5. **P3 (calibration) risks:** empirical-Bayes shrinkage with prior weight 8 is biased toward 0.5 in sparse buckets; re-keying consumers mid-flight can silently change sizing if tiers are moved before probabilities stabilize. Mitigation: dual-run telemetry (old + new tier computed side-by-side, alert on divergence > 1 tier) for 2 weeks before cutover.
6. **General:** every proposal here can overfit through the *evaluation* itself — repeated peeking at staging aggregates is multiple testing on the same 588 trades. The scenario numbers in this report are priors, not evidence; chapter 7's protocol (pre-registered metrics, untouched holdout, DSR/PBO gates) is the acceptance bar. Nothing in this report should be promoted on the strength of this document alone.

---

## 7. Walk-Forward / Out-of-Sample Validation (what exists, what was run, what is required)

**What exists in-repo (verified):**

- Purged expanding walk-forward (5 folds, purge = embargo = horizon) — `services/ai-engine/app/domain/training/validation.py:48-170`.
- Nested hyper-parameter/threshold selection with 3 purges; outer validation used for scoring only — `model_qualification.py:3086-3166`.
- Untouched final 20% holdout gate required after the research gate — `run_first_six_pair.py:181-295`.
- Side-selection three-class: 3-fold walk-forward, holdout PF 1.436 PASS / BA 0.363 FAIL → correctly NOT promoted — `docs/research/2026-11-02-side-selection-three-class-results.md`.
- Deterministic ensemble: folds 4–5 untouched; strategy screen PF ≥ 1.02 on ≥ 150 dev signals — `deterministic_strategy_ensemble.py:10-12, 219-224`.

**What was run in this review:** No new model was trained and no new walk-forward was executed — this review environment has no staging DB or training corpus access, and fabricating one would violate the evidence standard. Instead this review delivers: (a) the analytic decomposition of the provided staging aggregate (companion doc), (b) four SQL tools that reproduce every number cited here directly from staging, and (c) the pre-registered validation protocol below.

**Pre-registered protocol required before any P1–P6 promotion (acceptance bar):**

1. **Dataset:** ≥ 6 months of `trading.trades` (executed) + shadow-resolved decisions (ledger), de-overlapped per instrument-minute; segment by model/route/instrument/side/regime/close-reason/cohort per the brief.
2. **Split:** walk-forward with 6 folds, purge = embargo = max(horizon, 1 day) — the 1-day embargo closes the autocorrelation gap identified in F8.
3. **Metrics (all pre-registered):** net expectancy per trade (after 1.25×P90 spread model), PF, avg win/loss, max drawdown, trade frequency, and the P1-specific MFE-conditional exit curves. Classification metrics (accuracy/Brier) are reported but **cannot justify promotion**.
4. **Multiple-testing control:** every hyper-parameter trial logged in the trial ledger; report DSR (from `robustness_audit.py` utilities + ledger) and PBO via CSCV over the fold matrix. Accept only DSR > 0 and PBO ≤ 0.5.
5. **Cost stress:** re-run the winning configuration at 1.0×, 1.5×, and 2.0× the P90 spread model; the config must remain net-positive at 1.5×.
6. **Holdout:** final untouched 20% window evaluated exactly once, after all decisions are frozen.
7. **Shadow confirmation:** 4+ weeks of DEMO shadow with live spreads before any authority change; DEMO A/B requires ≥ 100 trades per arm or 8 weeks, whichever is later.

---

## 8. Rollout Posture per Proposal

| Proposal | Posture now | DEMO gate condition | LIVE condition |
|---|---|---|---|
| P1 exit re-tune | Offline audit + shadow replay (`paper-payoff-shadow-audit` grid) — **no behavior change** | DEMO A/B per §7-7 with net expectancy + PF improvement and no DD regression | Only after two consecutive successful DEMO windows; final risk gates untouched |
| P2 cost geometry | Shadow computation + telemetry only | DEMO-only enforcement after 4 weeks shadow | Same as P1 |
| P3 calibrated surface | Report-only dual-run telemetry | Re-key one consumer at a time after 2 weeks divergence-free | Same |
| P4 blocker dedup | (a) safe now; (b)/(c) behind flags, default off | After blocker-frequency telemetry stabilizes | N/A (mostly telemetry) |
| P5 drift refresh | Shadow-only (telemetry + counterfactual report) | Only if DRIFT-blocked counterfactuals prove net-positive continued episodes | Hard-band veto preserved forever |
| P6 meta-filter | Offline study → its own shadow artifact | Per §7 acceptance (DSR/PBO + economics) | Same as P1 |
| P7 ET freeze | Immediately (no behavior change; already promotion-blocked) | Re-arm via ledger rule only | ET stays promotion-blocked until ledger-qualified |
| P8 promotion scorecard | Implement now (gate code only, `approved_for_live` untouched) | — | — |
| P9 data resilience | Implement now (backfill + telemetry; no gate weakening) | — | — |
| P10 hygiene | Implement now except (a) — trailing-stop decision needs product input | — | — |

**Non-negotiables preserved throughout:** `risk.service.ts` pipeline (daily loss 5% of session opening balance, max DD 10%, per-trade risk 2%, leverage ≤ 30, mandatory SL/TP, kill switch, fail-closed authority binding), `final-dispatch-boundary.ts` commitment chain, market-safety gate (30 s quote age / 2% spread ratio / 1% deviation), and the currency-exposure guard (2%/3%). No proposal lowers any safety threshold; P2 *raises* an effective entry requirement; P6 *removes* trades; P1 changes only post-entry management of already-admitted, already-risk-gated positions.

---

## 9. Required Tests & Telemetry

**Tests (add with each implementation PR):**

1. P1: unit tests for the new lock-policy function (arm floors, retention curve, partial-exit sizing vs min-lot); regression test that SL/mandatory-TP invariants and `TradeCloseReason` mapping are unchanged; property test that no policy closes below the protected floor it promises.
2. P2: golden tests for `costBreakEvenStop` across the 6 pairs and ATR quantiles; test that RiskService per-trade risk % still binds after geometry change.
3. P3: calibration determinism tests (same ledger → same probability), divergence-alert test for dual-run telemetry.
4. P4: snapshot tests of emitted blocker sets (before/after dedup) on fixture decisions; the ET-floor test that currently would catch the 0.2→0.08 downgrade.
5. P5: envelope-refresh determinism, P0.5/P99.5 pinning, stressed-score monotonicity.
6. P6: leakage tests (no feature computed after `evaluatedAt`), purge/embargo verification, economics-gate rejection tests.
7. P9: backfill idempotency, rate-limit compliance (≤ 5 historical req/s), per-TF telemetry presence.
8. All: `bun run lint` / existing jest suites green; no migration touching `trading.trades` columns without a down-migration.

**Telemetry (new):**

- `exit_policy_audit` weekly artifact: counterfactual distribution (TP_FIRST/SL_FIRST/NEITHER_4H/DATA_GAP) per route × retention tier (SQL companion #2).
- `blocker_root_cause` histogram + co-occurrence matrix (SQL companion #3) — target: ≥ 90% of decisions with exactly one primary cause.
- `costR` distribution per route/ATR bucket (SQL companion #1 §4) — target: P90 ≤ 0.10R on admitted trades.
- Reliability/Brier per route (10 bins, refreshed daily) from the shadow ledger.
- Drift per-feature breach rates + DRIFT-blocked-episode counterfactual outcomes (feeds P5's gate).
- Collector per-(instrument, timeframe) `lastSuccessfulCollectAt` + gap-repair counters (P9).

---

## 10. Ranked Recommendations (by expected impact on profitability)

1. **P1 — Re-tune the exit engine from MAE/MFE + counterfactual evidence** (partial scale-out at ~1R + ATR trail; retire the fixed retention ladder). The single change that moves PF from 0.81 toward ≥ 1.0 without touching admission. *Posture: offline → shadow → DEMO A/B.*
2. **P2 — Fix M1 cost geometry** (cost-break-even stop floor; prefer M5-anchored geometry for strong-HTF continuations). Converts the silent cost-doom failure mode into explicit admission. *Posture: shadow → DEMO.*
3. **P6 — Meta-labeling loss filter** on the existing shadow ledger (filter bottom-decile P(win); scale size within existing clamps). *Posture: offline → shadow artifact → DEMO after DSR/PBO + economics gates.*
4. **P3 — One calibrated probability surface**; re-key dead consumers (sizing tiers, M5-handoff bar, bootstrap window). *Posture: report-only → staged consumer re-keying.*
5. **P4 — Root-cause blocker attribution; fix the ET-floor override and the "net"-floor naming**. Cheap, high diagnostic value; unlocks everything else. *Posture: (a) now; (b)/(c) flagged.*
6. **P5 — Drift envelope refresh + stressed-as-meta-feature**, gated by the DRIFT-blocked counterfactual study. *Posture: shadow until proven.*
7. **P9 — Market-data gap backfill + collector telemetry** (fixes the readiness-starvation class without touching fail-closed states). *Posture: now.*
8. **P8 — Economics-first promotion scorecard with enforced trial ledger (DSR) and PBO**. Protects every future model decision. *Posture: now (gate code only).*
9. **P7 — Keep early-transition shadow-only; add ledger lineage + data-driven re-arm rule**. Stops speculative spend; preserves the research lane.
10. **P10 — Hygiene: trailing-stop decision, TIME_TO_WORK taxonomy, dead-code removal, runtime reliability monitor, counterfactual weekly report**.

**Explicitly rejected approaches** (per the brief's constraints and the evidence): lowering any admission/confidence/expectancy threshold to raise activity; weakening the fail-closed broker-readiness states; touching `risk.service.ts` or `final-dispatch-boundary.ts` semantics; promoting any model on classification metrics; changing direction authority of the trained challenger (it remains `execution_authority: 'NONE'`, unanimous-3-of-3, 0.55 opportunity floor — `high_conviction_challenger.py:183-189`).

---

## Appendix A — Commits for ChatGPT/OpenAI to review

See the final commit list in the handover section of this branch (also reproduced in the chat handover). This branch contains **no** changes to: `apps/api/src/modules/risk/**`, `apps/api/src/modules/execution/**` (except none), `apps/api/src/modules/ai/**` production logic, `services/ai-engine/**` model logic. All additions are under `docs/research/` and `scripts/research/` plus this report.

## Appendix B — Reproducibility

All quantitative statements derive from either (a) the staging aggregate supplied in the review brief (reproduced verbatim in the companion doc) or (b) file:line-cited code in this repository at commit `c2dc177f`. The four SQL companions re-derive every staging-dependent number independently. Scenario tables are analytic models with stated assumptions — they are priors for the §7 protocol, not results.
