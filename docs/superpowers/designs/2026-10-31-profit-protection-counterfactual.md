# Profit Protection Counterfactual Tracer

## Goal
Persist a research-only answer to: after a cTrader DEMO trade was closed by PROFIT_PROTECTION, did its original TP or original SL get reached first?

## Method
- cTrader DEMO PROFIT_PROTECTION trades only.
- Mature after a 4-hour post-close horizon.
- Use the same broker connection's `market_data.provider_quote_candles`, timeframe M1, source `ctrader-broker-native`.
- Exclude the partially completed close minute; start from the next full M1 bucket.
- Preserve original TP and SL from the closed trade.
- Classify first barrier: `TP_FIRST`, `SL_FIRST`, `AMBIGUOUS_SAME_M1`.
- If no barrier: `NEITHER_4H` only when the M1 path has adequate continuous coverage; otherwise `DATA_GAP`.
- Persist in `trading.post_entry_shadow_observations` using checkpoint 240 and artifact `profit-protection-counterfactual-v1`.

## Safety
`post_entry_shadow_observations` enforces `execution_authority='NONE'` and `modifies_execution=false`. This tracer has no execution dependency and cannot close or alter positions.
