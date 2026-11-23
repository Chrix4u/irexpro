# 23 November 2026: proposed entry-quality hold — audit

Status: **RESEARCH ONLY**, no execution admission, lot sizing or LIVE permissions changed. Source is the authorized Pepperstone USD DEMO account's 30 completed trades and contemporaneously created trade intents, with a read-only query over the preserved M1 decision records.

| Historical trade group | Count | Wins | Losses | Actual net P&L |
|---|---:|---:|---:|---:|
| All DEMO entries | 30 | 19 | 11 | -$762.06 |
| Proposed exact double-ABSTAIN / no expectancy / OOD / not-paper-admitted entries | 19 | 9 | 10 | -$1,228.66 |
| Entries not matched by proposed rule | 11 | 10 | 1 | +$466.60 |

Nine profitable trades matching the proposed rule paid +$575.95; ten losing trades matching it lost -$1,804.61. They should not be conflated with real profits that the account would have made under the new rule: rejecting trades changes equity, concurrent exposure and future signals.

Within the 19 matches: USDCAD 2 wins/6 losses (net -$876.31); USDJPY 5/3 (net -$468.25); EURUSD 1/1 (net +$41.00); AUDUSD 1/0 (net +$74.90). Descriptive entry features of nine winners versus ten losses respectively: M5 alignment mean +0.0768 vs -0.3753; M30 directional efficiency +0.0743 vs -0.0955; higher-timeframe agreement -0.0442 vs -0.2283; entry confidence +0.682 vs +0.677. Confidence does not separate outcomes.

A **post-hoc, research-only** positive M5 *and* positive M30 split yields six winning and two losing trades in its passing subset; the passing subset still loses -$140.93 after fees. This is not a proven admission threshold and must not block either DEMO or LIVE orders.

Time-provenance: all 30 trade-intents were persisted and unmodified before execution and all decisions were evaluated before execution, BUT all decision rows were subsequently updated with outcome status. Stored candidate features are therefore NOT independently proven immutable at decision time. Future diagnostic snapshots should be append-only and timestamped before order dispatch.

For a later admission decision: run a prospective, independent DEMO shadow period; compare by instrument/session/regime and after-fee net profit, false winner rejection, losing trades avoided and drawdown. Avoid learning thresholds and certifying them on this same 19-trade sample. Broker demo risk exposure cap is separately held; neither is deployed. LIVE trading remains disabled.

Reproduce read-only: `node apps/api/scripts/research/replay-held-entry-quality-shadow.cjs 2026-11-23` after installing scoped API dependencies and supplying `IREXPRO_RESEARCH_DOTENV_PATH` to an authorized DB configuration.
