# iRexPro — Live Forming-Candle Expert / As-of Research Deployment

**Date:** 17 November 2026 (UTC)  
**Account:** owner-scoped Pepperstone cTrader USD **DEMO**  
**Deployed component:** research-only candle formation archive; does **not** participate in execution, modify risk gates, or change LIVE  
**Source branch:** `fix/planb-clock-neutral-telemetry-20261111`

## What changed and why

The existing iRexPro Plan B v4 broker challenger is a **loaded, trained three-expert consensus model** and the M1 tactical engine already uses candle-body, wick, close-location, momentum, ATR and higher-timeframe features. On 17 November, a separate next-M1/M5 completed-candle pilot was trained, with only small accuracy gains over a simple baseline and no demonstrated commission-inclusive profit.

The real missing input for the user's requested "read each candle as it forms" behavior was **historical data of how the same bar looked at an earlier instant**. Retrospectively slicing a completed OHLC candle into hypothetical 15-second candles would leak its final high, low or close. Instead, this research component derives snapshots from the timestamped native quote archive which is already captured live by `irexpro-native-quote-shadow` about every 2 seconds.

## Active research capture

- Existing source: `apps/api/scripts/collect-pepperstone-native-quote-snapshots.cjs`, which is owner-scoped Pepperstone DEMO and retains **positive broker bid/ask quotes** with native sample time and archive observation time. The raw source only retains seven days by its existing storage policy.
- New processor: `apps/api/scripts/collect-owner-demo-forming-candle-snapshots.cjs`, using **only previously observed and persisted quotes**, no broker API calls or SQL writes.
- PM2: `irexpro-forming-candle-shadow`, configured in `apps/api/scripts/irexpro-forming-candle-shadow.pm2.config.cjs`; separate process, restartable, startup list saved. Not wired into AI API endpoints or order router.
- Snapshot archive: `/home/lightworld/webapps/irexpro-research/forming-candle-snapshots/YYYY-MM-DD.jsonl`, files mode 0600, owner-only local storage; maximum 32 MiB/day, retention 90 days. This keeps compact partial-candle history beyond the original raw quote archive's 7-day retention.
- Each snapshot is a stage at :15, :30 or :45 seconds of each UTC minute for a *currently forming* M1 and M5 candle. M5 window starts on the UTC multiple of 5 minutes and is formed **only from sampled M1 positive-spread native quotes already observed by the cutoff**.
- Stored attributes: instrument, timeframe, current bar start, cutoff decision instant, elapsed seconds, *sampled* open/high/low/current close, body, wicks, range, close location, last valid bid, ask, positive spread, quote count, last native source quote time and last collector observation time.
- The schema explicitly declares `fullTickOhlc:false`, `fromCompletedFutureCandle:false`, `includesNextBarLabel:false`, `brokerOrderAuthority:false` and `modifiesExecution:false`. These are samples, **not tick-perfect broker candle highs and lows**.
- Invalid/stale bid/ask, late-observed native quotes, missing an already elapsed M1 segment of a forming M5 candle, future timestamps and nonapproved instruments are excluded.
- An initial replay of existing *actual as-of archived quotes* yielded **26,308** historical M1+M5 forming-candle snapshots from November 16–17; no synthetic partial-candle fabrication. On November 17 at 16:21 UTC, the daily archive held **10,433 M1 and 10,403 M5** distinct keys. The active worker was online and storing new snapshots.

## Next-candle labels and separate research model

`services/ai-engine/scripts/research_forming_candle_learning.py` joins the immutable partial snapshots to the actual **completed current and next native M1/M5 candles**, strictly for *labels*, with no finished current or next candle OHLC allowed in the feature columns. Inputs combine the sampled partial body, upper/lower wicks, observed quote spread, elapsed fraction, last close versus the **previous** completed candle, and ATR/momentum based only on **earlier** completed bars. Missing/nonconsecutive next-bar labels are rejected.

The initial source-to-label verification established **25,495** mature, usable labeled snapshots from the initial partial archive and the earlier strict completed-broker-candle export. Each timeframe's classification includes next RED/DOWN, SMALL BODY/FLAT (candle body below the as-of cost/ATR allowance), and GREEN/UP, with separate future-body and range targets.

The learner uses a **chronological**, globally shared across pairs, 60% train / 20% validation / 20% untouched test with 60-minute purges and **per-bar inverse-repeat weighting** so 15 forming-M5 snapshots do not count as 15 independent labels. Confidence scores remain **uncalibrated**. After-spread directional proxy is *not* after-commission realized P&L.

**Promotion policy:** This is research-only, even if a backtest appears good. Fewer than five independently sampled UTC trading days automatically triggers an insufficient-regime-history warning, not an approval. A future expert cannot enter execution unless it shows statistically meaningful **positive realized net expectancy after full fees and broker fill/path constraints** on later independent periods, maintains existing risk-at-stop and all broker protections, and is explicitly approved for DEMO shadow-to-trade promotion.

## Verification / ops commands

```sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/collect-owner-demo-forming-candle-snapshots.test.cjs
node scripts/collect-owner-demo-forming-candle-snapshots.cjs --backfill
pm2 describe irexpro-forming-candle-shadow
# Do not restart the active trading API just to run this collector.

cd ../../services/ai-engine
.venv/bin/python -m unittest discover \
  -s tests -p test_research_forming_candle_learning.py -v
```

For a labeled training run, first export newly completed native OHLC as existing owner DEMO research:

```sh
cd /home/lightworld/webapps/irexpro-staging/apps/api
node scripts/export-owner-demo-candle-training-corpus.cjs \
  --out=/tmp/irexpro-owner-native-forming.csv
cd ../../services/ai-engine
.venv/bin/python scripts/research_forming_candle_learning.py \
  --snapshots=/home/lightworld/webapps/irexpro-research/forming-candle-snapshots \
  --candles=/tmp/irexpro-owner-native-forming.csv \
  --dataset=/tmp/irexpro-forming-candle-labeled.csv \
  --report=/tmp/irexpro-forming-candle-learning.json \
  --models=/tmp/irexpro-forming-candle-models
```

The research model files and labeled dataset remain private under `/tmp`; **never commit private market archives or broker credentials**. Nothing in the new worker places orders or modifies the original 0.25% risk-at-stop, 6-lot DEMO conditional ceiling, commissions, position protection, or LIVE configuration.

## Known limitations and next investigation

Only ~one day of recorded positive-spread live partial-candle states had matured by the initial launch; future training must accumulate multiple independent trading sessions and verify calibration, class balance, session effects and full commission-inclusive profitability. Existing raw snapshots can be stored as sampled evidence but do not prove every midquote excursion or future executable exit. M10, M15 and H1 partial forecasts can be added after reliable multi-day M1/M5 results and their separate time-horizon labels are established.

The new research source is installed on VPS and the PM2 collector is **running**. The trained expert's use in actual trade prediction is **not enabled** and must not be claimed as deployed for live inference.
