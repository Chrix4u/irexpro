# Short-Horizon Direct Net-Return v4 Design

## Problem
The production participation stack is now materially less passive, but the retained short-horizon model family remains structurally sparse. Its decisions compound multiple model gates (opportunity probability, direction confidence, direction margin and payoff/risk), so a candidate can have positive economics yet never become an opportunity. Static gateway relaxation has already failed broad replay: no safe region delivered the required density while preserving profitable economics.

## Decision
Build a research-only multi-pair challenger that predicts friction-aware LONG and SHORT net return directly instead of requiring several independent classifiers to agree.

For each of EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD and USDCHF, and independently for 5m, 20m and 60m horizons:
- fit pair-specific LONG net-return regression;
- fit pair-specific SHORT net-return regression;
- choose the side with the larger predicted net return;
- calibrate one pair/horizon activation threshold using only the inner training/early-stop tail;
- enforce a bounded participation budget during inner calibration rather than a forced outer-validation trade quota;
- emit BUY, SELL or ABSTAIN.

The model ranks economics directly. Existing event risk, broker/risk, allocation, margin, drawdown, stop/target, post-loss and portfolio controls remain outside the model and are not changed by this research.

## Inner calibration
Threshold selection is train-only. A threshold is eligible only when the early-stop calibration cohort has:
- enough samples for stable estimation;
- positive mean realized selected-side net return;
- profit factor >= 1.10;
- both LONG and SHORT representation;
- bounded activation density so the solution cannot pass by trading every bar or by producing almost no trades.

Among eligible thresholds, choose the economically strongest threshold without consulting outer validation. If no eligible threshold exists for a pair/horizon/fold, that expert fails closed for that fold.

## Outer qualification
Outer validation remains untouched by threshold selection. Report per horizon and per pair:
- trade/opportunity count and active-market opportunities/day;
- mean/median minutes between entries;
- realized mean net R/bps;
- Profit Factor;
- Sharpe;
- max drawdown;
- positive fold fraction;
- positive instrument fraction;
- LONG/SHORT balance.

The existing locked research economics/risk gates remain authoritative. Participation is an additional requirement, never a substitute for profitability.

## Participation objective
The minimum research targets remain:
- 5m: >= 24 non-overlapping qualified opportunities per active FX validation day;
- 20m: >= 12/day;
- 60m: >= 6/day.

These are qualification targets, not production quotas. A model that produces more opportunities but loses money fails.

## Causality and leakage controls
- Reuse the causal MTF feature contract and `available_at` semantics.
- Future prices are used only for labels/evaluation.
- Purge and embargo remain horizon-sized.
- Pair/horizon thresholds are selected from training/inner-tail data only.
- No pair may use another pair's fitted model or threshold.
- No future/UAT data may select architecture, threshold or sizing.

## Authority
v4 is shadow/research only. It has no PAPER, DEMO or LIVE authority in this change. Promotion requires separate multi-fold evidence and review.
