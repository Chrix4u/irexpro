# Prospective owner Pepperstone DEMO weak-reversal entry-cap outcome monitor

## Production rule and independent outcome boundary

Owner demo cap source change `60c868a4` was deployed at **2026-11-20 17:37:18 UTC**. The trade observer uses that already-established immutable activation timestamp (not the date this outcome code was written) and requires exact joined owner, broker connection, Pepperstone cTrader DEMO and USD account. It reads only broker-settled trade history and persisted pre-entry intent metadata; output belongs exclusively to `/home/lightworld/webapps/irexpro-research/weak-reversal-forward/latest-report.json`.

The audit cannot submit orders, close positions, change trading states, toggle a strategy, increase or decrease the currently deployed sizing rule, edit the risk model or alter any existing profit-protection process. Every database snapshot runs in `BEGIN ... READ ONLY` on a strict exact account scoped query, with 500-trade maximum. The output is written via atomic replacement to a private JSON file, and a separate PM2 read-only observer refreshes the report approximately every 45 seconds with bounded error handling.

## Explicit accounting

Group by the **frozen entry-time metadata**, NOT by post-exit price: `WEAK_CONFIRMED_REVERSAL_CAPPED`, `CONFIRMED_REVERSAL_UNCHANGED`, `OTHER_ROUTE_UNCHANGED`, or `PROVENANCE_INCOMPLETE_OR_INVALID`. Entries before 17:37:18 UTC are NEVER counted as new cap results. An OPEN trade is censored: it is neither a settled winner nor a settled loser. A CLOSED row with missing gross, commission or swap is a missing-economic outcome, not zero-fee profit. Settled P&L is actual broker `realised_pnl+commission+swap`, once per broker trade ID.

Every record also preserves source entry quality, actual filled lot, before/after ceiling, commission and recent loss warnings, broker close reason and path gross peak/giveback. Daily and route group summaries measure actual after-cost wins, losses, net, profit factor and three consecutive booked losses closing within 20m. These are monitoring indicators, not trading-circuit-breakers. Specifically there is **no conversion from reductions of requested lots to hypothetical dollars saved**, because changes in fills, spreads, stop triggering and execution prices were never observed as a counterfactual.

Minimum evidence for *even considering* independent review of the warning is 5 different opening days AND at least 20 actual settled capped AND 20 actual settled unaffected Confirmed Reversal positions; the flag itself is permanently non-promoting.

## First affected real broker outcomes

At the 18:04 UTC review, two new Confirmed Reversal trades recorded `cap_applied=true` with seven lots requested maximum but four-lot allowed maximum:
- USDJPY BUY opened **17:55:18 UTC**, actually filled **4.00 lots**. Broker `BROKER_CLOSE` at **18:02:38 UTC**, gross -$120.97, fee -$24.00, **settled -$144.97 net**, broker-observed positive gross peak +$15.71. M1 `ABSTAIN`, trained expert `ABSTAIN`, prior fee p90 warning `AFTER_BROKER_FEES_BELOW_FLOOR` (as-of after-fee expected R -0.024825); original quality multiplier 0.35.
- AUDUSD BUY opened **18:00:50 UTC**, actually filled **2.41 lots** after downstream existing sizing, broker `BROKER_CLOSE` at **18:03:37 UTC**, gross -$98.81, fee -$14.46, **settled -$113.27 net**, broker-observed gross peak $0.00. M1 `ABSTAIN`, expert `ABSTAIN`, broker p90 after-fee expected R +0.052116, which is **below** required +0.08, and M5/H1 evidence **against**. Entry quality multiplier 0.35.

Combined first two actual post-cap Confirmed Reversal settlements = **-$258.24 net**, both losses. The open USDCAD BUY `TREND_CONTINUATION` 0.20-lot position was not capped; its eventual broker outcome is unknown while OPEN. **This sizing feature lowers the requested exposure on some already weak trades, but has not established an entry edge and has not stopped actual losses. Do not promote to real money.**

The future research question is whether a pre-entry, **frozen independent fee shortfall + weak model timing + higher-timeframe/recent-performance conflict** can distinguish losing from winning admissions over multiple new days without choking healthy opportunities. A shadow-only hypothesis may be added, but only post-activation, tracking false-positive blocked winners explicitly.
