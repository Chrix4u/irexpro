# Fast-Mark Provider Failover Design

## Intent

Keep Deriv as the primary six-pair PAPER fast-mark stream while allowing Twelve Data to operate as an entitlement-aware secondary. A secondary provider may never make an unsupported/rejected symbol look live.

## Constraints

- PAPER market-data availability only; no entry-model, sizing, risk, SL/TP, DEMO or LIVE authority changes.
- Deriv is primary in the current staging configuration.
- Twelve Data Basic currently accepts only EUR/USD on the six-symbol WebSocket request; rejected symbols remain fail-closed.
- Fresh Deriv wins per symbol. Fresh Twelve Data may be selected only when Deriv for that symbol is stale/unavailable.
- Closed M5 remains the final fallback.
- Provider health must continue reporting each provider independently.

## Approach

Run Twelve Data as a secondary when Deriv is configured primary and failover is enabled. Preserve provider observations even when they are not selected. In `LivePaperMarketDataService.updateStreamingMid`, prevent a secondary Twelve Data tick from replacing a still-fresh Deriv quote; allow it to replace stale Deriv; allow fresh Deriv to reclaim selection on recovery.

## Alternatives considered

- Rotate Twelve Data Basic across all six symbols: rejected because it creates intermittent/stale coverage and misrepresents entitlement.
- Replace Deriv with Twelve Data: rejected because current Basic entitlement covers only one FX symbol.
- New coordinator service: unnecessary for the existing cache and would add more moving parts than required.
