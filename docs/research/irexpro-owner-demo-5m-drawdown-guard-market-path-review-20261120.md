# iRexPro — five-minute DEMO drawdown guard: real broker loss and sampled post-exit path

**Verified November 20, 2026, 01:53 UTC.** Owner-only, Pepperstone cTrader, USD DEMO, real settled broker economics. This is retrospective **explanatory** market-path research, not a broker-executable backtest or permission to change risk controls.

## What triggered this review

- On Nov 20 at 00:59:33Z, USDCAD SELL from **EARLY_TRANSITION** opened 2.00 lots; the v8.9 `DEMO_DRAWDOWN_GUARD` closed it at 01:04:53Z for broker net **-$31.53**.
- At 01:06:24Z, **CONFIRMED_REVERSAL** placed another 2.00-lot USDCAD SELL in the same direction; the same guard closed that at 01:11:38Z for broker net **-$30.14**.
- The cross-strategy same-side repeat and opposite EURUSD exposure coordination bug was corrected separately in commit `6477ee43`, deployed to the API on Nov 20. The guard remains DEMO-only, five-minute checkpoint, `currentR <= -0.4` gate.

## Verified audit cohort

A strict read-only PostgreSQL query joins only the exact owner `pepperstone-ctrader` DEMO trades in USD to **TRADE_CLOSE_REQUESTED** audit records with independently stored `metadata.aiCloseTrigger.source='DEMO_DRAWDOWN_GUARD'`. It does **not** infer the close initiator from the generic `AI_CLOSE_SIGNAL` label.

As of the checkpoint:
- **29** confirmed guard-triggered broker closures, all net-negative, combined **-$1,386.64** actual realized P&L including recorded commission and swap.
- **Confirmed Reversal:** 21 guard exits, actual **-$864.08** net.
- **Early Transition:** 5, **-$336.04**.
- **Trend Continuation:** 3, **-$186.52**.
- **USDCAD:** 11, **-$542.38**; AUDUSD: 9, **-$383.39**; EURUSD: 4, **-$272.90**; USDJPY: 5, **-$187.97**.
- These are only positions selected for early guard closure, not the full universe of entries; do **not** infer the guard caused the losses or improved/ruined total system profit.

## Later native broker quote observations

Archived prospectively collected, real bid/ask sampled price pairs were time-validated from both source and capture clocks (max 15 seconds apart). Each later horizon includes only quotes that existed in the archive before that horizon. An eligible path needs at least two quotes, first/last within 30 seconds of respective boundaries and no gap over 60 seconds. Incomplete and missing records are **censored**.

| Time after actual close | Matured, complete paths | Last quote better than close price for old direction | Last quote worse | Original stop price observed on sampled correct closing side | Sampled recovery to original entry without sampled stop |
|---|---:|---:|---:|---:|---:|
| 1 min | 28 | 10 | 15 | 4 | 0 |
| 3 min | 29 | 12 | 14 | 8 | 4 |
| 5 min | 28 | 11 | 17 | 11 | 4 |
| 10 min | 27 | 9 | 18 | 15 | 5 |
| 20 min | 26 | 9 | 16 | 19 | 5 |
| 30 min | 26 | 11 | 15 | 21 | 5 |

**Do not read this as 21 confirmed SL executions.** The dataset contains intermittent bid/ask snapshots, NOT a continuous full-tick execution trace. An unsampled stop could occur before any apparent later recovery; the order and spread of unobserved paths are unknown.

At 10 minutes, just **five** exited trades had sampled price return to the original entry without a sampled original stop. That still does **not** establish a net-profitable hold: spread and commission already made the real exit negative, and the original SL/TP and other market opportunities would have to be replayed with full tick/execution evidence.

For the two reported Nov 20 USDCAD SELLs:
- The first had a sample back at its original entry within three minutes of exiting, but by ten minutes its last sampled mark was again **0.7 pip worse than the actual closing price**.
- The second did not show sampled entry-price recovery until the ten-minute window; by thirty minutes its last sampled mark was **1.1 pip worse than the actual closing price**.
- No sampled original stop was seen for either position in the 30-minute window. These individual paths merit further study, not a blanket guard deactivation.

