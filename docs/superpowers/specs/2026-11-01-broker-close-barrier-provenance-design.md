# Broker Close Barrier Provenance Design

## Intent
Recover accurate SL/TP close reasons when a broker reports a closed position without a specific close reason, using only authoritative trade barriers and provider exit price.

## Evidence
In the current cTrader DEMO 7-day cohort, 53 trades are labelled BROKER_CLOSE. Of those, 50 losses exited at the configured stop-loss barrier (average distance 0.10 pip, maximum 0.60 pip), 2 wins exited exactly at take profit, and 1 row has no usable exit price. All 52 price-provable rows also have valid entry/SL/TP geometry.

## Decision
When provider close reason is generic (MANUAL/SYSTEM/UNKNOWN/missing), infer a barrier close only if all of the following are true:
- provider close price is present and positive;
- entry price, stop loss and take profit are present and positive;
- barrier geometry is valid for the trade direction;
- exit price is at/crossed or within one pip of the relevant barrier.

Pip tolerance is 0.01 for JPY pairs and 0.0001 for the other supported FX majors.

Explicit provider close reasons remain authoritative and always win over inference.

If neither barrier is proven, retain BROKER_CLOSE.

## Historical correction
Add an idempotent migration that reclassifies existing BROKER_CLOSE rows to STOP_LOSS_HIT or TAKE_PROFIT_HIT using the exact same proof rules. Rows without adequate evidence remain unchanged.

## Goals
- Make realised-results reporting distinguish true stop losses and take profits from generic broker closes.
- Preserve conservative provenance when evidence is ambiguous.
- Avoid any change to execution, SL/TP placement, sizing, strategy logic or broker authority.

## Non-goals
- No retroactive P&L changes.
- No changes to trade entry/exit prices.
- No attempt to infer manual closes that occur between barriers.
- No LIVE-account promotion or execution-policy change.
