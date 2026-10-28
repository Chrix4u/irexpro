# Broker-Native FX Conversion Design

## Intent
Prevent valid cTrader DEMO setups from failing cross-currency risk/sizing solely because an execution-time spot subscription for a direct account/quote cross is unavailable.

## Goals
- Reuse fresh broker-native bid/ask evidence already persisted for the exact broker connection.
- Resolve direct and inverse conversion pairs conservatively.
- Allow a USD bridge only when both broker-native legs are fresh on the same connection.
- Preserve the existing live broker direct-quote fallback.
- Keep every stale, incomplete, or unprovable conversion fail-closed.

## Non-goals / anti-goals
- Do not weaken max trade risk, leverage, daily loss, drawdown, or session gates.
- Do not use Twelve Data or another external provider as execution-risk authority.
- Do not invent or cache synthetic rates beyond the freshness window.
- Do not start/reset a trading session.

## Approach
Use `ProviderQuoteCandleStoreService` as the broker-native evidence store and add a focused conversion service. Resolve A/Q from fresh A/Q bid, else inverse Q/A ask via conservative inversion, else A/USD × USD/Q using fresh conservative leg bids. Position sizing and RiskService use this cache-first evidence; existing direct broker pricing remains fallback authority.

## Constraints
- Same `brokerConnectionId` for every leg.
- Maximum quote age: 60 seconds; tolerate at most 5 seconds of clock lead.
- ExactDecimal only for inversion/multiplication.
