# Low-volatility / local-range challenger — research only

**Artifact:** `low-vol-range-shadow-v1` / `low-vol-range-shadow-outcome-15m-v1`.

This is a provisional, rule-based hypothesis, **not** a trained or calibrated
production model. It never submits signals, orders or risk grants, and it must
not be used as a DEMO-only route that would be unacceptable in LIVE.

## As-of data and candidate selection

Run only after a broker-native, completed and fresh M1 feature snapshot is
available. Each BUY and SELL proposal is independently observed. A **stabilized
entry hypothesis** requires:

- Low 1-minute volatility (score at most 0.16) and compressed local EMA/M5 trend.
- An RSI extreme on the proposed side (BUY at most 38, SELL at least 62).
- Price at least 0.55 ATR away from its M1 EMA21, with a mean-reversion direction.
- No strong H1/H4 alignment *against* the proposal. A local pullback within a
  broader directional trend is permitted as a **research** hypothesis.
- Stabilized latest M1 momentum, fresh features, clear event-risk evidence,
  and a fresh broker-observed spread estimate within structural stop geometry.

An **unstable-momentum control** has identical research conditions except that
the last momentum still points sharply against the proposal. It is **not**
presented as an executable candidate, but its 15-minute price outcome is
recorded to test whether stabilization actually improves results.

Every saved decision records the exact hypothesis cohort, side, as-of features,
observed spread geometry and `executionAuthority: NONE`. Historic Plan B,
M1, account risk, lot sizing and execution decisions are unchanged.

## Outcomes and causal separation

Fixed, non-overlapping UTC 16-minute study buckets are used *per instrument,
direction and hypothesis cohort*. The oldest eligible decision in each bucket is the episode leader.
Only the later **15 contiguous completed broker M1 bars** determine the
hypothetical TP, SL or mark-to-market outcome. The hypothetical entry uses the
first future M1 bar's open, not the candidate's already-observed close.

- A stop and target touched in the same OHLC bar are **AMBIGUOUS**, never
  counted as a win.
- Missing candle sequences become **UNOBSERVABLE_DATA_GAP**, not a guessed loss.
- The estimator subtracts the contemporaneous broker P90 spread plus a 25%
  buffer, rebased to the research stop distance. It **does not** know the true
  commission or slippage of an order that was never sent.
- `afterSpreadProxyRMultiple` is explicitly *not* final net profit;
  `netRMultiple` is null until a real, separately verified commission-cost
  model can support that claim.

Ingestion is idempotent. A study outcome cannot change a broker order, an
execution authority, a position or a production promotion ledger.

## Evaluation before any proposal for execution

Compare stabilized vs unstable-control outcomes by pair/side, by market
session and in time-ordered, non-overlapping folds. Report sample size,
unobservable/ambiguous fractions, spread-adjusted R, and actual after-fee
results only if independently verified. Handle multiple hypotheses per trade
direction, strategy overlap and choice of thresholds explicitly.

No execution promotion is automatic. Require independent out-of-sample
validation, positive folds and instruments, satisfactory after-commission
profit factor and Sharpe, controlled drawdown, robust broker-data reliability
and a separate DEMO/LIVE-parity review before asking to change an execution
route. Rejection by the current Plan B model remains authoritative.
