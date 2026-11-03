# ChatGPT independent verification of z.ai model productivity review — staging, 2026-11-03

**Status:** Staging read-only audit completed; diagnostic SQL corrected on this child branch. **No strategy, admission, order, position size, SL/TP, close-timing, risk, LIVE authority or default policy changed.** No deployment or merge to `main`.

## 1. Provenance / branch integrity

- Independent z.ai head reviewed: `51298b57ef66efcb2bfc804ef4f83b0620670df2` (branch `zai/model-productivity-review-20261102`).
- Compared to `main` `ae90fb4f64c114459c5ac4e62f6e5103884bee55`: z.ai branch has **seven documentation/research-only files**, not the handoff's claimed five. Those seven are the report, handoff, original review brief, scenario doc and three SQL companions. No production files changed. The branch diverges from `main`; do not merge it as an executable feature without a clean-base review.
- Code checks against `c2dc177f` confirmed the retention ladder in `paper-broker.adapter.ts:705-749`, M1 1.6R target in `m1-tactical-candidate.ts:24-26`, ensemble cost computation `ensemble-governance.ts:395-402`, and early-transition paper-net override `m1-tactical-governance.ts:127`. The 0.08R override replaces the route's default 0.2R *inside that generic governance call*, but other route-specific checks remain; do not characterize the complete ET path as having no 0.2R enforcement.
- z.ai's diagnostics were **not initially runnable to decision-grade quality**: negative profit-factor sign from division by a negative loss, incorrect USDCAD pip size 0.01, invalid `ORDER BY n`, invalid ROUND(float8, 4), counterfactual `state='outcome'` (actual states TP_FIRST etc.), invalid query alias, incorrect drift source (`reasons` rather than nested governance), R conversion without verified pip value, and mixing EUR with USD.
- The three corrected SQL scripts on this child branch have been executed against staging read-only; they return usable money-isolated output without touching trade state.

## 2. Corrected realized P&L (snapshot Nov 3, 2026, ~19:45 UTC)

Source: `trading.trades` CLOSED with non-null realized P&L; separate commission is booked as an ABS cost; recorded swap is added as signed credit. The broker execution reader uses this convention.

| Currency | Trades | Gross wins/losses/flat | Recorded realized (pre separate commission) | ABS commission cost | Economic net | Economic PF |
|---|---:|---|---:|---:|---:|---:|
| USD | 438 | 193/241/4 | -206.83 | 0.00 | **-206.83** | **0.8278** |
| EUR | 152 | 79/73/0 | -131.78 | 251.17 | **-382.95** | **0.4462** |

**Do not sum USD and EUR.** The previous blended 588-trade/0.81 PF snapshot was an outdated, cross-currency realized-only aggregate, not a valid economic-performance measure. EUR's positive-gross win rate ~52% masks sharply negative net P&L and a sub-0.5 PF after fees.

Selected EUR close reasons (commission-aware): `STOP_LOSS_HIT` 50 trades **-538.28 EUR**, `AI_CLOSE_SIGNAL` 18 **-99.89 EUR**, `BROKER_CLOSE` 6 **-38.23 EUR**, `PROFIT_PROTECTION` 76 **+259.23 EUR**, `TAKE_PROFIT_HIT` 2 **+34.22 EUR**. This directly **does not support** a conclusion that profit protection alone causes the deficit. Costs and losing positions demand equal priority.

Stop geometry at observed closed-trade stop distances is often ~5 pips (EUR cohort). A hypothetical 1.25× paper-assumed-spread/stop calculation gives roughly 0.25R EURUSD/AUDUSD and ~0.30R USDCAD/GBPUSD at that geometry. These are sensitivity estimates, **not** measured broker P90 execution costs or true realized per-trade costR; admission decisions must use broker-native cost evidence and unchanged risk sizing.

## 3. Profit-protection replay: P1 route stratification

All 76 available `profit-protection-counterfactual-v1` 240-minute records link to EUR closed trades. Outcomes are in `o.state`; `o.reason` is `ORIGINAL_BARRIER_REPLAY`.

- `TP_FIRST`: 52; `SL_FIRST`: 20; `DATA_GAP`: 4. These are original TP/SL **after the protected close**, not predictions of a proposed scale-out/trail.
- **All replay exits by route:** CONFIRMED_REVERSAL 13 TP / 1 SL / 1 GAP; EARLY_TRANSITION 27 TP / 9 SL / 0 GAP; TREND_CONTINUATION 12 TP / 10 SL / 3 GAP.
- **Small protected profit cohort (0 < recorded realized P&L <= 6 EUR):** CONFIRMED_REVERSAL n=6, 6TP/0SL, idealized hold minus actual **+1.221R**; EARLY_TRANSITION n=26, 19TP/7SL, **+0.495R**; TREND_CONTINUATION n=21, 8TP/10SL/3 gaps, **-0.324R**. The last result warns against a universal 'hold winners longer' rule.
- These deltas are **hindsight, first-barrier idealizations**, with data gaps excluded, partial-order execution unsimulated, no full spread/slippage/swap path and route policy confounding. Causal policy advantage is unproven, and the very small 6-trade CR subset should not be promoted.

**P1 decision:** Do **not** select fixed point parameters (50% scale-out at 1R + 2.5×ATR trail) from this checkpoint table. Use full intra-trade and post-close broker-native M1 price paths, preserve fill and position state, simulate a plateau grid by route against existing baseline, include commissions/spread/slippage/swap, account for partial lot constraints, enforce no look-ahead and independent purged walk-forward. Keep the current protective mechanism intact while the candidate remains shadow-only.

