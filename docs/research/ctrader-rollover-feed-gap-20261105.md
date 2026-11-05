# cTrader DEMO broker-native market-data gap around daily rollover — 2026-11-05

## Verified data, bounded scope

The persisted cTrader DEMO connection remained CONNECTED and the VPS API
service remained online. Nevertheless, all three focused DEMO pairs had their
latest M1 live quote sample at approximately 21:29:52–21:29:53 UTC while the
collector continued requesting historical M5 and M15 data and reporting stale
provider responses. A read-only 22:00:04 UTC query observed ~30-minute-old
live prices. By 22:02:28 UTC, the same data had recovered (GBPUSD quote age
0.0m, EURUSD 0.5m, AUDUSD 1.9m). These timestamps are consistent with a
temporary broker-side rollover feed interruption, **not proof of its cause**.

The market-data service correctly retains strict freshness checks on M1, M5,
M15 and broker-native quotes. The account's active FULL_AUTO DEMO session and
CONNECTED broker metadata alone cannot establish real-time market readiness.

## Safe instrumentation change

- Add historical M1 provider-origin freshness reporting to the collector's
  existing in-memory status: `latestBrokerClosedBarAt` and
  `staleHistoricalResponses`, already used for M5/M15/H1/H4.
- Keep the distinction between a successful transport/persistence call and a
  *fresh* closed broker candle. Do not synthesize bars, extend timeouts,
  alter scheduler rate limits or change the execution readiness policy.
- Warn, rate-limited to once per minute per broker binding, when none of the
  configured symbols yield usable broker-native live quotes in a collection
  cycle. If even one symbol is fresh, do not report total source failure.
- Quote lookup, sampling, execution and market-data permissions remain
  unchanged; no model, stop loss, allocation, risk or lot-size modification.

## Validation

Unit tests cover stale M1 diagnostics, successful recovery clearing the
stale status, the all-six-symbol no-quote warning with throttling, and the
one-fresh-symbol no-false-global-warning behavior. Data is read-only and
no user-account, broker-connection or token identifiers enter this document.
