# iRexPro — M1 drift study: label-selection and provenance audit

**November 19, 2026.** Research only. No model or execution policy change.

## What the source review established

The existing ordinary M1 15-minute shadow outcome study
(`M1TacticalEvidenceService.loadMatureShadowEpisodeLeaders`) is
*selective*. It requires `execution_authority='NONE'` and one of:
`shadowOutcomeEligible=true`, no blockers, or a sole
`M1_PHASE_SHADOW` blocker. It groups contiguous candidate minutes into
episode leaders using a >5-minute gap.

Consequently, a generic comparison of its labeled NORMAL and
OUT_OF_DISTRIBUTION rows does **not** sample all rejected drift events.
Missing ordinary shadow labels among drift-blocked decisions are
structural, not random. Neither high apparent win rates nor a
statistically significant mean could justify removing the drift gate.

The independently existing drift-counterfactual worker
(`loadPendingDriftCounterfactuals`) explicitly selects blocked
out-of-distribution and stressed candidates. It samples the earliest
eligible candidate **per instrument per fixed UTC 16-minute bucket**,
not separately for each BUY/SELL or Plan B route. Additional Plan B,
expert, broker, and other blockers may remain. Its output is persisted
under `governance.driftCounterfactual15m`, not
`governance.shadowOutcome15mV1`.

Both workers call `evaluateM1CausalOutcome15m`, which evaluates the
next 15 completed M1 OHLC bars and resolves stop, target, or terminal
mark-to-market outcomes. It does not prove a broker fill, actual spread,
commission, slippage, or margin availability. Sharing an evaluator
does **not** make their different samples interchangeable.

## What PR #745 does

- Reports ordinary-shadow and drift-counterfactual samples separately,
  never joining their net-R observations as though they were
  identically sampled.
- For rejected-drift counterfactuals, validates artifact version,
  original drift state, source, completed 15-minute horizon,
  time-consistency, and gross-minus-cost arithmetic.
- Reads decision-time spread-cost provenance from the recorded
  governance. Labels without broker-observed P90 cost stay explicitly
  in the non-comparable category.
- Distinguishes outcomes for which drift was the only substantive
  recorded blocker from cases with independent other vetoes.
- Reports raw rejected directional decision count, the number with
  settled counterfactual artifacts, valid labels, and missing labels.
- Maintains a same-source ordinary-shadow matched-day comparison with
  low-coverage and small-sample warnings. It is **descriptive only**.

## What the research cannot conclude

1. No evidence that normal and rejected trades would have the same
   fillability, order cost, or realized dollar P&L.
2. No proof that removing `DRIFT_OUT_OF_DISTRIBUTION` alone would
   permit an order: multiple other blockers frequently coexist.
3. No independently tested new drift threshold or retrained model.
4. No sound claim of profitability or readiness to promote LIVE.
5. No conclusion about all Forex signals from this owner's USD DEMO
   subset.

## Next safe validation

After authorized VPS access is available, run:

```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node scripts/audit-owner-demo-drift-outcomes.cjs 3
```

Read `rejectedDriftCounterfactuals` **separately** from
`matchedDriftDays`. A credible policy experiment should create
prospective paired quote outcomes with the *same* source timing,
selection rule, cost model, and complete instrument/side coverage before
comparing NORMAL versus OOD. Validate any retrained/recalibrated
candidate on unseen later market days; use settled broker DEMO after-fee
outcomes for final execution decisions.

This file is explanatory. PR #745 does not deploy to the VPS, retrain,
place trades, alter broker stops or grant trading authority.
