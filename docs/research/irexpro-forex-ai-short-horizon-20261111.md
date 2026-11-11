# iRexPro: broker-native 1/3/5/10-minute FX AI research
**11 November 2026. Independent DEMO research; NO orders, authority or model promotion.**

## Immediate conclusion
The user's proposed short-term price and time-to-profit prediction is a valid research objective, but a fixed 1-, 3-, 5-, or 10-minute holding period on the *existing* model is NOT profitable on the tested broker quote marks. Keep existing qualified DEMO entries and hard controls; do not add another universal no-trade gate. New specialist alpha must independently prove net value before any execution permission.

## Grounded broker results and economic context
Read-only Pepperstone cTrader DEMO, 31 closed trades opened from 10 November 2026 to 11 November ~10:22 UTC: 11 net wins and 20 net losses, actual net -$1,054.55, total commission -$675.60, before any new research strategy. Thirteen of the 20 losses had a *recorded* favorable broker-net peak, nine greater than the charged commission, but peak telemetry can be incomplete. Distinguish adverse-first from favorable-then-giveback trades, especially original TP winners that recover from early pullbacks.

Read-only executed-trade M1 *quote marks* after entry:
- 1 min: 8/30 net-positive, mean -$26.82
- 3 min: 7/30 net-positive, mean -$35.22
- 5 min: 9/22 net-positive, mean +$1.38
- 10 min: 8/18 net-positive, mean +$4.86
These samples include only positions STILL OPEN at observed mark; **strong survivor selection**. Quote mark 0–60 seconds after target, not a filled market-close simulation.

Read-only pair-side-deoverlapped scanner 5-minute episodes between 10 Nov 08:00 and 11 Nov 10:00 UTC: 1,214 episodes, 9,289 native M1 quote bars, prior broker-closed commission evidence, one standard lot. 10-minute hypothetical cost-adjusted marks:
- All: 1,203 labels, 40.2% positive, mean -$5.08 per lot
- Plan B admitted: 114, 43.9% positive, mean -$1.53
- Plan B not admitted: 1,089, 39.9% positive, mean -$5.46
- Trend continuation: 833, 42.6% positive, mean -$2.41
- Early transition: 370, 34.9% positive, mean -$11.09
All-candidate 1-, 3- and 5-minute means: -$9.14, -$9.04, -$7.89. There was NO proven net-positive fixed-horizon sleeve. The rejected pool contains safety and execution vetoes; a favorable mark is NOT proof of an order that was legally/technically executable.

## Competitor research — documented architecture, not verified profitability

| Platform | Independently inspectable design feature | Technique worth testing in iRexPro | Important limitation |
| --- | --- | --- | --- |
| AI4Trade.ai, AI-Trader Agent Marketplace | Agent leaderboard, market/trading posts, disclosed reasoning, copy/paper evaluation | Explain why an AI expects a move; rank competing agents with prospective scorecards | Site alone does NOT verify sustainable retail FX broker returns; ranking may be hypothetical or selection-biased |
| QuantConnect LEAN | Alpha Insights have direction, magnitude, confidence, explicit duration/expiry; research-to-live reconciliation; portfolio/risk/execution separated | A signal should specify 1/3/5/10-minute horizon and signed expected pips; expiry and cancellation are explicit | Infrastructure/framework, not a guaranteed profitable bot |
| Capitalise.ai | Rules for automated entries and exits, examples with 5m bar conditions and profit-triggered exits, historical simulation | Profit/time exit policies remain interpretable and independently backtested | Simulated performance does not establish after-cost brokerage results |
| cTrader cBots | Tick-server backtesting, commission and variable spreads; breakout, trend, RSI reversal, mean reversion templates, 24/7 cloud | Replay actual bid/ask tick order to resolve target-first versus stop-first; compare native cBot baseline | Grid and martingale are demonstrated platform styles, NOT recommended for iRexPro |
| Darwinex risk engine | Volatility-normalized independent investor VaR / position risk management | Use adaptive lot size and correlated thesis exposure rather than add model-veto rules | Normalizing risk is not predictive edge |
| Forex Fury (retail MT4/MT5 EA) | Vendor documents low-volatility range trading during a limited trading-hour window, with max spread/slippage controls | Research pair/session/regime-aware short-duration range specialist alongside trend model | Vendor claims of profits are not independently verified here; its one-pair-one-hour defaults should NOT become a blanket restriction |
| Forex Flex EA (retail MT4/MT5 EA) | Vendor describes pre-entry virtual trades, selectable strategies, news filters, trailing modes | Shadow-confirm price behavior before a real broker order; distinguish simulations from executions | Reject recovery multipliers, martingale/grid escalation; no independent claim of net success validated |
| Samurex Tandem / Outbreaker EAs | Vendor descriptions of London-session range breakouts, post-open mean reversion, rule-based SL/TP/breakeven/trailing and time exit | Research distinct specialist alpha by session and independently validated net exits | Marketing/backtests are not trustworthy return evidence without accessible broker-verified account history |
| Myfxbook / Forex Peace Army | Broker track-record and trading-privilege verification, some third-party monitored EAs | Publish verifiable prospective equity, fills, fees, drawdown, commission and all losses, not screenshots | Even verified past returns do not guarantee forward profitability |

