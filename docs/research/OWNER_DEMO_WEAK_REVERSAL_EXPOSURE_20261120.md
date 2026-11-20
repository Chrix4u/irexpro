# Owner Pepperstone DEMO weak Confirmed Reversal exposure ceiling — 20 November 2026

## Issue verified from broker / immutable entry decisions

The user reported three large consecutive DEMO losses: USDJPY SELL 7.00 lots gross -$233.68, fee -$42.00, net **-$275.68** closed 16:36:57 UTC; AUDUSD BUY 4.22 lots gross -$168.80, fee -$25.32, net **-$194.12** closed 16:42:30 UTC; USDJPY BUY 4.90 lots gross -$179.10, fee -$29.40, net **-$208.50** closed 16:52:53 UTC. These three settlements total **-$678.30** net. The closes span about 16 minutes. All three executed through the separately owner-authorized continuous DEMO Confirmed Reversal alternate although M1 timing was M1_TREND_CONTINUATION / ABSTAIN / ABSTAIN and trained expert ABSTAIN at all three decisions.

The exact submitted trade intents show the **existing** independent quality multipliers **0.4875 / 0.5 / 0.2975**. However, the owner's **ongoing seven-lot** authorization unconditionally suppressed this advisory multiplier in `submitPaperDecision()` (the surrounding normal broker hard stops, risk/margin and M5 soft cap still applied). The model's earlier signal of weak independent confirmation therefore was not changing requested size on this particular authorization.

At the time of entry, the broker-observed commission shadow had flagged both USDJPY entries as below expected after-fee floor. The other AUDUSD entry passed the cost shadow but had a causal, active recent strategy payoff brake. The ordinary primary reversal M1 gate did not admit the candidates, but the owner-enabled continuous DEMO alternate did; the risk evidence was not a hard veto because the user explicitly rejected no-trade starvation and discretionary auto-pauses.

## Exact-owner, non-veto correction

Created pure `evaluateOwnerDemoWeakReversalCap()` in `apps/api/src/modules/ai/owner-demo-weak-reversal-exposure-ceiling.ts`, wired into the actual authoritative `submitPaperDecision()` prior to existing M5 cap and `resolveM1CurrencyExposureGuard()`.

Feature: `IREXPRO_OWNER_DEMO_WEAK_REVERSAL_4LOT_CEILING=enabled`.

A new Confirmed Reversal order can have its **maximum requested lot** lowered to the preexisting standard 4 lots, NOT a forced 4-lot fill, only if **all** apply:
- Exactly owner-verified Pepperstone **USD DEMO** account, ongoing seven-lot permission and verified continuous advisory alternate, with quality-risk measurement actively enabled.
- Existing quality risk fraction is finite within 0.2 through 0.5 (already existing independent quality model; no newly trained threshold).
- Requested lot cap is greater than 4 lots (smaller requested lots remain untouched).
- **At least one separate, pre-entry warning**: real broker commission shadow says `AFTER_BROKER_FEES_BELOW_FLOOR` with at least 12 prior fills, **OR** the already-computed causal recent loss-streak brake is active with exact reason `RECENT_NEGATIVE_PAYOFF`. Unknown/insufficient broker evidence is not invented.

For a weak candidate requesting 7 lots this is **at most** 4, and for a weak one requesting 4.90 also **at most** 4; stronger entries preserve 7-lot permission, and entries already <=4 are completely unchanged. This does **not** pause sessions, reject an otherwise admitted strategy, reverse direction, amend SL/TP, increase any lot, use future settlements, or touch LIVE, other users/brokers or ET/continuation. The existing original stop risk, actual margin, commissions and M5 soft cap remain authoritative; downstream broker risk screens may still lower actual fills.

Every new order's immutable `trading.trade_intents.metadata` now records artifact, applied/reason, before/after requested lot caps, accepted commission warning and accepted recent-loss warning, enabling **genuine post-release forward comparison** of both winners and losers.

## One-day historical selection check (not a backtest of P&L)

