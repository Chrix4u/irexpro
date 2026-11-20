# Pepperstone USD DEMO — why no trades since 12:05 PM, 18 Nov 2026

## Verified entry brake

The API, AI engine and FULL_AUTO Pepperstone USD DEMO session remain active. At 13:45 UTC/Ghana time, the last three broker-settled trades were -$39.26 (AUDUSD Sell, 09:37), -$37.96 (USDJPY Buy, 09:43), and -$81.88 (AUDUSD Sell, 12:05): **-$159.10 net including recorded commissions**.

The existing M1 portfolio-wide loss-streak brake, unrelated to the recently disabled persistent-adverse-cut pilot, requires three consecutive DEMO net losses and pauses NEW entries for 120 minutes. Latest close 2026-11-18T12:05:33.982Z, expiry 2026-11-18T14:05:33.982Z (2:05:34 PM Ghana time). A newer actual close can change this time.

At 13:45 the owner-only forensic audit identified 776 scanner decisions since that close, zero new broker trade intents, 17 continuous reversal/early-transition alternative-eligible decisions, and 16 of those encountering the portfolio brake. The seventeenth was separately vetoed by a pair-side profitability-quality rule. These are decision events, not broker order fills or 17 promises of profitable trading.

## Route nuances and other blockers

Trend Continuation remains intentionally paused and the general shadow scanner predominantly evaluates that route; do not mistake thousands of scanner decisions for executable alternatives.

The scanner's diagnostic blocker list can show an M1 route-label mismatch even when the separate, owner-verified continuous Early Transition/Confirmed Reversal alternative is eligible. An advisory-qualified alternative can bridge that duplicate label test, but it cannot bypass the portfolio-wide loss-streak risk brake. The new diagnostic separates these notions. A pair-side reliability veto or an independent strategy-loss brake can also reject candidates.

Brake expiry means fresh candidates may be evaluated; it does not guarantee an order. A missing new order after expiry can reflect further risk/quality gates, not necessarily a malfunction or a broker connection failure.

## Operator diagnostics added

- apps/api/scripts/audit-owner-demo-entry-blockers.cjs: owner/broker/account-scoped, bounded PostgreSQL REPEATABLE READ READ ONLY forensic queries.
- apps/api/scripts/audit-owner-demo-entry-blockers.test.cjs and apps/api/scripts/watch-owner-demo-entry-blockers.test.cjs: deterministic safety and blocker tests.
- apps/api/scripts/watch-owner-demo-entry-blockers.cjs: read-only process that checks every 90 seconds, logs status transitions and periodic 20-minute summaries.
- apps/api/scripts/irexpro-owner-demo-entry-blockade-watch.pm2.config.cjs: independent 1-worker PM2 observer.
- Private atomic 0600 report: /home/lightworld/webapps/irexpro-research/entry-blockade/latest-report.json.
- Logs: pm2 logs irexpro-owner-demo-entry-blockade-watch --lines 15 --nostream.
- This monitor can be stopped independently without changing the execution API or actual risk gates.

The watcher explicitly distinguishes valid active portfolio brake, expired brake with no new order intent, stale scanner decisions, no newly qualified alternative, and a real submitted intent. Its output does not confer permission to execute an order.

## Risk and execution state preserved

No change to Early Transition / Confirmed Reversal lot allocations, entry authority, model weights, broker original SL/TP, five-minute DEMO drawdown protection, or tiered net-profit lock. The new persistent adverse cut and aggressive TP-progressive overlay remain disabled. No LIVE promotion or account alteration. The forward-entry and net-R calibration research collectors continue independently.

The earlier 17–18 Nov two-day after-fee cohort lost substantial net capital. Disabling an account risk brake merely to generate a new trade would not establish profitable entry strategy. If fresh eligible trades remain blocked AFTER 14:05:34, inspect the newly logged effective risk / quality reason; repair a demonstrated code deadlock rather than blindly removing financial protections.
