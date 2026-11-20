# iRexPro: frozen pre-entry winner/loser formation audit (2026-11-19)

READ-ONLY. No trading, exposure, stop/target, LIVE permission or model-weight change.

## Verified cohort
191 closed owner Pepperstone cTrader USD DEMO orders from Nov 17–19, each linked
to its original M1 decision recorded BEFORE the trade intent and broker open.

| Original Plan B route | Winners | Losers | After-fee net USD |
|---|---:|---:|---:|
| Confirmed Reversal | 56 | 62 | -2076.10 |
| Early Transition | 39 | 22 | -446.54 |
| Trend Continuation | 9 | 3 | +309.11 |
| Total | 104 | 87 | -2213.53 |

Discovery Nov 17–18: 99 trades, 55 winners, 44 losers, net -1333.76 USD.
Later Nov 19: 92 trades, 49 winners, 43 losers, net -879.77 USD.
The later date is retrospective, NOT an untouched sealed holdout.

## Models could not reliably discriminate profit
Winning-trade score AUC: .50 represents chance-level ranking.
These measurements are conditional on already executed orders.

| Frozen entry score | Reversal AUC | Transition AUC |
|---|---:|---:|
| Plan B overall | .5216 | .4685 |
| Predicted after-cost R | .4447 | .4312 |
| Meta probability | .4579 | .4254 |
| Trained expert opportunity score | .4706 | .4009 |

Reversal winner average predicted R .2337 vs loser .2586. Plan B's higher
forecast does NOT imply a higher realized probability of winning. Reversal
predicted-R AUC changed from .3649 on Nov 17–18 to .5244 on Nov 19, so a
simple inverted threshold would overfit. Every one of the 191 executed entry
snapshots had expert state ABSTAIN, both on winners and losers.

## Candle evidence reconstructed without future leakage
The mutable historical completed broker-candle table was later updated, so
its historical values cannot verify what the trader knew at entry.
Instead the independent sampled native bid/ask quote snapshot archive was
matched only when quote SOURCE and OBSERVED times were no later than the
original decision cutoff. 172 of 191 entries have both valid M1 and M5
pre-entry forming candles: Reversal 107/118, Transition 56/61, and
Continuation 9/12. Missing 19 are NOT counted as favorable candles.
These are sampled-quote forming bars, NOT full-tick OHLC and NOT an
independently trained candlestick expert prediction.

Candle body direction, rejection wick, close location, H1/H4 alignment,
M1/M5 momentum, Plan B quality and independent expert were compared.
Blocking entries solely for an opposing forming M1 body would have
discarded SIX winning Nov 19 Early Transition positions in that cohort.

M5 directional opposition with Confirmed Reversal was associated with:
- Nov 17–18: 16/33 flagged losses vs 8/20 unflagged
- Nov 19: 27/44 flagged losses vs 11/21 unflagged
This is exploratory, varies by instrument, and the flagged Nov 19 group
contained SEVENTEEN winning trades. Do not add a hard veto. There is
already a scoped M5-reversal disagreement soft lot cap.

## Entry and exit cannot be confused
At least 53 of the losing Reversal/Transition positions (39+14) recorded
an earlier favorable broker mark. Historical peak values do NOT guarantee
an executable earlier close. Study profit protection separately; never
feed after-entry peak or realized P&L into a pre-entry predictor.

## Development implication
1. Preserve immutable paired BUY/SELL entry-context and sampled native M1/M5
   candle features, expert probabilities/votes, regime, cost, quote age and
   exactly which authority pathway led to a broker order.
2. Calibrate supervised route-specific forecasts against actual settled
   after-fee broker outcomes (and prospectively labeled rejected quotes);
   account for correlated USD instruments, overlapping episodes, and lots.
3. Require sealed later UTC market days and realistic risk-normalized,
   after-cost execution performance. Measure blocked losers AND sacrificed
   winners, by strategy, pair and session.
4. Keep proposed avoidance rules SHADOW ONLY until validated. No retrospective
   rule may modify risk, stop, direction or entry authority automatically.

Scripts from apps/api:
node scripts/audit-owner-demo-win-loss-formation.cjs
node --test scripts/audit-owner-demo-win-loss-formation.test.cjs scripts/owner-demo-asof-candle-win-loss.test.cjs

Private report:
/home/lightworld/webapps/irexpro-research/entry-formation/latest-report.json
