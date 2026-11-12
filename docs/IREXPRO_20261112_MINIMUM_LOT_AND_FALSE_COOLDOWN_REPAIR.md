# iRexPro DEMO zero-trade execution deadlock — confirmed 12 November 2026

## Incident and evidence

The user observed no new trades after the EURUSD SELL closed at **10:19:03 UTC**.
The API/M1 scanner was active and Pepperstone cTrader DEMO FULL_AUTO
was connected. A previous change had created a carefully limited
0.01-lot "qualified continuation" alternative to primary Plan B
probation after verifying **7 actually closed AUDUSD SELL continuation
trades, 5 net wins, +0.274R mean after commission**.

**At 19:33 UTC** that strategy finally produced a valid broker-native
decision for AUDUSD SELL. It had M1_TREND_CONTINUATION authority,
+0.2236 M1 net expected R, broker quote/cost evidence, realised positive
pair-side reliability and no model blockers. It proposed:

- AUDUSD SELL, model reference entry ~0.68029;
- stop ~0.68079 (five pips);
- TP ~0.67949 (eight pips);
- explicit 0.01-lot maximum for this monitored DEMO trial.

The persisted trade intent was **REJECTED**, with no broker trade, after
a typed `POSITION_SIZE_BELOW_MINIMUM` during allocation. Two entirely
independent bugs turned this into a no-trade deadlock.

### Bug A: minimum-lot fee-aware position sizing always collapsed to zero

In `PositionSizingService`, the Pepperstone-specific cost envelope
set its ceiling to the **gross stop risk of the already-capped trade**:
`originalLots * riskPerLot`. It then divided that fixed gross amount
by `riskPerLot + two observed spreads + real historical commission`,
rounding DOWN to the broker's 0.01-lot volume step.

For an already capped **0.01-lot** trade with any non-zero spread or
commission, the ratio was necessarily below 0.01 and stepped down to
**zero**. This held even when the real configured account risk budget
could comfortably cover the all-in minimum-lot risk.

**Correction:** ONLY when an owner-verified Pepperstone focused DEMO
trade has already been reduced to the broker's exact minimum lot, use
the **lower of the existing drawdown-adjusted permitted risk amount
and durable risk-profile ceiling** as the cost-inclusive limit. Do
not raise requested volume, risk %, equity, free margin or trade SL.
Keep the original more conservative nominal-envelope behavior for
every larger-than-minimum trade, all LIVE accounts, and other brokers.

The existing broker margin check, leverage cap, stop geometry, account
risk service and conservative down-step sizing are unchanged. When
the actual cost-inclusive permitted budget cannot buy even the
broker minimum, the result is STILL `POSITION_SIZE_BELOW_MINIMUM`.

A reproducible unit test executes the REAL sizing engine for a
0.01-lot AUDUSD stop on a $40,000 DEMO, with an already configured
0.25% per-trade risk bound. Before this fix, it rounded down to
zero. With the fix, its permitted all-in risk is below $100 and the
lot size remains **exactly 0.01**, not higher. Another test confirms
a small-capital account still rejects unaffordable all-in minimum risk.

### Bug B: failed unfilled intent started 90-minute cooldown

In `M1TacticalEvidenceService.hasRecentM1QualifiedContinuationCanary`,
any prior `BROKER_NATIVE` authorized decision with the canary marker
was treated as a reserved 90-minute slot, regardless of outcome.

That original **19:33 UTC** decision was `EXECUTION_FAILED`, the
linked intent was `REJECTED`, and `trade_id IS NULL`. The earlier
logic nevertheless blocked qualified AUDUSD SELL at **19:38, 19:39,
19:46 UTC** with `M1_DEMO_QUALIFIED_CONTINUATION_CANARY_REPEAT_COOLDOWN`.

**Correction:** Exclude ONLY decisions whose outcome is
`EXECUTION_FAILED` AND whose EXACT owner/broker-linked trade intent
is definitively `REJECTED` with `trade_id IS NULL`. Pending,
successful, timed-out with uncertain broker outcomes and any
unreconciled intent **continue to reserve the cooldown**, to avoid
duplicate orders. No manual release or data rewrite was necessary.
Read-only SQL against the real Pepperstone DEMO records confirmed
the corrected cooldown reservation is **false** after the unfilled
19:33 attempt.

## Safety guarantees and acceptance criteria

- No orders manually forced. No historical outcomes, broker fills,
  spreads or account balances fabricated.
- No LIVE scope affected. No risk or stop-loss ceilings relaxed.
- Execution must still pass real as-of M1 route quality, broker
  spreads, session market-hours, news event risk, M1 DEMO profitability,
  account risk, position allocation and broker margin.
- For this route the one-per-90-minute limiter remains after the first
  *actual* accepted trade or an unreconciled intent.
- Regression coverage: minimum-lot budget accepts when truly affordable,
  rejects when not, and unchanged larger-lot Pepperstone fee reserve;
  reject-only canary cooldown query contract.
- Do not mark incident fixed until a future independently qualified
  order is accepted by the real connected DEMO broker and reflected
  in `trading.trades`. A passing test or a `BROKER_NATIVE` decision is
  not sufficient.
