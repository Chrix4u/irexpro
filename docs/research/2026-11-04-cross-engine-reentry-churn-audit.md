# iRexPro DEMO research: cross-engine same-side re-entry churn

**As-of:** 2026-11-04 10:41 UTC. **Code artifact:** `cross-engine-reentry-churn-observation-v1`.
**Scope:** one owner-authorized **cTrader DEMO** account, seven days of trades, EUR only in this validation.

## Why

iRexPro can open a M1 tactical entry soon after a Plan-B/ensemble exit, or the reverse. The existing `loadMultimodelLossStreakBrake` is intentionally route-specific and queries `external-irexpro-multimodel-ensemble` only, using gross `realised_pnl` without the recorded broker commission. That avoids broad indiscriminate gating, but leaves an **observability blind spot** for cumulative after-fee performance within the same instrument, side, and route when the engines alternate. This audit quantifies the blind spot **without activating any cooldown**.

## Definition and safeguards

- Only the user's own cTrader DEMO connection. The manually invoked tool uses a bounded `REPEATABLE READ READ ONLY` transaction and never writes, places orders, restarts services, modifies settings, or attaches to an execution scheduler.
- Allowed engines: M1 tactical and Plan-B/ensemble. Each trade must have valid open and **completed close**. A one-hour history buffer precedes the window. Maximum 14 days, 2,000 rows; exceeding this fails rather than silently truncating.
- A re-entry is a closed trade opened within N minutes **after the most recent earlier closure** in the **same pair and direction**. The previous close may belong to either engine, any strategy route. Match closes by actual **close timestamp**; do not assume opening order is closing order (overlapping positions).
- Compute net after *separately recorded* costs as `realised_pnl - abs(commission) + swap` only when **all three amounts** are populated; otherwise report an incomplete-cost trade, never assume a zero commission. Group currencies separately; no FX conversion or cross-currency summation.
- Report mutually exclusive 0–5, 5–10, 10–15 and 15–30 minute bands, as well as cumulative horizons 5/10/15/30, sliced by current route, pair/side, previous close reason, engine transition, and intersections of those dimensions.
- Additionally cluster three or more **closed positions** on the same pair/side/route with <=60 minutes between consecutive closes. These are descriptive correlation clusters, not independently sampled trade episodes. Print only grouped summaries, not user/broker/trade IDs.

## Independent staging evidence at 10:41 UTC

There were **158 closed trades** in the last seven days, of which **157** had all gross/net cost fields present. Summing only complete observations: **−€101.19** reported trading P&L before **€258.07** explicit commissions, giving **−€359.26 net** (swaps €0). Of the complete observations, **79 net winners and 78 net losers**; **four** trades with positive gross P&L were non-positive after costs.

| Interval since same-pair/side previous close | Trades | Gross P&L | Recorded commissions | Net P&L |
|---|---:|---:|---:|---:|
| 0–5 minutes | 10 | −€18.37 | €15.05 | **−€33.42** |
| 5–10 minutes | 15 | −€10.69 | €23.78 | **−€34.47** |
| 10–15 minutes | 12 | +€27.41 | €20.60 | **+€6.81** |
| 15–30 minutes | 8 | −€1.88 | €14.58 | **−€16.46** |

All rows above are **mutually exclusive**. The 15-minute **cumulative** cohort has **37 trades, 19 net winners / 18 net losers, −€61.08 net**, of which €59.43 was recorded commissions. It is *not* legitimate to count this total as a profit the system would recover by blocking those 37 trades.

15-minute outcomes segmented by current Plan-B strategy route:
- **EARLY_TRANSITION:** 19 trades, **−€52.90** net.
- **TREND_CONTINUATION:** 13 trades, **−€25.58** net.
- **CONFIRMED_REVERSAL:** 5 trades, **+€17.40** net (small sample, no policy conclusion).

After the previous close reason `PROFIT_PROTECTION`, 25 same-side re-entries occurred within 15 minutes, with **−€78.14** combined net on the *subsequent* trades. Of these, **16** current `EARLY_TRANSITION` re-entries contributed **−€47.66** and **9** current `TREND_CONTINUATION` re-entries **−€30.48**. In contrast, the 5 re-entries after an `AI_CLOSE_SIGNAL` produced **+€5.13** in aggregate; **do not** introduce a blanket after-AI-close cooldown or assume every re-entry is harmful.

A real mixed-engine cluster on **GBPUSD BUY / TREND_CONTINUATION** contained four completed trades between **09:28 and 09:57 UTC**: one net winner, three net losers, **−€13.68** total, across both M1 tactical and Plan-B. Existing brake's separate engine accounting would not see the entire combined sequence.

### Why this differs from the preliminary 32-trade summary

The earlier quick script iterated positions in opening-time order and held one latest prior closed trade. With overlapping positions, this can accidentally use a close timestamp that occurs *after* a new entry, and miss valid earlier closes. The new audit sorts closures by their actual timestamps and selects only a prior close strictly earlier than the candidate's opening. It finds **37** re-entries (not 32) within 15 minutes. These corrected figures supersede the preliminary **32 / −€41.34** estimate.

## What to test next (NOT deployed)

1. Shadow-only **profit-protection-then-re-entry** penalty and a 5/10/15-minute **same pair/side/strategy** cooldown, with exceptions for confirmed reversal or exceptionally fresh independent M1 evidence.
2. Shadow-only **cross-engine after-cost sleeve brake**: inspect the latest 3–4 completed trades for the same pair/side/route even if different engines, with net P&L and a minimum observable sample. Never transfer a losing sleeve's brake to unrelated pairs or directions.
3. Compare against the same pair/side/route **non-quick entries** during matched sessions/regimes, control for spread, volatility, account exposure, overlap and structural confounding. Avoid using the same history to select and validate a threshold.
4. Purged walk-forward/holdout with sufficient independent episodes; evaluate after-fee expectancy, drawdown, profit factor, opportunity cost of excluded profitable trades, and real broker fill limitations. Only then consider a separate, gated **cTrader DEMO** A/B test. No LIVE promotion.

## Run safely

From `apps/api` with compiled app modules, dependencies and authorized staging environment present:

```bash
node scripts/audit-cross-engine-reentry-churn.cjs
```

Optional `REENTRY_CHURN_AUDIT_SINCE` is ISO UTC (default seven days). Requires `VPS_FOREX_SCANNER_USER_ID` and `M1_TACTICAL_MARKET_DATA_CONNECTION_ID` from the protected environment. Never commit tokens or user IDs to this document. Test suite:
`jest src/modules/ai/cross-engine-reentry-churn-audit.spec.ts --runInBand`.
