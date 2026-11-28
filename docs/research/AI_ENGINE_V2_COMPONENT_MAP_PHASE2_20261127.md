# iRexPro AI Engine V2 — engine component map, phase 2

Status: research-only continuation of
`AI_ENGINE_V2_COMPONENT_MAP_20261127.md` (backlog item **P1-0**, delivered
on PR #846's branch). This phase-2 map is backlog item **P1-0.5** (see
`AI_ENGINE_V2_EXECUTION_BACKLOG_EXTENSION_20261127.md`) and covers exactly
the three areas map v1 named but did not itemize: the **Python ML core**
(v1 §0 row "Python engine"), the **orchestration scan-cycle internals**
(v1 §0 row L5), and the **cross-layer data-flow edges**. Section numbering
continues the v1 map (which ended at §11); §16 is the drift record, §17
re-states boundaries. No runtime edit, no model or threshold change, no DB
or broker access, no deployment; deployment hold intact.
`executionAuthority: NONE`.

Method: every path, line anchor and count below was re-verified by direct
file reads and `grep`/`wc -l` on this branch's tree (base `main` @
`80c316fe`, V2 delta `6407c1c6`). Line anchors are current for this tree;
per the v1 convention the CI detectors re-verify **paths and content
anchors, never line numbers**, and §16 records the re-verification against
today's `main` @ `2f59fc74`. The machine-readable mirror
`apps/api/scripts/research/v2-engine-component-map-phase2.cjs` (47
components across 10 families) is validated by
`v2-engine-component-map-phase2.test.cjs` in CI.

Companion artifacts: map v1 (P1-0), audit findings, challenger
architecture, execution backlog + this extension.

---

## 12. Python ML core deep map (L4/P)

Service root `services/ai-engine/` (220 tracked files). FastAPI,
signals-only service; the TS side reaches it exclusively through
`ai-engine-client` (§14, edge E1).

### 12.1 Service assembly

| Component | File (verified) | Anchors (verified) |
| --- | --- | --- |
| FastAPI app factory | `app/main.py` (111 lines) | `app = FastAPI(...)` l.79; six routers mounted l.101-106 in fixed order health → signals → market_data → models → scheduler → backtests; module-level `app = create_app()` l.111 |
| Route: health | `app/api/v1/routes/health.py` (35) | liveness/readiness surface |
| Route: signals | `app/api/v1/routes/signals.py` (116) | signal generation entry consumed by the collector |
| Route: market data | `app/api/v1/routes/market_data.py` (28) | OHLCV passthrough |
| Route: models | `app/api/v1/routes/models.py` (453) | `/models/active`, `/models/challengers/plan-b-v4/*`, `/models/challengers/plan-b-v85/*` — the endpoints the TS client actually calls (E1) |
| Route: scheduler | `app/api/v1/routes/scheduler.py` (198) | session start/stop surface |
| Route: backtests | `app/api/v1/routes/backtests.py` (97) | offline backtest trigger |

### 12.2 Model layer (`app/domain/models/`, 8 modules)

| Module | Lines | Role (verified) |
| --- | --- | --- |
| `baseline_xgboost.py` | 897 | active Champion-shaped model; carries the duplicated regime-threshold block at l.540-549 (audit A5, same thresholds as `high_conviction_challenger.py:317-325`) |
| `high_conviction_challenger.py` | 345 | shadow challenger Plan-B V4; scored via `/models/challengers/plan-b-v4/score-broker` |
| `post_entry_protection_challenger.py` | 209 | shadow challenger Plan-B V85; scored via `/models/challengers/plan-b-v85/score-broker-checkpoint` |
| `multitimeframe_features.py` | 344 | the 128-column MTF feature contract, verified by execution in map v1 |
| `registry.py` | 108 | `class ModelRegistry` l.24; `register_model()` l.32 requires a governance record; `build_default_registry()` l.90 registers an explicit heuristic scaffold when no verified trained artifact is configured (dev paper mode only) |
| `governance.py` | 78 | model governance metadata record type |
| `feature_engineering.py` | 187 | feature transforms shared by trainers |
| `schemas.py` | 46 | wire schemas for model payloads |

### 12.3 Signals layer (`app/domain/signals/`)

| Module | Lines | Role |
| --- | --- | --- |
| `signal_generator.py` | 420 | composes model output into `AiSignalCandidate`-shaped signals |
| `confidence.py` | 14 | confidence helpers (thin; the heavy confidence transforms live on the TS side, audit B1) |
| `explainability.py` | 31 | reason-code assembly |
| `schemas.py` | 112 | signal wire schemas |

### 12.4 Scheduler layer (`app/domain/scheduler/signal_scheduler.py`, 482 lines)

`PendingHorizonExit` l.35; `ScheduledSessionJob` l.46; `class SignalScheduler`
l.86; `register_session()` l.122; `unregister_session()` l.213;
`_get_signal_generator()` l.227; `_run_session_job()` l.240 — the Python
side schedules per registered trading session; the authoritative DEMO/LIVE
decision cycle is the TS `M1TacticalSchedulerService` (§13).

