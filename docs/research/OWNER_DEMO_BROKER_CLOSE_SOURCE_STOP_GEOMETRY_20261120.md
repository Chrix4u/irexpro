# iRexPro — broker-close source and original-stop attribution (owner USD DEMO)

**20 November 2026, 14:46 UTC. Source: existing read-only owner Pepperstone cTrader USD DEMO exit-payoff audit, opened since 17 November.**

## Why this change matters

The owner is investigating why an apparently correct forecast still loses money and whether the AI closes profitable positions prematurely. The persisted `BROKER_CLOSE` reason **does not establish STOP_LOSS, TAKE_PROFIT or external broker cause**. The application close-request audit, post-open order records and ORIGINAL intent SL/TP are independent partial evidence. This update joins these without issuing broker requests, modifying entry/exit models or claiming broker deal ACK.

## Verified settled-trade findings

284 broker-settled owner USD DEMO trades, broker-net -$3,034.21. 284/284 had verified original pre-entry model decisions linked to the original intent in the existing geometry audit. There were 85 recorded `BROKER_CLOSE` exits:

| Exit source evidence | Trades | After-fee winners | After-fee losers | Actual net |
|---|---:|---:|---:|---:|
| No matching application TRADE_CLOSE_REQUESTED audit or subsequent linked order record | 80 | 8 | 72 | -$5,976.07 |
| Matching persisted application request and linked post-open order | 5 | 4 | 1 | +$131.49 |
| Total BROKER_CLOSE | 85 | 12 | 73 | -$5,844.58 |

Of the 80 without a recorded matching application request, **69** closed **within two price pips of their originally submitted protective stop** (not a stop amended after opening). **All 69 were net losers, -$6,283.86**, with verified original decisions. The 69 include **37** whose ORIGINAL pre-entry M5 alignment was <= -0.20 in the proposed trade direction and **32** with no such contradiction. Thus an M5-only screen cannot explain all apparent original-stop losses.

Historical original pre-entry M5 condition in the ENTIRE 284-trade filled population — not only the stopped-looking losers:

| Strategy & frozen M5 | Filled/settled | Winners | Losers | Actual broker net |
|---|---:|---:|---:|---:|
| CONFIRMED_REVERSAL / M5 opposed <=-0.20 | 110 | 54 | 56 | -$1,761.85 |
| CONFIRMED_REVERSAL / M5 not opposed | 73 | 42 | 31 | -$367.96 |
| EARLY_TRANSITION / M5 opposed <=-0.20 | 23 | 17 | 6 | -$15.65 |
| EARLY_TRANSITION / M5 not opposed | 55 | 33 | 22 | -$650.60 |
| TREND_CONTINUATION / M5 not opposed | 23 | 14 | 9 | -$238.15 |

The 54 Confirmed Reversal winners and 17 Early Transition winners in the M5-opposed group would have been **incorrectly excluded by a blanket veto**. The historical win/loss contrast is exploratory: those dates and thresholds were already examined, they are not independent sealed holdout evidence. A planned untouched forward-validation cohort begins Sun Nov22 22:00 UTC in the separate owner loss-pattern watcher, requiring distinct days and enough actually broker-settled warned/unwarned entries before review.

## Implemented and limitations

Expanded the existing `apps/api/scripts/audit-owner-demo-exit-payoff-geometry.cjs` SELECT with correlated, owner-checked `EXISTS` evidence from `audit.audit_logs` (`TRADE_CLOSE_REQUESTED` within the actual open/close interval +2 minutes) and `trading.orders` (linked orders after opening). Existing query still demands exact owner, broker `pepperstone-ctrader`, `DEMO`, `USD`, non-deleted connection, actual CLOSED trades and non-null broker gross P&L/commission/swap.

New output groups app closure provenance, linked post-open order provenance, route versus proximity to *original* entry stop and take-profit, and frozen original model M5 opposition versus ALL settled winning/losing trades. Each group includes actual broker signed net after commission, original stop-based risk where verifiable, and winning trades sacrificed if hypothetically suppressed. No post-close prices or booked P&L are used as model entry features. Unit tests verify source separation and that missing source evidence remains UNKNOWN, as well as shadow-only behavior.

**The actual broker-native deal closure reason / STOP_LOSS trigger is NOT available in the inspected persistence tables** (`trading.orders`, `trading.trades`, `audit.audit_logs`); historical `BROKER_CLOSE` labels plus near-stop prices **cannot** establish a native SL hit, broker stop-amend ACK, gap slip or preventable loss. No order or account changes were made. A next engineering task is to capture verified cTrader execution/deal close reason and stop/target revision acknowledgments from provider response streams **without** sending orders, then compare those to original entry stop and quote path. Also separately evaluate stop-loss economics, spread and false abstention rates on truly new trading sessions.

This analysis cannot justify wider stops or larger LIVE positions. The explicitly owner-authorized up-to-seven-lot Pepperstone USD DEMO request ceiling and all existing risk, margin, stop and Start/Stop controls remain unchanged.
