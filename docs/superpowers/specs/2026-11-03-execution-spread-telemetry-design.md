# Execution Spread Telemetry Design

## Intent
Measure and report spread impact for new trades without changing execution authority or double-counting spread in net P&L.

## Goals
- Reuse the fresh bid/ask quote already proven by the final market-safety gate for every NEW_EXPOSURE PLACE dispatch.
- Persist entry quote evidence on the Trade at the durable OPEN transition.
- Calculate an auditable estimated round-trip spread cost in account currency using entry spread, contract size, lot size, and proven currency-conversion evidence.
- Report estimated spread cost and coverage separately from commission/swap and net realised P&L.
- Leave historical trades without quote evidence explicitly unmeasured.

## Non-goals / anti-goals
- No additional broker quote call on the critical execution path.
- No changes to model thresholds, admissions, risk gates, lot sizing, stop-loss/take-profit, or exit authority.
- No blocking or rejection when spread-cost telemetry cannot be calculated.
- No subtraction of estimated spread cost from realised/net P&L; broker realised P&L already embeds bid/ask spread.
- No fabricated backfill for historical trades.
- No pre-close quote call; CLOSE_POSITION must remain de-risking-first.

## Chosen approach
The market-safety gate returns the exact validated BrokerPrice it already fetched. The orchestrator carries that evidence on a FILLED new-exposure outcome. ExecutionService persists raw entry bid/ask/spread/timestamp at OPEN, then performs best-effort post-open spread-cost estimation. A small telemetry service resolves the instrument contract size and account/quote currency conversion using existing broker-native seams.

Estimated round-trip spread cost is an entry-spread proxy:

`spreadCostQuote = (ask - bid) * contractSize * lotSize`

It estimates one spread paid across a round trip under the explicit assumption that exit spread is similar to entry spread. It is not an extra broker debit and is never included in net-P&L arithmetic.

Currency conversion:
- account == quote: cost is already in account currency;
- account == base: divide quote-currency cost by the entry midpoint;
- third currency: use fresh broker-native account-to-quote bid evidence and divide by that rate;
- missing/unprovable evidence: retain raw quote telemetry, leave estimated account-currency cost null.

## Persistence
Add nullable Trade fields so legacy rows remain valid:
- entryQuoteBid
- entryQuoteAsk
- entrySpread
- entryQuoteObservedAt
- estimatedSpreadCost
- spreadCostEstimateMethod (`ENTRY_SPREAD_ROUND_TRIP_PROXY`)
- spreadCostContractSize
- spreadCostQuoteCurrency
- spreadCostConversionRate
- spreadCostConversionInstrument

## Reporting
Closed-trade reports add:
- `totalEstimatedSpreadCost`
- `spreadCostEstimatedTradeCount`

The UI replaces the placeholder Spread Impact card with an Estimated spread cost card and coverage detail. Mixed-currency results remain separated by currency. Per-trade API output exposes estimated spread cost plus entry-spread evidence where available.

## Safety
Telemetry estimation is post-fill and best-effort. Failure to derive contract size, currency, or conversion must never regress a durable OPEN trade or alter broker/provider state.