Sources:
- https://ai4trade.ai/
- https://www.quantconnect.com/docs/v2/writing-algorithms/algorithm-framework/alpha/key-concepts
- https://www.quantconnect.com/docs/v2/writing-algorithms/live-trading/reconciliation
- https://support.capitalise.ai/en/articles/4290602-the-backtest-operation
- https://capitalise.ai/explore-city-index/
- https://help.ctrader.com/ctrader-algo/documentation/cbots/backtest-a-cbot/
- https://help.ctrader.com/cbots/
- https://help.darwinex.com/risk-manager
- https://www.myfxbook.com/help/knowledge-base/verification/
- https://www.forexfury.com/about-us/
- https://www.forexfury.com/
- https://forexflexea.com/
- https://samurex.com/
- https://open-range-breakout.com/
- https://www.cftc.gov/LearnAndProtect/forexfrauds

A recent peer-reviewed study over 1–30-minute intraday forecasts reports that its FX models could show directional accuracy but NOT deliver net profitable currency pairs after costs. Reference: https://www.frontiersin.org/journals/applied-mathematics-and-statistics/articles/10.3389/fams.2026.1888767/full . This is a warning against confusing predicted direction with tradable edge, not proof that all possible FX models must fail.

## Proposed AI architecture

### Research horizon experts: four clocks, several regimes
Each 1-, 3-, 5- and 10-minute specialist predicts an uncertainty-aware distribution of **signed forward pip movement**, the probability of reaching a **minimum profitable broker-executable target before a volatility-adjusted stop**, and expected R after fees. The model may declare NO_EDGE; it must never claim exact future pips as certainty. Original M1 features, H1/H4 context, M5 acceleration, spread and depth, volatility, momentum, RSI, extension, pattern, London/New York session, market regime, recent failures and time of day are candidate features. Different experts can handle trend continuation, pullback, breakout, exhaustion and tightly bounded mean reversion. Never blur their distinct risk and reward profiles.

### First-touch competing-risk labels
Use broker BID/ASK tick sequences, not M1 bar high/low after the decision, to establish: which occurred first, target or stop; time to first target; no-hit/expiry; maximal favorable/adverse excursion; and realized cost-adjusted net R. For a BUY the entry uses ASK and exit uses BID; reverse for SELL. Commission evidence is scoped to the exact owned account and completed before candidate time. Separate swap and slippage from spread. Source-side/currency converter must use actual FX pair rate. Label *all scanner opportunities* in shadow, not just current executed trades; de-overlap repeated scans and distinguish soft model rejection from non-waivable news, broker authorization, exposure and market-integrity vetoes.

### Model selection and exit
A meta-learner chooses the specialist, direction and horizon by independently validated predicted **net** expectancy after cost. Exit can be a profitable target, a proven net trailing lock, a validated invalidation signal or horizon expiration; always preserve original hard broker stop/TP as fail-safe. Do not mechanically liquidate each trade at minute 1 or 3: their measured average marks were worse, and a hard time limit can discard subsequent winners.

### Independent evaluation and promotion
- Broker-native M1 quote collection currently covers only roughly Nov 9–11; need **many independent trading days, regimes and market sessions**. External Dukascopy archives can train features, but transfer must hold on actual Pepperstone spread/quotes/fills.
- Purged walk-forward chronological folds with embargo >= longest label horizon; reserve untouched full-day holdouts, group near-duplicate pair-side episodes; correct for searching multiple horizon/expert versions.
- Compare against current Plan B and existing research-only demo_first_hit_temporal_selector and demo_planb_temporal_challenger, naive momentum, reversal and NO_TRADE baselines. Do NOT overwrite their policies/weights on the current account.
- Economic reports: per-expert direction accuracy, Brier/probability calibration, target-first precision/recall, **net** expectancy R and pips, profit factor, spread/commission breakdown, worst drawdown, Sharpe, trade frequency, new missed opportunities, and high-TP winners preserved under exits.
- Run prospective silent predictions before proposed order time with full causal snapshots; then small **separate DEMO-only** execution after explicitly approved risk/promotion gates, never LIVE promotion from one or two sessions. Keep current six-pair DEMO rules working while research continues.
- The Plan B meta-score currently uses frozen coefficients (v8-shadow-meta-scorer.ts). Existing adaptive calibration and Python training challengers are not equivalent to automatically retraining that active meta-score on newly closed trades.

## Repeatable READ-ONLY utilities added by this change
From the authorized staging apps/api working directory:
  node scripts/audit-short-horizon-broker-marks.cjs
  node scripts/audit-short-horizon-m1-episodes.cjs
  node --test scripts/audit-short-horizon-broker-marks.test.cjs scripts/audit-short-horizon-m1-episodes.test.cjs

Optional OFFLINE dataset export for later approved research:
  IREXPRO_HORIZON_COHORT_EXPORT=/tmp/irexpro-m1-horizon-samples.json node scripts/audit-short-horizon-m1-episodes.cjs

