# Pepperstone owner DEMO entry quality: 17–18 November calibration warning

**Read-only audit at 18 November 2026 ~11:47 UTC.** No entry routing, model weights, lot allocation, risk veto or live/deployed model execution changed as a result of this document.

Source: exact owner Pepperstone cTrader USD DEMO trading.trades joined to the original trading.trade_intents metadata and the as-of capital allocation. Include only closed 17–18 November 2026 trades with Plan B strategyRoute EARLY_TRANSITION or CONFIRMED_REVERSAL; net is settled gross + signed commission + swap.

There are **92 closed trades** for these two strategies, with a combined booked **−$1,111.08 net**. Both routes nevertheless booked 49 protected wins totaling +$1,553.13, showing that the negative total is due to the distribution of losses and fees, not the absence of any winning patterns.

## Independent M1 timing specialist

79 of the 92 live filled trades had original M1 tactical route **ABSTAIN**, despite separate Plan B continuous execution authority. Those 79 eventually booked **−$1,141.33 net** across four instruments (EURUSD 9, AUDUSD 22, USDJPY 24, USDCAD 24). The remaining 13 trades had an explicitly named M1 route and booked a combined **+$30.25**. This is an important diagnosis, not a justification for a blanket ABSTAIN veto: the groups are small, nonrandom and include successful trades in both cohorts. Plan B and the M1 tactical specialist have separate authority assumptions. Investigate independent entry timing confirmation rather than halting all otherwise qualified trades.

## Forecast score calibration warning

Original Plan B governance net expected R (before entering) vs ACTUAL settled trade result:

| Recorded predicted net expected R | Closed trades | Wins | Booked net P&L | Mean initial risk-at-stop |
|---|---:|---:|---:|---:|
| Less than 0.20 | 25 | 16 | +$2.64 | $72.27 |
| 0.20 to less than 0.40 | 49 | 27 | −$713.80 | $71.10 |
| 0.40 and above | 18 | 8 | −$399.92 | $75.08 |

**Higher predicted positive R did not correspond to better after-cost realized returns in this two-day sample.** The original risk amount and booked net measure different things; do not equate them. The 92 trades are concentrated in a few correlated FX sessions with overlapping USD exposures. These are NOT independent training examples and do not establish long-run score reliability.

## Strategy-specific signs, not executable rules

- Confirmed Reversal USDJPY BUY: 4 trades, 0 net winners, −$282.96. Early Transition USDJPY BUY: 6, 3 winners, −$231.24. Combined 10 USDJPY BUY trades, −$514.20. This may reflect the prevailing market regime, not a permanent BUY prohibition.
- Early Transition AUDUSD SELL: 9, 8 winners, +$189.68.
- Confirmed Reversal AUDUSD SELL: 8, 3 winners, −$187.98, the same instrument and direction under a different strategy lineage.
- Confirmed Reversal USDJPY SELL: 11, 7 winners, +$113.05. Opposite direction performance within the same instrument differs substantially.

Do not retrospectively ban a symbol, side or session on this small two-day outcome. Overfitting would simply create more inactivity or selection bias. The user explicitly requests retaining existing DEMO exposure and lot sizing.

## Next model work, ordered by evidence

1. Construct a **strictly prospective** entry-quality dataset using the ORIGINAL submitted Plan B score, independent expert votes, original M1 ABSTAIN/route, M5/H1 regime and broker native quote freshness and spread. Do not use subsequent stop/TP outcomes in feature generation.
2. Label first 1/3/5/10-minute path excursions, original TP/SL first observed side-specific quote crossing, true booked commission/swap, and after-cost realized R, with possible missing quote windows explicitly censored.
3. Diagnose the current expected-R calibration against actual signed net R, across disjoint market dates/session groups with purged chronological out-of-sample splits. Compare against simple direction/regime baselines and report calibration uncertainty. Commissions and USDJPY/USDCAD price-to-USD conversion must be correct.
4. Research entry timing/confirmation decisions that improve the profitable-to-losing distribution without universally excluding M1 ABSTAIN records, without forcing lots smaller and without reinstating the aggressive adverse loss cut. Keep any new model SHADOW until prospective after-commission net benefit is demonstrated across independent days and symbols.
5. Do not treat the freshly trained forming-candle expert as an executable confirmation: its prospective directional spread-only performance and after-commission impact have not been proven.

This report makes no claim that either strategy or any candidate gate is ready for LIVE. It is the next research input following the separately deployed 49-winner first-observed-TP and protected-trailing-shadow study.
