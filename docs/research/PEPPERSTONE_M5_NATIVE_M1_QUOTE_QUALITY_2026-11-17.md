# iRexPro — M5 as-of research source-quality audit

**Timestamp:** 17 November 2026, 19:55 UTC.
**Account:** exact-owner Pepperstone cTrader USD DEMO.
**Scope:** data-quality research, not a change to broker orders, stop-losses, lots, profit protection, LIVE access or the current trained Plan B expert.

## Verified issue

The quote-derived previous-M5 context recorder samples immutable positive broker-native bid/ask observations from already stored M1 quotes. EURUSD was rarely eligible for a genuine +15-second M5 context because many M1 aggregate observations had zero or missing closing spread or infrequent **positive** bid/ask events. Other pairs had denser positive-spread evidence.

The read-only comparison of the past **180 completed M1 minute buckets per pair** produced:

| Pair | Native total samples | Native positive-spread samples | Positive fraction | Avg. positive samples/minute | Minutes with no positive samples | Minutes with zero/missing closing spread |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| EURUSD | 23,698 | 1,628 | **6.87%** | **9.04** | **9** | **144** |
| AUDUSD | 26,900 | 6,364 | 23.66% | 35.36 | 0 | 38 |
| USDJPY | 34,183 | 8,417 | 24.62% | 46.76 | 0 | 4 |
| USDCAD | 18,134 | 5,426 | 29.92% | 30.14 | 0 | 16 |

The same EURUSD period had **17 more minute bars with exactly one positive-spread sample**. These figures are *database aggregate diagnostics at audit time*, not proof of the quotes' full tick history or of the executable trading spread. Zero, crossed and unverified spreads must never be filled with zero fee, fabricated into a valid quote, or used to bypass a broker risk veto.

## New recurring data-health evidence

Extended `apps/api/scripts/run-owner-demo-m5-quote-context-readiness.cjs` to attach `nativeM1QuoteQuality` to its private `latest.json` report. The additional query:

- Is protected by the same exact-owner verified Pepperstone cTrader USD DEMO broker-connection scope.
- Uses the existing `BEGIN READ ONLY` transaction and only current `ctrader-broker-native` M1 aggregates.
- Groups positive quote counts, total quote counts, zero-positive minutes, single-positive minutes, and zero/missing closing-spread minutes per instrument over a 180-minute window.
- Distinguishes sparse positive quote evidence as a **research-only diagnostic flag**, not an entry restriction, feed substitution, broker quality verdict or automatic model-promotion rule.
- Fails closed on contradictory aggregates (for example more positive-spread samples than total samples), keeps missing symbols distinct from satisfactory observations, and does not output account identifiers or credentials.

The existing PM2 `irexpro-m5-quote-readiness-shadow` refreshes this report roughly every fourteen minutes. Its native source quality section helps explain otherwise misleading missing training coverage. No additional order-placing services or subscriptions were introduced.

## Model-readiness boundary at 19:55 UTC

After training the v2 current-quote snapshot format, the collector had **41** immutable prospective M5 snapshots: **29** mature native M5 labels, **12** awaiting later outcomes, across **10 distinct five-minute market slots on one UTC trading date**. EURUSD had zero eligible matured v2 snapshots.

The readiness gate remains **FALSE**. Minimum research-dataset thresholds remain 20 distinct UTC days, 1,000 distinct market slots, and 200 matured rows per instrument; even meeting those prerequisites would **not prove profitability or authorize trading**. The existing Plan B and order router remain unchanged.

## Verification and operation

```sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --check scripts/run-owner-demo-m5-quote-context-readiness.cjs
node --test scripts/research-owner-demo-m5-quote-context-readiness.test.cjs \
            scripts/run-owner-demo-m5-quote-context-readiness.test.cjs
node scripts/run-owner-demo-m5-quote-context-readiness.cjs
pm2 describe irexpro-m5-quote-readiness-shadow
```

Only the research watcher should be restarted to load the updated telemetry. No restart of the main trading API, AI service, quote producer or broker connector is necessary. The current endpoint is a **private server-side JSON report**, not an authenticated user-facing dashboard.

**Next work:** investigate the EURUSD native M1 positive-spread sampling path separately, preserve source/observed timestamps, and compare source quote coverage by trading session without weakening quote validity. Accumulate several weeks of genuine prospective observations before a quote-context-specific M5 model is trained or evaluated for trading.
