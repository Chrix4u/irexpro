# Causal cTrader DEMO broker-fee calibration — 6 November 2026

## Live no-trade diagnosis

The current cTrader DEMO session remains active but has opened zero
new trades. A two-hour scoped read-only sample at ~06:36 UTC contained
718 M1 evaluations, 104 proposed entries, two Plan B paper-admitted
setups, and ZERO primary execution authorizations. All 104 candidates
had the existing broker commission entry-gate status NOT_ENABLED.
That gate only becomes applicable after primary model qualification.
Therefore, the immediate cause of no trades is NOT the commission gate.

## Existing safety framework

Production ensemble governance accounts for broker spread and a
slippage allowance. A separate existing same-account, prior-closed-
trade P90 commission DEMO gate already operates as an additional
one-way veto of a qualified primary candidate. The historical
first-hit training experiment still assumed one extra friction pip
regardless of real pair/account fee evidence.

This PR calibrates ONLY that RESEARCH model cost assumption.
It does not introduce a second live gate, enable an order path,
replace any live weights, or change spreads, stops or lot sizes.

## Strictly causal fee model

The extended first-hit SQL additionally collects fee information:
- Prior CLOSED trades on exactly the configured cTrader DEMO
  owner/connection, same instrument, EUR account currency and seven-
  day lookback; close must precede the candidate evaluation time.
- Positive lot size, prior entry not after exit, nonmissing broker
  recorded commission AND swap, and at least FIVE prior fills.
- P90 per-standard-lot cost in EUR is the prior absolute recorded
  commission plus adverse financing (negative swap only), divided
  by closed-trade lot size.
- Exact same demo connection's prior EURUSD completed M1 quote is
  used to convert USD-quoted three majors' stop risk to EUR:
  fee_cost_R = fee_P90_EUR_per_lot * EURUSD_asof_mid /
  (100000 * original_stop_distance).
- The original bid/ask entry already accounts for the spread; only
  25% of observed spread is added as a HYPOTHETICAL adverse-slippage
  scenario. This is not measured realized brokerage slippage.
- Missing prior history/FX conversion is UNKNOWN, not zero; it
  cannot qualify the fee-aware research selector. Commission
  evidence is available only after the historical trade closed.

All SQL is source-pinned, 14-day-bounded and PostgreSQL
default_transaction_read_only. No identifiers/keys are exported.
The scheduled private model research job deletes source CSV after
processing and retains only small aggregate JSON diagnostics.

## Historical evidence

The new research-only SQL returned 1,655 source records over nine
UTC dates. Prior fee P90 plus as-of EURUSD were available for 488
AUDUSD, 488 EURUSD, and 403 GBPUSD source entries before final
de-overlap. The approximate November 5 held-out historical P90
recorded EUR commission per standard lot was:
AUDUSD €5.70, EURUSD €9.05, GBPUSD €10.81.

The latest completed November 5 holdout:
- Original 34 enriched-model selections: 8 TP-first, 13 SL-first,
  13 unresolved. Mean historical-broker-fee scenario on the 21
  resolved cases: -0.2316R.
- Fee-aware ranked 34 selections: 6 TP-first, 13 SL-first,
  15 unresolved. Mean historical-broker-fee scenario on 19 resolved
  cases: -0.4009R. The cost-aware ranking was WORSE.

Five strictly forward-in-time completed-date test folds:
- 143 enriched-model selections: 24 TP-first, 42 SL-first,
  77 unresolved, -0.2710R on 66 resolved broker-fee scenario cases.
- 143 causal-fee re-ranked selections: 22 TP-first, 41 SL-first,
  80 unresolved, -0.3085R on 63 resolved fee scenario cases.

These numbers are only bid/ask quote-close first-hit proxies with
conservatively censored midpoint-wick ambiguity; NOT verified stop
execution, live fill, realized net P&L, exact tick first-hit or
known future return. Additional slippage is an assumption.

## Outcome and next priority

The research module now exposes time-causal fee P90 coverage,
fee-cost R and two fixed model comparisons. Local regression tests
verify strict fee availability, proper EUR conversion, no future
holdout label leakage, fail-closed unknown costs and read-only
no-order boundaries.

NO PROMOTION: both models remain negative. Future entry-quality work
must use more independent market history, complete broker-native
bid/ask price paths, correct commission and net trade economics, and
strongly positive after-fee untouched out-of-time holdouts before
any separately approved minimal DEMO strategy trial.
