# iRexPro AI Signal Engine

> **Sprint 8+: broker market-data ingestion, causal model research, and scheduled paper-mode signal generation. No automatic live approval.**

The AI Signal Engine produces `AiSignalCandidate` objects from market data and
model inference. All candidates are forwarded to the NestJS `AiSignalService`
and continue through the platform's orchestration, risk, and execution controls.

---

## Quick Start

### Prerequisites
- Python 3.11+
- Redis running (optional — cache gracefully disabled if unavailable)
- NestJS API running on port 3000

### Setup

```powershell
cd services/ai-engine

python -m venv .venv
.venv\Scripts\Activate.ps1

pip install -e ".[dev]"

Copy-Item .env.example .env
```

### Run

```powershell
uvicorn app.main:app --reload --port 8001
```

Health check: http://localhost:8001/api/v1/health  
API docs: http://localhost:8001/docs

---

## Running Tests

```powershell
pytest
```

With coverage:

```powershell
coverage run -m pytest
coverage report
```

## Linting and Type Checking

```powershell
ruff check .
mypy app
```

---

## Real historical training corpus

### Upstream source

The current production-aligned historical source is the user's connected
MetaTrader broker through MetaApi. NestJS calls the broker adapter and exposes a
private OHLCV endpoint to the Python AI service. The Python service never
receives broker credentials.

The canonical training source is **M1 OHLCV**. iRexPro derives M5, M15, H1, and
H4 itself on UTC boundaries. This avoids training/live drift caused by broker
server timezone differences in higher-timeframe candles.

The current corpus path uses historical candles, not raw tick history. Tick data
can be added later for execution-cost and microstructure calibration without
changing the causal candle alignment contract.

### 1. Collect genuine M1 broker history

The internal OHLCV endpoint accepts an optional `before` cursor. The collector
pages backward in blocks of up to 500 candles, removes duplicates, excludes the
still-forming candle, validates OHLCV, and writes a CSV plus SHA-256 manifest.

Use the internal API key through the environment:

```powershell
$env:NESTJS_INTERNAL_API_KEY="<internal-key>"

python -m app.domain.training.collect_historical \
  --api-base-url https://irexpro.lightworldtech.com/api/v1 \
  --user-id <user-uuid> \
  --broker-connection-id <connection-uuid> \
  --instrument EURUSD \
  --timeframe M1 \
  --target-rows 100000 \
  --output data/EURUSD_M1.csv
```

Repeat for the approved initial major-pair universe:
`EURUSD`, `GBPUSD`, `USDJPY`, `AUDUSD`, `USDCAD`, and `USDCHF`.

Generated market datasets and model artifacts remain excluded from Git.

### 2. Build the causal multi-timeframe corpus

```powershell
python -m app.domain.training.multitimeframe_corpus \
  --m1-dataset data/EURUSD_M1.csv \
  --instrument EURUSD \
  --output data/EURUSD_MTF.csv
```

The corpus builder:

1. normalizes timestamps to UTC;
2. treats source timestamps as bar-open time;
3. derives only complete M5/M15/H1/H4 bars from M1;
4. calculates causal indicators independently per timeframe;
5. assigns every bar an `available_at` equal to its canonical close time;
6. uses a backward as-of join on `available_at <= decision_time`;
7. retains source-bar provenance for every timeframe;
8. fails closed if any feature becomes available after the decision timestamp;
9. writes a SHA-256 manifest recording the raw M1 and derived-corpus fingerprints.

Example at decision time `10:15 UTC`:

- M1 source: 10:14-10:15, available at 10:15
- M5 source: 10:10-10:15, available at 10:15
- M15 source: 10:00-10:15, available at 10:15
- H1 source: 09:00-10:00, available at 10:00
- H4 source: 04:00-08:00, available at 08:00

The still-forming H1 10:00-11:00 and H4 08:00-12:00 candles are therefore
impossible to join to the 10:15 decision row.

### 3. Leakage and chronological validation

CI tests cover:

- UTC canonical alignment;
- complete-bar requirements;
- backward `available_at` joins;
- explicit provenance validation;
- rejection of future higher-timeframe features;
- purged chronological splits;
- expanding walk-forward folds with purge and embargo gaps.

The prediction horizon must be no longer than the configured purge gap at every
fold boundary.

---

## XGBoost training

The existing verified XGBoost pipeline persists a real fitted classifier and
metadata sidecar with artifact checksums, feature schema, label definition, and
held-out metrics.

The original trainer still accepts single-timeframe OHLCV while the new
multi-timeframe corpus is being qualified. The multi-timeframe trainer/runtime
schema should only replace it after the real corpus has been generated for the
approved instruments and the leakage suite is green.

For the current single-timeframe training path:

```powershell
python -m app.domain.training.train_xgboost \
  --dataset data/EURUSD_H1.csv \
  --model-version xgboost-eurusd-h1-v1 \
  --instrument EURUSD \
  --timeframe H1
```

A model artifact is never automatically approved for live use.

### Model evaluation before staging

Classification diagnostics:

- balanced accuracy;
- precision and recall;
- F1;
- ROC-AUC;
- log loss;
- Brier score / probability calibration;
- class balance and sample count.

Walk-forward, net-of-cost trading diagnostics:

