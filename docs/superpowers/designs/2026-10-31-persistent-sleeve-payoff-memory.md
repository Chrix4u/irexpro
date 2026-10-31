# Persistent Sleeve Payoff Memory Design

## Problem
The current exact pair/side/route loss brake reads only the last 24 hours and uses a 12-hour cooldown. That is appropriate for a short loss streak but it forgets statistically meaningful negative payoff across the weekly FX close. At Sunday 2026-11-01 22:00 UTC, Friday's losing sleeves would have no rows in the 24-hour window even though their recent broker-native evidence remains strongly negative.

Verified cTrader DEMO evidence before this change:
- USDJPY BUY + EARLY_TRANSITION: 10 closed, 3 wins / 7 losses, net -36.27; last 8 net -20.94, PF 0.410.
- USDCAD BUY + EARLY_TRANSITION: 9 closed, 5 wins / 4 losses, net -16.62; last 8 net -19.99, PF 0.327.
- AUDUSD BUY + EARLY_TRANSITION: last 8 PF 0.728 (must remain executable by this rule).
- AUDUSD SELL + EARLY_TRANSITION: last 8 PF 1.008 (must remain executable).

## Decision
Keep the existing short-term three-loss brake and add a persistent severe-negative-payoff condition inside the same exact sleeve evidence loader.

The persistent condition is active only when all are true:
1. Exactly the same tenant, broker connection, instrument, direction, and Plan-B route.
2. The last 8 authoritative CLOSED trades are available within a 14-day evidence horizon.
3. Cumulative realised P&L across those 8 is negative.
4. Profit factor is strictly below 0.65.
5. The newest trade in the sleeve is no older than 96 hours.

The 96-hour relevance horizon crosses a normal weekend but allows stale sleeves to age out. A sleeve clears automatically when its rolling last-eight payoff improves above the threshold; there is no permanent blacklist.

## Safety
- No global confidence or consensus threshold is weakened.
- No profitable pair/side/route is blocked merely because another sleeve loses.
- Existing 3-loss/12-hour behavior remains intact.
- No changes to lot sizing, stop-loss distance, broker execution, or LIVE eligibility.
- Evidence remains broker-native realised P&L only.

## Telemetry
Return a distinct `PERSISTENT_NEGATIVE_PAYOFF` reason with the calculated PF and persistent flag so the scanner/UI can explain why the exact sleeve is quarantined.
