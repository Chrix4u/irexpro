# iRexPro — 7:38 PM to 11:31 PM DEMO inactivity investigation

Checked Thursday, November 19, 2026, Accra/Ghana local time (UTC).
Owner's authenticated Pepperstone cTrader USD DEMO account only.
This is a read-only investigation, not a new trade permission policy.

## Confirmed live account status

As of 23:24 UTC, API health HTTP 200, PM2 online with no unstable
restarts. The owner FULL_AUTO trading session was separately verified
ACTIVE. Explicit Trend Continuation pause is not enabled in VPS env.

Last actual broker order: USDCAD SELL opened 19:33:27 UTC, closed around
19:38 UTC with broker-account after-fee net loss -29.89 USD. No new
broker orders since then in the 23:24 UTC read-only database check.

The last 120 min contained 888 M1 directional assessment rows,
754 M1 ABSTAIN, 134 non-abstain and ZERO BROKER_NATIVE authorizations.
Among 134 non-abstain, 133 were Plan B not paper-admitted, 104 had
OOD drift. All 134 were assigned Plan B TREND_CONTINUATION, despite
several tactical M1_EARLY_TRANSITION candidates.

The 22:00–22:59 UTC hour was explicitly ROLLOVER_RISK, with zero
Plan B admission. After 23:00 UTC the rollover classification ceased,
but weak/extended trend and poor forecast quality remained.

## Why the accepted Plan B reversal signals still did not open

Some isolated Plan B paper-admitted decisions continued:
- 20:46 USDJPY BUY: M1 route EARLY_TRANSITION, Plan B route
  CONFIRMED_REVERSAL. It lacked the required M1 reversal confirmation
  and its early-transition pair-side reliability had degraded.
- 20:58 EURUSD BUY: Plan B confirmed reversal, but tactical M1 ABSTAIN
  and the independent expert direction did not align.
- 21:27 USDCAD SELL: Plan B confirmed reversal, but tactical M1 ABSTAIN
  and original observed P90 spread estimated cost ~1.075R, exceeding
  forecast gross ~0.194R.
- 23:15 USDCAD SELL: Plan B confirmed reversal, but tactical M1 ABSTAIN
  and P90 broker spread estimated cost ~1.40R exceeded forecast
  gross ~0.221R.

An admitted Plan B classification is not a final broker authorization.
An alternate pathway may require independent cost, direction or timing
approval. Suppressing those without evidence can open losing orders.

## New read-only 15-minute counterfactual quote audit

Script: apps/api/scripts/audit-owner-demo-after-1938-paper-approvals.cjs

Queries EXACT owner USD DEMO broker decisions since 19:38 UTC with
paperAdmitted=true, execution_authority=NONE. De-duplicates a bounded
one-earliest-per-16-minute broker-account/instrument/direction episode.
Only retrieves the SAME connection's completed broker-native M1 OHLC
bars with valid source times and positive native bid/ask coverage,
and applies iRexPro's existing 15-M1-bar TP/SL/MTM evaluator. All
after-entry M1 bars are outcome-only: no future pricing is used as
a prior signal. Estimated cost R is persisted at decision time from
BROKER_OBSERVED_P90, never fabricated from final profit.

At the 23:31 UTC run, nine raw paper-admitted unexecuted decision rows
became seven independent instrument-side episodes. Of those:
- Four had 15 complete broker-native M1 bars and a quote-only
  after-spread outcome. **All four estimated net R values were
  negative**: -0.595, -0.815, -1.500, -1.640.
- Three lacked enough valid completed future M1 bars; they are UNKNOWN,
  not counted as winning or losing.
- Mean of the FOUR labeled quote outcomes was -1.1375R; sum -4.55R,
  non-independent and not an executable account-return estimate.
- ZERO counterfactual outcomes are verified broker fills.

These results are NO PROOF that all rejected signals were losing,
but specifically do not justify disabling the current gates tonight.

## Link to win/loss formation learning

The earlier separately verified 191 settled trades had 104 winners,
87 losers, but a -2213.53 USD after-fee net. Confirmed Reversal
lost the most; its Plan B AUC was near chance. Frozen pre-entry
native M1/M5 forming-candle snapshots were available for 172/191.
Candidate quality calibration and executable profit-protection require
new prospective evidence. No filter is trained or promoted by this
counterfactual.

## Status

The trading API is healthy; no trading policy, lot size, broker stop,
model weight, manual Start/Stop, or LIVE permission was altered.
Research only. The next needed model improvement is an after-cost,
strategy-specific direction and timing classifier validated on
future untouched broker DEMO sessions. A newly introduced hard
blocking rule would be unjustified from these seven cases.
