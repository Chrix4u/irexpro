# Handover Report — z.ai Independent Review → ChatGPT/OpenAI Implementation Phase

**From:** z.ai Review Agent (independent reviewer role, per review brief)
**To:** ChatGPT/OpenAI (independent reviewer & implementation owner)
**Date:** 2026-11-03
**Branch to review:** `zai/model-productivity-review-20261102` (child of `review/zai-model-productivity-20261102`)
**Head commit at handover:** `1f6c125cf71df544630342ed3009dbbd1f33d919` (`docs(research): z.ai independent model/productivity review — evidence report + diagnostic SQL`)
**Base/brief commit:** `c2dc177f` (`docs(ai): add z.ai independent model productivity review brief`), on top of `09a25ce7` (merge of side-selection three-class v1)

---

## 1. What was done (summary for the reviewer)

### 1.1 Scope of the study
A read-only, end-to-end independent study of the iRexPro autonomous AI forex trading system was performed against commit `c2dc177f`, covering: the AI/model architecture (multi-model + Plan-B ensemble, confirmed-reversal and continuation models, XGBoost challenger, three-class side-selection), confidence scoring and calibration, drift detection, trade admission and governance gates, the M1 tactical engine, the cTrader market-data pipeline, entry timing, lot sizing, SL/TP geometry, post-entry monitoring, profit protection, and exit logic.

The stated objective was to improve **profitability, expectancy, profit factor, and drawdown — explicitly not win rate** — under the brief's hard constraints: no changes to `main`; no threshold-lowering to force trade frequency; every behavior-affecting experiment shadow-only or DEMO-only until statistically validated; no weakening of final account risk protections.

### 1.2 What was delivered (all on the review branch, nothing on `main`)
| Artifact | Path | Purpose |
|---|---|---|
| **Main review report** (10 chapters, per brief) | `ZAI_REVIEW_REPORT.md` | Findings F1–F12 with file:line evidence, root causes, proposals P1–P10, expected impact, overfit risks, validation protocol, rollout posture, tests/telemetry, ranked recommendations |
| **Expectancy/exit scenario model** | `docs/research/2026-11-03-zai-expectancy-exit-scenario-model.md` | Deterministic decomposition of the staging aggregate + scenario ladder S0–S3 |
| **SQL: expectancy decomposition** | `scripts/research/zai-expectancy-decomposition.sql` | Re-derives every staging number + P&L segmentation from the DB |
| **SQL: exit autopsy counterfactual** | `scripts/research/zai-exit-autopsy-counterfactual.sql` | Profit-protection exit autopsy: replay each closed trade as TP-first / SL-first / neither |
| **SQL: blocker co-occurrence** | `scripts/research/zai-blocker-cooccurrence.sql` | Blocker frequency/co-occurrence, root-cause dedup, DRIFT-blocked counterfactual feed |

**No production code, thresholds, admission logic, risk gates, or execution authority were modified.** All additions are under `docs/research/`, `scripts/research/`, and the report itself. This was verified before the commit.

### 1.3 The headline finding (F1 — critical)
The system loses to **exit truncation, not direction**. On the staging aggregate (588 closed trades, 271 W / 313 L / 4 flat, WR 46.09%, gross +1,420.85 / −1,761.82, net −340.97, PF 0.81):

- Realized payoff ratio = **0.93** (avg win 5.243 / avg loss 5.629) vs. **designed** R:R of 1.6R (M1, `m1-tactical-candidate.ts:24-26`) / 1.667R (M5) → the exit engine realizes only **~58% of design**.
- Breakeven win rate at realized payoff = **51.8%** > observed 46.4% → structural net loss.
- At the observed win rate, the **designed** payoff would be gross-profitable (+0.21R/trade). The profit-lock retention ladder (`paper-broker.adapter.ts:705-749`) harvests wins at 0.35–1.35R while losses run to ≈ −1R.
- Scenario S1 in the companion doc: restoring the average win to design scale (+24%) with WR unchanged takes PF 0.81 → 1.00 **with zero admission changes**. Exit re-tuning (P1) outranks every entry-side change.

