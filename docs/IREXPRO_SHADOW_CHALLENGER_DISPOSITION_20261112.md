# iRexPro: Z.ai and shadow challenger disposition — 12 November 2026

Scope: staging VPS and database, Pepperstone cTrader DEMO; audit only.
No LIVE activation, auto-promotion, discretionary order entry or bypass of
margin, broker stop, exposure, drawdown or event-risk controls.

## Why these models did not become automatic traders

Different research families serve different purposes:
- Z.ai P1 confirmed-reversal half-close + protected runner and Plan B v8.5
  profitable-state giveback classifier are **exit-management** experiments.
  They cannot create more entries.
- M1 low-volatility reversal, Plan B weak-trend persistence, and
  extension-exhaustion strategies are **entry** research observers.
- Delayed-entry / risk-parity stop, profit-lock patience, broker fee and
  OOD counterfactuals provide **diagnostic/management evidence**, not trained
  standalone trade prediction with permission to execute.

## Verified current evidence

| Challenger | Result | Decision |
| --- | --- | --- |
| Z.ai P1 confirmed-reversal partial exit | An earlier small replay reported +0.319R on 15 selected trades, not independent confirmation. From 7d live DEMO audit: 5 recorded P1 preflights, 0 research-eligible, 0 authorized dispatch, and 0 partial-close ledger legs. Preflight explicitly sets canSendPartialClose=false. | DO NOT promote; partial broker leg reconciliation and new qualified samples needed. |
| Plan B v8.5 trained giveback | 1,156 prior READY/OBSERVE observations, 6 prior READY/PROTECT_SHADOW, plus hundreds of recent WAITING_FOR_BROKER_DATA. Miswired to legacy cTrader account; internal ensemble decisions use paper-broker ID. | Fix broker-source selection to the owner-matched DEMO session at evaluation time; then verify new broker-native READY checkpoints and compare terminal P&L counterfactuals. Remains NONE. |
| Plan B rejected-edge outcome | 1,991 historical READY/OBSERVE and 223 READY/PROTECT_SHADOW observations; no current consistent qualification. Checkpoint current_r is *not* independently realized after-fee trade P&L. | Do not promote from positive snapshot current_r. Require independent prospective episodes, after-fee economics and actual broker risk replay. |
| Extension-exhaustion | 0 eligible candidates across 339 ensemble evaluations in the latest 3h across six pairs. Heavy REGIME_NOT_EXTENDED and DRIFT_NOT_NORMAL dispositions. | Not promoted; reevaluate regime-specific calibration rather than loosening all guards. |
| Weak-trend persistence | 0 eligible candidates in the same 339 evaluations. | Not promoted; lacks active independently positive after-cost candidate cohort. |
| Low-volatility reversal | Scored for EURUSD and AUDUSD in latest 2h: 238 decisions per pair; 0 eligible hypotheses, 0 new 15m settled outcomes. | Not promoted; adjust hypothesis only after proper historical walk-forward test. |
| M1 tactical & Plan B primary | Active scanning, abundant predictions, few executable entries; known negative realized/quote results. | Improve candidate forecasting and timing; trading volume is not qualification evidence. |
| Delayed-entry / 40% wider SL / profit-lock patience | Various historical simulated confirmations and many DATA_GAP states; historical review found weak sample and unproven after-cost improvements. | Diagnose incomplete data and compare to unchanged baseline; shadow only. |
| Z.ai P2 ATR stop, P3/P6 expert/meta-label, P5 OOD relaxation, P7 early transition | Earlier reviewed evidence unqualified; P5 and P7 had negative replay results. | No DEMO promotion based on the earlier report. |
| Multi-horizon 1/2/3/5/10/30/60m prediction research | New chronological holdout and conservative first-touch experiments revealed most short forecasts and naive four-red reversal rules unprofitable. AUDUSD 60m net positive only through one good day. | Not a qualified deployable alpha; requires additional independent broker days and stop/TP execution replay. |

## Miswired broker-source defect and repair

The original active paper ensemble writes shadow decisions with an internal
`paper-broker` connection. Global environment-based M1 data source continued
pointing to older `ctrader` DEMO while Pepperstone cTrader actively captured
new broker-native M1 candles.

Repair:
1. For virtual/shadow decisions, resolve owner-verified cTrader-family DEMO
   source from a FULL_AUTO session active **at the original decision time**,
   fallback only to a directly owned DEMO cTrader original connection. Never
   use the internal paper-broker or a stale global setting as quote source.
2. For executed-trade shadow checkpoints, use the verified DEMO trade broker,
   never the old global source.
3. No authorization/execution flow, lot sizing or broker position handling
   changed by this repair.

## Gates for any controlled DEMO promotion

- A strategy must have an executable, independently tested BUY/SELL proposal
  with broker-native as-of features; price direction alone is insufficient.
- Require independent chronological daily/sessions/regimes validation,
  non-overlapping trade episodes, realistic spread/commission/slippage,
  and actual historical order/stop/TP first-touch approximation.
- Demonstrate positive expectancy and profit factor after costs on later data,
  compare drawdown to unchanged Plan B baseline, establish broker reconciliation,
  and keep kill switch and portfolio protection.
- Manual, explicit DEMO-only promotion following a frozen version and tests.
  Never auto-promote to LIVE based on one attractive aggregate or a shadow
  classifier recommending PROTECT.

Read-only diagnostics can be performed without additional broker orders.
