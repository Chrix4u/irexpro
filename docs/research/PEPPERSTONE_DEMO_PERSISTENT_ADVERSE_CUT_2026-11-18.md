# Pepperstone owner DEMO persistent-adverse M1 exit pilot — 18 Nov 2026

## Diagnosis (read-only baseline)

Last 30 h at audit time (07:27 UTC): 83 closed Pepperstone DEMO fills, 49 booked after-commission winners, 34 losses, net -$692.70. Average booked win +$34.65; loss -$70.32. Commissions totaled -$914.28. Of 26 BROKER_CLOSE trades, only five had any recorded favorable peak >= $20 and 13 peaked below $5. Profit-only giveback cannot prevent losses that never became profitable. Existing Pepperstone-specific branch previously exited to research-only observation before the shared adverse-M1 loss guard.

## Controlled intervention

`IREXPRO_PEPPERSTONE_DEMO_PERSISTENT_ADVERSE_CUT=enabled` enables a **loss-reducing close request only** for the known owner, verified `pepperstone-ctrader` DEMO USD account, existing M1 EARLY_TRANSITION or CONFIRMED_REVERSAL positions. The primary Pepperstone net-profit lock runs first and is unchanged. No LIVE, other-broker or other-user authority, no new orders, lot size amendments, or broker SL/TP changes.

Loss-cut requires original stop still at broker, price moving against entry but not yet at stop, exact broker symbol/side/lot match, initial allocation stop-risk evidence, negative broker-net P&L <= -0.45R, favorable peak < 0.15R, >=2 minutes age, >=12 prior observations, >=2 completed consecutively quoted M1 candles with >=2 adverse bodies, latest body pressure <=-0.35, three-bar normalized momentum <=-0.15, latest candle <=75 s old, and valid latest spread <=25% of original entry-to-stop price distance. Missing/stale evidence means **do not close**; the existing broker stop remains in place.

This is a prospective risk reduction pilot, not proof of improved net expectancy. Closing early can cut off recoveries; slippage and commissions can change final booked outcomes. Preserve the toggle as an immediate kill switch. For validation, measure real before/after booked commissions, entry-level risk-normalized outcomes, close dispatch success/failure, instruments, wins sacrificed and drawdown. Do not promote to real-money trading from this change.

## Validation

Jest: `pepperstone-demo-adverse-cut.spec.ts`, `live-demo-profit-protection.service.spec.ts`; 111 targeted tests passed. `tsc -p tsconfig.build.json --noEmit` passed. Test cases cover normal qualified loss cut, missing/live native quotes, stale candles, spread blowouts, different broker, different owner, LIVE account, profits, prior peaks, direction/lot/stop mismatch, inactive flag and unaffected existing profit-lock behavior.