### 1.4 Full findings index (details + evidence in report §1–§2)
- **F1 (Critical):** exit engine truncates the right tail (payoff 0.93 vs designed 1.6R).
- **F2 (Critical):** M1 cost drag ≈ 0.15–0.19R vs 0.08R net floor (`ensemble-governance.ts:395-402`, 1.1×ATR stops with 5-pip floor) — geometry makes the edge structurally thin.
- **F3 (High):** two incompatible confidence scales flow through one `confidenceScore` field; sizing tiers at 0.80/0.88 are dead under the 0.738 M1 cap.
- **F4 (High):** one root cause emits up to 5 blocker strings; early-transition 0.2R floor silently downgraded to 0.08R (`m1-tactical-governance.ts:127`); "net"-named floor applied to a gross quantity.
- **F5 (High):** stale global-OR drift envelope over-blocks (must be measured, not assumed).
- **F6–F9:** early-transition structural suppression; side-selection delta signal unused; DSR/PBO gaps; accuracy-keyed promotion.
- **F10–F12:** cTrader starvation paths (M5 rotation vs 10-min window); dead control surfaces (`trailingStopPips` unenforced); missing breakeven/session exits.

### 1.5 Proposal index (P1–P10, ranked by expected PF impact — report §10)
1. **P1** Re-tune exit engine from MAE/MFE + counterfactual evidence (partial scale-out ~1R + ATR trail; retire fixed retention ladder). *PF 0.81 → 1.00–1.15 est.*
2. **P2** Fix M1 cost geometry (cost-break-even stop floor; M5-anchored geometry for strong-HTF continuations). *Raises an effective entry requirement — not a threshold cut.*
3. **P6** Meta-labeling loss filter on the existing shadow ledger (filter bottom-decile P(win)).
4. **P3** Single calibrated probability surface; re-key dead consumers.
5. **P4** Root-cause blocker attribution; fix ET-floor override and "net"-floor naming.
6. **P5** Drift envelope refresh, gated by DRIFT-blocked counterfactual study.
7. **P9** Market-data gap backfill + collector telemetry (no gate weakening).
8. **P8** Economics-first promotion scorecard with enforced trial ledger (DSR) + PBO.
9. **P7** Keep early-transition shadow-only; add ledger lineage + data-driven re-arm rule.
10. **P10** Hygiene batch (trailing-stop decision, taxonomy, dead-code removal, runtime monitor).

**Explicitly rejected:** lowering admission/confidence/expectancy thresholds; weakening fail-closed broker-readiness states; touching `risk.service.ts` or `final-dispatch-boundary.ts` semantics; promoting models on classification metrics; changing direction authority of the trained challenger.

### 1.6 Honest limitations of this review
- No staging DB, training corpus, or runtime access existed in the review environment. All staging-dependent numbers derive from the brief's aggregate; the four SQL companions re-derive them independently and must be **run against staging** before any implementation decision.
- No new walk-forward was executed. The scenario table (PF 1.05–1.25 path) is an **analytic prior**, not a backtest result. Report §7 contains the pre-registered validation protocol that any P1–P6 promotion must pass.
- Repeated peeking at the same 588-trade aggregate is itself multiple testing — treat the report's numbers as priors with stated assumptions (companion doc §6 reproduces the arithmetic).

---

## 2. What ChatGPT should do (review checklist, in order)

### Step 0 — Verify the branch is clean
1. `git fetch origin && git checkout zai/model-productivity-review-20261102`
2. Confirm `main` is untouched: `git diff main...HEAD --stat` should show only `ZAI_REVIEW_REPORT.md`, `docs/research/2026-11-03-zai-expectancy-exit-scenario-model.md`, and the three `scripts/research/zai-*.sql` files.
3. Confirm the brief was honored: read `docs/research/zai-model-productivity-review-2026-11-02.md` (commit `c2dc177f`) and check every constraint maps to a section in `ZAI_REVIEW_REPORT.md`.

### Step 1 — Independently verify the evidence (do not trust the report)
For each finding, spot-check the cited file:line at commit `c2dc177f`:
- F1: `paper-broker.adapter.ts:705-749` (retention ladder), `m1-tactical-candidate.ts:24-26` (designed 1.6R), `vps-forex-signal-collector.service.ts:285-286` (M5 1.667R).
- F2: `ensemble-governance.ts:395-402` (cost model), `ensemble-governance.ts:7` (0.08R floor), `paper-market-spec.ts:10-15` (PAPER spreads).
- F3/F4: confidence-cap 0.738 path, sizing tiers 0.80/0.88, `m1-tactical-governance.ts:127` (ET floor override).
- F8/F9: `validation.py:48-170`, `model_qualification.py:3086-3166`, `run_first_six_pair.py:181-295`, promotion scorecard keying.
- F10: M5 collector rotation vs the 10-minute window math.

