# iRexPro broker-aware dynamic position sizing — 2026-11-05

## User decision and design

**0.20 lot is the preferred PROFESSIONAL DEMO size, not an unconditional minimum.** iRexPro does not accept deposits or set a broker account's minimum deposit: the user funds the connected broker directly. A $5 or $10 balance should not be rejected by iRexPro *solely* because it falls below a product-defined balance threshold, but no system can guarantee a trade on such small balances.

An executable volume is derived from the exact user's current broker account equity/free margin and currency, instrument contract size/minimum/step/maximum, fresh entry/stop geometry, the user's persistent maximum risk-at-stop %, allowed effective leverage, AI allocation/model upper bound, broker-required margin, and the final independent RiskService and cost-aware entry gates. **All amounts are exact decimal arithmetic and all lot steps round DOWN**; missing broker evidence blocks dispatch.

The previous hard PAPER product 0.20 lot and 0.10 margin fallback floors blocked many smaller risk-eligible DEMO trades for reasons unrelated to the broker's actual minimum. Those two **artificial executable floors are removed**. The 0.20 preferred lot is still lifted toward when the broker/model/stop-risk/allocation/leverage constraints allow it. Otherwise, the largest step-normalized, demonstrably affordable volume is considered down to the *actual broker minimum*, not a fabricated 0.01 or 0.001 minimum. Non-DEMO/LIVE behavior does not gain any new preferred-floor override; existing profile, risk and execution safeguards remain.

The M1 aligned-currency exposure pre-screen now searches down in 0.001-lot increments instead of enforcing the prior 0.20 product floor. This is **only a search resolution**: the final broker instrument minimum, stop risk, broker margin, cost evidence, route reliability and risk gate must all still accept the proposed size. A 0.001 search result is not a promise that the connected broker trades 0.001 lots.

For DEMO accounts with **equity <= 50 units of the account currency**, the sizing engine limits available margin to 80% of the lesser of confirmed broker free margin and the explicit AI allocation, retaining 20% headroom. The actual margin check remains broker-native. It never increases the risk percentage or authorized leverage to manufacture a tiny-account trade.

## Reproducible examples (mocked broker)

At EURUSD 1.085, a 10-pip stop, 100,000 units per standard lot, explicit allocated capital equal to equity, user max 2% stop risk and 30x effective leverage:

| Broker balance | Broker minimum/step | Risk-safe chosen lot | Expected margin test | Outcome |
| --- | --- | --- | --- | --- |
| $5 | 0.001 / 0.001 | 0.001 | $3.60 | eligible for further risk/fee gates |
| $10 | 0.001 / 0.001 | 0.002 | $7.20 | eligible for further risk/fee gates |
| $10 | 0.01 / 0.01 | none | not called | reject below broker minimum/effective leverage |
| $5 | 0.01 / 0.01, **smaller 1,000-unit contract** | 0.10 | $3.60 | eligible only if broker reports that contract and volume |
| $1,000 | 0.001 / 0.001 | preferred 0.20 | $720.00 | eligible for further risk/fee gates |
| $1,000 | 0.001 / 0.001 | 0.066 | $990.00 | margin-based step-down from 0.20 |

These are **unit tests, not observed broker quotes or trade executions**. cTrader and its brokers may offer larger minimum lots, different margins, leverage and fees. An account that cannot cover the instrument's smallest permitted position should show `POSITION_SIZE_BELOW_MINIMUM` or `BROKER_MINIMUM_MARGIN_UNAFFORDABLE` with a useful reason. No order should be issued to force a trade.

## Rollout / risk scope

- This work is strictly **sizing policy**. It does not send a trade, turn on an ended AI session, change cTrader credentials, lower win-rate/profit-cost qualification, disable profile drawdown, eliminate the 5-pip minimum SL, modify Stop/Kill, or enable the research partial-exit execution.
- Live trading is not newly unlocked, nor are any risk limits lifted. Both Stop AI Trading and outstanding position supervision remain as before.
- Commission-aware broker entry qualification remains mandatory; for tiny balances, broker minimum commissions may make otherwise affordable micro trades **uneconomic**. Such setups must abstain instead of promising a profit.
- The audit's `preferredLotTarget`, `lotSelectionReason`, `microAccountMarginReservePercent` and `paperProductMinimumLot` (now **actual broker min**, not 0.20) explain selection.

## Release acceptance

Run focused position sizing and M1 exposure suites, then M1 scheduler and strategy orchestrator regression suites, full API TypeScript check, changed-file lint and GitHub risk/security/CI checks. Deploy to staging only after exact-SHA gate passes. Test a connected cTrader DEMO account with its actual live min/step/margin before promoting to automatic execution. **No guarantee of order placement or profitability**.
