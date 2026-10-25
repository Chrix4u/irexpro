# PAPER Shadow Local-Edge Scout Design

## Goal
Increase PAPER participation in empirically profitable local market pockets without globally lowering confidence, consensus, drift, calibration, or risk controls.

## Evidence
Resolved active-policy M5 shadows show broad TREND_CONTINUATION is negative, so blanket threshold relaxation is unsafe. However exact instrument/direction/session/adaptive-state pockets with >=20 samples, PF >=1.20, average >=+0.10R, and positive recent-8 evidence contain repeatable edge. Several profitable pockets are globally OOD/dislocated and remain profitable even when global net-R/calibration vetoes them.

## Authority
A local pocket is `SUPPORTED` only when all historical criteria pass causally using outcomes resolved before the current evaluation time. The scout may override soft global admission/drift/net-R/calibration vetoes at micro PAPER size. It never overrides macro event risk, unusable execution costs, portfolio/risk capacity, mature losing route/pair-side reliability, post-loss confirmation, entry-market geometry, SL/TP, or broker/risk engine controls.

## Candidate floors
- Strategy route: TREND_CONTINUATION only.
- Confidence >= 0.60.
- Consensus >= 4 votes.
- Trade quality >= 0.30.
- Exit quality >= 0.30.
- PAPER lot cap: 0.10, RESEARCH risk tier.
- Direction quality and aligned momentum are diagnostic only for this lane because the profitable local-pocket cohort frequently has low global direction quality and adverse short-horizon momentum.

## Historical pocket support
- Exact samples >= 20.
- Profit factor >= 1.20.
- Average net outcome >= +0.10R.
- Recent window = latest 8 resolved outcomes.
- Recent wins >= 5/8.
- Recent net outcome > 0R.
- Active decision-policy version only.
