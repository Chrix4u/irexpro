# Owner DEMO loss-cluster dialog — 19 November 2026

## Motivation

The owner reported continued significant DEMO losses. At **2026-11-19 02:56:07–02:56:08 UTC**, Pepperstone USD DEMO closed:
- **EURUSD BUY**, Confirmed Reversal, **-$66.00 net**.
- **USDCAD SELL**, Confirmed Reversal, **-$57.17 net**.
- Combined **-$123.17 after broker commissions**.

Both were dispatched on the `DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE` path despite normal M1 `ABSTAIN`, independent expert `ABSTAIN`, and opposing higher-timeframe evidence. This **does not justify automatically reversing direction or imposing a blanket new trade ban**; alternative entries include winners too. The owner insists that any loss-pattern response must be visible and controllable, and existing Start/Stop Trading must remain the authority.

## Implemented UI behavior

- The existing broker-scoped closed-execution snapshot is read from the selected Pepperstone **DEMO FULL_AUTO** session. No new broker, database or order polling is added.
- An owner-visible loss-cluster dialog appears for the **two most recently closed**, distinct USD DEMO positions only when both were broker-settled net losses, closed within **two minutes**, the most recent close was within **60 minutes**, and the combined loss is at least **$25**.
- Commission is normalized once as a debit regardless of API sign; swap and realized broker P&L must be present and numeric. No missing commission is treated as zero.
- The snapshot must have been loaded for the exact currently selected broker connection and must not be a degraded closed-execution fallback.
- The dialog clearly displays the two instruments/directions, each net result and combined loss.
- **Continue Trading** acknowledges the incident locally. The existing AI trading session remains running with its normal strategy admission, Start/Stop, broker risk, margin and order management.
- **Stop Trading…** invokes the existing Stop Trading confirmation. That confirmation explains that Stop ends new AI entries and requests closure of existing AI-opened positions. The alert does **not** initiate Stop automatically.
- The browser remembers review of the exact incident for the remainder of the tab session, so four-second polling does not continually reopen the modal. A newly closed pair with a new incident ID receives a new alert.
- Other brokers, LIVE accounts and non-FULL_AUTO sessions do not receive this DEMO-specific warning dialog.

This is a **client-side app alert**, not an SMS, push notification or background alert when the app is closed. It is **advisory**, not a strategy-risk admission veto, timeout, approval token, or claim to fix profitability.

## Tests and release

Source:
- `apps/web/src/lib/owner-demo-loss-cluster.ts`
- `apps/web/src/lib/owner-demo-loss-cluster.spec.ts`
- `apps/web/src/components/trading/OwnerDemoLossClusterNotice.tsx`
- `apps/web/src/components/trading/OwnerDemoLossClusterNotice.spec.tsx`
- `apps/web/src/app/trade/page.tsx`

11 focused unit/component tests cover loss accounting, account and session scope, timestamps, deduplication, missing data, continue without changing session, stop delegating to the existing confirmation, and avoiding repeated dialogs. TypeScript `tsc --noEmit --incremental false` passed.

## Next financial work

Do not confuse the alert with an improvement to the strategy's expected return. The independently audited 121 settled USD DEMO trades had **-$1,859.45 net**, commission **-$1,267.20**, after-cost profit factor approximately **0.53**, and materially optimistic Plan-B expected R. To improve profitability, validate a recalibrated entry model against unseen time periods, examine early reversal timing, and measure broker exits and correlated USD exposure. Do not promote to LIVE from current results.
