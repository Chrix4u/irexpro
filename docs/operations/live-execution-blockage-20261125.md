# LIVE execution blockage investigation — November 25, 2026

Scope: the November 25, 2026 14:03–23:01 GMT LIVE window (4,269 evaluations,
zero trades). Repository revision under review: PR #810 head `b8c4550`
(production `88d7ad4e`, qualification gateway `79ebdcef`, expert-research
integration PR #813 `1ecba8de`). This investigation is broker-disconnected:
no broker session was opened, no production database was read or changed, no
real-money route was enabled, and the deployment hold
(`DEPLOY-HOLD-ACTIVE-BROKER-20261122.txt`) remains untouched.

## 1. Recorded-counter reconciliation

Each operator counter maps to exactly one originating component and one
upstream boolean. The counters overlap because the same boolean is recorded
under multiple names at successive layers:

| Recorded counter | Originating component | Upstream condition |
| --- | --- | --- |
| 4,269 evaluations | M1 tactical scheduler per-candidate evaluation | — |
| 4,264 without execution authority | `evaluateMultimodelAuthority` (`authority.executable === false`) | any authority blocker |
| 4,145 model governance blocks | `evaluateM1TacticalGovernance` / `evaluateEnsembleGovernance` | non-empty governance blockers |
| 4,139 Plan B admission failures | `evaluateMultimodelAuthority` → `MULTIMODEL_PLAN_B_NOT_ADMITTED` | `ensemble.paperAdmitted === false` |
| 4,139 ensemble paper admission failures | `evaluateEnsembleGovernance` → `ENSEMBLE_NOT_PAPER_ADMITTED` | same `ensemble.paperAdmitted === false` boolean |
| 4,138 ensemble promotion admission failures | `evaluateEnsembleGovernance` → `ENSEMBLE_NOT_PROMOTABLE_ADMISSION` / `ENSEMBLE_NOT_ADMITTED` | same boolean, minus EARLY_TRANSITION-route cases (PAPER-only by policy) |
| 3,645 out-of-distribution drift flags | `evaluateEnsembleGovernance.driftOf` → `DRIFT_OUT_OF_DISTRIBUTION` | feature vector outside the drift envelope |
| 5 stop-distance risk rejections | `RiskService.checkStopLossDistance` → `INVALID_SL_DISTANCE` | measured absolute stop distance < 5 pips |

Arithmetic checks:

- 4,269 − 4,264 = **5** — exactly the five evaluations that carried full
  execution authority and were rejected later by the stop-distance risk gate.
- 4,139 = 4,139 — Plan B admission and ensemble paper admission are the same
  `paperAdmitted` boolean observed at two layers (authority wrapper +
  governance blockers).
- 4,139 − 4,138 = **1** — one EARLY_TRANSITION-route evaluation: the
  promotion counter deliberately omits `ENSEMBLE_NOT_PROMOTABLE_ADMISSION`
  for that route because early transitions are PAPER-only by policy, not
  failed promotions.
- 4,145 − 4,139 = **6** — evaluations governance blocked for drift, spread,
  sleeve or event-risk reasons while admission itself had passed.
- 3,645 OOD flags are a strict subset of the 4,145 governance blocks, not an
  independent cause.

One failed admission therefore records the same boolean as up to **five**
distinct reason strings (`ENSEMBLE_NOT_PAPER_ADMITTED`,
`ENSEMBLE_NOT_PROMOTABLE_ADMISSION`, `ENSEMBLE_NOT_ADMITTED`,
`MULTIMODEL_PLAN_B_NOT_ADMITTED`, `MULTIMODEL_GOVERNANCE_BLOCKED` + wrapped
copies). Pinned by
`apps/api/src/modules/ai/ensemble-governance.counter-overlap.spec.ts`.

## 2. Root-cause findings

### RC-1 — The 97% admission-failure rate is structural abstention, not data corruption

`scorePlanBMultimodelShadow` requires the 6-of-7 consensus, `meta.admitted`,
route-specific `expectedR` floors and a regime of TREND_HEALTHY /
REVERSAL_CONFIRMED / TRANSITION_EARLY. When the reversal is NOT confirmed
(momentum outside 0.5–1.5 ATR), a TREND_WEAK context is not
admission-eligible — and simultaneously fails the continuation drift
envelope: the Plan-B `emaSeparation` of a flat market sits below the
continuation hard floor (0.050248), producing `DRIFT_OUT_OF_DISTRIBUTION`.
The drift flag and the admission failure therefore move together because
they share upstream geometry.

Demonstrated by the broker-disconnected replay
(`apps/api/src/modules/ai/qualification-gates-replay.spec.ts`): one synthetic
fixture family, varying only the final-bar impulse, reproduces (a) full
qualification (`REVERSAL_CONFIRMED`, paper-admitted, drift NORMAL,
`PRIMARY_PLAN_B` authority, executable), (b) the recorded admission+OOD
overlap pattern, (c) counter-M15 `mtfStrength:HARD_LOW` OOD, and (d)
over-impulse `extensionAtr:HARD_HIGH` OOD. No data defect is required to
produce the recorded rates; conversely, none of these are evidence of
genuine live-market conditions either — they characterize the gates.

### RC-2 — The five stop-distance rejections are the LIVE absolute-geometry gate working as designed

The model stop distance is already floored at five pips
(`max(1.1 × ATR14, 5 pips)` in `m1-tactical-candidate.ts`). LIVE validates
**absolute** geometry against the fresh executable quote at dispatch; DEMO
**rebases** the model geometry onto the fresh quote first
(`DEMO_MARKET_GEOMETRY:REBASED`, `rebaseModelMarketGeometry`). Quote movement
between the closed-bar reference and dispatch shortened the measured distance
below the minimum. Reproduced exactly, broker-disconnected, in
`risk.service.spec.ts` ("recorded LIVE stop-distance geometry"): a 5.0-pip
model stop measured 4.4 / 3.6 / 4.1 pips on a drifted quote rejects with the
precise typed reason `Stop-loss distance 4.4 pips is below minimum 5 pips
for EURUSD`, while the same geometry on the DEMO path rebases to exactly 5.0
pips and approves. Migrating LIVE to rebased geometry is a runtime behavior
change and is intentionally NOT made here; it stays subject to the parity
acceptance criteria in `docs/operations/demo-live-execution-parity.md`.

### RC-3 — Duplicated rejection recording (defect class: observability)

Pinned as RC-1/§1. This is not a safety defect — every duplicate is
fail-closed — but it misleads operators into counting independent causes.
The layered checks remain mandatory; only the *interpretation* is corrected
here.

### RC-4 — Lagging native M5/M15 context can never be repaired from live samples (availability limitation, deliberately not corrected)

When direct native M5/M15 history lags more than one full timeframe, the
store's M1-fill path requires full-minute provenance
(`firstSampleAt <= barOpen && lastSampleAt >= barOpen + 59s`). A live
tick-sampled minute always has `firstSampleAt > barOpen`, so it can never
extend lagging native context; the pair fails closed with
`BROKER_M5_CONTEXT_STALE` / `BROKER_M15_CONTEXT_STALE`. This is deliberate
evidence protection (no unverified midpoint ticks may patch broker-native
history — see `provider-quote-candle-store.service.ts`), not corruption.
Pinned by `provider-quote-candle-store.live-fill.spec.ts`. Relaxing it would
change evidence quality and is out of scope for a behavior-preserving
correction.

### RC-5 — No demonstrated market-data integrity defect

Audit results (code review + existing and new specs, all broker-disconnected):

- Candle construction: UTC minute buckets, midpoint OHLC from bid/ask
  samples, later-quote close semantics, positive-spread preservation, no
  fabricated history (`provider-quote-candle-store.service.spec.ts`,
  `.ctrader.spec.ts`).
- Timestamps: completed-bar causality bound to decision time
  (`bucket_time + timeframe <= decisionTime`), M1 close age ≤ 90 s, M5 ≤ 10
  min, M15 ≤ 20 min, minute-grid validation with documented no-tick carry.
- Feature normalization: ATR/RSI/EMA/alignment finite-checks fail closed;
  `volatilityScore` is price-relative; drift-envelope inputs use the
  documented Plan-B scale (the historical raw-EMA bug is already fixed in
  `m1-tactical-governance.ts`).
- Model artifact compatibility: all layers pin
  `plan-b-multimodel-shadow-v4`, `ensemble-governance-v3`,
  `m1-tactical-features-v1`, `m1-tactical-v2-m5-lifecycle`; policy-version
  mismatches are explicit blockers (`M1_POLICY_MISMATCH`).

**Operator action to close the residual question**: decompose the persisted
`driftDiagnostics` / `driftDiagnosticsAtDecision` for the 3,645 OOD records
in `m1_tactical_decisions` by feature diagnostic
(`mtfStrength:HARD_LOW` vs `extensionAtr:HARD_HIGH` vs …). That classifies
the window's abstention into counter-trend proposals, over-extended trends
and rollover/volatility regimes from real evidence. This investigation could
not do so because the production database was not accessed.

## 3. DEMO/LIVE architecture review (continuation of PR #810)

- Shared model identity: `PRIMARY_M1_MODEL_IDENTITY` and
  `EXTERNAL_IREXPRO_STRATEGY_CODES` are the single registry consumed by
  signal production, orchestrator admission, evidence SQL and the DEMO
  drawdown guard. No strategy-code string literal is duplicated between
  DEMO and LIVE admission paths (verified by review of PR #810 diffs).
- Shared decision calculations: features, candidates, Plan-B scoring,
  ensemble governance and multimodel authority are one code path for both
  accounts; the scheduler's only account-specific branch is the market-data
  source (`requireExecutionBrokerSource` for FULL_AUTO). The remaining
  intentional divergence is the geometry policy (RC-2) and the account
  admission boundary (below).
- Account-specific boundaries, documented separately from strategy
  qualification: broker certification (`pepperstone-ctrader`, provider
  identity `pepperstone`, `isProductionLiveEligible`), connection status
  CONNECTED/ACTIVE, `liveTradingEnabled`, FULL_AUTO session binding, exact
  connection binding, account snapshot freshness (30 s), margin and
  financial risk limits, mandatory SL/TP direction and minimum distances,
  idempotency and protective-order atomicity. None were relaxed.
- Geometry difference evaluated broker-disconnected only (RC-2). LIVE
  execution authority was not changed.

## 4. Individual expert research (PR #813)

- Merge compatibility with PR #810: `git merge-tree` clean; the combined
  tree passes the targeted suites (69 jest tests incl.
  `high-conviction-overlay.spec.ts`) and the standalone
  `node --test` expert suites (10 tests).
- Recorder: `captureExpertResearchEvidence` accepts only the exact
  three-expert artifact, validates every per-expert field, and cross-checks
  individual predictions against the aggregate `long_votes`/`short_votes`
  — individual predictions are never inferred from aggregates; any mismatch
  voids the evidence (`modifiesExecution: false` throughout).
- Offline evaluator: bounded input (≤ 100,000 observations), unique sample
  IDs, fixed-horizon UTC labels, descriptive statistics only
  (accuracy, balanced accuracy, Brier score, calibration bins, pairwise
  error correlation) with explicit limitations; absent outcome classes
  degrade to `null` instead of invented values.
- Provenance: `docs/research/OFFLINE_EXPERT_EVIDENCE_CONTRACT.md` requires
  independently generated predeclared labels and quarantines timestamp
  discrepancies. No dataset was available in this environment, so no
  prediction-accuracy numbers are reported — none were invented.

## 5. Verification (broker-disconnected)

- `tsc --noEmit` clean; `eslint --fix` clean on all touched files.
- Full API suite: **503 suites passed, 2 skipped (real-PG integration
  requires a database), 7,041 tests passed, 0 failures** (13 skipped are the
  same PG-gated cases).
- New regression evidence added by this investigation (18 tests):
  - `qualification-gates-replay.spec.ts` — 6 tests (end-to-end gate replay).
  - `ensemble-governance.counter-overlap.spec.ts` — 4 tests (counter
    semantics, EARLY_TRANSITION asymmetry, admission/drift independence).
  - `provider-quote-candle-store.live-fill.spec.ts` — 3 tests (M1-fill
    provenance boundary).
  - `risk.service.spec.ts` — 5 tests (recorded 4.4/3.6/4.1-pip LIVE
    rejections + DEMO rebase contrast).
- PR #813 standalone suites: 10/10 `node --test`.

## 6. Remaining limitations and unresolved certification requirements

1. Production-database evidence was not accessed: the counter decomposition
   of §1 is derived from code semantics plus the recorded totals; the
   drift-diagnostics breakdown (§ operator action) must be certified from
   `m1_tactical_decisions`.
2. The replay fixtures are synthetic characterizations of gate behavior —
   they are not recorded market data and establish nothing about real
   November 25 market conditions or profitability.
3. LIVE rebased geometry (parity with DEMO) remains an open runtime change
   gated by the parity acceptance criteria (offline replay, quiescent
   session, verified artifact, rollback, separate release approval).
4. The M5/M15 live-fill availability limitation (RC-4) remains by design;
   changing it requires a deliberate evidence-quality decision.
5. Real-PG integration suites (2 skipped) still require a properly
   configured disposable PostgreSQL environment (pgcrypto) for the final
   1-of-86 re-verification.
6. Compilation success, frequent DEMO executions, and this test evidence do
   NOT establish real-money readiness. The deployment hold stays active;
   no real-money execution route was enabled, no qualification requirement
   was bypassed, and no production database change was made.
