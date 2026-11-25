# Owner Pepperstone USD demo — quote coverage / spread validity

## Scope
This report is read-only. It does not replace provider-native quotes,
synthesize bid/ask, modify protective exits, submit trades or change capital.

Run from `apps/api`:

```
node --test scripts/audit-owner-demo-native-quote-coverage.test.cjs
node scripts/audit-owner-demo-native-quote-coverage.cjs
```

Output: `/home/lightworld/webapps/irexpro-research/native-quote-snapshots/latest-coverage-report.json`.
It evaluates the existing two-clock validated native JSONL quote archive,
from 04:30 UTC on 20 November 2026. It flags per-symbol source gaps over
60 seconds and reports sample density/quantile gaps.

## Findings at 10:55 UTC, 20 November

| Pair | Valid archived samples | Source gaps over 60s | Longest gap |
| --- | ---: | ---: | ---: |
| EURUSD | 2,154 | 51 | 210.247s |
| GBPUSD | 10,173 | 0 | 35.707s |
| AUDUSD | 8,652 | 0 | 36.929s |
| USDJPY | 10,545 | 0 | 36.542s |
| USDCAD | 9,164 | 0 | 37.142s |
| USDCHF | 9,456 | 0 | 36.654s |

Independent read-only database aggregation over the same broker-native M1
source found EURUSD had 28 buckets without a positive-spread quote among
388 minute buckets. The other five major pairs had none. EURUSD's
positive sample share was materially smaller (approximately 5%) than
the other pairs (approximately 19–30%).

### Implications and next checks

- The quote archive's EURUSD gaps are consistent with sparsity already
  present in `market_data.provider_quote_candles`; the sidecar does not
  appear to be the sole bottleneck.
- The one-shot cTrader adapter explicitly requires account- and
  symbol-matched spot events with a valid provider timestamp, and the
  candle store distinguishes a positive bid/ask spread from a zero spread.
  Verify **actual provider message semantics and symbol precision** before
  changing the conversion or freshness logic.
- Preserve the positive-spread, source/capture freshness and original
  broker stop/target checks. Never fill gaps with fabricated prices.
- Historical quotes are sampled observations, not broker-deal fills;
  missing samples cannot establish whether an original TP or SL was hit.
- Do not enable live-account execution or new broker-side stop amendments
  based on a historical quote-quality audit.

A majority of stored quote observations across all pairs have zero
spread; this is an upstream data-quality question, not yet proof of
a specific adapter defect. No execution change is authorized by this finding.