### 12.5 Agents layer (`app/domain/agents/`, 1,717 lines total)

`coordinator.py` (121), `context_service.py` (156), `context_sources.py`
(199), `macro_context.py` (294), `snapshot.py` (105), `schemas.py` (130),
providers: `bls_calendar.py` (285), `bls_historical_schedule.py` (360).
Context/agent assembly for macro and calendar context; BLS feed is a
research/data surface, not an execution input.

### 12.6 Backtesting layer (`app/domain/backtesting/`, 756 lines)

`backtest_engine.py` (167), `trade_simulator.py` (209), `metrics.py` (111),
`report_builder.py` (64), `validation.py` (53), `schemas.py` (152).
Offline-only; feeds `/backtests` route; not connected to the DEMO/LIVE
decision path.

### 12.7 Market-data layer (`app/domain/market_data/`, 770 lines)

`ohlcv_service.py` (238), `redis_cache.py` (103), `schemas.py` (49),
providers: `base.py` (36), `broker_provider.py` (224), `mock_provider.py`
(118). Mirror of the TS market-data layer for Python-side research; the
authoritative candle store is the TS `provider-quote-candle-store` (map v1
§8).

### 12.8 Training domain inventory (`app/domain/training/`)

Verified by directory listing: **73 `.py` files + 7 `.sql` readonly probes =
80 entries; of the `.py`, 6 are committed `test_*.py` suites → 67
research/ops scripts.** This refines the audit's "~30 fenced research
families" (A5/D-series) into an exact taxonomy:

| Family (prefix) | Count | Examples / notes |
| --- | --- | --- |
| `single_pair_v10..v39` series | 30 | the version-treadmill core (v32-v39 alone: 296-457 lines each); largest dead-candidate block for P1-6 |
| `six_pair_*` | 6 | `opportunity_selector` (410), v73 profitability router, v74 micro-EV + quote routers, v75 specialists + sleeve routers |
| `demo_*` shadow/audit scripts | 9 | near-miss, first-hit temporal selector, first-touch horizon, net-alpha challenger, two-pair horizon audit, planb temporal challenger, rejected-entry/rejected-first-hit shadows (+ paired `.sql` probes) |
| `ood_*` | 2 (+2 `.sql`) | shadow candidate + six-pair cohort |
| data collection / import | 4 | `collect_dukascopy`, `collect_historical`, `collect_bls_historical_context`, `import_histdata_ticks` |
| training/qualification core | 12 | `train_xgboost` (270), `train_multitimeframe` (1,481), `train_final_multitimeframe` (503), `train_final_event_pair_bundle` (888), `model_qualification`, `bounded_final_campaign`, `qualification_diagnostics`, `robustness_audit`, `validation`, `dataset_builder`, `single_pair_qualification`, `single_pair_final_test` |
| export bundles | 2 | USDJPY qualified payoff-risk + research hybrid bundles |
| other studies | 8 | `adaptive_throttle`, `agent_context_evaluation`, `backtest_placeholder`, `m1_materialized_cache`, `multitimeframe_corpus`, `run_bls_context_overlay_study`, `run_first_six_pair`, `zai_economics_first_gate`, `side_selection_three_class`, `deterministic_strategy_ensemble`, `v10_robustness_report`, `v11_calibrated_opportunity` (counted within the 67) |

`CONFIDENCE_FLOOR = 0.60` lives in 5 of these modules (map v1 §6, B5);
the 6th copy is the TS orchestrator constant. Early-stop == reported-set
in `train_xgboost.py` (audit D-series) remains the training-integrity
finding this inventory feeds into P1-6.

## 13. Orchestration scan-cycle internals (L5, TS)

| Component | File | Anchors (verified) |
| --- | --- | --- |
| M1 tactical scheduler | `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts` (4,871) | `export class M1TacticalSchedulerService` l.789; `onModuleInit` l.823; `getStatus` l.850; **`runOnce` l.959 → `observeOpenPositionRescueShadow` l.4652: the whole scan → decide → dispatch cycle is ONE method of ≈ 3,693 lines**; rescue-shadow recorders l.4652/l.4693; private helpers from l.4853 |
| Strategy orchestrator | `apps/api/src/modules/strategy/strategy-orchestrator.service.ts` (1,536) | `processSignal` l.181; `rebaseResearchPaperWorkflowProbe` l.1068; `ensureLiveSizingSnapshotFresh` l.1169; `recordTradeIntent` l.1216; `recoverDuplicateOutcome` l.1327; `validateStructure` l.1448; `recordIgnored` l.1463 |
| VPS signal collector | `apps/api/src/modules/ai/vps-forex-signal-collector.service.ts` (7,283) | class l.1045; `onModuleInit` l.1152; `getStatus` l.1272; `maybeCollect` l.1526; `collectOnce` l.1587 — upstream ingest cadence |
| Evidence service | `apps/api/src/modules/ai/m1-tactical-evidence.service.ts` (3,013) | cohort SQL over `trading.trading_sessions` l.479 and `trading.m1_tactical_decisions` l.491; per-route counters `route <> 'ABSTAIN'`, `execution_authority = 'BROKER_NATIVE'`, `outcome_state` l.566-573; settled-trade join `trading.trades` l.664 with sizing from `trading.capital_allocations` l.677 |

