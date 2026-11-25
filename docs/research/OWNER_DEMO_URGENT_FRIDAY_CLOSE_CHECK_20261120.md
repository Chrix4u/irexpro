# iRexPro — Friday 20 November 2026 urgent pre-weekend DEMO check

**Checked live between 20:57:27 and 21:00:30 UTC (Ghana time).** Primary retail spot FX week normally closes at Friday 17:00 New York = **22:00 UTC** in November, subject to individual Pepperstone instrument hours. This is a pre-close inspection, not a promise that an order will open before cutoff.

## Confirmed real-time health

- Trading API `irexpro-api-staging` online, unchanged PID **2797464**, public `/api/v1/health` **HTTP 200**; independent profit-protection monitor online PID **2452772**.
- Owner verified Pepperstone USD **DEMO** FULL_AUTO session remained ACTIVE / CONNECTED in prior exact-owner SQL inspection. The broker account was **flat at 20:57:40 UTC**, no unprotected live positions or trade restart required.
- Exact broker-native quote snapshot file had fresh **21:00:26–21:00:27 UTC broker event-time quotes** for all six majors sampled: AUDUSD, EURUSD, GBPUSD, USDCAD, USDCHF, USDJPY, archived at 21:00:28 UTC. Recent native quote feed is active; this does not prove zero gaps or guaranteed broker fill.
- Live trading decisions were also current: **40 decisions over five minutes**, 31 M1 ABSTAIN and **zero broker-native authorizations**. Same thing across prior 10 minutes (80 decisions, zero authorizations). Thus scanner is not frozen at 52 and neither browser UI nor API research instrumentation has imposed a recent execution halt.
- Independent read-only entry-blockade monitor at **20:57:24 UTC**: recent scanner decisions, **0 eligible alternative orders**, **0 new broker intents** since previous close, and effective owner model/portfolio loss streak/fast-stop cooldown vetoes explicitly **false**.
- The 20:11 UTC research-only API deployment added one configuration key and no changed/removed existing values. The pre-vs-post compiled scheduler diff added only the pre-dispatch confluence observer and read-only exact owner DEMO account check for **already executable** reversal candidates. Never count rejected candidates as trade failures.

## Crucial just-before-close first recent admitted reversal

The most recent successful Plan-B nomination occurred at **20:58:17.906 UTC**, EURUSD **BUY**, the **20:57 UTC** closed-bar decision:

- Strategy route **CONFIRMED_REVERSAL**, Plan-B paper admission true, **7/7** consensus passes; ensemble 0.6761983; model net expected **+0.168649 R**; drift NORMAL.
- M1 timing independent specialist **ABSTAIN**, but this had previously been an owner-authorized relaxed demo possibility. However, the independent expert recommended **SELL**, with 3 bearish votes and zero bullish votes, state **ABSTAIN**. Existing demo trial rejected it as **EXPERT_DIRECTION_NOT_ALIGNED**. Final authority `NONE`. No broker order.
- Opposite EURUSD **SELL** at 20:58:18 had ensemble 0.450546, gross expected **−0.1810 R**, net expected **−0.2060 R**, regime TREND_WEAK, Plan-B admission false, drift STRESSED, independent expert SELL. It was not qualified just because the expert leaned SELL.
- No fee confluence warning was admitted or used as a veto: `ownerDemoPreDispatchFeeConfluenceShadow.selectedForDispatch=false` and `noOrderBlock=true`. This is a genuine **conflicting model-entry signal**; do not auto-buy against unanimous independent expert or auto-sell a negative-expected-R alternative.
- Direct sampled EURUSD quote verification: nearest archived broker-native quote after the decision was **20:58:28.491**, bid 1.09656 ask 1.09658, and another at **21:00:22**, bid 1.09659 ask 1.09661. Over this short path, a hypothetical BUY marked at the second quote would have only **+0.1 pips before separate $6/lot commission or slippage**, or approximately **−0.9 pip** after an assumed $6/lot commission (about 0.6 pip) and 0.4 pip round-trip slippage. A SELL similarly had approximately −0.5 pip after bid/ask spread before commissions. The archive had gaps; these are **not executable fills, not backtested final strategy returns, and not reliable proof of either winning or losing**.

## Root-cause discrimination

- Between 17:30 and 20:00 UTC, several confirmed reversals and an early transition qualified and opened. From 20:00 through 20:57, Plan-B saw no admitted signals, with most candidates TREND_CONTINUATION, adverse expected-after-cost returns, poor directional vote, weak/OOD market structure and M1 abstention. One EURUSD confirmed reversal passed Plan B at 20:58 but failed independent expert directional alignment. Therefore not all possibilities are frozen; candidate quality and independent expert disagreement explain the latest no-order result.
- Existing `plan-b-multimodel-shadow.ts` evening session factor **0.52** dates to October 2026 and is not a percent-completed order, nor a hard veto (the component's minimum is 0.50). The recent frontend wording clarified this without changing execution.
- The only safe immediate operational action is to **continue current DEMO observation**. No evidence justified increasing lots, bypassing after-cost admission, changing Stop/Profit Protection, forcing the opposite side, or restarting critical services before Friday close. A correct nontrade is better than a fabricated green meter.
- Shadow validation next market session should compare adverse EURUSD expert-conflict signals with later broker quotes and actual future labeled reversals, including the missed-winning-trade risk, before modifying the live engine.

**Result:** Verified live scanner and quote feed, identified a real late reversal conflict, documented why neither side currently has fully aligned entry authorization, did not place broker orders or alter risk gates.
