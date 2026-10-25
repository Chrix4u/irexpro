# Short-Horizon Barrier-Calibrated v5 Design

## Problem

iRexPro's production stack has historically been too sparse for the user's intended M1/M5 operating style. Friday 2026-10-23 produced only four PAPER trades. Simply lowering production gates is not acceptable: replay showed higher activity without durable economics.

The direct terminal-return v4 research candidate is also rejected. In its bounded 5m screen it produced zero active signals, and a training-only calibration probe showed that every one of the six pairs had zero threshold candidates with both positive mean realised return and Profit Factor >= 1.10. Side balance was mostly healthy, so the failure was economic ranking, not a BUY/SELL representation gate.

## Historical evidence

The repository already contains a causal first-passage event-barrier label. It asks whether a LONG or SHORT spread/ATR-adjusted positive barrier is reached first inside the horizon, rather than requiring the terminal price at exactly t+h to remain favourable.

Earlier barrier research showed that predicting whether a meaningful move happens soon was substantially stronger than predicting its direction. v7 then replaced the weak direction head with independent LONG-vs-rest and SHORT-vs-rest models, but used fixed activation rules: winning side probability >= 0.60 and LONG-vs-SHORT probability margin >= 0.10. Later v8-v10 hybrid/payoff/risk experiments also remained research candidates rather than proving promotion-quality economics.

## First 5m screen diagnosis

The first exact-SHA one-fold v5 screen produced zero active signals. A frozen-corpus calibration probe showed this was initially a search-grid defect rather than an economic rejection: all six pair calibrations had zero structurally eligible grid cells because the absolute probability grid began at 0.55 while pair-specific 99th-percentile winning scores ranged roughly 0.467–0.560. The first-passage labels themselves remained populated and two-sided. v5 therefore uses training-only empirical score quantiles so calibration can evaluate the intended 5–25% activation-density region before economics decide whether a pair passes.

## Chosen architecture

v5 keeps the path-aware first-passage target but removes fixed global activity gates.

For each of the six pairs and each horizon (5/20/60 minutes):

1. Fit an independent LONG-actionability classifier and SHORT-actionability classifier using only causal MTF features.
2. Use an inner, horizon-purged training-only calibration tail to search a bounded, pair-adaptive grid of:
   - minimum winning-side probability derived from calibration-tail score quantiles; and
   - minimum LONG-vs-SHORT probability separation derived from calibration-tail margin quantiles, including a zero-margin anchor.
   The grid adapts to each expert's score scale while remaining entirely train-only; absolute validation/future score levels never select thresholds.
3. A calibration candidate is eligible only when it has enough active rows, bounded activation density, positive mean realised net return, Profit Factor >= 1.10, and both BUY and SELL representation where the data supports both sides.
4. Among economically eligible candidates, select the candidate with the best **profit throughput** (`mean realised net bps × activation density`), then Profit Factor, then density. This explicitly rewards useful frequency only after economics pass.
5. Validation routing is pair-specific and fail-closed. A row trades only when the pair calibration passed, the winning side clears its probability threshold, and its side separation clears the calibrated margin. Missing models/calibration never borrow another pair's policy.

This differs materially from v7-v10: v5 does not use global fixed 0.60/0.10 activation gates, does not reuse terminal-return ranking, and makes activity/economics calibration pair-specific and training-only.

## Leakage controls

- UTC `decision_time` remains the sole ordering clock.
- Future high/low/return columns are labels/evaluation only and never features.
- Outer walk-forward is expanding-window with horizon-sized purge and embargo.
- The internal fit/early-stop/calibration split is horizon-purged.
- Calibration is fit only from the outer-training period.
- Validation and untouched-future rows never select thresholds or margins.
- Simultaneous pair signals are collapsed into one equal-weighted portfolio period for conservative opportunity counting; overlapping holding periods are not double-counted.

## Research gates

Frequency is an additional requirement, never a replacement for economics:

- 5m: >= 24 non-overlapping opportunities per validation day
- 20m: >= 12/day
- 60m: >= 6/day
- balanced accuracy >= 0.52
- Sharpe >= 1.0
- Profit Factor >= 1.15
- max drawdown <= 12%
- positive fold fraction >= 60%
- positive instrument fraction >= 67%

Inner pair calibration uses PF >= 1.10 and positive mean realised net bps so that the outer validation still has to prove the stricter research gate.

## Governance

This candidate is RESEARCH / SHADOW ONLY.

- `approved_for_paper = false`
- `approved_for_demo = false`
- `approved_for_live = false`
- no production gateway changes
- no forced-trade quota
- no automatic promotion based on activity

The first compute gate is a 5m one-fold early-rejection screen. If it fails either economics or participation, do not spend compute on 20m/60m. If it passes, proceed to full multi-fold 5m, then 20m/60m, then untouched-future evidence before any discussion of PAPER authority.
