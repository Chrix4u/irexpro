# Pepperstone owner DEMO: causal entry context and actual after-commission results

Snapshot 18 November 2026, 12:22 UTC, Ghana time. RESEARCH ONLY. NO entry, lot, model, broker stop, exit, account-risk or LIVE changes.

## Purpose and scope

The separate seven-day commission audit (135 USD DEMO trades) found +0.256R mean Plan B predicted net versus -0.228R actual net, with recorded commission averaging 0.149R. That requires diagnosis, not another knee-jerk threshold change.

The new audit selects the exact owner's Pepperstone cTrader USD DEMO trades from 17 November onward, with original submitted Plan B route Early Transition or Confirmed Reversal. It joins each actual broker fill to its original trade intent, model score and expectation, independent expert votes, M1 tactical route, planned entry, risk allocation recorded before fill, and eventual gross + signed commission + swap.

Separately, historical provider quotes are read from the native broker snapshot collector's event and receipt timestamps. For a causal feature to be used, BOTH timestamps must be no later than the original trade-intent timestamp; a quote recorded late cannot be reinterpreted as information available earlier. Midpoint momentum is only a sampled broker-quote context, not a certified native M1/M5 candle or a trained model. Future market paths are outcomes only and cannot train the original entry.

## Verified two-day results

93 closed trades, 51 net winners, 42 net losers; win rate 54.84%. Recorded gross -$164.92, commissions -$1,028.04, booked net **-$1,192.96**. Mean booked winner +$34.01; mean loser -$69.70. The substantial expected-payoff asymmetry remains. Only TWO distinct market dates: insufficient for independent out-of-sample validation.

The original submitted expected net return averaged +0.2822R; actual booked net averaged -0.2242R relative to initial allocation risk, for a forecast error averaging -0.5064R. Every trade has matched recorded fees and initial allocation risk. The model may predict moves in some contexts, but expected net R is materially optimistic in this sample.

Expected-R groups: less than 0.20R: 25 trades and +$2.64 net; 0.20 to less than 0.40R: 49 and -$713.80 net; at least 0.40R: 19 and -$481.80 net. No credible positive ordering by predicted profitability in this sample.

By date: 17 November, 69 trades, -$593.01 net; 18 November through the snapshot, 24 trades, -$599.95 net. By strategy: Early Transition, 41 trades, -$544.21; Confirmed Reversal, 52, -$648.75.

## What price did in the first minute

90 of 93 have a recent independently timestamped broker quote available to the initial intent; 83 have sufficiently sampled prior-five-minute quote context.

Of the 89 trades with a fresh mark at +1 minute while their position was still open:

| Direction of quoted close-side move in first minute | Trades | Eventually net-winning | Actual booked net |
|---|---:|---:|---:|
| Aligned with predicted trade direction | 32 | 23 | +$399.80 |
| Opposite to predicted direction | 52 | 22 | -$1,483.49 |
| Approximately flat | 5 | 3 | -$118.69 |

One trade closed before one minute and three had no fresh contemporaneous mark. This correlation is NOT proof that waiting a minute or vetoing short-term adverse movement would have saved that P&L. Twenty-two of the initially adverse trades eventually WON; a strict one-minute reversal veto would also sacrifice profitable trades.

Causal *pre*-intent momentum is NOT the simple solution: 52 trades with prior-minute quote momentum aligned with the prediction still booked -$509.50, and 46 with aligned prior-five-minute quote momentum booked -$595.89. These are exploratory, correlated, two-day groups and must not become retrospective trade gates.

## Frozen one-minute timing challenger, research only

The second new pure research module evaluates a possible confirmation at precisely one minute after the real entry, using the original *planned* entry, valid original stop/TP geometry, broker bid/ask observed before the one-minute checkpoint, no more than 1.5 pip spread, a 0.3 to 2.5 pip planned-entry-direction band, prior-60-second price momentum at least 0.3 pip, and adequately sampled, non-opposing five-minute price context. These thresholds are initial UNTRAINED hypotheses, not validated model parameters. They are intentionally frozen for future observational tests. Missing or late quote = reasoned abstain.

Of 93 historical trades, 22 met those research conditions. Among those 22, 21 have a fresh quote three minutes after entry while the ORIGINAL position was still open: **11 favorable / 10 unfavorable** directional marks relative to a hypothetical quote-side delayed entry. Of 18 with a usable five-minute quote while the original trade was still open: 10 favorable / 8 unfavorable. There is no compelling directional edge in this small sample.

A 60-second-delayed hypothetical market quote is NOT a cTrader broker fill. Historical original trade P&L must not be advertised as the delayed-entry candidate's P&L. No order was placed, reserved, simulated as filled or sent to a broker by the diagnostic. Future prices are NEVER used to produce the checkpoint decision.

## Independent five-minute drawdown guard finding

After disabling the new persistent-adverse rule, an AUDUSD SELL opened at 12:00 UTC and booked -$81.88 at 12:05. Audit logs show a separate existing v8.9 five-minute DEMO_DRAWDOWN_GUARD, not the newly disabled loss-cut pilot. This guard closes when its broker-native checkpoint confirms drawdown <=-0.4R. In 10 matured drawdown-guard closes from 17–18 Nov, subsequent sampled price paths first observed original stop on nine and original TP on one within 30 minutes; the latest one was not yet mature. These are NOT verified tick-by-tick broker fills, but insufficient evidence to disable the older guard. It remains active.

## Preserved production state

Early Transition and Confirmed Reversal entry permissions, models and lots unchanged. Recent persistent-adverse M1 cut is disabled on owner DEMO; extra-aggressive TP-progressive overlay disabled; earlier tiered net-profit protector (65%, 75%, 80%) enabled. Legacy five-minute DEMO drawdown guard remains active. Original broker SL/TP unchanged. True broker-amended trailing stop and forming-candle expert remain research only. LIVE promotion not authorized.

## Next evidence and acceptance

1. Preserve causally observed quotes, original score and planned entry for every independent trading day, including missingness and broker event/receipt lag.
2. Compare the frozen 60-second timing challenger against at least several further market dates and separate currency/session cohorts. Use forward, price-and-cost-correct delayed-entry execution assumptions and prospective observational reliability, not original trade P&L to fake delayed order fills.
3. Calibrate Plan B net-expected-R against future realized net R with chronological purged groups and commission/slippage accounting. Test M1/M5 direction, spread, volatility and expert state, without hindsight feature leakage or selecting thresholds solely from outcomes.
4. Only after independent forward evidence should any new gate or execution-authority change be proposed. Do not tighten lots or reduce the owner DEMO strategies' requested exposure during this research.
5. Keep original broker SL/TP and explicit early-exit protections in force; risk of further equity loss remains while model is unprofitable.

## Reproduction

From apps/api on the authorized VPS:
- node --test scripts/audit-pepperstone-asof-entry-context-net.test.cjs scripts/owner-demo-entry-timing-checkpoint-shadow.test.cjs
- node scripts/audit-pepperstone-asof-entry-context-net.cjs

The full report remains PRIVATE at /home/lightworld/webapps/irexpro-research/entry-context-net/latest-report.json with atomic 0600-permission write. It contains each trade-level causal quote comparison, original metadata and scored shadow checkpoints. No personal trade IDs or brokerage credentials enter Git history. There is no executable trade authority.
