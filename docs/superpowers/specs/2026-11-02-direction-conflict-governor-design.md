# Direction Conflict Governor Design

## Intent
Prevent iRexPro DEMO from opening contradictory same-instrument positions within minutes because independent model layers disagree. A newer opposite thesis must not create an unmanaged full hedge.

## Chosen approach
1. A primary Plan-B candidate is blocked when all broker-native trained experts unanimously support the opposite direction with confidence >= 0.70.
2. Before future promoted-DEMO execution, an already-open opposite M1 position is treated as a direction-flip conflict rather than independent exposure.
3. A confirmed-reversal candidate may request exit of the older opposite thesis first; the new side executes only after the old position is confirmed closed. Other opposite candidates wait.
4. Existing 5-second profit/adverse monitoring, SL/TP, loss brakes and drawdown controls remain authoritative.

## Non-goals
- No promise that every leg exits in profit.
- No unrestricted hedging or martingale behavior.
- No LIVE-account authority changes.
- No retroactive bulk closing on deployment.

## Safety
All new behavior is DEMO-only and requires existing Plan-B/M1 authority. The new side never bypasses risk, cost, event-risk, drift or session gates.
