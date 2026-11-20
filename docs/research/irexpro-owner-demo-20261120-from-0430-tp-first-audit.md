# iRexPro — did the 04:30–07:06 Ghana Pepperstone demo winners reach TP first?

**Forensic audit performed 2026-11-20 at 07:09:29 UTC/Ghana**, using exact owner Pepperstone cTrader USD DEMO positions **opened from 04:30 to 07:06**. The eleven positions were settled by the review, and the broker-native archived bid/ask continuation was observed to **07:09:29**. No broker orders or settings were altered.

## Broker-settled results

11 closed positions: **6 actual net winners, 5 losers, -$309.58 net USD after commissions and swap**.

- 6 `PROFIT_PROTECTION` closes: **+$289.19** net.
- 3 `AI_CLOSE_SIGNAL` closes: **-$153.58** net. Two were `BROKER_ADVERSE_PROTECTION` rescue, one `DEMO_DRAWDOWN_GUARD` per independently recorded `TRADE_CLOSE_REQUESTED`.
- 2 `BROKER_CLOSE` closes: **-$445.19** net.
- None of the positions has a definitive original TP-trigger exit in the stored provider reason. All signed `TRADE_CLOSED` audit metadata had `providerCloseReason=UNKNOWN` and use app-close-intent fallback or generic provider close where applicable. **Do not claim we have a proven full broker TP/deal trigger count.**
- Original target was **not sampled as reached before actual broker closure** in the ten trades with adequately complete preclose bid/ask paths. One EURUSD SELL preclose sample was incomplete. The ordinary app close reasons are not TP.

## After PROFIT_PROTECTION: which original TP or SL appeared first?

The first sampled original target/stop AFTER the actual profit-protection closure, in chronological order:

| Opened GMT | Trade | Actual net | Observed ORIGINAL TP vs ORIGINAL SL if still held | Last-recorded TP/SL sensitivity |
|---|---|---:|---|---|
| 04:45 | AUDUSD SELL | +$41.88 | **Original SL first** at ~06:07 | Modified SL crossed earlier, ~05:55 |
| 04:48 | USDCAD BUY | +$56.88 | **Original SL first** at ~06:30 | Modified SL first too |
| 05:25 | AUDUSD SELL | +$107.04 | **Original SL first** at ~05:53 | Modified SL first too |
| 06:01 | USDJPY BUY | +$28.08 | **Original TP first** at ~06:22:42; original SL ~06:34:45 | Last-recorded TP first ~06:06:47, no last-recorded SL crossing seen |
| 06:33 | EURUSD BUY | +$8.90 | **Inconclusive first-hit path**; no recorded barrier crossing | EURUSD archive had a ~136-second gap |
| 06:39 | EURUSD SELL | +$46.41 | **Inconclusive first-hit path**; no recorded barrier crossing | Postclose archive started ~113 seconds late |

**Defensible sampled first-hit count among six winning profit-protection trades: 1 TP first, 3 SL first, 2 incomplete/unclassified.** All four classifiable first-hit paths have source/capture clocks checked (max quote delay 15sec), close-side bid (BUY) or ask (SELL), first/last quote within 30sec of path edges, and no adjacent source gap larger than 60sec. The observed complete paths in fact mostly had <17sec maximum gaps.

The two incomplete EURUSD paths do **not** prove TP. A supplementary check against the exact owner connection's **35 broker-native EURUSD M1 price candles covering 06:35–07:09 GMT** found the recorded mid-price low **1.09835** and high **1.09891**. The two EURUSD original targets were **BUY 1.09930** and **SELL 1.09786**, both beyond the observed M1 high/low band; the two original stops were BUY 1.09800 and SELL 1.09916, also outside this band. These candles provide corroborating price-range evidence that **neither barrier appears reached**, not proof of a contiguous executable bid/ask sequence.

## Other important trade

`USDJPY BUY` opened **05:25**, closed by `BROKER_ADVERSE_PROTECTION` at **-$22.17** at 05:38. This position subsequently had an **original** target sampled ~06:06:01, without an earlier crossing of the **original** SL 159.078. But the **last-recorded broker stop 159.088** was sampled at ~05:43:27, before the **last-recorded TP 159.218** at ~06:06:30. Hence it is **NOT defensible to score that loser as an unambiguous missed TP winner** under the broker-adjusted levels.

The two `BROKER_CLOSE` losers (AUDUSD at 05:40 and 06:27) generated **-$245.67 and -$199.52**, respectively. `USDJPY SELL` at 06:48 closed by AI guard -$120.96. The actual high-lot downside is more material than a claim that most winning positions needed longer holding.

## What we can and cannot conclude

- The data **does not support blanket disabling or delaying profit protection**. On four full sampled after-close paths, only one original TP appeared before the original SL and three original stops appeared before targets.
- The clearest **research candidate for a too-early win closure** is the USDJPY 06:01 BUY. It did reach sampled TP after the actual +$28.08 profit protection, and original/last-recorded TP-first classifications agree. That is **not a guaranteed executable missed profit** because historical order execution costs, spread, active stops, actual fill timing and unknown unsampled ticks are not proven.
- All market path first-hit labels are **sampling observations, not actual broker TP/SL deal events**; native bid/ask snapshots may miss intrabar crosses.
- A quote at or beyond a target after closure does not establish how an actual kept-open position would have been margined, stopped or filled.
- Actual provider reasons are **UNKNOWN** in the closed-trade audit, so the definitive actual-broker TP count is **not independently provable** from those metadata alone.
- No change to existing live trading, owner-demo higher-lot trial, noon expiry, profit-lock, exit guard, or stop/target policy.

## Reproduction

Read-only, exact-owner forensic script:
`apps/api/scripts/audit-owner-demo-20261120-0430-tp-first.cjs`

Run under `apps/api`:
`node scripts/audit-owner-demo-20261120-0430-tp-first.cjs`

Private latest result:
`/home/lightworld/webapps/irexpro-research/exit-payoff/latest-nov20-from-0430-tp-first.json`

Tests: `apps/api/scripts/audit-owner-demo-20261120-0430-tp-first.test.cjs`. The script's as-of time advances when re-run, so its results may change if new positions open or additional quotes arrive; the **fixed 07:09 GMT results above** are the audit snapshot being reported to the owner.

**Next:** prospective shadow-only conditional hold/runner research for scenarios similar to the 06:01 USDJPY winner, with positive protected stop, independent candle confirmation, broker minimum-stop-distance and fee/spread availability, full stop-before-target quote replay and explicit lost-winner downside costs. Avoid blanket delayed exits while larger-lot demo trial is in flight.
