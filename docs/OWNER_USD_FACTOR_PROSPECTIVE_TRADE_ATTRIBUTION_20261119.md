# iRexPro — prospective USD factor attribution to actual DEMO trades

**19 November 2026 — Research only, no trading authority**

## Why this observer exists

The independent six-pair USD factor has not shown a positive standalone after-spread directional edge in the initial ~48-hour backtest. Its possible value is as **context** to the existing Confirmed Reversal, Early Transition and Trend Continuation strategies.

The retrospective join to 105 settled owner DEMO trades found incomplete strong independent cross-pair evidence for many entries. Of the 54 eligible entries, aligned versus opposed net results differed substantially, but both groups lost money and the trades were selected and clustered. This is not proof a new entry veto or lot multiplier works.

The separate **prospective trade-attribution observer** provides genuine frozen feature records rather than retroactively labeling every previously settled trade.

## Guardrails and design

`apps/api/scripts/watch-owner-demo-usd-trade-alignment.cjs`:

- Runs independently of the trading API and scanner.
- Verifies the exact configured owner, active FULL_AUTO broker-bound session, connected/authorized Pepperstone cTrader USD DEMO account, and six broker-native M1 market feeds.
- Creates an immutable, broker-owner fingerprinted activation timestamp. Never retroactively enrolls positions opened before that activation.
- Enrolls only broker positions observed **OPEN** within two minutes of their open time. First-seen already-closed trades cannot be cherry-picked or given an artificial historical entry feature.
- Freezes a leave-one-out USD-strength state from the **most recent fully completed M1 candle at least 3 seconds before that trade actually opened**. It never uses future candles to make the entry factor.
- Requires independent, timely, positive-spread broker bid/ask data. Missing peers or consensus become `UNAVAILABLE` or `NO_STRONG_CONSENSUS`, not implicit approval or rejection.
- After the broker trade is reported CLOSED, records broker gross P&L plus commission and swap. The originally frozen entry features are immutable in the study.
- Separates `aligned`, `opposed`, and `unavailable` trade cohorts, by strategy, net profit and UTC trading day.
- Uses bounded `REPEATABLE READ READ ONLY` PostgreSQL transactions and private, restart-resilient journal/state files under `/home/lightworld/webapps/irexpro-research/usd-common-factor/trade-forward/`.
- Has **no** access to broker order submission or closure. Does not modify models, Start/Stop, stops, targets, lot sizes, risk gates, accounts or LIVE trading.

## How to verify

```sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/watch-owner-demo-usd-trade-alignment.test.cjs
pm2 start scripts/irexpro-owner-usd-trade-alignment-forward.pm2.config.cjs
pm2 save
```

The observer starts at zero positions by design. The existing independent USD price-direction forward shadow continues separately. The attribution report must not be interpreted as a random or independent controlled trial: all trades share market regimes and the AI self-selects its entries.

## Next evidence threshold

Collect across multiple independent trading days, compare after-cost trade results by route and factor alignment with confidence intervals, and evaluate whether the USD context improves calibration *without reducing net profit or indiscriminately blocking winners*. Require a prospective shadow comparison before promoting this factor into an actual DEMO model input. The code here grants no such execution authority.