This writes a user-private 0600 JSON only in an explicitly approved /tmp/irexpro-*.json path, refuses overwrites, and contains 17 allowlisted as-of predictive features and separately held outcome labels. No user ID or broker connection ID is exported. On 11 Nov the protected, exploratory dataset contained 1,214 five-minute episodes and was 2.0 MiB; no model was trained or promoted because the sample covers too few independent market days.

Both audits enforce active owned Pepperstone DEMO connection, read-only repeatable-read PostgreSQL transaction, bounded statement time, causal quote sample timestamp, broker bid/ask, as-of historical commission, clear censoring/quote-missing labels and NO executable broker/model action. CI runs 15 pure tests. **No new entry veto, order path, user setting, broker permission, training artifact or production model is changed in this research change.**

## November 11 follow-up: out-of-time model learning experiment (research only)

The first dataset contains 1,659 as-of episodes spanning just two UTC dates:
- November 10 train, after trimming a 20-minute label embargo before November 11.
- November 11 separate but **incomplete same-day** holdout. One prior day is not enough to qualify any model.
- 17 original candidate attributes and five as-of Plan B features; no future quote, realized P&L, broker ID or account ID in predictors.
- Per-horizon L2 logistic profitable-mark probability plus Ridge expected broker-net-USD mark; scaler and feature encoder fitted on training day only.
- A second paired-Ridge experiment predicts marks for the **original direction and opposite direction**, choosing NO_EDGE if neither estimated after-fee result is positive. Both label families are segregated from predictor inputs; only historical causal quote marks are used.
- These are hypothetical *one-lot* MARKS before additional slippage, not broker-filled trades with first-touch SL/TP or a portfolio simulator. **No model weights persisted, no registry changes, no order authority.**

### Out-of-time cost-adjusted mark comparison

Dollar values below are **average estimated USD per hypothetical standard lot**, not actual P&L.
The model-selected samples are different, so the table does NOT represent
a parallel, equal-risk, executed portfolio backtest.

| Horizon | All original candidate marks on held-out day | Timed-alpha selected | Timed-alpha selected count |
| --- | ---: | ---: | ---: |
| 1m | -$6.80 | -$23.50 | 2 |
| 3m | -$6.65 | -$10.74 | 14 |
| 5m | -$6.74 | -$9.12 | 80 |
| 10m | -$5.93 | -$9.01 | 116 |

**None** improved mean net value. The top fifth by predicted net
also had *worse* mean holdout economics for every horizon.

### Original vs opposite direction research

On all paired broker-quote episodes before chronological holdout, the original 10m candidate direction averaged -$5.36/lot and the opposite direction -$13.62/lot; 399 of 1,264 reverse 10m marks were individually net positive. Selecting the reversed direction *after seeing future prices* is invalid hindsight. A model must identify reversals prospectively before spread and commission.

The supervised three-way direction research on later-day holdout produced:

| Horizon | Original held-out marks | Opposite held-out marks | Model-selected BUY/SELL marks | Selected pairs |
| --- | ---: | ---: | ---: | ---: |
| 1m | -$6.80 | -$8.10 | -$10.14 | 7 |
| 3m | -$6.65 | -$8.28 | -$11.09 | 15 |
| 5m | -$6.74 | -$8.17 | -$9.52 | 84 |
| 10m | -$5.93 | -$8.93 | -$7.53 | 227 |

**No profitable or qualified model emerged.** These negative holdout
results mean simply reversing the existing trend-continuation decisions is
not a validated answer. Continue collecting independent market days.

### Reproducible offline experiment

Run from an authorized VPS **without changing broker trading permissions**:

1. In apps/api, export the as-of candidate data to an owner-private,
   non-overwriting file with the explicit research-only scripts, e.g.
   IREXPRO_HORIZON_AUDIT_START=2026-11-09T00:00:00Z,
   IREXPRO_HORIZON_AUDIT_END=2026-11-11T11:00:00Z and
   IREXPRO_HORIZON_COHORT_EXPORT=/tmp/irexpro-m1-horizon-samples.json.
   No user IDs or broker connection IDs are exported.
2. From services/ai-engine with installed dependencies and PYTHONPATH=.,
   run Python module
   app.domain.training.demo_timed_alpha_multihorizon with --cohort-json
   and --report-json pointing to distinct /tmp/irexpro-*.json paths.
3. The report defaults to zero order authority, cannot overwrite results,
   never saves model weights, and labels each horizon
   EXPLORATORY_ONLY_INSUFFICIENT_DAYS. Tests validate train/holdout chronology,
   20-minute embargo, refusal of execution-bearing datasets and invariance
   of model predictions when held-out labels are changed.

Next research required: actual **broker bid/ask tick ordering** with
causal stop/TP first-touch / competing-risk and time-to-target labels,
commission/slippage stress, minimum 10 independent training days and
at least 3 independent future holdout days, then prospective DEMO-only
shadow comparison. The existing approved Plan B / M1 paths must continue
running; the experimental NO_EDGE outcome is not a new trade blocker.
