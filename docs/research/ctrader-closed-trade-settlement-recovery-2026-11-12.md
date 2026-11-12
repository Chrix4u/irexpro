# Closed cTrader DEMO settlement recovery (12 November 2026)

## Root-cause and observed incident
At 05:07 UTC on 12 Nov, a USDCHF BUY on the Pepperstone cTrader DEMO account
opened (0.20 lots) and later was marked CLOSED. Its realised P&L, commission
and exit price were all NULL. The system must not represent it as a confirmed
zero result.

State reconciliation previously fetched the provider's closed-trade history
only when at least one internal trade was still OPEN, PENDING or
RECONCILIATION_PENDING. Once no such trades existed, a later authoritative
deal could not fill missing economics on an already CLOSED trade.

cTrader order IDs and position IDs can differ; the affected row's stored
externalPositionId was NULL. cTrader closes are keyed by the provider
position ID, not necessarily by the entry order ID.

## Production-grade recovery rules
The existing state reconciliation loop now performs a bounded 15-minute
lookback for up to 10 CLOSED cTrader DEMO trades within 7 days that have
all three settlement fields still NULL.

The broker's authenticated DEMO adapter supplies closed-deal history.
Recovery requires exactly one provider closing deal with the same position
ID, instrument, full lot volume, entry price and compatible close time.
If the app stored only the entry order ID, the authenticated broker must
provide the matching FILLED order's position ID, with exact order ID,
symbol, side, filled size and entry price evidence. Closing deal side may
be the opposite of the original position side; this is not inferred.

Strict guards:
- DEMO only, never LIVE.
- No guessed or overwritten existing realised P&L, commission or exit price.
- Reject multiple/partial closing deals and broker cost-sign ambiguity.
- Nullable-only, CLOSED-only, user/connection-specific atomic update,
  so a concurrent reconciliation cannot double-settle a trade.
- Original status and close reason are retained. No broker order is sent.
- Recovery is audited with provider position ID and closing timestamp.
- If evidence is absent, the trade remains financially unresolved; no
  fabricated zero or synthetic provider closing record is inserted.

## Qualification
The revised broker reconciliation and settlement evidence suites passed
79/79 automated tests, including missing-position-ID recovery, partials,
incomplete broker economics, races, and rejection for LIVE connections.

A successful deployment does NOT guarantee the historical USDCHF row will
be repaired: the actual provider history must contain a complete, unique,
validly signed closing deal. The database is only updated if it does.
