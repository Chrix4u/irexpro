# iRexPro — AI Trader loading and no-trade diagnosis, 12 Nov 2026

## Production symptoms reproduced in staging
- Last AUDUSD DEMO trade opened 10:09:12 UTC, closed 10:16:31.
- Last EURUSD DEMO trade opened 09:39:19 UTC, closed 10:19:03.
- 11:00–13:00 UTC plus partial 13:00 hour: 632 EURUSD/AUDUSD
  M1 directional decisions and zero execution approvals.
- 13:51 UTC spot check: 28 AUDUSD + 28 EURUSD evaluations in latest 15m;
  zero approvals and broker-native M1 candles current.
- Dominant *overlapping* blockers: ensemble admission,
  multimodel governance, continuation timing and out-of-distribution
  classification. Out-of-distribution diagnostics frequently show hard-low
  directional MTF strength or EMA separation. The two alternate reversal
  and transition modes generally lack their own M1 timing confirmation.

## Did we over-block profitable trades?
Read-only historical, non-overlapping BID/ASK exit-mark audit of 959
single-gate rejected records. Conservative extra fee/slippage reserve:
1.1 pips round trip after observed quoted spread. The hypothetical entry
is delayed to the next completed M1 quote mark; actual broker fills,
first-touch stop/TP and market impact are not represented.

| Single veto | 10m entries | 10m net pips |
| --- | ---: | ---: |
| Reversal lacking M1 confirmation | 239 | -290.4 |
| Early transition lacking M1 confirmation | 90 | -95.6 |
| Primary-only probation | 50 | -74.0 |
| Continuation timing not ready | 58 | -42.8 |

At 60m, continuation-timing cohort was +14.3 pips aggregate but
-32.7 pips on Nov 12 alone. **No stable positive after-cost evidence for
blanket gate removal or aggressive DEMO promotion.**

## Corrected operational broker-source mismatch
Environment bindings on the staging API were still set to legacy
cTrader DEMO while current broker-native data belonged to a verified
connected/authorized Pepperstone cTrader DEMO account. The following
were updated on staging after checking the active FULL_AUTO session,
broker ownership, DEMO type, connected status, and scanner-user match:

- `M1_TACTICAL_MARKET_DATA_CONNECTION_ID`
- `MULTIMODEL_BROKER_EXPERT_SOURCE_CONNECTION_ID`

A private mode-0600 previous .env backup was retained on the VPS.
The API was reloaded with updated process environment and both
running-source equality checks passed. These settings affect M1 source
and high-conviction broker expert/cost evidence; they do **not** grant
execution authority, bypass SL/account risk, or promote models.
Do **not** modify the paper-broker scanner's identity as a shortcut.
To prevent recurrence, the next refactor should make those sources
derive from the owner-verified active DEMO session rather than
hand-maintained static connection IDs.

## AI Trader loading improvements
- Route-level Next.js `/trade/loading.tsx` skeleton, plus client-level
  loading screen during auth restoration and initial terminal load.
- Animated, motion-reduction-aware shimmer and scanning animation:
  broker equity, allocation, 24h net P&L, open P&L, strategy and chart.
- Account allocation fetch starts immediately after broker identity is
  known, independent of the slower provider/AI research telemetry and
  history requests. No risk controls are activated without verified data.
- KPI placeholders continue on any secondary feed still awaiting a first
  valid response; no false "0" open P&L or placeholder dash on initial
  render. Prior valid snapshots remain displayed on refresh errors.
- No external animation assets or recurring dependencies introduced.

## Remaining work / completion gate
1. Preserve real broker stops, margin, kill switch, drawdown, and risk
   controls while consolidating duplicate *model* vetoes; identify
   independent entry alpha first.
2. Fix Python v8.5 shadow checkpoint errors; some rows now READY with
   Pepperstone broker source, but other POST_ENTRY_SCORING_FAILED.
3. Train/calibrate entry prediction using older data and independent
   later Pepperstone holdout, including TP/SL first-touch with realistic
   broker costs, signed BUY/SELL direction and 1/3/5/10/30/60m horizons.
4. Controlled low-exposure Pepperstone DEMO strategy trial only after
   consistent after-cost out-of-sample evidence. Do not auto-promote LIVE.
5. Compare observed browser load latency before/after; an animated
   skeleton improves perceived waiting, but cannot make an unhealthy
   backend fast by itself.
