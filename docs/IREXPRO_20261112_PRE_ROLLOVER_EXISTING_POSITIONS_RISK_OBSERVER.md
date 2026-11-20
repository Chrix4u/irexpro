# iRexPro — Pepperstone DEMO pre-rollover open-position exposure observer
**12 November 2026 | Read-only risk telemetry | No trade authority**

## Source incident

At **21:15:19 UTC** on 12 November, the M1 QUALIFIED_CONTINUATION
fallback opened AUDUSD SELL at **0.68053**, 0.01 lot, stop **0.68101**
(4.8 pips) and target **0.67971**. It was held until New York
17:00 EST (22:00 UTC), when liquidity changed sharply.

The exact owner-bound Pepperstone broker quote recorder showed at
21:58:56 bid 0.68088 / ask 0.68091 (**0.3 pip spread**).
At 22:01:21 it showed bid 0.68016 / ask 0.68143
(**12.7 pip spread**). cTrader had closed the SELL at ask 0.68143,
**4.2 pips worse** than the planned stop; the recorded net loss was
**$0.99** (gross -$0.90, paid commission -$0.06, swap -$0.03).
Broker close reason was `BROKER_CLOSE`: do not claim independent
proof of the provider's intrasecond stop-trigger mechanism.

Read-only historical account audit showed only **one position
carried through 17:00 New York rollover** in the recorded
November sample for the current Pepperstone account. Consequently,
a live rule to forcibly flatten ALL primary Plan B positions at
rollover is **not justified**. It could prematurely end profitable
continuations and would contradict the user's requirement not to
suppress otherwise qualified trades.

## Implemented, SHADOW_ONLY

New pure, unit-tested decision module:
`apps/api/src/modules/execution/reconciliation/pepperstone-rollover-exposure-shadow.ts`

The existing cTrader DEMO live profit-protection loop now observes
only owner-bound Pepperstone DEMO positions in the **final ten
minutes before 17:00 America/New_York**:

- November EST: 21:50–21:59 UTC; July EDT: 20:50–20:59 UTC.
- Uses the broker's exact connection, pair and
  `source='ctrader-broker-native'` bid/ask marks; never chart mid,
  cross-account samples, future quotes, or stale quote older than 45s.
- Bounded quote lookup by actual M1 bucket time to avoid expensive
  history scans on the overloaded VPS.
- Requires same instrument/side/lots for the provider OPEN position
  and the stored trade; verifies its broker stop matches the
  authoritative stop within 0.15 pip; valid initial risk evidence.
- For a SELL, measures distance from the ASK to stop; for BUY, from
  BID to stop, with correct JPY pip scaling.
- Flags a research `WOULD_REDUCE_ROLLOVER_RISK` when existing
  spread itself is wider than the remaining stop distance during
  an adverse position OR the position is at least -0.25R and within
  the larger of 2 pips or 35% of its original protective-stop distance.
- Records one audit per trade/UTC rollover day when this condition
  first arises. Failing audit/query does not affect execution.
- Runs asynchronously relative to existing profit protection exits:
  audit service cannot slow a broker close.
- **No automatic exits, broker orders, stop amendments, lot changes,
  primary Plan B admission changes, or LIVE access.** Explicit
  `noBrokerTradeAuthority:true`,
  `modifiesOpenPositions:false`, and
  `requiresProspectiveOutcomesBeforePromotion:true` in audit.

The prior fixes remain deployed:
- Independent M1 canary must have seven REAL closes from its own
  `QUALIFIED_CONTINUATION` execution authority, not borrowed
  2–4-lot `PRIMARY_PLAN_B` fills.
- Independent M1 canary cannot open in the hour before NY rollover.
- Primary Plan B 2–4-lot risk sizing capability is unchanged.

## Verification and next gate

- 15 unit tests specifically for NY DST timing, real stop buffer,
  BUY/SELL executable quote side, JPY pip precision, stale quote,
  provider identity, and no broker authority.
- Full cTrader DEMO profit-protection + rollover observer regression:
  **81 tests / 2 suites passed**, including integration check that
  risk is audited without any `ExecutionService.closeTrade`.
- Validate build and PM2 API reload separately; do not mark
  broker deployment successful until verified.
- Collect prospective flagged vs unflagged outcomes in at least
  several rollover sessions, with actual quote spread and net
  provider fills. Only then evaluate a narrow, reversible DEMO
  close policy against the currently observed opportunity cost.

This safety observer intentionally does **not** increase entry
frequency or guarantee profitable results.
