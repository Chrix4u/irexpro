# Pepperstone DEMO reversal and early-transition net profit lock — 17 Nov 2026

## Reconciled failure

Read-only confirmation from owner's connected Pepperstone cTrader **USD DEMO**: USDJPY BUY, 3.18 lots, opened 00:44:13 UTC and closed 00:53:20 UTC on 17 November 2026. Filled entry 159.472, exit 159.421, original stop 159.422, target 159.552. Gross realized trading P&L **−$101.73**, recorded commission **−$19.08** and swap $0.00; combined loss **−$120.81**. Maximum observed broker-reported favorable P&L **+$72.20**, initial position risk at stop **$99.7008973**, and final persisted giveback **$173.93**. Recorded close reason `BROKER_CLOSE`. The trade intent identifies `EARLY_TRANSITION`, via `DEMO_ADVISORY_REVERSAL_EARLY_ENTRY_PILOT`; it had 104 path observations.

The earlier Pepperstone net-profit close branch was enabled but restricted to `TREND_CONTINUATION` **below 0.50R peak**. Other Pepperstone M1 routes only emitted shadow observations. The generic cTrader route-aware lock (EARLY_TRANSITION 0.75R arm floor) did not run for Pepperstone; regardless, this trade's 0.724R peak was below that threshold. No claim that the exact historical broker close could have been filled at a hypothetical earlier price is warranted.

## Scoped fix

`pepperstone-demo-net-profit-lock.ts` now accepts **only** the existing `TREND_CONTINUATION` plus explicitly allowed `EARLY_TRANSITION` and `CONFIRMED_REVERSAL`. The continuation policy (0.20–0.50R early net-giveback pilot) remains unchanged.

The new reversal/early-transition route is additionally restricted to the configured scanner owner's **USD** DEMO account; an unset or mismatched owner cannot enable it for another tenant. It enters the *candidate* path only when **both** `IREXPRO_PEPPERSTONE_DEMO_NET_PROFIT_LOCK=enabled` and `IREXPRO_PEPPERSTONE_DEMO_ALTERNATE_NET_PROFIT_LOCK=enabled`. It requires 0.50R peak or more, a meaningful history-based cost-covered peak, a falling broker-reported net P&L, a 55%-of-peak broker-net threshold subject to an additional full causal fee reserve, and strictly positive estimated economic headroom.

Each close attempt is limited to **already-open DEMO** positions with independently verified broker instrument, direction, lot amount, entry, current price, original stop and TP, a minimum of four previous observations, a recently observed broker position, risk-at-stop evidence, and at least five same-symbol or eight same-account predecision filled commission observations. `ExecutionService.closeTrade(..., TradeCloseReason.PROFIT_PROTECTION)` owns the broker dispatch and reconciliation. **No additional entries, no lot changes, no stop/target modification, no LIVE account authority, no promises of realized profit.**

The same USDJPY scenario ($72.20 peak, $99.70 risk, $19.08 conservative fee reserve) yields a model protected broker-net P&L floor of **$39.71**; a synthetic falling mark of $39.30 requests a DEMO-only profit close, while +$54.26 remains a hold. The design provides room for runners but cannot guarantee execution at the exact floor during rapid gaps, provider disconnections or market slippage. At high volatility a protective request may still realize a loss.

## Validation / deployment

Focused Jest suites `pepperstone-demo-net-profit-lock.spec.ts` and `live-demo-profit-protection.service.spec.ts`: **98 passed** before release. Nest API production build: **PASS**. Existing narrow continuation, disabled alternate switch, risk/fee/price mismatch, wrong broker/account, and incomplete-observation behavior retained. API startup logs should confirm the alternate branch switch state after explicit DEMO-only activation.
