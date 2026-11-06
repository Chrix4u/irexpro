# cTrader DEMO no-trade: recover drift-episode research and clarify real blockers
Date: November 6, 2026. Observability only; no new order authority.

## Live evidence and the actual obstruction

The mobile UI displayed MULTI-MODEL ACTIVE, DEMO FULL AUTO,
no qualified strategy route (TREND_EXTENDED), shadow challenger
UNAVAILABLE, readiness 64, and a model-drift execution veto.

Read-only exact-connection data for the preceding 3 hours:
178 non-ABSTAIN proposed entries across AUDUSD/EURUSD/GBPUSD,
117 OUT_OF_DISTRIBUTION, 41 STRESSED and 20 NORMAL drift states,
only four Plan-B paper-admitted, and 80 PAPER_NET_EXPECTED_R
vetoes. Main drift failures: extensionAtr HARD_HIGH (106) and
rsi14 HARD_LOW (55). Several admitted candidates also failed
after-cost expectancy, and an otherwise admissible idea failed
the existing DEMO broker-commission entry veto.
A readiness meter is never a broker authorization or a profit signal.

The separate shadow-expert UNAVAILABLE reason was
BROKER_MARKET_DATA_UNAVAILABLE, meaning its required broker-native
multi-timeframe price history was missing, not that the main M1
cTrader feed was necessarily unavailable.

## Defect recovered

The existing drift counterfactual collector included only
nonexecuted drift-rejected proposals WITHOUT other substantive
blockers. This inadvertently excluded nearly all of the
market conditions we need to learn. In the five-hour audit, 304
of 359 non-ABSTAIN decisions had a drift veto, but zero had a
saved driftCounterfactual15m research result.

## Narrow repair

1. Include all nonexecuted drift-rejected proposals in the
   research-only cohort, even if Plan-B admission, economics,
   timing or another condition also failed.
2. Choose the earliest drift proposal per instrument and
   fixed UTC 16-minute bucket. Rank ALL rows, including already
   settled ones, before checking whether the bucket leader still
   needs a counterfactual result. This prevents duplicate
   independent samples when scans repeat.
3. Limit to the most recent 48 to 16 minutes, maximum eight
   episode leaders per pair, so the fixed 60-bar completed-M1
   buffer can supply causal 15-minute observations. Keep
   original stop/target geometry and the existing conservative
   outcome calculation.
4. Save whether multimodel or generic governance detected drift,
   its original diagnostic labels, and the list of OTHER blockers.
   Do not infer that removing drift would authorize a trade.
5. Update the UI to give priority to actual Plan-B nonadmission,
   after-cost economics and account vetoes rather than showing
   the secondary drift warning as the sole reason. Expose the
   shadow expert broker-history availability reason.

A read-only production-scope database query found seven
candidate episode leaders within the correct maturity window
(AUDUSD 2, EURUSD 3, GBPUSD 2) to be collected after release.

## Safety boundary

Changes are limited to nonexecuting evidence collection and
presentational wording. Execution, ensemble admission, actual
model weights, commission and slippage rules, lot sizing,
broker credentials, kill switch, stop-losses and risk gates
remain unchanged. This repair DOES NOT automatically make
unprofitable ideas executable. Any later DEMO promotion needs
positive untouched, after-broker-cost out-of-time evidence.
