# Route-Aware Profit Protection Design

## Problem
cTrader DEMO profit protection closes many winners too early. Of 62 PROFIT_PROTECTION exits, 44 later reached original TP before original SL. For exits <= EUR 6, 29/44 later reached TP first.

## Evidence
Conservative post-close replay uses broker-native M1 candles, excludes the partially completed close minute, and classifies the first original barrier hit within four hours.

For profit-protected trades whose peak favorable excursion was below 0.75R:
- CONFIRMED_REVERSAL: 7 trades, 7 TP-first / 0 SL-first; historical barrier counterfactual +8.4R versus actual protected exits.
- EARLY_TRANSITION: 27 trades, 20 TP-first / 7 SL-first; historical barrier counterfactual +14.0R.
- TREND_CONTINUATION: 9 trades, 3 TP-first / 6 SL-first; relaxing protection would worsen the replay by about -4.35R.

Broker M1 momentum at the protection exit did not discriminate TP-first from SL-first reliably enough. Route is the stronger observed separator.

## Decision
1. Preserve current profit-lock policy for TREND_CONTINUATION and unknown routes.
2. For EARLY_TRANSITION and CONFIRMED_REVERSAL, do not arm profit protection below 0.75R peak favorable excursion.
3. Once 0.75R is reached, use the existing retention tiers unchanged.
4. Apply the route-aware behavior to cTrader DEMO execution by passing the originating Plan-B route into the existing profit-lock evaluator.
5. Do not alter stop loss, take profit, entry selection, lot sizing, or LIVE behavior.
6. Persist no fabricated counterfactual truth; the historical replay is research evidence only.

## Safety
- LIVE remains structurally excluded by LiveDemoProfitProtectionService.
- Trend Continuation retains its current protection because its replay shows protection is economically useful.
- Missing/unknown route falls back to current conservative behavior.
