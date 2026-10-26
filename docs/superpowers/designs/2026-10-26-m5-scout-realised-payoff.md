# M5 Scout Realised-Payoff Governor

## Goal
Keep the higher PAPER participation rate while preventing a specific M5 scout generation from continuing to spend capital after enough live outcomes prove that generation unprofitable.

## Design
Evidence is isolated by exact `trade_intents.model_version`; generations never share payoff history. Fewer than 6 closed trades stays COLLECTING and does not reduce participation. At 6+ trades, PF >= 1.0 remains healthy; PF 0.75-<1.0 with negative net P/L reduces the scout cap to 0.05 lots; PF < 0.75 with negative net P/L makes that scout generation SHADOW_ONLY. Zero-loss positive cohorts are healthy. Invalid/missing evidence fails to COLLECTING rather than fabricating negative performance.

The governor is applied only after a scout wins the normal scan. It cannot create an entry, relax event/cost/drift/portfolio/post-loss/broker controls, or change non-scout NORMAL_PAPER and M1 authority.
