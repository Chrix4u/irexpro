# iRexPro — recurring 20:00 UTC DEMO trade starvation, November 17–20, 2026

**Owner issue:** There have been no new orders for approximately 1 hour 46 minutes since the last Pepperstone USD DEMO entry at 19:41:25 UTC Friday 20 November, despite continuous automated model evaluations. Is the 20:00 cutoff a newly added restriction?

**Methods:** Postgres **READ ONLY** exact-owner, exact Pepperstone cTrader USD DEMO `trading.m1_tactical_decisions`; daily 19:00–21:30 UTC comparisons and current forward 21:00–21:29. The 20:00–21:00 decision counts are **repeated model-side evaluations**, not unique trade opportunities. No live API orders, runtime risk changes, or staging restarts.

## Live evening comparison: exactly 20:00–21:00 UTC

| Date | Decisions | Plan-B paper admitted | Authorized broker entries | Negative model after-cost expected-R decisions | Session-quality component |
|------|----------:|----------------------:|--------------------------:|-----------------------------------------------:|--------------------------:|
| Tuesday Nov 17 | 480 | 4 | 0 | 203 | 0.52 |
| Wednesday Nov 18 | 460 | 4 | 0 | 202 | 0.52 |
| Thursday Nov 19 | 480 | 2 | 0 | 314 | 0.52 |
| Friday Nov 20 | 448 | 1 | 0 | 287 | 0.52 |

**Across all four evenings:** **1,868** evaluations, **11** Plan-B paper admissions, **0 authorized broker orders** in the same 8–9 PM Ghana time hour.

Earlier 19:00–20:00 UTC, authorized count by day was Nov17 0; Nov18 0; Nov19 1; Nov20 2. During Nov20 21:00–21:29, 224 more checks and 2 Plan-B admissions produced zero authorized trades.

**Interpretation:** This is a persistent **time-of-day model-admission/confirmation issue**, not a new hard technical blockade introduced at 20:00 on Friday. It does not establish that the rejected trades would have been profitable if executed. The broker API is healthy and model scans remain fresh.

## What the code actually does at 20:00 UTC

`apps/api/src/modules/ai/plan-b-multimodel-shadow.ts::sessionQuality()` uses **0.72** between 16:00 and 19:59 UTC and **0.52** thereafter. Git blame dates this rule to **2026-10-02**, not tonight. The session component has ensemble weight **0.08**; the change reduces otherwise identical ensemble scores by **0.016**, and 0.52 still passes the hard session minimum of **0.50**. Thus this factor can shift marginal scores but **cannot by itself account for zero orders**; gross/meta admission and independently governed net expected R, M1 confirmation and trained expert alignment are separate constraints.

## Three Friday evening model admissions that failed execution

- **20:58:17.906 EURUSD BUY** — Confirmed Reversal paper admitted, score **0.6762**, estimated net +0.1686R; M1 **ABSTAIN**, trained expert **SELL** with 0 BUY/3 SELL votes, expert state ABSTAIN; **expert opposite side**, advisory `EXPERT_DIRECTION_NOT_ALIGNED`, final blocker `MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED`, no order. Its independently evaluated SELL candidate was negative after fees (**−0.2060R**, TREND_WEAK/STRESSED, not Plan-B admitted) and not ready for dispatch.
- **21:03:14.407 USDJPY BUY** — Confirmed Reversal paper admitted, score **0.6620**, net +0.1321R; M1 **ABSTAIN**, expert **SELL** 1 BUY/2 SELL votes; `EXPERT_DIRECTION_NOT_ALIGNED`, `MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED`, no order.
- **21:19:15.257 USDJPY BUY** — Confirmed Reversal paper admitted, score **0.5622**, net +0.1160R; M1 **ABSTAIN**, expert **BUY** with 2 BUY/1 SELL votes; advisory `NEGATIVE_AFTER_FEE_OR_MARKET_RISK` umbrella reason because **score below the >=0.60 alternate-entry floor** and net expected R below the **0.12R standard alternate floor** (other spread / cost / event / sleeve criteria not independently established by this review). No order.

These are independent checks, NOT proof all three would have won. In earlier 17–19 evening checks, some nominally paper-admitted candidate exits were rejected due to expert mismatch, M1 degraded side, drift or historical loss-streak brakes. This shows the recurring no-trade behavior predates today's 20:11 UTC deployment.

## Recent engineering changes / attribution

There **have been several trading-engine commits between November 17 and today** affecting lot-risk sizing, owner pause/advisory handling, cross-sleeve recovery, after-cost scoring and broker position safety. It would be inaccurate to claim that the codebase has not changed since Tuesday. But the independently verified **20:11 Friday API deployment was research-only**, and the **21:19 Friday counter-pilot deployment** only refreshed an owner USD DEMO *strict independent counter opportunity* window to **22:00 Friday**, at most two entries, with unchanged qualification algorithm, stop-risk and after-cost controls. No immediate Friday counter entry has qualified, no forced trades.

**Actionable conclusion:** The next engineering target should be **time-stratified as-of forward validation of the *M1 abstain + independently admitted Plan-B* cases, testing the missed-trade opportunity cost and whether duplicate M1/expert gates can be replaced with stronger genuinely independent confirmation**. Separately validate the expert-proposed *opposite* side with its own net-after-cost expectancy and stop/target. Do not indiscriminately remove M1, fees, broker margin, portfolio risk or economic admission just to raise execution counts—recent realized demo outcomes were poor enough that trade frequency alone would not prove progress.