## 4. Drift/blocked opportunity replay: P5 decision

The original z.ai SQL erroneously concluded there were zero drift cases because it searched `ensemble_shadow_decisions.reasons`, while the engine stores veto state in `components.governance.driftState`. Shadow outcomes are in `components.outcome`.

Sample snapshot:
- 35k+ ensemble decisions; ~28.4k OOD, ~6.0k NORMAL, ~0.73k STRESSED.
- First-hit `WIN`/`LOSS` observations in the overlapping ledger (raw): OOD n=26,971, mean net **-0.1846R**, PF **0.7515**; NORMAL n=5,478, mean net **-0.1873R**, PF **0.7495**; STRESSED n=680, mean net **-0.1628R**, PF **0.7826**.
- Sensitivity check keeping only one per 72-minute instrument+direction bin: OOD **3,303** episodes, mean net **-0.2086R**, PF **0.7241**; NORMAL **945**, mean net **-0.2088R**, PF **0.7247**; STRESSED **119**, mean net **-0.1876R**, PF **0.7442**.
- This simple fixed-bin de-overlap is **not** a rigorous independent-episode algorithm; overlapping policies, regime, selection effects and unresolved states remain. No six-month sample or out-of-sample validation yet.

**P5 decision:** Reject drift-gate loosening or reclassification as an execution admission feature at this stage. There is **no observed net-positive shadow advantage** among drift-OOD candidates, and normal candidates are also negative. Collect six months and analyze truly drift-only vetoes and costs; any refreshed envelope remains shadow-only until economic qualification.

## 5. Verified gate and confidence issues

- In 20-minute M1 decisions, `MULTIMODEL_GOVERNANCE_BLOCKED`, `ENSEMBLE_NOT_PAPER_ADMITTED`, `MULTIMODEL_PLAN_B_NOT_ADMITTED`, `DRIFT_OUT_OF_DISTRIBUTION` and `MULTIMODEL_CONTINUATION_TIMING_NOT_READY` are the prevalent code reasons. These are nonexclusive, not proof each is an independent cause.
- Ensemble ledger has candidate-confidence median around 0.6083, ensemble-score median around 0.4840, P90 ensemble score ~0.5600. Only 47 of 35,149 ledger records have confidence >=0.8; zero >=0.88. This supports a calibration/sizing-scale mismatch hypothesis; the ensemble ledger confidence should not be mistaken for a single calibrated win probability.
- P4 root-cause attribution may improve telemetry without changing the actual broker gate. The ET floor-override and gross-vs-net comparison deserve **separate, test-covered, disabled-by-default** implementation work; never bypass downstream risk authority.

## 6. Decisions requested in z.ai handoff

1. **P1 parameters:** undetermined. Route-conditional shadow plateau search first; **no change to current exits**. Trend Continuation warns against longer hold as a default.
2. **P2 six-pair scope:** run report-only M1-vs-M5-anchored geometry comparisons for **all six majors**, segment by pair/side/regime/route. A candidate 'strong HTF continuation' must require pre-entry M5/M15/H1/H4 directional agreement, costR reduction and unchanged account-risk sizing; per-pair promotion only after independent positive economics. **No execution geometry changed now.**
3. **P5 sufficiency:** raw OOD ledger abundant, but <6-month span and overlapping; even preliminary nonoverlap returns negative, so **not sufficient for a relaxation**. Keep the hard veto unchanged.
4. **P10 trailingStopPips:** treat the field as **legacy, not an active broker-side trailing-stop promise**. Preserve historical storage and risk-gate semantics; avoid marketing/UI claims that it is enforced. A functional trailing-stop policy needs independent adapter parity and A/B validation before enablement.
5. **Swap-aware exit:** **yes**, mandatory before any longer-hold DEMO A/B, not required to begin offline/shadow research. Also include net commissions, dynamic spread, order partial-fill/lot rules and overnight gap risk.

## 7. Implementation order (conservative)

- **Now on this child branch:** repair and execute the three research SQL scripts; publish this evidence report and verified handoff decisions. P1 replay first, no trading behavior changed.
- **Next isolated research implementation:** extend existing `paper-payoff-shadow-audit.ts`/price-path replay with route-conditional P1 policy candidates and audit them alongside the current baseline, explicitly non-authoritative; add deterministic, no-lookahead cost/lot-size tests.
- **Then:** add P2 broker-observed costR vs stop floor telemetry, per-pair/route sessions; P6 independent meta-label research; P3 calibration dual-run; P4 primary/secondary blocker diagnostics (no admission rewrites).
- **Remaining:** P9 failure-aware market-data backfill without weakening quote freshness; P8 economics-first promotion, DSR/PBO and trial ledger; P7 ET research posture; P10 truthful trailing-stop state and exit taxonomy.
- **Promotion bar:** >=6 months, six-fold purged walk-forward and embargo >=max(horizon,1day), untouched final holdout, DSR>0/PBO<=0.5, net-positive under 1.5×P90 spread stress, >=4 weeks DEMO shadow, then >=100 trades/arm or >=8 weeks DEMO A/B, whichever is later. **None of this is yet satisfied.**

The independent review is valuable, but its original thesis that direction picking is already sufficient and exits alone cause losses **is not proven** by mixed-currency realized aggregates. The audit provides a stronger, falsifiable route to improvement.
