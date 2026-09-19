# iRexPro AI Signal Engine

> **Sprint 8: market-data ingestion + scheduled paper-mode signal generation. No live trading approval.**

The AI Signal Engine produces `AiSignalCandidate` objects from market data and
model inference. **It never executes trades directly.** All candidates are
forwarded to the NestJS `AiSignalService` which routes them through the full
safety pipeline:

```
AI Engine  →  NestJS AiSignalService
         →  StrategyOrchestrator
         →  Subscription Gate
         →  Broker Connection Gate
         →  Risk Engine
         →  Execution Engine
         →  Broker Adapter
```

---

## Quick Start

### Prerequisites
- Python 3.11+
- Redis running (optional — cache gracefully disabled if unavailable)
- NestJS API running on port 3000

### Setup

```powershell
# Windows PowerShell
cd services/ai-engine

python -m venv .venv
.venv\Scripts\Activate.ps1

pip install -e ".[dev]"

# Copy environment config
Copy-Item .env.example .env
# Edit .env as needed
```

### Run

```powershell
uvicorn app.main:app --reload --port 8001
```

Health check: http://localhost:8001/api/v1/health  
API docs:     http://localhost:8001/docs

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

---

## Linting and Type Checking

```powershell
ruff check .
mypy app
```

---

## Collecting a real historical training corpus

The training pipeline should use broker-authoritative, fully closed candles rather
than mock/runtime fixtures. The collector pages backwards through the internal
market-data endpoint in bounded 500-candle requests and writes one deterministic
CSV plus integrity manifest per instrument.

Example for the default H1 universe:

```powershell
python -m app.domain.training.collect_broker_history \
  --user-id <user-uuid> \
  --broker-connection-id <connected-broker-uuid> \
  --instruments EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF \
  --timeframe H1 \
  --rows 15000 \
  --output-dir data/corpus
```

The collector:

- uses the connected broker through the NestJS internal API; Python never receives broker credentials;
- requests historical pages using an explicit `endTime` cursor;
- drops still-open candles;
- deduplicates overlapping provider pages;
- stores candles in chronological order;
- writes a SHA-256 manifest for every CSV;
- keeps generated corpora out of Git.

The normal signal scanner remains unchanged and continues to request only the
latest candles. Historical cursor reads are available only to broker adapters
that explicitly declare the historical capability.

---

## Training a pair-specific model bundle

After collecting and reviewing the broker corpus, train one candidate per
instrument/timeframe rather than pooling unrelated price scales into one model:

```powershell
python -m app.domain.training.train_corpus \
  --corpus-dir data/corpus \
  --output-dir models \
  --bundle-name fx-h1-candidate-v1 \
  --timeframe H1
```

The batch trainer verifies every corpus manifest SHA-256 before training. It
writes one model + metadata sidecar per pair and a bundle manifest containing
the exact instrument/timeframe routes. Paper approval is still false by
default; `--approve-for-paper` is an explicit operator decision and never
enables live trading.

To activate a reviewed paper bundle:

```text
XGBOOST_MODEL_BUNDLE_PATH=/secure/model-store/fx-h1-candidate-v1.bundle.json
```

At runtime the registry selects an exact route such as `EURUSD/H1`. If no
verified route exists for a requested pair/timeframe, the default model is
used and telemetry continues to identify whether that fallback is trained or
the heuristic scaffold. A model whose artifact metadata claims a different
instrument/timeframe is rejected from that route.

---

## Training a real XGBoost model

The runtime can load a real fitted XGBoost classifier, but generated artifacts
are deliberately not committed to Git. Supply a genuine historical OHLCV CSV
with columns `timestamp, open, high, low, close, volume`, then train offline:

```powershell
python -m app.domain.training.train_xgboost \
  --dataset data/EURUSD_H1.csv \
  --model-version xgboost-eurusd-h1-v1 \
  --instrument EURUSD \
  --timeframe H1
```

Training uses forward-return directional labels, excludes near-flat labels,
keeps chronological order, purges the prediction horizon between train and
validation, and writes both a model JSON artifact and a metadata sidecar with
SHA-256 checksums, feature schema, dataset fingerprint, label definition,
validation period, and held-out classification metrics.

After reviewing the validation output, an operator can explicitly create a
paper-eligible artifact with `--approve-for-paper`. Live approval is never
created by the training script.

Configure the runtime with both paths:

```text
XGBOOST_MODEL_PATH=/secure/model-store/xgboost-eurusd-h1-v1.json
XGBOOST_MODEL_METADATA_PATH=/secure/model-store/xgboost-eurusd-h1-v1.metadata.json
```

At startup the runtime verifies the artifact SHA-256 and exact feature schema
before loading it. If verification fails, telemetry continues to report the
heuristic fallback rather than claiming that a trained model is active.

Model confidence is the classifier's directional class probability estimate;
it is **not** a probability of profit or a guarantee of future performance.

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/health` | Service health |
| GET | `/api/v1/models/active` | Active model metadata |
| GET | `/api/v1/models` | All registered models |
| POST | `/api/v1/market-data/mock-ohlcv` | Mock OHLCV data (dev only) |
| POST | `/api/v1/signals/generate` | Generate signal candidate (not published) |
| POST | `/api/v1/signals/publish-to-api` | Generate + publish to NestJS |
| POST | `/api/v1/scheduler/sessions/start` | [INTERNAL] Register paper-mode scheduler job |
| POST | `/api/v1/scheduler/sessions/stop` | [INTERNAL] Unregister scheduler job |
| POST | `/api/v1/backtests/run` | Run isolated backtest (SIMULATED ONLY) |
| GET  | `/api/v1/backtests/sample-report` | Sample backtest report (mock data) |

NestJS internal market-data endpoint (called by `BrokerMarketDataProvider`):
`GET /api/v1/market-data/internal/ohlcv` (requires `x-irexpro-internal-api-key`)

---

## Safety Rules

1. `AI_SIGNAL_MODE` defaults to `paper`. Live mode is not supported.
2. `AI_SCHEDULER_ENABLED` defaults to `false`. Production requires explicit config.
3. No model is approved for live trading by default.
4. Python never accesses broker credentials — OHLCV flows through NestJS `BrokerService`.
5. Signal candidates are never executed by this service.
6. Secrets are never logged or included in signal payloads.
7. Mock market data is blocked in production unless `AI_ALLOW_MOCK_MARKET_DATA=true`.
8. The runtime supports verified trained XGBoost artifacts; without one it truthfully reports the heuristic scaffold.
9. Backtest results are `simulatedOnly=True` and never reflect real trading performance.
10. `BacktestEngine` never calls NestJS signal endpoint or any broker API.

---

## Model Governance

See `app/domain/models/governance.py`. Live trading approval requires a future
formal governance workflow involving the quant team and legal/compliance review.
No automatic live approval path exists.
