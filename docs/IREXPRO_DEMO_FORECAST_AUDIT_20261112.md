# iRexPro demo short-horizon trading investigation — 12 November 2026

## Problem
Active Pepperstone cTrader DEMO FULL_AUTO scans were repeatedly ABSTAIN or denied
entry despite visible intraday market movement. Optimizing acceptance rate alone
is invalid; a forecast must be profitable after costs and risk in later market data.

## Read-only experiment implemented
- `apps/api/scripts/export-demo-horizon-quotes.cjs`: broker-native completed
  M1 bid/ask/ohlc export from active Pepperstone DEMO, optionally older cTrader
  DEMO used **only for earlier chronological training**.
- `services/ai-engine/app/domain/training/demo_pepperstone_two_pair_horizon_audit.py`:
  per-instrument 1/2/3/5/10/30/60 minute forward-mid-return Ridge forecasts,
  previously unseen three-day holdout, LONG/SHORT/no-trade decisions, broker
  bid/ask costs and independent non-overlapping hypothetical entries.
- `services/ai-engine/app/domain/training/demo_first_touch_horizon_research.py`:
  conservative M1 TP/SL approximation. Same-bar dual-touch counts stop first.
  This is **not tick-level execution research**.
- `services/ai-engine/app/domain/training/test_demo_forecast_horizon_audit.py`:
  future labels require a real later bar, with no gap interpolation; ambiguous
  dual barrier touch results in loss; unavailable future data is not scored.

To reproduce on the VPS:
```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node scripts/export-demo-horizon-quotes.cjs /tmp/irexpro-broker-horizon-input-UNIQUE.csv
cd ../../
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1 MKL_NUM_THREADS=1 \
 services/ai-engine/.venv/bin/python -m app.domain.training.demo_pepperstone_two_pair_horizon_audit \
 --csv /tmp/irexpro-broker-horizon-input-UNIQUE.csv --out /tmp/irexpro-horizon-report-UNIQUE.json
```
Use fresh unique private /tmp paths; do not publish quote or customer data.

## Results / reasons **not** to grant broker authority yet
On a smaller current-Pepperstone-only test, the 10m holdout model yielded:
EURUSD 11 non-overlapping marks / -12.6 pips, AUDUSD 8 / -8.1 pips.

On a larger older-cTrader-pretraining / three-date Pepperstone holdout:
- AUDUSD 60m: 35 simulated marks, +51.2 net pips, but day-by-day
  +54.0 (Nov10), -1.1 (Nov11), -1.7 (Nov12). Thus no stable edge.
- EURUSD 60m: 39 simulated marks, -83.1 net pips.
- Four-red immediate-rebound trading was negative on the holdout.
- In 24 tested four-candle/TP/SL/hold strategies, only 2 had positive
  aggregate returns, and neither won on all three later dates. Multiple
  comparisons mean neither can be called qualified.
- Of 134 decisions denied solely by primary-only DEMO probation, 130 could
  be matched to quotes. Holding hypothetical non-overlapping entries at
  5/10/15/30/60 minutes produced -74.6/-64.9/-72.3/-71.9/-41.8
  aggregate net pips respectively, using bid/ask and a 1.1-pip
  estimated fee/slippage reserve.

## Limits
Quote marks are not actual broker fills, first-touch sim is not precise tick
ordering, and historic spreads/commissions can change. 12 Nov is a partial
UTC date. The previous cTrader account differs from the active Pepperstone
account, so cross-provider training transfer is not proved. This is not
investment advice or a profit guarantee.

## Engineering direction
1. Keep legitimate margin, exposure, stop, session and independent drawdown
   safeguards. Do not silently promote a strategy from a small favorable sample.
2. Build a single DEMO-only candidate scorecard for both BUY and SELL with
   net-of-cost expected payoff over 1/2/3/5/10/30/60m, uncertainty bands,
   expected adverse excursion, and measurable expiration/exit criteria.
3. Backtest walk-forward with *more independent Pepperstone dates*, per-day
   and per-regime profitability, first-touch tick quotes and actual fee evidence.
4. Compare existing Plan B admissions and blocked-only counterfactuals. Only
   the route with independently positive results may advance to a tightly
   capped broker DEMO pilot, with kill switch, portfolio constraints and
   broker audit. Never auto-promote to LIVE.
5. Record every forecast timestamp and subsequent outcome so rejection and
   execution quality can be measured, not inferred from a high scan count.

No trade execution, broker positions, risk policy or live user controls were
modified by the tools in this audit.