The single-method `runOnce` span (≈ 3,693 lines) is the structural fact
P1-3 must consume: reliability gates (map v1 §3) are invoked from inside
one monolithic method, so "one reliability service" requires defining
extraction seams first. The phase-2 mirror asserts the span stays ≥ 3,000
lines as a regression tripwire — when it shrinks (someone refactored), the
P1-3 inputs are stale and the detector refuses.

## 14. Cross-layer data-flow edges (verified by content anchors)

- **E1 — TS → Python (score requests).** `ai-engine-client.service.ts`
  default base URL `http://localhost:8001/api/v1` (l.152); calls exactly
  five endpoints (l.220-269): `GET /models/active`, `GET
  /models/challengers/plan-b-v4/status`, `POST
  /models/challengers/plan-b-v4/score-broker`, `GET
  /models/challengers/plan-b-v85/status`, `POST
  /models/challengers/plan-b-v85/score-broker-checkpoint`. The Python
  surface consumed by the runtime is therefore the models router (§12.1,
  453 lines) — nothing else in the Python API is on the DEMO/LIVE decision
  path.
- **E2 — Evidence persistence (decisions → tables).**
  `m1-tactical-evidence.service.ts` reads/writes `trading.trading_sessions`,
  `trading.m1_tactical_decisions` (columns `route`,
  `execution_authority`, `outcome_state`), `trading.trades`,
  `trading.capital_allocations` (l.479-677). These four tables are the
  canonical decision/evidence store the V2 attribution ledger (P0-3) must
  stay disjoint from.
- **E3 — Candle path.** `market-data.service.ts` (`priceDigits = 10`,
  l.97) → `provider-quote-candle-store.service.ts` (MetaApi 30-second
  snapshot bars, map v1 §8) → `m1-tactical-features.ts` (502-line TS
  feature contract) → candidate/route/governance (map v1 §1-§4) →
  scheduler dispatch (§13) → evidence (E2) → exit engines (map v1 §5).
- **E4 — Exit write path.** Exit engines X1-X6 (map v1 §5) consume the
  settled evidence produced by the same scheduler cycle they protect —
  the exit-side economics loop (G1) closes inside one `runOnce` invocation.

## 15. Phase-2 mirror contract

`v2-engine-component-map-phase2.cjs` exports the 47-component inventory,
`validatePhase2ComponentMap`, `verifyPhase2ComponentPaths`,
`verifyPythonTrainingInventory`, `verifyOrchestrationAnchors`,
`verifyEngineClientEdge`, `verifyEvidenceEdge`, and
`summarizePhase2Map`. Typed refusal codes:
`PHASE2_COMPONENT_PATH_MISSING`, `PHASE2_INVENTORY_INVALID`,
`PHASE2_TRAINING_INVENTORY_MISMATCH`, `PHASE2_RUNONCE_SPAN_REGRESSION`,
`PHASE2_ENGINE_CLIENT_EDGE_DRIFT`, `PHASE2_EVIDENCE_EDGE_DRIFT`. The test
suite (14 tests) proves: inventory validity + family reconciliation (47
components; families `python-app` 1 / `python-api` 6 / `python-models` 8 /
`python-signals` 4 / `python-scheduler` 1 / `python-agents` 8 /
`python-backtesting` 6 / `python-market-data` 6 / `orchestration` 5 /
`data-edge` 2); path existence; training inventory 67/6/7; `runOnce`
span ≥ 3,000; all five engine-client endpoints + base URL present; all
four evidence tables present; and that tampering with the inventory
(unknown family, unknown layer, duplicate key, missing path, malformed
constants) is a typed refusal.

## 16. Drift record

- Branch tree `6407c1c6`: map v1 detector 11/11 pass; phase-2 mirror
  14/14 pass.
- `main` @ `2f59fc74` (worktree check, 2026-11-27): map v1 detector
  **11/11 pass — zero drift** after today's merge (#851). Phase-2 anchors
  were collected from the branch tree; §12-§14 line anchors are current
  for `6407c1c6` and re-verified by content (not line) checks, so they
  survive the `80c316fe → 2f59fc74` advance (the two merged commits touch
  accounting/reconciliation, not any mapped path).

## 17. Boundaries

Research-only: no runtime import, no production data, no broker access,
no deployment; the Champion is untouched. All counts and anchors above are
verified on this branch's tree; the executable mirror re-verifies paths,
content anchors, the `runOnce` span, the training inventory and both
edges in CI on every run. Nothing here grants order authority:
`executionAuthority: NONE`.
