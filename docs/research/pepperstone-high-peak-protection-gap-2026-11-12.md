# Pepperstone cTrader DEMO: high-peak profit giveback, 12 November 2026

## Verified incident

EURUSD SELL on 12 November 2026 opened at 03:12:19 UTC, 2.00 lots,
1.10731 entry, 1.10780 stop, 1.10650 target. Capital allocation
finalRiskAtStop was $100. Broker sampled unrealized PnL peaked at $130
(1.3R), but the broker closed the trade near the original stop at
04:37:46 UTC. Recorded gross PnL was -$100 and commission -$12, giving
-$112 net. Broker observations continued (path_observation_count=1,023).

The enabled Pepperstone DEMO net-giveback rule explicitly protects
early peaks BELOW 0.5R, so it did not apply to this large peak.
It deliberately keeps some eventual full-TP runners open.

A read-only study of 38 recent closed trades and 1,297 sampled M1
bid/ask broker quotes examined a simple high-peak giveback threshold.
It would have triggered on five trades: this EURUSD loss and FOUR
eventual TP winners. A blanket high-peak trailing exit is not safe.
These marks are sampled M1 prices, not a complete broker tick replay.

## New prospective research

The Pepperstone high-peak giveback shadow component now independently
observes existing DEMO M1 continuation trades without execution rights.
It requires broker identity, DEMO USD account, matching original
broker stop, target, direction and size, mature fresh broker observations,
a peak >=1R, a deep giveback with positive after-extra-fee net PnL, and
fresh consecutive M1 quote bars confirming adverse directional momentum.

A qualifying signal is deduplicated in the existing audit trail once
per trade and component. It cannot execute/modify a broker order,
change stop/target/volume, override any trade qualification gate,
or truncate TP winners. It must be validated prospectively before
any separate future DEMO promotion.

## Outstanding integrity issue

A USDCHF BUY opened at 05:07 on 12 November was marked CLOSED with
realised_pnl, commission and exit_price NULL. This does NOT imply
a $0 result and needs broker settlement reconciliation.

## Verification

Existing profit protection, Pepperstone net lock, and new high-peak
model suites: 98/98 passing. NestJS API build succeeded. Staging API
restarted with zero open trades, returned health HTTP 200 and
authenticated to Pepperstone cTrader DEMO. No new trading rules enabled.
