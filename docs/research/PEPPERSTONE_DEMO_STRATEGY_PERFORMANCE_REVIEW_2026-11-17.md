# iRexPro strategy performance review, Pepperstone USD DEMO

Read-only verified review at 2026-11-17 03:07:33 UTC. Since 2026-11-16 23:36 UTC: 12 independent positions, 11 closed (7 winners, 4 losers), one open. All 11 completed have broker-reconciled P&L and fees. Gross realized USD +240.56; commission −144.66; swap 0; final after-cost net **+$95.90**. Closed-trade after-fee profit factor about 1.37, with realized-equity drawdown reaching $120.81. Not evidence for LIVE qualification.

Confirmed Reversal: 9 closed, 6 wins / 3 losses, net **+$185.93**, plus one open AUDUSD SELL 1.72 lots. Early Transition: 2 closed, 1 win / 1 loss, net **−$90.03**. Guarded Trend Continuation: zero actual broker entries, cannot measure. Original four-trade advisory net −$57.90; continued trial six completed trades net +$154.22; separate PRIMARY_PLAN_B Confirmed Reversal 0.01-lot trade net −$0.42.

Tighter 65/75/80% after-fee protection produced verified close requests and subsequent settled trades AUDUSD BUY **+$30.96** and USDCAD SELL **+$80.79**, combined **+$111.75**. Both logs say old 55%-of-peak retention would still have held at the instant of decision. This does not establish a hypothetical later fill or prove that new policy is superior over more trades.

Main positive: USDJPY SELL reversal net +$150.53. Main losses: earlier USDJPY BUY transition −$120.81; AUDUSD SELL reversal −$99.68 (exit at original SL); EURUSD SELL reversal −$39.16 (AI close). The 0.01-lot PRIMARY_PLAN_B execution route requires separate sizing examination, not blanket 3–4 lot forcing against broker-margin/0.25%-risk restrictions.

At 03:07:33 UTC the one open AUDUSD SELL had an observed gross P&L of about −$53.32. It is *not* realized, fee-adjusted P&L. Continuous DEMO trial has no cumulative trade quota/expiry; no new trade gate or LIVE alteration is authorized by this review.

The owner-scoped read-only script `apps/api/scripts/audit-pepperstone-continuous-evidence.cjs` now counts distinct PRIMARY_PLAN_B trades in their own cohort rather than omitting them. Six Node tests passed; refreshed private report is at `/home/lightworld/webapps/irexpro-research/continuous-evidence/latest-report.json`.
