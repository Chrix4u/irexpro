# iRexPro: broker-native historical tick first-touch research

11 November 2026 — Pepperstone cTrader DEMO research only. No new entry, exit, risk, or LIVE authority.

## Why
Our prior M1 quote-close analysis cannot determine whether a projected profit target is touched BEFORE an original stop loss. The broker quote candle table preserves close-side bid/ask but not historical price sequencing. The 17 deduplicated USDJPY loss-streak-brake episodes with favorable 10-minute average mark are NOT proof that any original stop could have survived. Native tick ordering is necessary for research into this question.

## Broker protocol
Spotware cTrader Open API 2145/2146 supplies native bid and ask tick history separately. The first returned item has an absolute Unix millisecond timestamp; later items carry backwards-relative millisecond differences. Tick prices are scaled by 100000. Tick arrays are newest-first. The hasMore flag requires additional pages; our first version rejects incomplete pages and requires manually narrower windows. The cTrader service already enforces the official 5 historical requests/second limit. The provider permits up to seven days per request, and our DEMO research request deliberately limits each range to 12 minutes, already in the past.

Official documentation:
https://help.ctrader.com/open-api/symbol-data/
https://help.ctrader.com/open-api/messages/
https://help.ctrader.com/open-api/model-messages/

## Implemented
- CTraderAdapter.getHistoricalBrokerTicksForResearch: an explicit DEMO-only internal broker-history read; not part of IBrokerAdapter, not exposed to a controller, not called by the AI scanner, and unavailable in LIVE mode.
- Bounded account-authorized 2145 requests for BID and ASK followed by a complete 2146 check. Refuses truncated, missing, malformed, unpaired or stale evidence. No new broker permissions.
- Pure first-hit evaluator uses ASK for BUY hypothetical entry and BID for BUY exit, and BID for SELL entry and ASK for SELL exit; returns TARGET_FIRST, STOP_FIRST, NEITHER_WITHIN_HORIZON, AMBIGUOUS_SAME_MILLISECOND or INSUFFICIENT_TICK_EVIDENCE.
- Tests using a fake Spotware connection verify both quote-side requests, response shape, hasMore refusal, LIVE refusal, no order calls, and correct first-hit order including equal-millisecond ambiguity.

## Limitations and next step
This source addition does not backfill market history or train/promote models. A historical first-touch result is not proof that a real order would fill there; broker SL trigger method, slippage and spread must also be tested. No model is promoted using only two independent trading days. Keep the working six-pair DEMO champion and all LIVE protections unchanged. Backfill short, complete BID/ASK windows for each selected USDJPY rejected signal through this new read path, match the exact persisted as-of SL/TP geometry, and evaluate first-target-before-stop out of time before changing the streak brake.