A read-only audit of all 23 settled owner seven-lot-authorization Confirmed Reversal trades opened after 12:50 UTC Friday Nov 20 gave: **11 wins / 12 losses, -$1,501.97** actual net. The conditions would have selected 14 completed positions whose original realized lot sizes were >4: **3 winners / 11 losers, -$2,134.22 broker net**; the remaining 9 comprised **8 winners / 1 loser, +$632.25 broker net**. The new ceiling would not change entries already at or below 4 lots. This is a *reviewed, same-day observational distinction*; it includes the three-loss incident and is **not independent validation**, cannot establish restored profitability, and MUST NOT be treated as causal proof that an earlier 4-lot fill would have produced the identical price path, exit, commissions, or outcome. There is no verified hypothetical amount saved.

## Testing and safe deployment

- Exact-size pure unit tests: 8 covering 7/4.9/etc, cost samples, clean confirmation, missing history, inactive loss brake, other strategy, exact account, no lower-size manipulation, no stopping entries or changing stops, invalid lots.
- Prior existing owner seven-lot and M5-cap regressions: 19; **27 combined passing**.
- Scheduler-level selected integration regressions: **2 passing** (continuous owner DEMO alternate, fee shadow; unrelated tests deliberately skipped).
- Full API TypeScript compile completed separately with code **0**, output under `apps/api/dist.owner-weak-ceiling-staged`, without interrupting the running API.
- Safely deployed only after the previously open EURUSD SELL closed. The exact Pepperstone USD DEMO broker was confirmed flat before the API restart. The original compiled scheduler, sourcemap and API env were backed up for rollback; the tested staged JavaScript scheduler/helper were atomically placed into the active dist directory; the exact DEMO-only env flag was enabled. Only `irexpro-api-staging` was restarted, and its health returned HTTP 200. The independent existing profit protection monitor was not restarted.

**Limitations:** Risk-only measure, not an entry accuracy predictor. Current Confirmed Reversal net profit factor and losses remain unsatisfactory. Need multiple independent trading days of after-fee outcomes before claiming financial improvement or widening to live.

## Actual live activation and forward score boundary

**Deployed and activated 2026-11-20T17:37:18Z (Ghana UTC)**, source commit `60c868a4`, exactly scoped to the user-owned Pepperstone USD DEMO account. The flat check passed after the ongoing EURUSD SELL closed at **17:36:10 UTC**, actual broker-net **+$101.65**, reason `PROFIT_PROTECTION`. No existing open position was closed to deploy. PID of API changed **2349902 → 2633473**; profit-protection daemon retained **2452772**, and independent recovery monitor retained **2577750**. POST-RESTART `/api/v1/health` returned **HTTP 200**. Runtime-loaded pure module checked: weak 7-lot candidate → ceiling 4, adequately supported candidate → stays at ceiling 7, `blocksTrade:false`, `altersBrokerStops:false`. Exact API .env was verified with `IREXPRO_OWNER_DEMO_WEAK_REVERSAL_4LOT_CEILING=enabled`.

The **first post-release broker-opened trade** at 17:37:42 UTC was USDCAD BUY `TREND_CONTINUATION`, 0.20 lots. The durable intent confirms artifact recorded, `cap_applied=false`, reason `NOT_EXACT_OWNER_DEMO_CONTINUOUS_REVERSAL_UNCHANGED`, before and after both 0.20 lots. This is genuine **end-to-end evidence that the deployed rule left a different strategy/lot cap unchanged** and that the system continued to open trades. It is **NOT** evidence yet of improved Confirmed Reversal after-cost results. The first genuinely affected CR admission after activation must be audited via immutable metadata and later broker-close settlement, counting eventual winners as well as losers; no profit claim can be made from only a deployment check.

Only newly created compiled build staging `apps/api/dist.owner-weak-ceiling-staged` may be removed after deployment verification, to conserve VPS disk; retain rollback backups outside the repository. Unrelated untracked previous release directories must not be deleted by this change.
