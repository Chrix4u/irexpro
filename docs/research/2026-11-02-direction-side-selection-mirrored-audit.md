# Direction Side-Selection Mirrored Audit — 2026-11-02

## Purpose
Measure how often a losing executed direction would have succeeded if the same fill had been taken in the opposite direction with identical risk and reward distances. This is a read-only counterfactual study, not an execution policy.

## Method
- Source: current cTrader execution connection.
- Label replay: existing 72-bar M5 first-hit outcome resolver.
- KEEP: actual trade won.
- FLIP: actual trade lost; mirrored opposite trade hit TP first.
- ABSTAIN: actual trade lost; mirrored opposite trade hit SL first.
- UNRESOLVED: insufficient/ambiguous path or invalid geometry.
- All route/reliability/model fields used for pattern analysis are pre-entry metadata. Future candles are target-label data only.

## Current 24-hour session
28 current-engine closed trades were resolved:
- KEEP: 10
- FLIP: 10
- ABSTAIN: 8

Among the 18 losing trades, 10/18 (55.6%) were FLIP labels and 8/18 (44.4%) were ABSTAIN labels.

Notable slices:
- Plan-B EARLY_TRANSITION: 0 KEEP / 5 FLIP / 3 ABSTAIN.
- M1 ABSTAIN overridden by multimodel execution: 0 KEEP / 4 FLIP / 0 ABSTAIN.
- M1 EARLY_LOSS_STREAK: 0 KEEP / 2 FLIP / 0 ABSTAIN; the currently deployed reliability gate already vetoes this state.
- RECENT_MEANINGFUL_DEGRADATION: 0 KEEP / 2 FLIP / 1 ABSTAIN.
- USDJPY SELL: 0 KEEP / 2 FLIP / 1 ABSTAIN.
- AUDUSD BUY: 0 KEEP / 2 FLIP / 0 ABSTAIN.
- USDCAD SELL: 1 KEEP / 3 FLIP / 3 ABSTAIN.

## Fourteen-day current-engine cohort
137 cTrader trades were audited; 136 resolved:
- KEEP: 72
- FLIP: 48
- ABSTAIN: 16
- UNRESOLVED: 1

Among the 64 resolved losing trades, 48/64 (75.0%) were FLIP and 16/64 (25.0%) were ABSTAIN.

Route-level resolved loss split:
- Plan-B EARLY_TRANSITION: 27 FLIP / 5 ABSTAIN = 84.4% of resolved losses flippable.
- CONFIRMED_REVERSAL: 15 FLIP / 6 ABSTAIN = 71.4% flippable.
- TREND_CONTINUATION: 6 FLIP / 5 ABSTAIN = 54.5% flippable.

M1-route resolved loss split:
- M1 ABSTAIN: 31 FLIP / 4 ABSTAIN = 88.6% flippable, but the same cohort also contains 44 KEEP winners. Therefore M1 ABSTAIN is not a blanket veto or reversal signal.
- M1 EARLY_TRANSITION: 12 FLIP / 6 ABSTAIN = 66.7% flippable.
- M1 TREND_CONTINUATION: 5 FLIP / 6 ABSTAIN = 45.5% flippable.

Pair-side highlights:
- USDJPY BUY: 5 KEEP / 8 FLIP / 1 ABSTAIN.
- USDJPY SELL: 2 KEEP / 5 FLIP / 1 ABSTAIN.
- EURUSD SELL: 5 KEEP / 6 FLIP / 0 ABSTAIN.
- USDCAD BUY: 7 KEEP / 5 FLIP / 0 ABSTAIN.
- AUDUSD BUY: 13 KEEP / 6 FLIP / 1 ABSTAIN.
- USDCAD SELL: 9 KEEP / 7 FLIP / 3 ABSTAIN.
- AUDUSD SELL: 18 KEEP / 5 FLIP / 6 ABSTAIN; this side has materially more true ABSTAIN losses than most other slices.

Reliability highlights:
- EARLY_LOSS_STREAK: 0 KEEP / 3 FLIP / 0 ABSTAIN (small sample; already vetoed in current DEMO policy).
- RECENT_MEANINGFUL_DEGRADATION: 1 KEEP / 4 FLIP / 1 ABSTAIN.
- RECENT_PROVISIONAL_DEGRADATION: 0 KEEP / 1 FLIP / 1 ABSTAIN (very small sample).

## Interpretation
The data rejects both simplistic policies:
1. “Always keep the model direction” misses a large number of directional inversions.
2. “Always reverse a losing-looking setup” is unsafe because ABSTAIN cases exist and many superficially similar states are KEEP winners.

The target problem is therefore genuinely three-class: KEEP / FLIP / ABSTAIN.

The strongest next research question is not whether opposite direction can help; the replay establishes that it often can. The next question is whether pre-entry features can predict these three labels on unseen time periods with enough precision and expectancy to pass qualification gates.

## Next phase
Build a much larger labeled dataset from shadow opportunities using the same mirrored-path target semantics. Train a multi-pair three-class side-selection model with purged walk-forward time splits and an untouched future holdout. No DEMO authority should be granted until the model passes the existing balanced-accuracy, Sharpe, profit-factor, drawdown, fold, instrument and confidence gates.
