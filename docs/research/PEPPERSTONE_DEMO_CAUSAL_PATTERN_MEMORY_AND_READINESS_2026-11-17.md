# iRexPro — overnight reversal losses, no-entry investigation, and causal pattern memory
17 November 2026 · all times UTC/Ghana.

## Confirmed overnight facts, read-only owner Pepperstone USD DEMO

At 10:05 UTC, **30 closed trades** since 00:00 UTC, **14 net winners, 16 net losers**, settled after-fee P&L **−$441.78**, commission **−$363.06**, **zero open**. The user's earlier approximations of 48,700 and 48,155 account value are not a precise same-time, same-basis equity ledger; do not claim their difference has been fully reconciled to the 30 completed trades.

Eleven losing trades had positive observed favorable floating P&L at some point; however, many barely moved in the desired direction. Actual notable cases (observed peak vs after-fee net):
- USDJPY BUY 00:44 peak +$72.20, net −$120.81 (earlier pre-fix giveback incident).
- USDJPY BUY 03:32 peak +$18.39, net −$124.87.
- USDJPY BUY 06:35 peak +$4.44, net −$120.95.
- AUDUSD BUY 07:14 peak +$27.52, net −$99.76.
- EURUSD SELL 07:00 peak $0.00, net −$97.90.
These are heterogeneous failure patterns; not a single reliably predictive signature.

## No orders after 08:11

At 10:05 UTC the active owner session was Pepperstone cTrader **connected / authorized DEMO FULL_AUTO**, but no positions had opened after the USDCAD 0.01-lot position closed 08:11:07 UTC. **920** pair-side decision records were logged from 08:11 to 10:05 with **no execution** (multiple correlated checks per pair, not 920 independent opportunities).

Overlapping blockers across those checks included 779 Plan-B not admitted, 711 drift out of distribution, 752 continuation timing not ready, 42 portfolio net-loss brakes, 23 multimodel loss-streak brakes. The 120-minute portfolio brake was still active near 10:01 after 3 consecutive losses and its 08:11 last-close anchor; some route-specific 12h brakes remained active much longer. 36 continuous advisory decisions were marked preliminarily ELIGIBLE but still faced final loss brakes or missing directional admission. At 10:05 no universally executable current setup was proven. **Neither increased readiness nor a green gauge is broker authority**, and the quality-lot overlay deployed at 09:53 did not create these historical model blockers.

## Confirmed dashboard defect and correction

The server correctly encodes continuous owner DEMO advisory pilot as `endsAt:null, maxEntries:null`. Browser M1 tactical status validator incorrectly demanded non-null values and discarded the *entire* genuine status. The UI then fell back to unrelated broad-scanner confidence, sometimes showing 90-100% TRADE READY. A separate null-decision bug treated `undefined !== "NONE"` as qualified quorum, labeling "QUORUM READY" while Plan B/experts were still awaiting an executable decision.

Web correction:
- Accept `continuousEvidence:true` only with both `endsAt:null,maxEntries:null`; limited pilots still require a valid date and positive integer limit.
- Never label absent, invalid or failed status as executable quorum.
- On connected DEMO without an authoritative tactical decision, show **Awaiting verified Plan-B decision — no trade authorized**, not a green fallback meter.
- Trial card accurately says *no scheduled expiry* and *no cumulative trade-count limit*. No broker risk or model admission changes.
- 60 readiness tests (plus trader UI regression) cover these and other real blocked cases.

## Pattern memory v1 (owner-scoped shadow research, no direction flips)

Existing system already persists every M1 tactical decision with candidate features, governance, blockers and durable signal/trade links, and stores broker profit-path snapshots and final fees. New **pepperstone-demo-causal-pattern-memory-v1** adds as-of pattern retrieval from **only already closed, settled** trades for exact owner, Pepperstone DEMO connection, instrument, direction and Plan-B route, over previous 90 days, max 100 records. The original entry vector is: model candidate score, extension/ATR, volatility, EMA separation, multi-timeframe strength, RSI.

Distance uses fixed expert-readable feature scales; <=0.24 averaged normalized discrepancy is "similar". Neighbor matches are deduplicated to **20-minute historical market episodes**, at most 12. Report matched episodes, wins/losses, average account-currency net R including commission and swap, positive-then-lost count, closest feature distance, and the hypothesis:
`INSUFFICIENT_MATCHED_HISTORY` (<4);
`POSSIBLE_FALSE_REVERSAL` / `POSSIBLE_FALSE_CONTINUATION` (>=4 matched episodes, >=75% losers, mean net R <= -0.20);
`REPEATED_FAVORABLE_PATTERN` (>=4, >=70% winners, mean net R >0.1);
or `MIXED_HISTORY`.

All latest candidates admitted or blocked with current Plan-B routes receive that **shadow-only** annotation in the tactical governance record; actual entries also carry memory provenance in immutable intent metadata. Missing history never authorizes a trade; the pattern flag is independent and owner-scoped. **No ML weights are retrained and no current broker BUY is flipped to SELL based on analogues**. This creates the causal recall/feedback dataset needed for later validated decision improvements without hindsight leakage.

Operator switch: `IREXPRO_PEPPERSTONE_DEMO_PATTERN_MEMORY=enabled` in `apps/api/.env` only after successful Nest build and unit/integration tests. Disable this switch and restart API to roll back the observer. Existing loss brakes and other risk protections remain fully active. No fixed trade count. Any future promoted pattern-based directional policy must be evaluated on independent out-of-sample trades and must not promote from correlated repeats alone.

## Future evaluation

Replay each historical decision using *only* data preceding its timestamp, calibrate analog similarity thresholds, compare false reversal versus true continuation rates including pips, broker spread and signed fees, and evaluate counterfactual direction as shadow. Separate 1/3/5/10-minute causal horizon outcomes; allow live demo directional authority changes only after the observed analogues demonstrate repeatable out-of-sample net benefit. A profitable reversal is not automatically a losing continuation's opposite. Do not promote to LIVE on this small sample.

## Verification notes

Production Next and Nest builds, read-only history query, scheduler integration, PM2 restart and logged pattern output must all pass before stating that these changes are deployed. Historical profit figures and no-entry blocker counts were read from the owner-scoped Pepperstone DEMO PostgreSQL records; user screenshots alone do not prove a broker trade.
