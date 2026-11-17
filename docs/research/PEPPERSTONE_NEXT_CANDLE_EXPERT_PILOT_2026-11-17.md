# iRexPro Candlestick Formation Expert: trained research pilot

Prepared 17 November 2026 (UTC). Owner Pepperstone cTrader USD DEMO. Research only: neither model has any authority to open/close trades, alter lot sizes, change broker stops, or modify LIVE trading.

## Existing expert and new specialist

The deployed Plan B v4 broker expert is real and loaded; its verified internal status shows artifact plan-b-v4-oof-three-expert-consensus-challenger and loaded=true. The existing M1 model already extracts body/range, upper/lower wick, momentum, ATR, M5 runs and M5/M15/H1/H4 alignment. It is NOT specifically a verified next-candle color/size specialist.

This first in-house specialist uses completed native candle history to train two separate next-candle models (M1 and M5): RED/DOWN, SMALL BODY/FLAT or GREEN/UP, plus estimated body and range expressed in ATR units. The small-body class includes bodies below the causal spread allowance or 0.05 ATR. It is not intended to predict perfectly or trade every tiny tick.

## Data provenance

The read-only owner-scoped broker export recorded 26,869 completed candles across four pairs (EURUSD, AUDUSD, USDJPY, USDCAD) and timeframes M1/M5/M15/H1/H4. Its CSV remains private on the VPS at /tmp/irexpro-owner-candles-native-20261117.csv.

M1 requires actual positive bid/ask quote evidence. M5/M15/H1/H4 are broker-native aggregated trend bars with valid OHLC but NO direct bid/ask, so the trainer obtains a conservative spread allowance from the p90 of at least five positive M1 spreads in the most recent 60 M1 samples. Cost evidence is joined only if the M1 bar was already completed at the higher-timeframe decision, with 2-minute maximum quote age. Absent spread evidence is not replaced by zero.

Features include causally completed candle geometry, recent sign, range compression, momentum and M5/M15/H1/H4 completed context. Next-bar labels require an adjacent real broker-native bar. Missing bars are NOT fabricated. The final test period is chronologically later than training/validation with one-hour embargo around boundaries.

## Actual independent holdout on first pilot

| Metric | Next M1 | Next M5 |
| --- | ---: | ---: |
| Total usable next-bar examples | 16,686 | 3,426 |
| Training / validation / untouched test | 9,740 / 2,838 / 3,147 | 2,007 / 583 / 636 |
| Three-class test accuracy | 41.53% | 46.07% |
| Training-only majority baseline | 40.48% | 43.55% |
| Balanced test accuracy | 37.72% | 34.96% |
| Raw class probability >= 0.65 directional forecasts | 8 | 102 |
| Correct color within that small selected group | 62.50% | 52.94% |
| Favorable direction AFTER estimated spread allowance | 62.50% | 53.92% |
| Average spread-only directional move normalized by ATR | -0.1032 ATR | +0.0454 ATR |

The 0.65 model scores are NOT calibrated likelihoods. Both accuracy improvements over baseline are small; test balanced accuracy is weak; the M1 selected sample of 8 is unusably small. The M5 result is before commissions, slippage, swap, risk-at-stop and market fills and therefore is NOT verified profitability. M5 validation accuracy (51.80%) fell to 46.07% in the later test block, showing risk from changing conditions.

### M5 65%-threshold selected results by instrument

| Pair | High-confidence sample | Positive spread-only move | Mean ATR-normalized move |
| --- | ---: | ---: | ---: |
| EURUSD | 34 | 47.06% | -0.0516 |
| AUDUSD | 34 | 70.59% | +0.1426 |
| USDJPY | 16 | 43.75% | +0.1617 |
| USDCAD | 18 | 44.44% | -0.0586 |

Numbers above are retrospective statistical observations, not a proposal to execute AUDUSD or any other pair. Do not average raw USDJPY price movements with EURUSD because their price scales differ. The displayed averages were ATR-normalized. Do not claim that favorable post-spread price movement covers the actual commission.

## Files and deployment boundary

1. apps/api/scripts/export-owner-demo-candle-training-corpus.cjs — read-only owner DEMO completed-candle exporter.
2. services/ai-engine/scripts/research_candle_formation_expert.py — three-class candle-direction and body/range research trainer with chronological split.
3. services/ai-engine/tests/test_research_candle_formation_expert.py — tests for as-of higher context, adjacent labels, strict quote quality and no trading authority.
4. .github/workflows/research-candle-formation-expert.yml — independent GitHub syntax/casual-feature test workflow.

All source files are on branch fix/planb-clock-neutral-telemetry-20261111 and pulled to the authorized VPS working tree. The saved model artifacts are PRIVATE: /tmp/irexpro-candle-formation-models-v2/candle_formation_m1_RESEARCH_ONLY.joblib and candle_formation_m5_RESEARCH_ONLY.joblib. The final normalized research report is /tmp/irexpro-candle-formation-expert-20261117-final.json. No new expert has been registered in the active AI decision pipeline. API and trading website were online at the last verification.

## Reproducibility

Run these commands only on the authorized VPS in its existing application checkout:

    cd /home/lightworld/webapps/irexpro-staging/apps/api
    node scripts/export-owner-demo-candle-training-corpus.cjs --out=/tmp/irexpro-native-candle-corpus.csv
    cd ../../services/ai-engine
    .venv/bin/python -m unittest discover -s tests -p test_research_candle_formation_expert.py -q
    .venv/bin/python scripts/research_candle_formation_expert.py --input=/tmp/irexpro-native-candle-corpus.csv --out=/tmp/irexpro-next-candle-pilot.json --models=/tmp/irexpro-next-candle-models

## Next work before considering any trading changes

1. Collect time-stamped, append-only partial forming-candle observations (e.g. at 15/30/45 seconds of M1 and the equivalent fractions of M5), retaining the actual as-of broker bid/ask and duration. Do not turn an already completed candle into a fictional partial candle; that would leak the future high, low and close into training.
2. Expand history across multiple months and different volatility regimes, ideally using the existing Dukascopy corpus for pretraining and sealed Pepperstone native data for calibration.
3. Benchmark simple momentum, logistic regression, gradient boosting and, only if justified, a temporal CNN. Evaluate forecast calibration, expected range and direction after commissions, spread, slippage and broker SL/TP path, per instrument and session.
4. Require independent later out-of-sample periods and an economically significant net edge; record every prospective prediction and true outcome for pattern memory before any model promotion. Never treat a model's probability of green as automatic BUY permission.
5. Outside quant/ML specialists may provide independent model validation, but avoid paying a recurring vendor for unverified next-candle claims when our own training and broker data already exist.

Decision: research models have been trained but are NOT eligible for automatic trading. Preserve all existing profit protection, capital risk and trade entry gates.
