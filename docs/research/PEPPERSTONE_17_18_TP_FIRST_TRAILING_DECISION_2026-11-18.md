# Pepperstone DEMO profit protection, first TP and trailing-stop research

**As of 18 November 2026, 11:32 UTC/Ghana time. Research only: no trades, stop amendments, lot changes or LIVE authority.**

## Settled profit-protected trades, 17–18 November

Scope is the exact owner, Pepperstone cTrader USD DEMO, closed PROFIT_PROTECTION positions, Early Transition and Confirmed Reversal only. Broker trade fill, exit, original stop/TP, lots, gross, signed commission and swaps are all recorded.

- 49 actual profitable closes with **+$1,553.13 net** booked.
- Early Transition: 23, +$774.15 net; Confirmed Reversal: 26, +$778.98 net.
- 17 Nov: 38, +$1,285.53; 18 Nov: 11, +$267.60.
- Best booked net win +$98.68. Peak P&L is not booked net profit. Other route losses outweighed protected gains.

## After the actual profit exit, which barrier was seen first?

Independently stored roughly two-second native Pepperstone quote-poll snapshots have separate market timestamp and receipt timestamp. 275,666 archived records inspected; 172,993 records accepted for the four permitted instruments across relevant days. A BUY exit uses BID; a SELL exit uses ASK. The audit checks observed crossings of the ORIGINAL TP/SL and counts the first observed level at fixed horizons.

| Time after actual profitable close | First observed original TP | First observed original SL | Neither observed | Not mature |
|---|---:|---:|---:|---:|
| 15m | 11 | 3 | 35 | 0 |
| 30m | 15 | 10 | 24 | 0 |
| 60m | 18 | 15 | 16 | 0 |
| 120m | 25 | 16 | 8 | 0 |
| 240m | 28 | 19 | 1 | 1 |

**Never call these broker-confirmed TP fills.** The polling stream has intervals with no ticks, so the first observed crossing might not be the true first crossing. At 120m, 20 of the 25 first-observed TP paths had maximum quote gaps of at most 20 seconds before their first event; only 7 had every gap at most 12 seconds. Independently comparing the broker-native sampled MIDPOINT M1 candles, 22 of the 25 had no opposite stop wick in the completed subsequent minutes, one had a possible earlier stop wick, and two reached the TP in the fractional exit minute. Side-specific intrabar highs and lows, continuous ticks, fills and the fractional minute remain unverified.

## What is active?

The owner DEMO tiered broker-net PEAK retention currently has tiers 65% after 0.50R, 75% after 0.75R and 80% after 1.00R. A separately enabled progressive TP-relative overlay can tighten this to approximately 86–91% near TP. When the protector triggers, it closes the WHOLE position at market; **it does not amend a positive broker-side trailing stop**. The pre-existing protected-runner and independent stop-readiness checks are SHADOW ONLY after the close request.

Since 17 November, independent trend-recheck metadata has 50 CLOSE_CANDIDATE observations: 49 THESIS_NOT_EXECUTABLE and one NO_THESIS. The current trend adviser has NOT authenticated a qualified HOLD. Of the last four observable owner DEMO tiered/progressive close logs, three said the tier-only retention would not have closed the position at that specific instant; that is not a fill or profitability backtest.

## Owner's 50/65, 60/70, 80/75 proposal

A ratcheting hypothetical stop preserves the chosen fraction of the highest OBSERVED favorable price movement once the position reaches 50%, 60%, or 80% of its original fill-to-TP distance, respectively. Stop is checked against a subsequent quote, never the same input quote. Indicative returns re-use actual signed commission/swap and include an extra 0.5 pip execution sensitivity; live conversion, fills, stop minimum distances, amendment acknowledgment and latency remain unknown.

Replacing the original profit close with this naive full trailing rule was worse on 12 of 19 frequent-quote sampled path comparisons and better on seven (indicative combined -$185.10). **Do not activate that policy as a wholesale replacement.**

A safer hybrid keeps the actual booked close if a valid positive proposed broker stop cannot ALREADY be computed at that close with fresh quote and distance/headroom safeguards. On the small selected quote sample:

| Shadow hybrid policy | Candidate trades | Frequent quote paths with observed events | Better / worse | Indicative difference |
|---|---:|---:|---:|---:|
| 50/65, 60/70, 80/75 | 5 | 5 | 1 / 4 | -$56.27 |
| More patient 70% TP with 55% retention, 85% with 65% | 4 | 3 | 3 / 0 | +$91.66 |
| 80% TP with 60% retention only | 2 | 2 | 2 / 0 | +$47.16 |

**Three favorable observations are not a proven trading edge.** Each backtest has sampling gaps, zero assumed amend latency, reused fees and unknown real broker-side fill prices. The positive patient-sample differences are exploratory and not a reason to activate stops without additional forward-session evidence.

## Adverse-cut experiment

Five recently closed owner-DEMO AI_CLOSE_SIGNAL positions had explicit PERSISTENT_ADVERSE_CUT action logs on 18 November. Within one hour after those closes, two first observed original TP and three first observed original SL. Actual booked combined -$253.73. Hypothetically, the five originally configured bracket prices with the same booked fees and an extra 0.5 pip would yield -$50.91, a +$202.82 indicative difference. This is not a continuous tick or executable fill replay, nor evidence that turning off early-cut always helps; the three stop-first scenarios could grow losses.

The current cut has no reliable independent reversal-vs-temporary-pullback confirmation and can forfeit recoveries. The switch is reversible, exact owner DEMO scoped; retain the original broker SL/TP.

## Decision and verification gates

1. Do **not** change Early Transition / Confirmed Reversal lot allocation, model weights or entry authorization, as the owner requested.
2. During a reversible owner-DEMO comparison, disable the recent adverse-cut experiment while preserving broker SL/TP. Risk: future losing trades may run farther to original stop.
3. Temporarily disable only the EXTRA aggressive TP-progressive overlay, while retaining the existing tiered profitable exit and original broker SL/TP. Risk: some already-booked winnings may be given back. Compare prospective after-cost outcomes before claiming improvement.
4. Keep all protected-runner broker amendments research-only until actual cTrader symbol tick and minimum-stop verification, exact provider position ID, acknowledged stop amendments, idempotent persistence and reconciliation are proven.
5. A future entry/exit continuation expert must be causal at the actual decision time, with M1/M5 quote freshness, independent directional consensus, after-fee economics, and real SL/TP order sequencing. The as-of shadow currently rejects every HOLD candidate; do not override the actual profit lock with that unverified signal.
6. No LIVE promotion unless multiple independent days show consistent net after-cost profit, reasonable losing tail, and acceptable drawdown.

## Reproduce on authorized VPS

Run both from apps/api under the installed repo: node --test scripts/audit-owner-demo-protected-profit-tp-trailing.test.cjs ; node scripts/audit-owner-demo-protected-profit-tp-trailing.cjs .

Detailed trade-level observations, gaps, conservative M1 wick corroboration and trailing-policy scenarios are stored privately (0600) at /home/lightworld/webapps/irexpro-research/profit-lock-tp-trailing/latest-report.json. No personal broker identifiers or detailed trade IDs are committed. All source changes here are research-only.
