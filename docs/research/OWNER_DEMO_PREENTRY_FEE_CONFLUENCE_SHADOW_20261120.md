# Owner Pepperstone USD DEMO — frozen pre-entry fee/dual-abstention research

## Hypothesis (research only, no entry veto)

The underlying daily losses in Confirmed Reversal were driven mainly by positions which never reached a gross favorable peak sufficient to cover commission, even after the owner-authorized weak-reversal 4-lot ceiling went live. A historical, **in-sample** 23-trade 7-lot-eligible Confirmed Reversal cohort contained a high-loss group when:
- Prior settled same broker-account fee samples showed the proposed entry's expected after-fee return below the route's positive floor.
- M1 tactical entry timing was `ABSTAIN`.
- The independent trained expert also returned `ABSTAIN`.
- As-of completed H1/M5 direction or causal recent-negative-payoff evidence sometimes opposed the new trade.

That in-sample combination also included **genuine winners**, so it is not a proven trade veto.

## Frozen prospective-only implementation

Added `apps/api/scripts/owner-demo-preentry-fee-conflict-shadow.cjs`, its isolated immutable state helper, and hooked the resulting scorecard into existing `apps/api/scripts/audit-owner-demo-weak-reversal-ceiling-forward.cjs` and the separate existing read-only PM2 scorecard. **No changes to the API build, model admission, broker order APIs, stop-loss, profit-protection settings, lot permissions, strategy selection or Start/Stop Trading behavior.**

A new independent activation marker `/home/lightworld/webapps/irexpro-research/weak-reversal-forward/preentry-fee-double-abstain-activation.json` was frozen at **2026-11-20T18:34:10.795Z**. It is hashed to the exact owner and broker connection, with Pepperstone cTrader DEMO/USD bound and explicit prohibitions on entry veto, lot changes, profit protection changes, exits and live account promotion. It cannot silently be moved backward for a historical success claim.

Every 45 seconds, the research-only watcher uses a **READ ONLY** serially scoped owner/broker SQL query joining `trading.trades`, `trading.trade_intents`, `broker.broker_connections` and an exact `trade_intent_id` **causally chosen** `trading.m1_tactical_decisions` record. The tactical record's `created_at` AND `evaluated_at` are both required no later than the broker fill `opened_at`. It reads the independent expert state, native fee P90 shadow `shadowReason`, `shadowAfterFeeExpectedR`, `minimumAfterFeeR`, minimum **12** prior completed broker fee samples, M1 route and pre-entry H1/M5 features, as well as already completed recent strategy net-payoff evidence.

Crucial anti-hindsight controls:
- **A trade must be first observed truly `OPEN` after rule activation to receive any warning or control classification.** The first as-of-open record is frozen into an isolated private file `preentry-fee-double-abstain-state.json`. Subsequent settlement or changes to decisions cannot rewrite it.
- A trade first discovered already CLOSED is labeled `MISSED_WHILE_OPEN_NOT_CAPTURED`, excluded from claimed prediction success. A trade opened before activation cannot be relabeled, even if still OPEN today. An otherwise eligible position with no causal decision is labeled insufficient and cannot be retroactively promoted.
- `FEE_DEFICIT_DOUBLE_ABSTAIN_WITH_INDEPENDENT_CONFLICT` is the strongest research caution: all fee economics/maturity and both independently abstaining votes are confirmed plus opposing H1/M5 or sufficiently evidenced prior-negative payoff.
- `FEE_DEFICIT_DOUBLE_ABSTAIN_CAUTION` is a weaker warning without confirmed extra conflict.
- `NO_CONFLUENT_ENTRY_WARNING` is control. `OTHER_ROUTE_CONTROL` is kept separate, so healthy alternative strategies are not affected.
- **The scorecard records actual eventual broker-net wins among warnings as false positives and actual winning dollars they would have mistakenly excluded if promoted**, as well as actual broker-net losses among warnings. It never claims saved trades/dollars or calibrated probabilities.
- Actual outcome sources remain `realised_pnl + commission + swap`. OPEN trades have NO actual result. The scorecard is non-promoting even when enough sample statistics accumulate; review requires 5 different trading days and at least 20 warned and 20 unwarned settled positions.
- All existing 5/10/15/20-minute recovery and sub-minute quote observers, 4-lot weak-reversal exposure ceiling and broker Stop/Profit Protection remain untouched.

## Verified at activation

The exact account's real completed decision join was confirmed read-only, including proof that 5 post-exposure-release positions already opened before 18:34:10 all had M1 decision creation and evaluation timestamps **prior** to broker entry. These five entries are correctly excluded from the newly frozen forward confluence rule. **63 relevant automated tests passed** covering pure warning logic, fee maturity, pre-fill causality, frozen activation ownership, tampering, postclose no-backfill, false warnings on actual winners, read-only DB SQL, and prior recovery observers. After the join comma syntax fix, the read-only query succeeded against PostgreSQL and the new scorecard initially showed **zero new prospectively qualifying trades, zero claimed warning successes**.

First two real post-5:37 PM Confirmed Reversal capped trades remained **-$258.24 after fees**; they preceded this separate 18:34 rule and cannot be counted as independent validation of it.

Operational next step: commit/push to existing iRexPro feature branch, restart **only** the standalone `irexpro-owner-weak-reversal-forward-scorecard` PM2 research process, verify reporting latency, absence of errors, unchanged live API and broker profit protection PIDs, and actual still-open trades unaffected.

## First real, independently frozen event and timing honesty

At **2026-11-20T18:35:40.905Z**, an **AUDUSD BUY** `CONFIRMED_REVERSAL` opened at **2.25 lots** (existing four-lot ceiling and downstream sizing). The new frozen read-only watcher first observed it as OPEN at **18:37:15.737Z** and filed `FEE_DEFICIT_DOUBLE_ABSTAIN_WITH_INDEPENDENT_CONFLICT`. The source decision had been created before the broker fill, and the fee shadow had estimated after-fee **+0.07321 R** versus the required **+0.08 R**. At the time of capture the broker trade was still OPEN; its eventual result was **unknown**, so the warning cannot be counted as correct or incorrect until the broker closes and fully settles the fee.

**Important distinction:** This is a *pre-fill-evidence, post-fill observation* and a genuine pre-**settlement** research warning; it is **NOT** a warning actually issued to the execution scheduler before the order was placed. This study can test whether the entry-evidence signals would have distinguished losses from wins, but cannot retroactively prevent this trade or claim a fill/exit. Added `warningIssuedBeforeBrokerFill:false` and `firstCapturedSecondsAfterBrokerFill` to future frozen snapshots to expose research latency instead of implying real-time pre-dispatch authority. The first observation above is already immutable and will not be rewritten to insert later fields.

After this read-only research upgrade, the trading API process PID **2633473**, original profit-protection process PID **2452772** and main recovery monitor PID **2577750** remained unchanged. The new scorecard alone was restarted and returned an as-of refresh under 45 seconds with no error. As of 18:40 UTC the new caution cohort had **one opened, zero settled**, hence zero proven winners/losers and zero claimed saved money. The original two post-5:37 PM capped losses remain **-$258.24 net** and are excluded from the new research rule because they predate its separate activation.
