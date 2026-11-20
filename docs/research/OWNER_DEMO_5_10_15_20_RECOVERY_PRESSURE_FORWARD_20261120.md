# Owner-only DEMO trade recovery pressure observer — 20 November 2026

## Objective

Investigate the owner's observed large givebacks, including November 20 USDCAD shorts that temporarily recorded favorable P&L but closed negative after commissions. In the audited Pepperstone USD DEMO ledger, a USDCAD SELL opened 15:08:24 UTC showed max favorable gross P&L $64.00 and closed 15:18:27 UTC at gross -$184.68, commission -$29.40, **broker net -$214.08**. A distinct USDCAD SELL opened 14:51:22 UTC had a +$50.31 recorded peak and closed with gross -$177.85 and commission -$29.40, **net -$207.25**. Neither validates that a different exit was possible, and these separate records do not conclusively identify the user's UI example (peak $60.85).

The user's request is to monitor whether a position facing reversal may fail to recover within the next **5, 10, 15 or 20 minutes** without undermining the profitable positions that currently reach their targets. This change **does NOT introduce a new exit strategy**, broker stop amendment or automatic trigger into current profit protection.

## New active prospective observer

- Pure as-of scoring and outcome functions: `apps/api/scripts/owner-demo-recovery-risk-shadow.cjs`.
- Read-only monitor: `apps/api/scripts/watch-owner-demo-recovery-risk-shadow.cjs`.
- Isolated PM2 config: `apps/api/scripts/irexpro-owner-recovery-risk-shadow.pm2.config.cjs`.
- Scope: one exact pre-configured owner account, one Pepperstone cTrader broker connection, account type DEMO and currency USD. Eligible original routes are EARLY_TRANSITION and CONFIRMED_REVERSAL. **No LIVE data or control.**
- Activation marker, observer state and date-stamped append-only observations in `/home/lightworld/webapps/irexpro-research/recovery-risk-forward`; summary in `latest-summary.json`.
- Enrollment: only when the trade is **actually OPEN**, opened after activation, and seen within **90 seconds** of broker opening. No hindsight reconstruction of closed trade snapshots.
- Frequency: polling about every 12 seconds for **new, on-time** OPEN trade snapshots at trade ages 1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20, 25, 30, 40, 50, and 60 minutes. A snapshot must be taken in its first 30 seconds; otherwise it is missed, not backfilled. This provides early warnings for positions that might close before minute 5.
- Each snapshot records a separate **5/10/15/20-minute** recovery-pressure *scenario*, rather than a fabricated percent probability that a losing trade will or will not recover. Labels are currently observational, untrained and uncalibrated.
- Uses completed positive-spread broker-native M1 quote observations from the trade's exact broker connection, with recorded timestamps, positive-quote counts and updated-at no later than snapshot time. EURUSD candles with zero spread and inadequate positive samples are **rejected**. Uses the same close side as the actual BUY/SELL exit for quote-only gross P&L.
- Uses original immutable intent stop/fill/lot size for risk geometry, 1/3/5-minute direction-adjusted price momentum and any *fresh* as-of observed broker P&L peak/giveback. Estimated fee reserve is accepted only if supported by a pre-fill allocation's `historicalFeePerLot`; zero or missing fee coverage produces no hypothetical after-fee quote figure.
- Scenario categories: `TOWARD_ORIGINAL_STOP` where adverse near-stop momentum is observed, `POSITIVE_PEAK_GIVEBACK_WITH_COUNTER_MOMENTUM` where a fee-covered peak has been lost amid confirmed 1/3-minute counter-momentum, `COUNTER_MOMENTUM_WATCH` and `NO_STRONG_REVERSAL_WARNING` for other valid conditions, plus explicit unknowns if quotes or entry data are invalid. **No labels claim a permanent or inevitable reversal.**
- After each snapshot, separately records eventual actual broker settlement when available, or the future *as-of* positive-spread quote-only mark at +5/10/15/20 minutes **only if still OPEN**. A position closed before the horizon gets its actual net settlement and close reason. Missing future checkpoints expire; no mutable historical quote backfill.
- Reports both high-risk warnings and **warned winning trades**, deduplicating warning settlements by trade ID to avoid inflating loss savings. Several independent days and warned/unwarned, net-of-commission comparisons are still required before training/calibrating probabilities or considering a discretionary change. Due to nonrandomized observational cohorts, an after-the-fact improvement cannot prove changing exits would have saved the same amount.

## Isolation, safety and deployment

The new process connects to PostgreSQL in `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`, queries the correct demo broker records and writes **only** the research directory. It does not call the cTrader trading API, issue broker orders, update models or alter existing profit protection, take profit, stop loss, lot size, margin gates, risk vetoes or LIVE account behavior. A watcher watchdog restarts this research process only on a >90-second stall or repeated errors. It is safe to stop independently if quote quality is insufficient.

The current model **cannot** reliably predict that a price "will never return". It first has to learn which *real-time* observed signs historically precede stop-loss-like exits and distinguish them from normal retracements on eventual winners. User-visible results must distinguish recorded marked favorable peaks, theoretical quote-only after-fee values, actual broker fills, and provider-native stop-trigger causes (not yet verified in the database).

**Rollout rule:** collect forward proof from multiple untouched trading days, compare warnings *against eventual winners as well as losers*, evaluate actual after-cost economics and broker quote coverage, and run shadow counterfactuals with realistic slippage/fees before any proposal to alter automatic protection. No automatic promotion is permitted.
