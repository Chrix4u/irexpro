# iRexPro AI Engine V2 — Independent Audit Findings: The Seven Directive Categories

Research-only. Prepared on 2026-11-27 against `main` @ `b91e577c` and the open research stack PR #834, #836, #837, #838. Nothing in this document modifies production, risk or execution behavior. This is a first-pass static audit of the full engine surface; row-level authorized evidence is referenced only through already-public repository documents.

**Coordination:** this document is the seven-category companion to the existing `V2_ENGINE_AUDIT_FINDINGS.md` defect register (D-01..D-05, PR #839). It organizes the evidence by the research directive's exact categories (a)–(g), adds the per-trade cost decomposition, route-level profit factors and the entry-vs-exit separation assessment. Where both documents cover the same defect, the D-register is the primary record and this document adds the category mapping and economics decomposition.

## 1. Scope and method

Studied surfaces:

| Surface | Scale (non-spec/test files excluded) | Role |
|---|---|---|
| `apps/api/src/modules/ai` | 137 TS files, 43,129 lines | Ensemble governance, experts, strategies, research observers, entry confirmation |
| `services/ai-engine` | 206 Python files, 56,659 lines | Model training, qualification, backtesting, signal generation |
| `apps/api/src/modules/strategy` | 6 files, 2,342 lines | Exit orchestration, strategy lab |
| `apps/api/src/modules/trading` / `execution` / `risk` / `broker` | 30 files, 14,274 lines | Order lifecycle, risk guards, broker adapters |
| `docs/` | 200+ dated research post-mortems | Documented outcome evidence since 2026-11-02 |
| PRs #834/#836/#837/#838 | M1 evidence-completeness, abstention taxonomy, cohort statistics | Prior M1 research stream |

Economic baseline reference: `docs/IREXPRO_AFTER_COST_PROFITABILITY_AND_CALIBRATION_BASELINE_20261119.md` — 121 settled Pepperstone USD DEMO trades, 61W/60L (50.41%), net after costs **−$1,859.45**, commissions **−$1,267.20**, profit factor **0.529** (gate: 1.15), predicted mean **+0.3242R** vs realized broker-net mean **−0.2833R**.

## 2. Findings by weakness category

### (a) Architectural weakness and duplicated intelligence

- Two parallel engines (NestJS 43k lines + Python 57k lines) with overlapping responsibilities: feature construction, scoring, and qualification logic exist on both sides of the `ai-engine-client` boundary.
- `ensemble-expert-registry.ts` registers 12 components: 2 trained models (`plan-b-v4-high-conviction` 128-feature XGBoost, `plan-b-v85-post-entry` 41-feature give-back classifier), 5 heuristic policies, 4 risk guards, 1 frozen baseline. The heuristic policies (`plan-b-multimodel-shadow-v4`, `early-transition-paper-policy`, `extension-exhaustion-shadow`, `trend-persistence-shadow`, `v8-fixed-meta-policy`) re-implement overlapping regime/direction/quality checks — duplicated intelligence by construction.
- Model-version sprawl: test names in `services/ai-engine/tests` span `single_pair_v11` … `single_pair_v25`; artifact identifiers reach `plan-b-v85`; governance is on v3, cost model v5, drift model v4. At least 25 model generations coexist without a single promotion record that closed the loop from forecast quality to after-cost economics.
- Three entry routes (Confirmed Reversal / Early Transition / Trend Continuation) multiply an already-wide expert surface; Trend Continuation was the worst performer (PF 0.3218 on 12 settled trades — below any plausible qualification floor, and n is far too small to defend).

### (b) Uncalibrated confidence measurements

- `ensemble-governance.ts` admits on `scoreEdge` thresholds (hard floor 0.08) applied to raw model scores. There is no evidence chain from that score to a calibrated probability of the realized outcome.
- The 19-Nov baseline measured the consequence: mean predicted +0.3242R vs realized −0.2833R. The prior M1 research (PR #836) measured M1 confidence AUC 0.4752 — below the 0.5 even-chance line.
- PR #834/#836 correctly refuse to assign a numerical "abstention strength" (`abstentionStrength: null`) because no calibrated probability exists. This is the right diagnosis: V1 confidence numbers are order statistics, not probabilities, and cannot support threshold-style admission logic.

### (c) Data-quality and evidence-recording defects

- Expert data authorities mix `BROKER_NATIVE`, `TWELVE_DATA_CLOSED_M5`, and `BROKER_NATIVE_OR_TWELVE_DATA` — dual providers with different settlement semantics inside one ensemble decision.
- The 19-Nov baseline records `BROKER_CLOSE` loss labels whose trigger (stop-loss vs other closure) is not attributable from stored evidence; recent commits (#827/#828, "classify statement mismatches without guessing settlement") show the same defect class was being repaired on the platform side.
- The M1 evidence-completeness audit (PR #834) exists precisely because the 12-field decision record was incomplete for settled outcomes. Evidence completeness is an open engineering property, not a given.

### (d) Model instability and overfitting risk

- The drift model gates sleeves on a `development-envelope-4599-v1` — an envelope fitted to one development window; PR #836's statistical review found remaining issues in the cohort-statistics claims, and #837 needed to preserve "unknown blocker codes without labeling them mandatory risk controls" — i.e., category labels have drifted during research.
- The project's own promotion gate (PF ≥ 1.15, positive folds, Sharpe ≥ 1, ≤12% drawdown) has never been met on out-of-sample after-cost data, yet 25+ generations of models were produced. That is churn without qualification — the classic overfitting treadmill: each version encodes more of its training period.
- Sleeve promotion requires ≥100 closed trades (`ENSEMBLE_SLEEVE_CORE_MIN_CLOSED_TRADES`) — a correct guard, but the 19-Nov sample (121 trades total across all routes) means no single route/sleeve has ever reached it.

### (e) Predicted-vs-realized outcome discrepancy

- Documented sign inversion (+0.32R predicted / −0.28R realized). The baseline authors correctly note the two R metrics are not identical forecast targets (exit policy, fills, horizons differ), so this is not one bug — it is evidence that **calibration and exit policy must be investigated separately**, which V2 makes structural (separate measurement planes, below).
- Timing replay (19 Nov): 39 timing-rejected candidates would have lost an estimated −3.13R — abstention had positive counterfactual value that day, but the sample is one day and counterfactual, not broker fills.

### (f) Excessive complexity and conflicting expert opinions

- 43k lines of AI-side TypeScript for a system whose settled evidence base is 121–192 trades. The expert-to-evidence ratio is inverted: more shadow lanes than trades per route.
- Governance simultaneously runs: scoreEdge floor, net-EV cost guard, drift guard, macro guard, sleeve-state machine, and route-specific floors (0.08R global, 0.2R early-transition). Multiple authorities can each veto, and none is individually accountable for the realized outcome — conflicting-expert opacity.
- Research observers ("shadow", "collecting") accumulate with no retirement criterion; `EXECUTION_BACKLOG.md` itself lists RES-02 as "review #811/#812/#813 expert observation provenance" — an acknowledgement that the observer fleet is unaudited.

### (g) Sources of poor economic performance

Ranked by documented evidence:
1. **Per-trade friction exceeds per-trade edge.** Commissions −$1,267.20 on 121 trades ≈ −$10.5/trade; gross was −$4.9/trade. Even a zero-edge strategy loses ~$10.5/trade here; the 0.08R net-EV floor is far below the observed cost scale.
2. **Miscalibrated entry expectancy** (finding e): admission believes +0.32R while delivery is −0.28R.
3. **Exit policy confound**: profit-protection wins +$165.88 vs BROKER_CLOSE −$306.48 in the 19-Nov sample; exits were not independently evaluated against the entry signal's stated payoff geometry (`avgWinR`/`avgLossR` at decision time vs realized MFE/MAE).
4. **Correlated USD-grouped entries**: multiple simultaneous positions expressing one USD view — the baseline explicitly warns the number of pairs is not the number of independent positions.
5. **Route dilution**: Trend Continuation (PF 0.32) and Early Transition (PF 0.54) trade without per-route sample sufficiency.

## 3. Entry intelligence vs exit management — separate assessment

- **Entry intelligence**: confidence is uncalibrated (b), the admission floor is a raw-score threshold (0.08), and route taxonomy multiplies entry lanes without route-level sample sufficiency. The correct V2 response is a single calibrated probability core with lower-bound admission (see architecture doc §3).
- **Exit management**: the profit-protection family (0.25R/0.50R locks, progressive peak retention, trailing) has never been evaluated against a fixed entry distribution on identical windows; MFE/MAE telemetry exists (`post-entry-path-telemetry` expert) but as a "collecting" observer, not an evaluation plane. V2 separates the exit policy as an independently measurable layer with its own counterfactual fixtures.

## 4. What V2 changes, preserves and challenges

| V1 element | V2 stance |
|---|---|
| Fail-closed risk guards, provenance discipline, read-only research pattern, hard floors concept | **Preserved** — reused directly in V2 modules |
| 12-component expert ensemble with 5 overlapping heuristic policies | **Challenged** — collapsed to one calibrated probability core + named guards (each guard individually accountable) |
| Point-estimate admission floors (scoreEdge 0.08 / net-EV 0.08R) | **Challenged** — lower-bound (P10) net-EV admission with broker-observed costs |
| Mixture of Twelve Data and broker-native data authorities | **Challenged** — broker-native quotes as the single decision-time authority |
| Exit policy entangled with entry scoring | **Challenged** — separate measurement planes, evaluated on identical fixtures |
| Win-rate/observer-count as progress evidence | **Challenged** — after-cost CI, profit factor, calibration ECE as the only promotion evidence |

## 5. Limitations of this audit

- Static, first-pass: file-scale analysis plus the repository's own documented baselines; no row-level authorized data was accessed (none is committed to the public repo, correctly).
- The 121-trade economics baseline is one frozen window (16–19 Nov); the 192-trade M1 cohort in PR #836 extends it but remains an operator-supplied anonymized export.
- Exit-policy counterfactuals referenced are the repo's own estimates, not broker fills.
- Coordination with PR #834/#836/#837/#838 outputs (notably #836's outstanding statistical corrections and #837's integration review) is required before any V2 statistical claim reuses their cohorts.

## 6. Pointer to the follow-up documents

- Architecture: `docs/research/AI_V2_CHALLENGER_ARCHITECTURE.md`
- Execution backlog: `docs/research/AI_V2_EXECUTION_BACKLOG.md`
- Offline implementation: `apps/api/scripts/research/v2-*.cjs` (+ `.test.cjs`), synthetic fixtures only, `node --test`.
