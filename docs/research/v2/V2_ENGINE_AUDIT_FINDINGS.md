# iRexPro AI V2 Research — Full-Engine Audit Findings

**Branch:** `research/ai-v2-challenger-architecture-20261127`
**Base:** `55c11626` (combined M1 research candidate, PRs #834/#836/#837/#838)
**Status:** research-only. No runtime import, no model change, no threshold change, no database access, no broker call, no execution or promotion authority. Deployment hold remains active.
**Method:** independent read-only audit of the entire AI engine (Python `services/ai-engine/`, NestJS `apps/api/src/modules/ai/` + `strategy/` + `execution/` + `risk/` + `market-data/` + `broker/`), the research corpus (`docs/research/`, 154 files), and the broker-confirmed economic evidence. Citations are file:line on this branch.

---

## 1. What the engine actually is (component inventory)

| Layer | Components | Scale |
|---|---|---|
| Python ML core | Plan-B v4 three-expert consensus challenger, baseline XGBoost wrapper (5 inference paths), MTF-128 feature contract, regime router, OOD shadows, candle-formation experts | ~8,100 LOC runtime; ~31,900 LOC `app/domain/training/` across 87 modules |
| TS decision layer | M1 tactical scheduler (4,871 lines), Plan-B multimodel shadow, v8 frozen logistic meta scorer, ensemble governance, ~40 named shadow observers, adaptive services | 298 files, ~84,000 LOC in `modules/ai/` alone |
| Strategy/execution/risk | orchestrator gate chain (25 gates), AI exit orchestrator, 5-second profit-protection sweep, Pepperstone net-profit lock, risk engine (14 validation steps), position sizing, qualification gateway | ~15,000 LOC across 5 modules |
| Market data | cTrader broker-native collector, live quote sampler, provider_quote_candles store, paper market cache, reconciliation | Postgres store + 3 collectors + 2 consumer paths |
| Research corpus | 154 research docs; 34 documented defects/incidents; 32 broker-confirmed economic cohorts | 364 docs total |

Two parallel decision lanes run in production: the **DEMO M1 lane** (`m1-tactical-scheduler.service.ts`) and the **PAPER ensemble lane** (`vps-forex-signal-collector.service.ts`, 7,283 lines). They share governance helpers but compute their own scores, geometries and evidence pools.

## 2. Broker-confirmed economic evidence (selected; full table in corpus)

| Cohort | n | Win rate | Net after cost | PF | Source |
|---|---:|---:|---:|---:|---|
| 04–09 Nov (old EUR DEMO) | 35 | 51.4% | −€22.42 | 0.751 | `IREXPRO_20261104_MODEL_LINEAGE_OLD_VS_NEW_BROKER_RESULTS.md` |
| 10–12 Nov (Pepperstone USD) | 44 | 38.6% | −$1,259.71 | 0.68 | `IREXPRO_20261112_ACTIVE_PLANB_USD_SLEEVES_AND_M1_TIMING_RESEARCH.md` |
| 16–19 Nov frozen audit | 121 | 50.4% | −$1,859.45 | **0.529** | `IREXPRO_AFTER_COST_PROFITABILITY_AND_CALIBRATION_BASELINE_20261119.md` |
| 17–20 Nov | 214 | 55.1% | −$2,288.29 | 0.6218 | `irexpro-owner-demo-initial-reward-vs-realized-payoff-20261120.md` |
| Whole account statement | 424 deals | — | **−$7,045.21** | — | `IREXPRO_RECONCILIATION_UNMATCHED_DEALS_AND_EVIDENCE_GAPS_20261125.md` |

**Exit-type R decomposition (17–20 Nov, 214 settled):** PROFIT_PROTECTION exits +0.4155R mean (107 exits, +$2,985); BROKER_CLOSE −0.8821R (69, −$3,497); 5m drawdown guard −0.7571R (31, −$1,464); other AI closes −0.6433R. All trades shared a uniform 1.6R design target. **The payoff distribution, not the win rate, is where expectancy dies.**

**Cost drag:** commissions ≈ 0.146–0.202R per trade; the modeled spread-only cost was ≈0.073R — a ~3× understatement (`2026-11-04-commission-r-calibration-gap.md`).

## 3. Calibration evidence (why "confidence" cannot be trusted as-is)

1. M1-confidence AUC **0.4752** over 192 settled trades (CI [0.393, 0.557]) — chance level (`M1_ABSTENTION_INTELLIGENCE_RESEARCH.md`, PR #836).
2. Plan-B forecast AUC 0.5216 (Reversal) / 0.4685 (Transition) over 191 settled; trained-expert ABSTAIN on all 191 entries (`2026-11-19-owner-win-loss-pre-entry-formation.md`).
3. Expected-R vs realized-R: +0.3242R predicted vs −0.2833R realized (121 trades); gap −0.5064R (93 trades); predicted-R buckets show **no positive ordering** across realized outcomes.
4. Five distinct, non-commensurable confidence scalars feed one 0.60 gate (audit §4.1 below).

## 4. Architectural defect register (ranked by economic impact)

### 4.1 Uncalibrated, non-commensurable confidence (D-01)
- TS M1 candidate confidence = `min(0.738, 0.5 + 0.3·quality + 0.08·eff − 0.08·vol)` — a hand formula, capped, never calibrated (`apps/api/src/modules/ai/m1-tactical-candidate.ts:156-162`).
- Plan-B collector confidence = different formula clamped to [0.6, 0.8] (`vps-forex-signal-collector.service.ts:994-997`).
- v8/Plan-B frozen logistic probability with 29 hand-copied 17-decimal coefficients; admission thresholds 0.46 / 0.40828402366863903 (`v8-shadow-meta-scorer.ts:3-7, 51-81`).
- Python event-pair confidence = `min(direction_confidence, opportunity_probability)` — a min of two marginals is not a joint probability (`services/ai-engine/app/domain/models/baseline_xgboost.py:577, 606`).
- Dispatched `confidenceScore` is path-dependent: one of four incomparable quantities depending on which rescue/handoff path fired (`m1-tactical-scheduler.service.ts:4281-4291`).
- The sizing tier ladder (VERY_STRONG ≥0.8 / ELITE ≥0.88) is unreachable because M1 confidence is capped at 0.738 (`scheduler:723-730`).
- Calibrators (Platt/isotonic) exist **only** in offline training; no runtime inference path loads or verifies one.

### 4.2 Duplicated intelligence (D-02)
- Two full M1 scoring stacks: TS hand-tuned composite (9-feature weighted sum, `m1-tactical-candidate.ts:143-186`) vs Python XGBoost event-barrier experts trained on the same MTF feature contract.
- Three "Plan B" scorers with three different admission floors (0.6 / 0.46 / 0.40828…): Python 3-expert consensus, TS deterministic policy, TS frozen logistic.
- `directionQuality` has three definitions under one name (`m1-tactical-candidate.ts:156`; `plan-b-multimodel-shadow.ts:124-133, 182-264`).
- Net-expectancy computed in ≥5 places per decision; reliability thresholds in ≥10 services (pf floors 1.5/1.15/0.7 at overlapping scopes).
- Two trade geometries for the same instrument-minute (M1 1.1×ATR/1.6R vs Plan-B 1.5×ATR/2.5×ATR) — realized outcomes blend non-comparable R units.

### 4.3 Exit-side economics dominate losses (D-03)
- The profit lock arms at 0.50R (0.395R M1 rescue band) and closes at 40–90% of peak while losers ride to the full −1R SL; the code's own comment admits the retired 0.30R arm "harvested tiny wins while full SL losses remained ~1R" (`broker/adapters/paper-broker.adapter.ts:678-712`).
- `OPPOSITE_EXPERT_PROFIT_HARVEST` closes at just +0.15R (`execution/reconciliation/live-demo-profit-protection.service.ts:216-229`).
- Exit authority is spread over 8+ overlapping classifiers (profit lock, net-profit lock, adverse cut, post-peak rescue, drawdown guard, thesis protection, continuation recovery grace) whose precedence is emergent, not specified; route determines which protections apply (`live-demo-profit-protection.service.ts:596-1630`).
- Continuation recovery grace can hold a −0.45…−0.65R position up to 4.5 minutes, then ride to −1R.
- No partial-close machinery exists in the production path (full-position closes only; the 0.02-lot pilot cannot dispatch).
- No broker-side trailing stop; the 5-second sweep is the de-facto trailing mechanism; `trailingStopPips` is always null.

### 4.4 Evidence-recording and data-quality defects (D-04)
- **First-write-wins decision persistence**: `m1_tactical_decisions` upsert does `DO UPDATE SET updated_at = updated_at` — re-evaluations are silently dropped; the adaptive layer learns from stale first-evaluation rows (`ai/m1-tactical-evidence.service.ts:1037-1039`).
- **Placeholder governance values**: M1 governance fabricates `sessionQuality=1`, `consensusPassed=1/1`, `portfolioRiskScore=0`, `openPositionCount=0`, `tradeQuality=exitQuality=pairSideQuality=directionQuality` for every M1-lane decision (`ai/m1-tactical-governance.ts:70-99`) — corrupts drift diagnostics and stored evidence.
- **Blocker-list erasure**: micro/local-impulse drift-only rescue persists OOD trades with an **empty blocker array** (`m1-tactical-scheduler.service.ts:2881-2882`) — forensics cannot distinguish "clean" from "rescued OOD".
- **`before` cursor silently dropped** by cTrader/OANDA OHLCV adapters (3-param impl vs 4-arg call) — as-of/backfill queries return *latest* bars: direct look-ahead risk (`broker/adapters/ctrader.adapter.ts:726`; `broker.service.ts:1883`; routed at `market-data.service.ts:67`).
- **Provenance flattening**: per-row candle `source` overwritten by response-level source; M1-aggregated M5/M15 buckets carry no source — the Python mixed-provenance guard can never fire (`market-data.service.ts:164-166`; `provider-quote-candle-store.service.ts:527-535`).
- **Direct-MT5 timestamps mislabeled UTC** (broker-server time) — 2–3h bucket shift on the MT5 lane (`services/mt5-connector/.../mt5_terminal.py:72-74`).
- **Residual paper-source override seam** in the Python engine: global `market_data_connection_id` still overrides the execution connection on paper/research paths (`signal_generator.py:123`) — the exact class of the documented paper-broker miswiring incident.
- **No inter-candle gap detection at runtime** — a feed with missing minutes still yields a 20-candle window spanning the hole (`ohlcv_service.py:174-238`).
- **No runtime OOD gate in Python** — the deployed artifact scores shifted inputs; only non-finite checks (`baseline_xgboost.py:456-495`).
- Unbounded calibration-cache growth keyed by per-decision timestamps with no eviction (`adaptive-prediction-calibration.service.ts:417-420`).

### 4.5 Complexity, conflicting experts and the version treadmill (D-05)
- ~15 interacting config flags + rescue/veto lattice: expert unanimity can *rescue* a failed admission while profitability gates veto the same candidate the expert rescued; the counter-pilot evaluates the **opposite side** through the full pipeline on the same minute (`m1-tactical-scheduler.service.ts:1895-1956`).
- 12 experts in the TS registry with frozen weights; 5 confidence semantics; cross-lane timing coupling (DEMO handoff gate reads PAPER-lane rows within ±2 min).
- 27+ candidate-version research scripts (v11…v39, six_pair v73–v75) re-testing overlapping history; `bounded_final_campaign.py` — the intended treadmill terminator — is **broken**: it imports `single_pair_v41_live_promotable_microstructure` / `single_pair_v42_side_meta_label` which do not exist.
- Small-sample gates can qualify noise: MIN_OUTER_TRADES=20, MIN_PER_FOLD_TRADES=3, 2-day training windows.
- Three hardcoded 2026-11 timeboxed experiments still run DB queries on the entry-critical path every minute.

## 5. What V1 gets right (must be preserved in V2)

1. **Fail-closed discipline**: evidence-unavailable ⇒ veto, unknown regime ⇒ reject, unprovable quote ⇒ null, OOD ⇒ block by default.
2. **As-of evidence architecture**: closed-candle-only reads, decision-time persistence before dispatch, day-purged calibration studies, censored-not-imputed labels.
3. **Append-only fill ledger** with DB triggers (`execution/orders/order-fill-evidence.entity.ts`) — closed the historical double-booking defect.
4. **Broker-native data discipline**: single-source M1 provenance, full-minute provenance rules for M5/M15 reconstruction, per-bucket positive-spread capture.
5. **The documented promotion-gate regime** (PF ≥ 1.15, Sharpe ≥ 1, DD ≤ 12%, multi-fold, broker reconciliation, manual DEMO-only promotion) — repeatedly and correctly *refused* to promote every candidate challenger to date. This refusal discipline is the corpus's most valuable asset.

## 6. Cross-references

- M1 abstention six-slot taxonomy and cohort statistics: `docs/research/M1_ABSTENTION_INTELLIGENCE_RESEARCH.md` (PR #836); margin semantics (PR #837); evidence coverage (PR #834).
- LIVE blockage investigation: PR #818; DEMO/LIVE architecture review: PR #810.
- The V2 proposal built on these findings: `docs/research/v2/V2_ARCHITECTURE_PROPOSAL.md`.
- DEMO-account Champion-Challenger evaluation design: `docs/research/v2/V2_CHAMPION_CHALLENGER_DEMO_EVALUATION_DESIGN.md`.
- Execution backlog: `docs/research/v2/V2_EXECUTION_BACKLOG.md`.
- Executable research invariants: `apps/api/scripts/research/v2-evaluation-metrics.cjs`, `v2-champion-challenger-attribution.cjs`, `v2-decision-record-contract.cjs` (+ 23 tests).

## 7. Limitations

- Audit is static code review + corpus synthesis; no runtime profiling, no production DB access, no re-execution of trading code.
- File:line citations refer to branch head `55c11626`; line numbers drift with refactors.
- Economic figures are the corpus's own broker-confirmed aggregates, reproduced without re-derivation; we did not have row-level private data and none was accessed.
- The 424-deal whole-account figure includes periods before the audit windows and is not directly comparable to cohort figures.
