# iRexPro — audited broker gross vs net versus entry warning (20 November 2026)

**Owner Pepperstone USD DEMO, frozen-entry forward watcher (not a census of all account trades), 14:20 UTC. Research-only; no LIVE or broker order changes.**

The owner observed that his models show positive gross trading P&L but after broker commissions the trading result becomes negative. A new decomposition of **independently settled** broker entries now distinguishes true adverse-market trades from fee-only sign reversals.

## Broker-settled decomposition

| Frozen route | Fully reconciled settles | Gross trading P&L | Signed commissions | Signed swaps | Broker-net USD | Gross-positive but after-fee negative |
|---|---:|---:|---:|---:|---:|---:|
| EARLY_TRANSITION | 29 | +380.00 | -427.80 | 0 | -47.80 | 0 |
| CONFIRMED_REVERSAL | 125 | +81.07 | -1,649.40 | 0 | -1,568.33 | 0 |
| Combined | **154** | **+461.07** | **-2,077.20** | **0** | **-1,616.13** | **0** |

All 154 settled trades have full gross+commission+swap evidence which agrees with booked net within $0.03 rounding allowance (no fabricated fees). 85 trades were already gross positive and remained net positive, while **69 trades were already gross negative** before fees and remained net negative. It is therefore incorrect to say commissions individually converted these winning trades to losing trades. However total gross P&L was positive, and commissions converted aggregate gross profitability into a net loss.

The **80 PROFIT_PROTECTION** closes generated +$4,692.79 gross and +$3,507.31 after commissions. **29 AI_CLOSE_SIGNAL** exits were already -$1,306.17 gross (-$1,682.19 net); **45 BROKER_CLOSE** exits were already -$2,925.55 gross (-$3,441.25 net). Recorded close reasons are labels; their names do not independently prove native broker SL/TP modification acknowledgments.

Current frozen-entry warning economics are likewise decomposed **without** adding post-exit P&L to the originally frozen pre-entry features:
- Confirmed Reversal and frozen M5 opposing sign: 75 settled, 35 wins and 40 losses, -$581.57 gross and **-$1,443.53** after -$861.96 signed commissions. Blanket abstention would discard **35 actual winners**.
- Confirmed Reversal USDJPY BUY: 7 settled, 1 winner/6 losers, -$287.50 gross / -$366.04 net. This is observational over only two trading days; not a vetted automatic no-trade rule.
- Early Transition opposing M1 momentum: 9 settled, **all 9 winners**, +$554.54 gross and +$410.12 net. A generic M1-momentum opposition ban would be actively counterproductive in this observed set.

## Implemented analysis and constraints

The read-only forward research watcher now reports, for every route / instrument / frozen warning / close-reason cohort:
- gross trade P&L, signed commission and swap, fully reconciled settlement coverage;
- gross-profit trades, gross-loss trades, and the **fee-only gross-positive/net-negative** count and booked dollars;
- after-cost P&L, after-cost profit factor, and an indicative normalization by original pre-fill allocation risk where present;
- hypothetical winners rejected and losers avoided by a warning, without issuing broker orders.

It will NOT infer missing signed fees. Any missing, positive-signed commission or gross+fee+swap mismatch is marked unavailable, not forcefully reconciled. A post-close fee is an outcome, NEVER a pre-entry feature. No changes were made to original warning thresholds, candlestick models, risk gate, demo lot size or LIVE permissions.

**Next model milestone:** prospective, untouched-market-day validation of strategy-specific warnings after the historical reviewed dates. An eligibility gate should require multiple independent trading days, adequate flagged and unflagged signals, and after-fee and risk-normalized outperformance without sacrificing many winning trades. Any early example-based pattern should remain shadow-only until that evidence is available.

Files changed: apps/api/scripts/watch-owner-demo-loss-pattern-shadow.cjs and its Node unit tests. The 7-lot DEMO allowance remains authorized and separate.
