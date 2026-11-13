# Pepperstone cTrader DEMO: owner lot preference (3–4 lots)
**13 November 2026 UTC | Code reviewed, not actively deployed**

## Operator request
Stop automatic 0.01-lot AI trading on the connected Pepperstone cTrader
DEMO and use a 3–4-lot preferred execution band.

## Grounded findings
- Existing promoted DEMO engine V8 permits up to 4 lots, but recovery/
  qualified-continuation canaries cap themselves at 0.01 lots. Other
  fallback paths cap at 0.2.
- Owner-scoped, read-only broker ledger at approximately 01:17 UTC on
  13 Nov found an OPEN USDJPY BUY 0.01-lot trade. Do not alter its SL,
  TP, size, or lifecycle while validating this preference.
- A recent AUDUSD SELL closed at 1.72 lots. Previous 4-lot broker trades
  had both significant wins and losses. Larger lots do not improve entries.
- Pepperstone DEMO protective per-trade prescreen remains 0.25% of
  allocated capital. Broker margin, actual stop, model cap, portfolio
  brakes and risk profile remain binding.

## Scoped implementation in a separate development branch
- A pure rule classifies authoritative risk-sized entries.
- Apply it only after exact owner/connection, server-promoted model,
  Pepperstone cTrader DEMO and FULL_AUTO session verification.
- Reject an AI strategy proposal whose cap is below 3; NEVER increase a
  0.01 recovery canary to 3 merely to satisfy an operator preference.
- Reject broker/risk-sized entries outside [3.00, 4.00] before allocation
  or broker dispatch with typed DEMO_OPERATOR_LOT_PREFERENCE_BLOCKED.
- Approved size remains the exact broker/risk-sized volume within band;
  never round up, increase risk, change SL/TP or enable LIVE permissions.
- Keep pre-existing open positions and all non-Pepperstone routes unchanged.

## Expected trade-off
This rule can materially REDUCE the number of new trades. A valid setup
for which the broker/risk engine permits only 1.72 lots will now abstain,
not become a 3-lot order. A 5-pip stop on 3 lots of EURUSD/AUDUSD
roughly represents $150 gross stop exposure before costs; on 4 lots
roughly $200. Against a $40,000 allocation, these respectively exceed
a 0.25% ($100) cap. Account-specific conversions and margin still apply.
Do NOT relax existing loss brakes solely to force the preferred size.

## Validation and deployment
20 targeted tests pass: sub-3 and oversize rejection, 3/4 acceptance,
invalid sizes, scope isolation, exact code integration before allocation.
The active broker session and an open position block restarting the API
under the existing deployment policy. This branch is NOT deployed.
After controlled stop, broker-confirmed flat and CI gates, verify actual
broker fills preserve the requested band. No LIVE promotion authorized.
