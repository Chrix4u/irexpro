# iRexPro DEMO: spread-only cost estimate vs recorded broker commission

**As-of:** 2026-11-04 11:18 UTC. **Artifact:** `ex-ante-vs-realized-commission-r-audit-v1`.
**Scope:** one owner-authorized cTrader DEMO account, last seven days, EUR only in this sample.

## Motivation and finding

The Plan-B `ensemble-governance-v3` `executionCostR` calculates **(1.25 × broker-observed P90 spread) / initial stop distance**, with a non-promotable paper spread fallback. This is *spread and modeled slippage* only; the code does not explicitly add the separately recorded broker commission. Therefore the stored `m1_execution_cost_r` and the subsequent trade's `abs(commission)/finalRiskAtStop` measure **different cost components**; treating the first as an all-in execution cost underestimates the commission burden.

The read-only initial account audit, run 2026-11-04 11:18 UTC, sampled **158 closed DEMO trades**. **157** had complete commission, swap and realized trading-P&L records, and all 157 had a strictly positive `finalRiskAtStop` from the pre-entry capital allocation.

| Group | Complete paired trades | Mean gross R | Mean net R | Mean broker commission R | Mean modeled spread-only R |
| --- | ---: | ---: | ---: | ---: | ---: |
| All routes | 157 | −0.093 | **−0.296** | **0.202** | **0.073** |
| Early transition | 70 | −0.129 | −0.330 | 0.201 | 0.069 |
| Trend continuation | 53 | −0.034 | −0.238 | 0.205 | 0.077 |
| Confirmed reversal | 34 | −0.113 | −0.313 | 0.200 | 0.076 |

For the full 157-paired cohort the broker commission distribution, as a fraction of pre-entry final monetary risk, was **P50 = 0.202R, P90 = 0.284R**. All 158 records declare `BROKER_OBSERVED_P90` as modeled spread evidence source, but that source is **not** commission data. Four positions with positive gross P&L had non-positive net P&L after recorded costs.

### Entry-forecast diagnostic

Stored metadata contains `m1_net_expected_r` and `multimodel_governance_net_expected_r`, both intended as pre-entry expectations, but not a guaranteed immutable snapshot of the entire broker fill situation. After pairing each with observed **net after commission and swap / pre-entry finalRiskAtStop**, the complete-trade cohort had:

- M1 expected net R mean **+0.131**, observed net R **−0.296**, mean realized-minus-forecast **−0.426R**.
- Plan-B governance expected net R mean **+0.285**, observed net R **−0.296**, mean realized-minus-forecast **−0.580R**.

These are **diagnostics, not validated model miscalibration estimates**: trade-selection censoring, session mix, policy changes, time variation, broker fill risk, variable stop-loss geometry and multiple overlapping signals could affect comparability. The sample is in-sample, only trades that executed and closed.

The Plan-B spread model **omits a separately paid cost component**, but fixing fees alone cannot solve a mean **negative pre-fee trade return**. Model selection and exit timing need their own purged chronological validation.

## Audit safeguards

- Manual tool `apps/api/scripts/audit-commission-r-calibration-gap.cjs` is never imported by execution services.
- Require matching user-owned, active **cTrader DEMO** connection; bounded `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction; max 14 days and 2,000 rows; on truncation fail closed.
- Join only capital allocation records created **on or before actual trade opening** and select the latest. Prefer `sizing_inputs.finalRiskAtStop`; allow `riskAmount` fallback only if final risk is actually absent. Reject missing/zero/negative risk and missing/invalid timestamps. The allocation figure is **not independently reconstructed broker stop-loss cash risk**.
- Only compute net and R when gross realized P&L, explicit commission and swap **all exist**. Treat missing fields as incomplete, not zeros. No cross-account or cross-currency sums, no user/broker/trade identifiers or secrets printed.
- Separate known spread/slippage estimate from commission component: never subtract one as if it already included the other.
- Route × engine, cost-source, and currency group summaries. Preserve unknown rows in counts.

## Next experiments — separate work, not activated

1. Obtain/verify deterministic broker commission schedules by connection, symbol, quantity, currency and account type; compare against completed broker commissions and validate conversion into the same R denominator. Use robust recent and prospective data, never accidentally leak future commissions into entry-time decisions.
2. Build **shadow-only** all-in expected cost = conservative spread/slippage + independently predicted round-trip broker commission + fees/financing where relevant, with exact account-currency conversion and missing-data fail-closed semantics.
3. Quantify opportunity cost from the hypothetical extra cost floor using timestamped, decision-time predictions, **independent chronological holdouts**, post-fee expectancy, drawdown, and frequency/coverage changes. Do not assume avoided historical losses are causal realized savings.
4. Validate entry-to-exit model calibration by route and engine, including standardized initial broker cash-risk R, non-overlap diagnostics, counterfactual exits, and held-out market regimes.
5. Only consider a separately reviewed, cTrader DEMO-only A/B execution policy after the shadow study shows robust benefit. Never bypass current spread, governance, portfolio, risk, broker or lot gates. No LIVE rollout.

## Safe invocation

From `apps/api` on the VPS with compiled modules, installed dependencies and protected runtime variables in the process environment:

```bash
node scripts/audit-commission-r-calibration-gap.cjs
```

Uses `VPS_FOREX_SCANNER_USER_ID` and `M1_TACTICAL_MARKET_DATA_CONNECTION_ID`. Optional `COMMISSION_R_AUDIT_SINCE` ISO timestamp, defaults seven days. Never put real account credentials in Git. Test with `jest src/modules/ai/commission-r-calibration-gap-audit.spec.ts --runInBand`.
