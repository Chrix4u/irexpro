# As-of two-sided M1 entry arbitration: retrospective audit v3

Date: 19 November 2026. Lightworld iRexPro, owner Pepperstone USD DEMO
only. No live execution changes. Reproducible read-only command:

```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/research/m1-entry-asof.test.cjs
node scripts/audit-owner-demo-entry-disagreement.cjs 4
```

## Corrected causal availability

The first retrospective opposite-side M1 audit could read a same-bar
opposite decision that was actually persisted AFTER the filled order.
A same M1 bar timestamp does not prove the decision was available.
The v3 audit now selects only an opposite-side M1 decision whose
`evaluated_at` and `created_at` are both <= the actual order opened_at,
and requires the executed-side M1 decision was created <= opened_at.
Later opposite-side decisions remain *audit-only*, not pre-entry signals.

At 2026-11-19 ~18:23 UTC, 200 fully-settled Pepperstone USD DEMO
trades closed over four days were examined. 135 had opposite-side M1
decision available before entry, while 65 had their opposite-side
decision saved only after entry. Thus the earlier retrospective
'dual abstain' count was inflated by look-ahead.

## Measured candidate, before any executable authority

Actual, already-settled trades with both sides known ABSTAIN AT ENTRY:
- Confirmed Reversal: 72 trades, 38 net winners, actual net -$693.69.
- Early Transition: 30 trades, 21 net winners, actual net +$57.43.

'Don't enter a trade when both M1 sides abstain' is therefore NOT a
universal strategy: it would miss actual Early Transition profits.

The read-only omission calculation reports positive winnings that a
hypothetical skip would forgo **separately** from losses it would avoid.
This is NOT a counterfactual broker fill or executable no-trade policy.
Chronological day grouping at the audit snapshot:
- Confirmed Reversal early days: skip 22 actual trades, miss 13
  profitable trades ($558.67), avoid 9 losers ($569.18), theoretical
  difference +$10.51.
- Confirmed Reversal later days: skip 50 actual trades, miss 25 winners
  ($667.56), avoid 25 losers ($1,350.74), theoretical +$683.18.
- Early Transition early days: +$1.85 omission difference;
  later days: -$59.28 (more winners would have been forgone).

This is hypothesis generation only. Adjacent trades are correlated,
strategy code and market regimes changed, and no independent unseen
prospective evaluation has occurred. No recommendation is being made
to block all Confirmed Reversal executions on this evidence alone.

## Reproducibility and guardrails

Pure `evaluateM1AtEntry` checks both persistence and evaluation time.
`theoreticalNoEntryOmission` keeps winning opportunity cost distinct
from avoided losses and asserts `executablePolicy:false`.
Seven Node tests cover the before/after-order boundary, future
evaluation timestamp, missing input, genuine opposite signal and
the accounting of missed wins versus avoided losses.

Next evaluate route- and symbol-specific conditions with broker-native
spread and contemporaneous H1/H4 alignment using chronological holdout
periods. Keep labels separated from decision-time features and do not
infer an opposite BUY fill from a SELL loss.
