# iRexPro — after-fee M1 and primary Plan B reliability correction
**12 November 2026 | Connected Pepperstone cTrader DEMO | Real broker P&L**

## Why this matters

From 11 November through the current latest closed broker ledger, 27
trades produced gross realized **−$416.47**, but their signed broker
commission and swap charges totaled **−$400.89**. The actual settled
net result was **−$817.36**. Gross expectancy is therefore an
unreliable proxy for trading quality and can mislabel a small gross
winner as an after-fee loss.

The previously installed `M1TacticalEvidenceService` had three
financial calculations still based solely on gross
`trading.trades.realised_pnl`:

1. `loadRoutePairSideEvidence` supplied the M1 strategy's
   historical winner/loss/R-evidence gate.
2. `loadMultimodelLossStreakBrake` supplied the primary Plan B
   per-pair/direction/route payoff and loss-streak brake.
3. `loadOutcomeMetrics` provided the historical M1 performance
   rollup and profit-factor computation.

## Conservative correction

All three now use settled ACCOUNT-CURRENCY broker net:
`realised_pnl + commission + swap`, since the account books
commission and swap as signed values. This does not change actual
broker trade P&L, positions, commissions or account balance.

- M1 evidence includes only CLOSED trades with known settled
  commission and swap; unknown fees cannot be treated as zero.
- The primary Plan B brake reads the recent eight real fills in
  exact user/DEMO connection/pair/direction/Plan B route. A
  missing cost component yields a NULL net and an explicit
  `BROKER_COST_EVIDENCE_INCOMPLETE` fail-closed result, not
  an accidentally positive or artificially smaller loss streak.
  The existing cooldown, loss-payoff thresholds, risk bounds and
  route matching are unchanged.
- The historical outcome metric's wins, losses, P&L and profit
  factor all use after-cost realized values and omit unpriced
  rows until settled costs are known.

### Direct incident audit of the 2 p.m. signals

At 14:25, 14:26 and 14:33 UTC, three EURUSD SELL signals had primary
Plan B authority with positive modeled post-cost R and no primary
authority blockers. Final broker-native dispatch was withheld by
`M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK`.

This was NOT an unexplained model-side failure: two earlier
**PRIMARY_PLAN_B / CONFIRMED_REVERSAL** EURUSD SELL trades had
closed at 08:58 and 10:19 UTC, both with realized net losses.

The three-hour bounded loss-streak recovery code, commit
`d3c71aa8` (16:50 UTC on 12 November), was introduced **after**
those 14:xx decisions. It would be misleading to attribute the
old stored rejections to a present-day cooldown-expiry defect.

The primary M1/Plan B entry algorithms, 2–4 lot sizing
capability, broker SL/TP, spread/R calculations, risk brakes,
demo account identity and rollover protection remain unchanged.
No forced order or stop amendment is part of this fix.

## Verification

- On the connected DEMO broker, all 44 November closed trades
  had recorded commission and swap; no presently observed
  gross-winner/net-loser classification inversion. However
  including fees still significantly changes the magnitude
  of profitability/payoff evidence.
- Tests assert SQL uses the signed booked cost expression, and
  primary missing-fee evidence explicitly refuses new authority.
- Requires full API test/build before deploy, followed by PM2,
  broker connection and real broker-ledger verification.

The fix makes risk and performance attribution trustworthy; it
does NOT guarantee higher trading frequency or profits.