## Candlestick expert evidence AT the original guard request

A separate join uses the most recent **frozen, previously written, causal** M1 next-candle expert forecast less than 90 seconds old and recorded **before** the broker close request. No forecast created later is permitted.
- **17 of 29** guard exits had a verified prior forecast; 12 had no sufficiently verified nearby forecast.
- **Zero high-confidence directional forecasts** in the 17 matched cases.
- The M1 expert's three-class next-candle label is *not* an after-cost recovery classifier. The small, highly correlated cohort cannot justify model-controlled guard exemption.

## Implemented research

- Script: `apps/api/scripts/audit-owner-demo-drawdown-guard-postexit.cjs`.
- Unit coverage: `apps/api/scripts/audit-owner-demo-drawdown-guard-postexit.test.cjs`; synthetic two-clock / sampled-stop / late recovery / horizon censoring / future-leakage tests.
- Private report: `/home/lightworld/webapps/irexpro-research/drawdown-guard-postexit/latest-report.json`.
- Private day archives: `/home/lightworld/webapps/irexpro-research/drawdown-guard-postexit/daily/YYYY-MM-DD.json`.
- A bounded **rolling seven UTC calendar day** view; snapshots persist one per UTC day, keeping earlier evidence accessible while current coverage rolls forward.
- PM2 watch process: `irexpro-owner-demo-drawdown-guard-postexit-shadow`, refreshes every **30 minutes**, no execution authority.

```sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/audit-owner-demo-drawdown-guard-postexit.test.cjs \
  scripts/audit-owner-demo-candle-expert-trade-alignment.test.cjs \
  scripts/audit-owner-demo-prospective-candle-outcomes.test.cjs
node scripts/audit-owner-demo-drawdown-guard-postexit.cjs
```

## Historical five-minute score provenance defect discovered

The 29 confirmed guard close attempts could be matched to preexisting `trading.post_entry_shadow_observations` with recorded `current_r` and model probability. **All 29 rows had `evaluated_at` written after the actual audit close request**, with timestamp differences **1.67 to 8.13 seconds**. This is a storage-timing limitation, not proof the underlying AI scoring itself occurred after the close. Nevertheless, those historical score timestamps cannot be presented as independently frozen *pre-close* observations for training.

Remediation: in `PostEntryDemoDrawdownGuardService`, freeze `preCloseEvidenceEvaluatedAt` immediately after the verified broker-native AI response and before calling `ExecutionService.closeTrade()`. The subsequent database write now uses that exact timestamp in `evaluated_at` and in the JSON evidence, rather than SQL `now()` after broker dispatch. The broker risk-reducing CLOSE call still precedes the audit DB write and is never held up by storage.

**Important:** no older observation is rewritten or retroactively certified. The continuous research watcher now explicitly joins only guard observations meeting **all** of: the exact prior trade, matching owner, `action=CLOSE_DEMO`, `evaluated_at <= TRADE_CLOSE_REQUESTED.created_at`, and the durable JSON `evidence_evaluated_at` exactly equal to the database evidence time. A raw score with later timestamps is labeled **historical/unverified**, never relabeled as pre-close. The November 20 baseline correctly shows **0 verified pre-close scores out of 29 historical exits**. Future qualifying scores can be compared against the sampled 10-minute stop-versus-recovery path without changing trading decisions. This does not modify the guard threshold, its timing, broker orders, stops or LIVE authorization.

## Trading decisions deliberately NOT made

- Do not disable the five-minute DEMO guard: sampled follow-through was often adverse and original stop levels were frequently observed afterward.
- Do not raise the drawdown exit threshold, widen original broker SLs, promote candlestick expert to broker close authority, or automatically extend holding time.
- Continue prospective data collection and compare genuinely **pre-exit** features for the few no-stop recoveries versus those with later sampled original SL. Demand multi-day, after-fee out-of-sample evidence and an explicit safe rollback mechanism before altering DEMO exit authority.
