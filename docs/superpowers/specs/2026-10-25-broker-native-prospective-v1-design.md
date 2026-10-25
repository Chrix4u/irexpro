# Broker-Native Prospective v1 Design

## Decision context

Six-pair conditional-payoff v6 was rejected on the frozen Dukascopy MTF corpus: EURUSD, GBPUSD, and USDJPY had no economically valid train-only payoff tail, while AUDUSD, USDCAD, and USDCHF lacked the locked conditional-event evidence floor. Earlier pooled classifiers, deterministic ensembles, and quote-microstructure pair sleeves were also rejected.

The materially different evidence line is the MetaApi broker-native v84 5-minute event-barrier experiment. On the original 25k-per-pair development sample, its base and micro variants showed positive 5-minute economics but insufficient trade evidence/frequency. The 25k limit was an explicit research target, not a pagination limit.

## Current constraint

The MetaTrader 5 demo connection that supplied the historical broker-native corpus is currently in ERROR because MetaApi will not deploy the account until its provider account is topped up. Credentials remain VERIFIED. The connected scanner is the paper broker, so the system must not fake or mutate the MT5 connection state for research.

## Available untouched evidence

The local provider quote store retained approximately 8.3k M1 candles per pair after the original `2026-10-02T21:00:00Z` development cutoff, sourced from `metaapi-rpc-sampled`. These rows are frozen separately in `/home/lightworld/research/irexpro-broker-native-prospective-holdout-v1` with file and manifest SHA-256 hashes.

The sampled candles are not equivalent to full provider historical bars: midpoint OHLC is built from local quote samples, and `sample_count` is not broker-native tick volume. Therefore this screen uses only the v84 **base** feature contract; micro/tick-volume features are excluded.

## Prospective protocol

1. Development stays limited to the frozen 25k-per-pair broker-native corpus ending before the Oct 2 cutoff.
2. Post-cutoff local sampled rows are prediction/evaluation only and never participate in fitting, isotonic calibration, feature selection, threshold selection, or hyperparameter selection.
3. Pooled six-pair fit/calibration splits on whole timestamps with a 5-minute purge.
4. The v84 model family and hyperparameters remain fixed: two-stage XGBoost actionability then direction-on-actionable rows.
5. Actionability and direction-confidence floors remain fixed at 0.55.
6. Prospective rows require 60 prior contiguous M1 minutes and 5 future contiguous M1 minutes; rows around collection gaps are excluded.
7. Same-pair overlapping events are collapsed using actual event resolution/timeout minutes.
8. Positive-instrument fraction uses all six pairs as the denominator; an inactive pair counts as non-positive.
9. Holdout stability is reported over three chronological windows with no refit and no selection.

## Governance

This is a **falsification-only** screen. Failure is sufficient to reject the v84 base H5 architecture. Success is not sufficient for PAPER/DEMO/LIVE promotion because the holdout uses sampled midpoint candles rather than full provider historical bars. A successful result only justifies restoring/funding deeper MetaApi broker-native history and repeating full frozen-corpus certification.

`promotion_eligible=false`, `approved_for_paper=false`, `approved_for_demo=false`, and `approved_for_live=false` are unconditional.

## Prospective outcome

Exact evaluator SHA: `814d10fc`.

After continuity and causal-context filtering, the untouched sampled holdout contained 27,724 scorable rows across all six pairs. The frozen base H5 architecture selected only 3 trades over 8 holdout dates (0.375/day). All 3 lost money. Aggregate trading metrics were PF 0.00, Sharpe -1.856, net return -0.0009936, max drawdown 0.0009934, trade-direction balanced accuracy 0.50, mean actionability confidence 0.5975, median entry gap 1,190 minutes, and 0/6 positive instruments. Actionability BA was 0.5024 and direction-on-actionable BA was 0.5129. The three chronological no-refit windows returned approximately -0.0001012, -0.0008924, and 0.0, so positive-window fraction was 0%.

Decision: **REJECT v84 base H5**. Do not tune its thresholds, model parameters, feature set, or calibration using this holdout. The holdout is now consumed as evaluation evidence. Any next experiment must materially change the information set or learning formulation and must obtain a new untouched validation period or a separately frozen historical protocol.
