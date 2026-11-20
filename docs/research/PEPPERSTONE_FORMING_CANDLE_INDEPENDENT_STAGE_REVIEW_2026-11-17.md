# iRexPro — Fixed-stage forming-candle expert evaluation

**17 November 2026, 16:43 UTC.** This is an internal research record, **not** proof of profitable forex execution.

## Research pipeline running on the authorized VPS

- The existing `irexpro-native-quote-shadow` runs as a read-only sidecar to preserve observed Pepperstone cTrader positive bid/ask prices. It does not contact the broker to place orders.
- New `irexpro-forming-candle-shadow` PM2 process is ONLINE and has been persisted through `pm2 save`. It reads existing native-quote JSONL at fixed 15s/30s/45s within each minute; M5 is composed only of already-observed M1 native quote samples. Incomplete/missing minute paths are excluded, not invented.
- Initial backfill replay recovered **26,308** historical as-of snapshots from November 16–17. The live archive continues recording subsequent observations; snapshot retention is 90 days, per-day bounded 32MiB. Stored observations are sampled-midquote geometry, **not full-tick OHLC**, and have no broker account identifiers.
- Source `apps/api/scripts/collect-owner-demo-forming-candle-snapshots.cjs`, 13 unit tests passed. No trading API restart or live strategy modification was needed.

## Matured labels and training

- Read-only native candle exporter produced current GBPUSD-excluded four-instrument broker-native M1/M5/M15/H1/H4 corpus. Higher timeframe OHLC has no independent executable bid/ask, so measured M1 positive-spread evidence is used where needed; zero spreads are not invented.
- `services/ai-engine/scripts/research_forming_candle_learning.py` pairs **26,448** matured partial observations to actual completed **current and following** provider-native candle labels, using current/following OHLC as LABELS only.
- Predictors see only the forming-candle snapshot at observation time and completed previous candles. Global chronological 60/20/20 folds with 60-minute embargo and per-bar inverse duplicate weights. Every snapshot of a given candle is kept in the same split.
- Two research next-candle models (`M1`, `M5`) were trained and stored privately in `/tmp/irexpro-forming-candle-models/`. Their report is `/tmp/irexpro-forming-candle-evaluation-20261117.json`; training data private `/tmp/irexpro-forming-candle-labeled-20261117.csv`.
- Both train only on **two UTC trading dates**, hence `insufficientRegimeHistory=true` and `promotionAllowed=false`.

### Initial untouched chronological test (repeated snapshots; not independent trades)

| Measure | M1 | M5 |
|---|---:|---:|
| Test snapshots | 2,103 | 2,061 |
| Independent currency-pair/candle episodes | 741 | 147 |
| Model 3-class accuracy (next bar RED/FLAT/GREEN) | 43.84% | 49.34% |
| Training-only majority baseline | 46.36% | 39.01% |
| Raw model confidence >=65% | 1 snapshot / 1 candle | 228 snapshots / **25 candles** |
| Selected-class correct rate | 100% (N=1, meaningless) | 54.39% (N=228 correlated) |

### Fixed-stage independent-candle validation

`services/ai-engine/scripts/research_forming_candle_independent_stages.py` deliberately keeps exactly one prediction per currency-pair/candle at **predeclared** stages, without hindsight selection of the best-looking snapshot.

| Horizon / stage | Independent candles | Next-candle accuracy | Training-majority baseline | Observed-partial-body continuation baseline | High confidence unique |
|---|---:|---:|---:|---:|---:|
| M1 after 15 seconds | 693 | **41.27%** | 45.60% | 38.24% | 0 |
| M1 after 45 seconds | 700 | **45.00%** | 46.71% | 40.57% | 1 |
| M5 after 15 seconds | 132 | **52.27%** | 39.39% | 42.42% | 16 |
| M5 after 4m45s | 138 | **51.45%** | 40.58% | 43.48% | 14 |

M1 has **not** outperformed the simple majority baseline. M5 looks more promising on this small short-term sample, but neither is eligible for trade execution. These are **next candle** labels, not “will the currently forming candle finish green.” Do not mix the two tasks. The stage validation outputs are private at `/tmp/irexpro-forming-independent-stages-20261117.json`. Four synthetic independent-stage tests passed.

**IMPORTANT:** The spread-only paper proxy is based on next candle body; it does not replicate a trade entered during the current incomplete candle or its actual round-trip fees, margin use, slippage or SL/TP path. Neither accuracy nor an after-spread hypothetical price move establishes positive net realized P&L.

## Reproduce on VPS

```sh
cd /home/lightworld/webapps/irexpro-staging/services/ai-engine
.venv/bin/python -m unittest discover -s tests -p test_research_forming_candle_learning.py -v
.venv/bin/python -m unittest discover -s tests -p test_research_forming_candle_independent_stages.py -v
.venv/bin/python -m scripts.research_forming_candle_independent_stages \
  --dataset /tmp/irexpro-forming-candle-labeled-20261117.csv \
  --models /tmp/irexpro-forming-candle-models \
  --out /tmp/irexpro-forming-independent-stages-20261117.json
```

## Promotion and future data

- Leave existing Plan B v4 broker-native consensus expert, profit protection, lot limits, margin controls, stop-risk and LIVE unchanged.
- The research-only models cannot submit or modify an order; the new collector stores append-only read-only price evidence to aid future training.
- Collect multiple market weeks or months of **actual as-of intrabar** quotes (not fake partial candles reconstructed from OHLC). Monitor source age, quote gaps, archive size and session changes.
- Next validation: fit the current-bar-completion target separately; calibrate M5 predictions by stage and instrument with a much larger independent chronological period; price a real hypothetical entry from the actual as-of bid/ask through broker-realistic exit bid/ask and full commission. Only after repeatable after-cost improvement on later unseen episodes should an advisory-only expert influence the Plan B consensus. Never auto-promote based on this pilot.

**Status:** deployed research collector verified online. Model trained and independently evaluated, not integrated into live broker routing.
