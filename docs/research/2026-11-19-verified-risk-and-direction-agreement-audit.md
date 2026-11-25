# iRexPro — verified stop-risk normalization and M1 direction agreement

19 November 2026, owner Pepperstone USD DEMO only. READ-ONLY research.

## Correction to delayed M1 timing study

The v2 matched-exit comparison inferred original stop-risk in account
currency from a price movement and gross settlement ratio; this can
disagree materially with the authoritative capital-allocation risk.

Example owner USDCAD SELL trade
`0c2be108-00b6-4877-8bd4-3455c74b81e0`:
- Actual broker-reconciled gross +$26.56, commission -$12, net +$14.56.
- Actual original `trading.capital_allocations.sizing_inputs.finalRiskAtStop`
  $69.88120195, **not** the previous inferred $88.07.
- The actual net result is approximately +0.208R, not +0.165R.
- Indicative next-bar entry 1.43110 versus original SELL 1.43089,
  a 2.1-pip better quote, with original broker close 1.43070.
- The matched same-exit research is *not executable P&L*. The original
  broker settlement establishes approximate account-currency gross
  per price unit; same original lot/fees/close and no intervening SL/TP
  are counterfactual assumptions. Quote opens are not broker fills.

Version `m1-confirmed-delay-stop-parity-shadow-v3-verified-risk`
retains v1 and v2 historical records separately and uses the verified
capital allocation. It refuses to estimate a delta if the original gross
P&L sign contradicts price movement, original movement is too small,
original risk is missing, quotes are incomplete, or an intervening
hypothetical stop/target is touched. Records remain
`execution_authority=NONE`, `modifies_execution=false` and
`modelTrainingStatus=RESEARCH_ONLY_NOT_TRAINED`.

## Independent M1-side agreement audit

Read-only CLI:
`cd apps/api && node scripts/audit-owner-demo-entry-disagreement.cjs 4`

The script is scoped to the owner Pepperstone USD DEMO broker, reads only
fully settled closes, records original entry metadata separately from
retrospective M1 opposite-side audits and future-dependent labels, and
splits days chronologically. It does not retrain models.

Owner USD DEMO November 17–19 close cohort at approximately 18:00 UTC:
- Confirmed Reversal 117 closes, 56 profitable, net -$2,046.21.
- Early Transition 61 closes, 39 profitable, net -$446.54.
- Trend Continuation 12 closes, 9 profitable, net +$309.11.
- Among 86 Confirmed Reversal trades both the executed direction
  and opposite M1 route abstained; net -$1,036.51. This is **not**
  evidence that the opposite order would have been executable or
  profitable.

A wider 4-day report as of 18:08 UTC contained 200 closes,
106 winners, net -$2,497.00. Adjacent M1 trades overlap and are not
independent trials. Very small route subsets are not proof that a
new entry policy will generalize.

## What must happen before changing authority

Use only immutable pre-entry inputs for directional/timing hypotheses;
use fee-settled closes, M1 quote paths, risk and stop/target quote
barriers as labels. Compare route- and symbol-specific hold-vs-delay
performance on independent unseen market days. Do not assign profitable
future closes to abstained BUY candidates, and do not auto-reverse.
Leave existing DEMO/LIVE execution authority and broker stops unchanged
until independent evidence justifies a specific policy update.
