# iRexPro prospective entry-timing collector: owner Pepperstone DEMO

**Implementation: 18 November 2026.** This is an *observational* forward-validation facility. It cannot train, trade, place orders, amend stops, change lot allocation, change broker session permissions, modify the existing loss/profit protector, or enable LIVE trading.

## Motivation

The 17–18 November research found 93 completed Early Transition and Confirmed Reversal owner-DEMO trades, -$1,192.96 net booked after -$1,028.04 commissions. Original predicted net expectancy averaged +0.2822R and actual net realized -0.2242R. Among 89 fresh in-position first-minute quote marks, 52 moved against the predicted entry direction, 32 favorably, five flat. A 60-second confirmation pilot yielded 22 original position candidates, but 21 usable three-minute quote marks split only 11 favorable / 10 unfavorable. Those retrospective findings are not independent profit validation.

An essential next step is to **freeze new entry decisions prospectively**, record their actual futures with fixed deadlines, and retain true separate market days. Do not tune entry restrictions from only two sample days.

## Exact production-safe deployment boundary

- VPS repository: /home/lightworld/webapps/irexpro-staging
- Script: apps/api/scripts/collect-owner-demo-prospective-entry-timing.cjs
- PM2 process: irexpro-prospective-entry-timing-shadow
- PM2 config: apps/api/scripts/irexpro-prospective-entry-timing-shadow.pm2.config.cjs
- Private root: /home/lightworld/webapps/irexpro-research/prospective-entry-timing (mode 0700)
- Immutable activation: activation.json, exact owner fingerprint plus initial UTC activation time, 0600
- Append-only daily event data: YYYY-MM-DD.jsonl, mode 0600, 12 MiB/day cap, 45-day bounded retention
- Derived private report: latest-summary.json, 0600, atomically replaced
- Native bid/ask sample source: existing independently running broker-poll append-only daily quote archive (no new paid market-data connector)
- State source: exact owner-owned Pepperstone cTrader USD DEMO *trading.trades* and immutable pre-order trade-intent metadata via bounded PostgreSQL REPEATABLE READ READ ONLY queries
- M1 route whitelist: EARLY_TRANSITION or CONFIRMED_REVERSAL. Only four authorized FX instruments and the user's DEMO account. Other brokers, accounts, LIVE and tenants are excluded.
- Watch interval: 12 seconds; no duplicate PM2 workers. Row limit: 250; only trades opened after immutable activation; at most prior 18 hours of owner-scoped trades.

## Capture stages

1. ENTRY: accepted only when an actual owner DEMO position is still OPEN and newly seen within 90 seconds of its broker-open time, *after the collector activation*. The original planned entry, prediction, independent expert vote/state, original lot size and stop/TP, pre-order allocation risk and original intention timestamp are frozen. Independent broker sample source and observation timestamp must be no later than the original order intention. Historical, late, closed or malformed entries become ENTRY_MISSED / ENTRY_REJECTED and CANNOT be backfilled.
2. CHECKPOINT_60S: within 8–40 seconds after one minute past actual open; compute the previously frozen 60-second *hypothetical* timing policy using only quotes that had already been observed by the checkpoint target. A missed checkpoint stays CHECKPOINT_60S_MISSED; it cannot be reconstructed later. If real trade already closed, shadow states REAL_TRADE_ALREADY_CLOSED.
3. MARK_3M, MARK_5M and MARK_10M: separately collected within 8–40 seconds after each fixed event. Each is a sampled SIDE-SPECIFIC broker quote mark, NOT a broker fill. If the original position closed before this horizon, mark is explicitly censored from the original-trade in-position directional score. A late or missing mark stays missing, rather than using hindsight.
4. SETTLED: after real broker reconciliation, append signed gross, commission, swap and after-cost actual net USD for the ORIGINAL REAL broker position. This result must NEVER be falsely assigned to a nonexistent delayed-entry order.
5. Every saved event is idempotently keyed by exact private trade ID and stage. The append-only journal can recover on process restart and does not double count. The derived report exposes aggregate statistics without personal trade IDs.

## How to read the summary

latest-summary.json contains capturedEntries, missed/rejected entry counts, independently observed trading days, settledTrades, true settledNetUsd, byOriginalEntryRoute, byFrozen60sDecision and future quote marks inside/outside the original trade's lifespan. Grouping a frozen shadow signal against the ORIGINAL position's final net is diagnostic only. It is **not** an execution-aware delayed-entry strategy backtest.

No positive return inference is authorized until sufficient disjoint unseen market dates exist, and later order simulations account for actual bid/ask, spread, true provider fill/latency, slippage, original stop/TP and fee economics. The summary's prospectiveQualification remains NOT_QUALIFIED even if the sample's short-run booked net becomes positive.

## Current protections preserved

Early Transition and Confirmed Reversal lot sizing, entry permission and models are unchanged. The recent persistent adverse-loss-cut pilot remains DISABLED; extra-aggressive TP-progressive retention remains DISABLED; original tiered positive profit lock (65/75/80) remains ENABLED. Older broker-native five-minute DEMO drawdown guard stays active. Original actual broker SL/TP is authoritative. Protected runner and trained forming-candle expert retain RESEARCH ONLY status. No REAL/LIVE account promotion authorized.

## Test, operate, inspect

From apps/api:
- node --test scripts/collect-owner-demo-prospective-entry-timing.test.cjs scripts/audit-owner-demo-prospective-entry-outcomes.test.cjs scripts/audit-pepperstone-asof-entry-context-net.test.cjs scripts/owner-demo-entry-timing-checkpoint-shadow.test.cjs
- node scripts/collect-owner-demo-prospective-entry-timing.cjs          (single-cycle dry observation with real owner-only DB)
- node scripts/audit-owner-demo-prospective-entry-outcomes.cjs       (read-only journal summary)
- pm2 start scripts/irexpro-prospective-entry-timing-shadow.pm2.config.cjs
- pm2 show irexpro-prospective-entry-timing-shadow
- pm2 logs irexpro-prospective-entry-timing-shadow --lines 15 --nostream

Stop ongoing observation (without affecting trading): pm2 stop irexpro-prospective-entry-timing-shadow . Do not remove the immutable activation marker or edit the private journal to retroactively make historical entries look prospective.

The process requires zero additional broker API services or subscriptions. It is separate from the actual trading API and should never restart or modify the primary trading engine as part of read-only research deployment.