### Step 2 — Run the four SQL companions against staging
They are the bridge between the report's analytic priors and implementable decisions:
1. `zai-expectancy-decomposition.sql` → confirm/reproduce the aggregate; produce the **per-segment** P&L (route × instrument × side × regime × close-reason).
2. `zai-exit-autopsy-counterfactual.sql` → the profit-protection exit autopsy (TP-first / SL-first / neither replay). **This decides P1**: if a large share of harvested winners would have hit full TP first, the retention ladder is destroying value and P1 is confirmed.
3. `zai-blocker-cooccurrence.sql` → confirm F4's root-cause inflation; produce the DRIFT-blocked counterfactual feed that gates P5.
4. Sanity-check the F2 cost estimate: `costR` distribution per route/ATR bucket (report §9 telemetry target: P90 ≤ 0.10R on admitted trades).

### Step 3 — Implement in the report's priority order, with the report's rollout posture (§8)
| Order | Proposal | Posture at implementation |
|---|---|---|
| 1 | P1 exit re-tune | Offline audit + shadow replay only — **no behavior change** until DEMO A/B passes §7-7 |
| 2 | P2 cost geometry | Shadow computation + telemetry; DEMO-only enforcement after 4 weeks shadow |
| 3 | P6 meta-filter | Offline study → own shadow artifact → DEMO only after DSR > 0, PBO ≤ 0.5, and economic superiority |
| 4 | P3 calibration | Report-only dual-run telemetry first; re-key one consumer at a time after 2 weeks divergence-free |
| 5 | P4 blocker dedup | (a) safe now; (b)/(c) behind flags, default off |
| 6 | P5 drift refresh | Shadow-only until the DRIFT-blocked counterfactual proves net-positive episodes |
| 7 | P9 data resilience | Implement now (backfill + telemetry; no gate weakening) |
| 8 | P8 promotion scorecard | Implement now (gate code only; `approved_for_live` untouched) |
| 9 | P7 ET freeze | Immediately (no behavior change; already promotion-blocked) |
| 10 | P10 hygiene | Now, except trailing-stop decision needs product input |

### Step 4 — Hold the validation bar (report §7 — the acceptance contract)
Before **any** P1–P6 promotion: ≥ 6 months of executed + shadow-resolved trades; 6-fold walk-forward with purge = embargo = max(horizon, 1 day); pre-registered **economic** metrics (net expectancy after 1.25×P90 spread model, PF, avg win/loss, max DD, frequency) — classification metrics cannot justify promotion; DSR > 0 and PBO ≤ 0.5 via the trial ledger; cost stress at 1.0×/1.5×/2.0× P90 spread (must stay net-positive at 1.5×); untouched 20% holdout evaluated exactly once; then 4+ weeks DEMO shadow with live spreads, and DEMO A/B with ≥ 100 trades/arm or 8 weeks.

### Step 5 — Add the tests & telemetry specified in report §9 with each PR
Key ones: lock-policy unit + property tests (no close below protected floor), `costBreakEvenStop` golden tests across 6 pairs, calibration divergence alerts, blocker snapshot tests, leakage/purge tests for P6, and the four new telemetry artifacts (`exit_policy_audit`, `blocker_root_cause`, `costR` distribution, reliability/Brier per route).

### Step 6 — Preserve the non-negotiables (report §8, final paragraph)
`risk.service.ts` (daily loss 5% of session opening balance, max DD 10%, per-trade risk 2%, leverage ≤ 30, mandatory SL/TP, kill switch, fail-closed authority binding), `final-dispatch-boundary.ts` commitment chain, market-safety gate (30 s quote age / 2% spread ratio / 1% deviation), currency-exposure guard (2%/3%). **No proposal lowers any safety threshold.** P1 changes only post-entry management of already-admitted, already-risk-gated positions.

---

## 3. Questions the reviewer should answer back (decision points flagged for you)
1. **P1 parameterization:** after running the exit autopsy, do the MFE-conditional curves support a partial scale-out at ~1R + 2.5×ATR trail, or a different plateau? The report deliberately does not pick point parameters — it requires plateau acceptance under walk-forward (§6-1a).
2. **P2 scope:** which of the 6 pairs get M5-anchored geometry? The report's criterion is "strong-HTF continuation" — needs an operational definition accepted by you.
3. **P5:** is the DRIFT-blocked counterfactual feed large enough to decide? If < ~200 blocked episodes in 6 months, extend the window rather than weaken the gate.
4. **P10 trailing-stop:** the report flags `trailingStopPips` as an unenforced control surface — enforce it or remove it? Needs a product decision, not an engineering one.
5. **Swap-aware exits:** PAPER swap ≡ 0 today; before P1's longer holds go to DEMO, add swap to the audit — confirm you agree this is a blocker for P1's DEMO phase, not for its shadow phase.

---

## 4. One-line summary
The system picks directions well enough; the exit engine and M1 cost geometry give the money back — fix exits first (P1), then cost geometry (P2), then filter with meta-labels (P6), all shadow-first, all evidence-gated, with win rate explicitly not a target.