- total net return;
- average and median net return;
- win rate;
- profit factor;
- Sharpe ratio;
- Sortino ratio;
- maximum drawdown;
- trade/decision count.

Transaction-cost assumptions must include spread, commission, and slippage
before the economic metrics are accepted.

Stability must also be reviewed across:

- walk-forward folds;
- each currency pair;
- London/New York/Asia sessions;
- volatility/trend regimes;
- the worst fold and worst instrument, not only aggregate averages.

A staging candidate must have zero leakage violations and must not be promoted
on classification accuracy alone.

### Agent Council historical overlay research

The six-pair walk-forward study can now export the exact outer-fold validation
predictions for each horizon. These are the only quantitative predictions that
may be used for contextual overlay research.

Build the first real causal context archive from official BLS monthly release
schedule pages:

```powershell
python -m app.domain.training.collect_bls_historical_context \
  --start-year 2024 \
  --start-month 1 \
  --end-year 2026 \
  --end-month 9 \
  --output research/context/bls_historical_events.jsonl
```

The collector uses only fixed official BLS monthly list-view URLs. Each page's
official `Last Modified Date` is interpreted conservatively as end-of-day U.S.
Eastern time because no modification clock time is published. Governed releases
at or before that timestamp are excluded as retrospective; they are not allowed
to masquerade as pre-event knowledge. A SHA-256 manifest records every page URL,
payload hash, availability timestamp, included event count, and retrospective
exclusions.

A standalone research evaluator can then replay that normalized historical macro
event archive against the outer-fold predictions:

```powershell
python -m app.domain.training.agent_context_evaluation \
  --predictions research/first-six-pair-run/reports/six_pair_walkforward_5m_predictions.csv \
  --events research/context/historical_macro_events.jsonl \
  --horizon-bars 5 \
  --pre-event-minutes 30 \
  --post-event-minutes 15 \
  --report research/context/agent_council_overlay_5m.json \
  --annotated-predictions research/context/agent_council_overlay_5m_rows.csv
```

Historical event inputs must be provider-normalized records with
`observed_at`, `available_at`, and `scheduled_for`. At each validation
decision, the evaluator ignores any provider revision that was not yet
available. The initial candidate policy only suppresses an already-active quant
entry when verified high-impact context yields `BLOCKED`.

The evaluator does **not** change direction, confidence, selected directional
return, position size, Risk Engine behavior, or execution. Its report remains
research-only and explicitly compares blocked winners and blocked losers before
any paper/UAT policy can be considered.

For one existing walk-forward prediction file, the collector + evaluator can be
run as one reproducible research command:

```powershell
python -m app.domain.training.run_bls_context_overlay_study \
  --predictions research/first-six-pair-run/reports/six_pair_walkforward_5m_predictions.csv \
  --horizon-bars 5 \
  --output-dir research/context/h5 \
  --pre-event-minutes 30 \
  --post-event-minutes 15
```

The secured `Six Pair Research Run` uses this orchestration automatically on
the horizon selected by quant-only research. It persists the BLS archive,
manifest, overlay report, and annotated prediction rows with the candidate
research output and logs side-by-side quant/context metrics. The context result
is observational only: it does not participate in horizon selection, final
XGBoost fitting, untouched-test approval, paper promotion, or live promotion.
If official context collection/evaluation cannot be completed, the workflow
emits `CONTEXT_RESEARCH_HOLD` and leaves the existing quant governance path
unchanged.

---

## Runtime model artifacts

Configure the runtime with both paths:

```text
XGBOOST_MODEL_PATH=/secure/model-store/xgboost-eurusd-h1-v1.json
XGBOOST_MODEL_METADATA_PATH=/secure/model-store/xgboost-eurusd-h1-v1.metadata.json
```

At startup the runtime verifies the artifact SHA-256 and exact feature schema.
If verification fails, telemetry continues to report the heuristic fallback
rather than claiming that a trained model is active.

Model confidence is the classifier's directional class probability estimate;
it is not a probability of profit or a guarantee of future performance.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Service health |
| GET | `/api/v1/models/active` | Active model metadata |
| GET | `/api/v1/models` | All registered models |
| POST | `/api/v1/market-data/mock-ohlcv` | Mock OHLCV data (dev only) |
| POST | `/api/v1/signals/generate` | Generate signal candidate |
| POST | `/api/v1/signals/publish-to-api` | Generate + publish to NestJS |
| POST | `/api/v1/scheduler/sessions/start` | Register paper-mode scheduler job |
| POST | `/api/v1/scheduler/sessions/stop` | Unregister scheduler job |
| POST | `/api/v1/backtests/run` | Run isolated simulated backtest |
| GET | `/api/v1/backtests/sample-report` | Sample backtest report |

NestJS internal market-data endpoint:
`GET /api/v1/market-data/internal/ohlcv`
(requires `x-irexpro-internal-api-key`).

---

## Safety and governance

1. Mock market data remains blocked in production unless explicitly enabled.
2. Python does not receive broker credentials.
3. Secrets are never logged or included in signal payloads.
4. Generated corpora and model artifacts are not committed to Git.
5. Trained-model telemetry must remain truthful about the loaded artifact.
6. Backtest results are simulated and are not evidence of future performance.
7. Model promotion requires explicit governance; training does not grant live approval.
