# v79 Gated Multi-Horizon Mixture-of-Experts

Status: **development research only**

## Frozen before outer evaluation

- Experiment: `v79_gated_multihorizon_pair_moe_v1`
- Pair scope: AUDUSD, EURUSD, GBPUSD, USDCAD, USDCHF, USDJPY
- Realized outcome horizon: H5
- Confirmation horizon: H10
- Model family: pair-specific XGBoost net-return regressors
- Sides: independent LONG and SHORT regressors
- Router: causal training-window regime gate
- Regimes:
  - calm
  - active_clean
  - stressed
- Regime thresholds:
  - spread stress = training `spread_to_atr_ratio` 75th percentile
  - active volatility = training `m1_atr_pct_14` 60th percentile
- Sparse regime fallback: pair-global expert
- Internal chronology:
  - fit: first ~70%
  - early stop: next ~15%
  - threshold calibration: final ~15%
  - H10 purge around internal boundaries
- Outer validation: 3 purged walk-forward folds
- Extra slippage: 0.25 bps
- H5 and H10 must agree on direction before a trade is eligible
- Threshold search is restricted to the fixed grid committed in code
- Early elimination is allowed only when 2/3 stability gates are mathematically unreachable

## Formal research gates

No deployed promotion gate is changed.

- Minimum outer trades: 30
- Median signal gap: <= 10 minutes
- Balanced accuracy: >= 0.52
- Sharpe: >= 1.0
- Profit factor: >= 1.15
- Max drawdown: <= 12%
- Positive outer-fold fraction: >= 2/3
- Calibration-pass fraction: >= 2/3
- Positive total return
- Six-pair ensemble requires >= 4/6 individually qualified pair specialists

## Safety / anti-contamination

- `sealed_future_holdout_touched=false`
- `production_eligible=false`
- No PAPER authority
- No DEMO authority
- No LIVE authority
- No automatic promotion
- No post-hoc threshold lowering after outer-fold inspection
- Failed pairs are rejected rather than re-tuned on their outer results

## Rationale

v74/v75 demonstrated repeated calibration-to-outer collapse. v79 changes model
family instead of continuing to tune the same profitability classifier:

1. predict net return magnitude rather than only profitable/not-profitable;
2. require agreement between a fast and confirmation horizon;
3. route through causal market regimes;
4. keep threshold calibration chronologically separate from model early stopping;
5. preserve an untouched outer fold for every reported result.
