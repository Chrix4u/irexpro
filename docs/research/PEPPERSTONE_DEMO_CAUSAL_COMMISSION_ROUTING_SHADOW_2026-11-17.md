# iRexPro — Why a new commission-aware trading gate must NOT be activated

**17 November 2026, 21:44 UTC — Pepperstone cTrader USD DEMO.** Research-only outcome, **no LIVE promotion or active entry-gateway changes**.

## Problem

The independent 126-trade commission-R audit found a negative average realized gross result of −0.058R, explicit commission burden of ~0.146R, and negative net return of −0.205R. That means trading direction/exit opportunity and explicit broker costs **both** need improvement. Merely seeking more trades or increasing lots cannot repair net expectancy.

A conservative historical commission estimator already exists in `research-causal-commission-estimator.cjs`: p90 broker commission per lot from a minimum of five same-instrument, same-account trades that **closed strictly before** candidate entry, within the preceding seven days. The source estimator is pure research code, not an execution gate.

This new diagnostic evaluates an exploratory +0.08R expected-after-commission floor **without applying it to orders**. It uses the existing stored `m1_net_expected_r` prior-to-trade forecast and only earlier closed commission records.

## Actual read-only cohort result

Run at **21:44:23 UTC** against the exact owner Pepperstone USD DEMO account.

| Measure | Count/result |
| --- | ---: |
| Read-only historical trade rows scanned for fee lookback | 143 |
| Closed trades in seven-day evaluation window | 126 |
| Eligible four-instrument strategies | 116 |
| Other instruments excluded from this four-pair comparison | 10 |
| Evaluable using ≥5 strictly earlier fee observations | **106** |
| Insufficient prior same-instrument fee history | 10 |
| Research-only advisory flags below +0.08R | **93 / 106 (87.7%)** |
| Net-winning historical trades among those flagged | **50** |
| Historical trades the heuristic would retain | **13** |
| Net-losing historical trades among those retained | **5** |
| Average causal estimated broker commission | **0.1488R** |
| Average observed broker commission, same cohort | **0.1488R** |
| Observed fee forecast MAE | **0R** on this selected historical sample |

**The key discovery:** a new +0.08R entry veto would exclude **50 actual winning trades**, while retaining five losers. This is direct evidence that simply tightening a commission-aware gate risks reproducing the user's prior "everything blocked" problem. Neither the flagged trade cash totals nor the retained cohort may be called causal saved profit, because those trades were *not* actually filtered and exposure would have changed.

The commission forecast matched recorded commission extremely closely in this small, broker/account-specific sample, consistent with a stable per-lot fee schedule; this does **not** imply future commission, slippage, fills or the overall trading strategy can be forecast perfectly. Most evaluated forecasts have too little expected return even though some closed as net winners. Better **gross opportunity** calibration remains essential.

### By strategy

| Strategy | Causal fee-qualified | Below +0.08R | Actual net winners among flagged | Retained historic trades | Actual net losers among retained |
| --- | ---: | ---: | ---: | ---: | ---: |
| Early Transition | 30 | 29 | 17 | 1 | 0 |
| Confirmed Reversal | 44 | 41 | 22 | 3 | 1 |
| Trend Continuation | 32 | 23 | 11 | 9 | 4 |

The following facts **must not** be combined into an invented profitability claim:
- Current strategy results are **historical selected DEMO trades**, not forward out-of-sample tests of the proposed threshold.
- The fixed +0.08R floor is an **exploratory heuristic**, not validated net-expectancy calibration or a mathematically optimal threshold.
- The per-trade R denominator is the capital allocation's recorded initial risk, not cash return, account-equity percentage, or independently verified actual stop fill.
- Explicit broker commission is only one cost. Spreads/slippage can already affect the actual trade's price P&L; swaps and genuine broker fees must remain separately reconciled.
- A missing model forecast or fewer than five earlier same-pair commissions must not silently become an order veto.
- No backtest on these observed, already-executed trades establishes causal savings from hypothetical skipped orders.

## What was implemented

1. `apps/api/scripts/research-owner-demo-commission-routing-shadow.cjs` — pure, read-only chronological commission-estimate and strategy split, including how many real winners would be wrongly flagged.
2. `apps/api/scripts/run-owner-demo-commission-routing-shadow.cjs` — protected exact-owner Pepperstone USD DEMO read-only database extraction, maximum 2000 rows, previous seven-day fee history and seven-day evaluation, no user/account identifiers in output.
3. `apps/api/scripts/research-owner-demo-commission-routing-shadow.test.cjs` and `...run-owner-demo-commission-routing-shadow.test.cjs` — causality, scope, incomplete risk, opposite future timestamps, trade authority and classification regression tests.
4. A private, local VPS JSON report at `/home/lightworld/webapps/irexpro-research/net-economics-shadow/latest.json`, mode 0600, no credentials or account identifiers.
5. Updated GitHub Actions `research-net-economics-ci.yml` for both new test suites.

The code is **not loaded by the active Plan B trading engine** or order routing. No extra API service, vendor subscription or broker permission has been introduced.

## Correct next action

**Do not deploy this commission gate.** Instead:
- Observe the next market sessions and analyze which routes, instruments and quote conditions have a **positive gross opportunity** after a calibrated pre-entry forecast, without relying on hindsight wins.
- Train a *new* shadow calibration of gross returns and trade exit pathways; layer prior-only commission estimates in advisory scoring, never as immediate unconditional veto.
- Compare prospectively against the existing trading route, counting lost winners, changed exposure and net cash after full costs and drawdown.
- Only adjust execution thresholds after evidence supports fewer poor trades **without unnecessarily eliminating the profitable opportunities**.
- Continue DEMO. Do not increase lot sizes to recover equity, remove stop/risk protections, or promote an unqualified model to LIVE.
