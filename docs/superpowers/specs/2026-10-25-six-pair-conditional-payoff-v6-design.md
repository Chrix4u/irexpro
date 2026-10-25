# Six-Pair Conditional Payoff v6 Design

## Intent

iRexPro needs materially more M1/M5 opportunities without weakening profitability/risk gates. Barrier-calibrated v5 proved that the six-pair first-passage target has ample two-sided opportunities, but its LONG-vs-SHORT probability ranking produced no economically valid calibration slice on any pair. The next candidate must rank sides by expected economics rather than classifier probability alone.

## Evidence behind the choice

The historical USDJPY `event_barrier_v33_conditional_event_payoff` experiment is the strongest relevant prior: horizon 1, three purged folds, 47 non-overlapping trades, PF 1.891, Sharpe 4.909, max drawdown 0.13%, positive-fold fraction 2/3, direction balanced accuracy 0.522, and opportunity balanced accuracy 0.533. It used conditional favorable/adverse payoff severity weighted by event probabilities and did not tune on outer validation or future-UAT rows.

Direct expected-return/ranking families later failed out of sample, while balanced pairwise-edge v69 reached only PF 0.946 with negative Sharpe. Profitability-tail variants v34/v35 had strong headline economics but failed two-sided execution, so they are not the template.

## Chosen architecture

Research-only v6 generalizes the v33 economic idea across EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, and USDCHF while reusing v5's causal pair-specific event classifiers and leakage controls.

For each outer fold and pair:

1. Split outer training into a horizon-purged model-fit region and a train-only calibration tail.
2. Fit independent LONG-event and SHORT-event probability models using only causal MTF features.
3. Fit four pair-specific conditional severity regressors in causal barrier units:
   - LONG favorable severity on LONG-event rows;
   - LONG adverse severity on SHORT-event rows using realized LONG loss magnitude;
   - SHORT favorable severity on SHORT-event rows;
   - SHORT adverse severity on LONG-event rows using realized SHORT loss magnitude.
4. For each row, estimate probability-weighted expected favorable and adverse severity for both sides, then compute expected net payoff for LONG and SHORT.
5. Choose the side with the larger predicted expected net payoff. This is deliberately different from v5, which chose the side with the larger event probability.
6. On the train-only calibration tail, search bounded score/density candidates. A pair is eligible only when the selected expected-net tail has enough rows, 5–25% activation density, at least 5% representation from each side, positive realized mean net bps, and PF >= 1.10. Among eligible candidates, maximize realized profit-throughput before PF and density.
7. Validation is fail-closed and exact-pair only. Missing models, inadequate conditional-event evidence, or failed calibration means ABSTAIN.

## First evidence gate

Start only with horizon 1 and one outer purged fold over the same frozen six-pair MTF corpus family. Do not run wider horizons until this screen proves both economics and participation.

Outer research gates remain at least as strict as the locked project gates:
- balanced accuracy >= 0.52;
- Sharpe >= 1.0;
- Profit Factor >= 1.15;
- max drawdown <= 12%;
- positive fold fraction >= 60%;
- positive instrument fraction >= 67%;
- at least 24 non-overlapping opportunities per validation day for the first six-pair M1 screen.

A one-fold early screen cannot establish the positive-fold fraction by itself; it is an early-rejection screen only. If economics or participation fails, stop and diagnose. If both are credible, proceed to multi-fold horizon-1 evidence before any PAPER discussion.

## Leakage and governance

- UTC `decision_time` is the ordering clock.
- Future returns/barrier outcomes are labels/evaluation only, never model features.
- Inner fit/early-stop/calibration boundaries are horizon-purged.
- Outer validation uses horizon-sized purge and embargo.
- Thresholds and payoff filters are selected from outer-training data only.
- Validation and untouched future rows never select models or thresholds.
- Simultaneous pair signals are equal-weighted into one portfolio period and overlapping holding periods are not double-counted.
- Candidate is RESEARCH / SHADOW ONLY: `approved_for_paper=false`, `approved_for_demo=false`, `approved_for_live=false`.
- No forced-trade quota, no lowering of economics gates, no automatic promotion.

## Approaches considered

1. **Conditional expected payoff (chosen):** strongest historical economic evidence and directly addresses v5's side-ranking failure.
2. **Direct expected-return regression:** simpler, but multiple historical variants (including v37/v50/v51/v67 expected-return work) failed out of sample.
3. **Pairwise edge/meta-label ranking:** v69 approached breakeven but validation economics remained negative; weaker evidence than conditional payoff.
