# iRexPro — narrowly restore independently qualified DEMO M1 continuation
**12 November 2026 | Owner-verified Pepperstone cTrader DEMO only**

## Specific rejected signals actually found

Repeated user observation: from roughly 13:00 to 01:00 Ghana time, no
new trades despite active scanning. Plan B and M1 often disagree.
The 13:00 classifier switch and the old Plan B hour-harmonic bias
contribute, but they are NOT the only or entire cause.

On 12 November between 17:45 and 19:13 UTC, the active DEMO
decision ledger contained **21 AUDUSD SELL** evaluations satisfying
all of the following:
- route: M1_TREND_CONTINUATION, independently eligible fallback
  tier `QUALIFIED_CONTINUATION`
- same pair/side/policy actual closed records: **7 trades, 5 wins,
  2 losses**, average realized R **+0.3943**, recent realized R
  **+0.78**, reliability `POSITIVE_EXPECTANCY`
- Additional mandatory real after-commission evidence: seven completed
  AUDUSD SELL broker trades returned **five NET wins and two NET
  losses**, combined **+$322 USD after $120 commission** (gross
  +$442). Risk-normalized NET total **+1.92R**, average **+0.274R**,
  latest three **+0.42R**.
- `blockers` had *exactly one* value:
  `M1_DEMO_PRIMARY_ONLY_ROUTE_PROBATION`.

The temporary primary-only configuration was set after unrelated
fallbacks generated losses. It barred even independently qualified
mature M1 continuation, despite 0.20 lot size cap and no other
recorded execution veto. This is a concrete probation-policy deadlock,
not simply an M1 confidence threshold or broker disconnection.

## Exact corrective policy

- **Do not** globally disable Plan B, session risk, primary-only
  probation, model drift, news checks, margin, stop-loss protection,
  drawdown, profit protection, risk suspension or LIVE restrictions.
- Preserve probation for BOOSTRAP_CONTINUATION, M5 handoff,
  transitions, extension scouting, high-conviction rescue, other
  fallback paths, and ALL unqualified M1 continuation routes.
- Allow only the **QUALIFIED_CONTINUATION** path to pass the extra
  probation veto when its *real exact pair/side closed trade history*
  is `POSITIVE_EXPECTANCY`, >=7 samples, >=5 wins, average and
  most-recent realized R both positive.
- Independently read the 7 most recent completed distinct broker-native
  trades of that exact owner, broker, pair, side, route and M1 policy.
  Require all seven have actual commission, swap and initial-risk
  evidence; **NET** wins >=5, NET average R >0 and latest three NET R
  positive. Missing fees/risk evidence deny the exception.
- Independently verify from DB the exact owner-bound connected
  Pepperstone cTrader account is DEMO and its FULL_AUTO session
  is ACTIVE. A rollout phase named DEMO is not enough.
- Deny the exception in the actual 17:00–18:00 New York rollover
  hour, including daylight saving changes.
- Cap trial signals at **0.01 lot**. This is a MAX, not a requested
  minimum; broker-supported minimum, margin, account funds and
  permitted risk may reduce or deny the signal.
- No more than one exact owner/broker/pair/side canary
  authorization per **90 minutes**; use durable, read-only
  broker-native decision history. If query is unavailable, BLOCK.
- Continue the normal preexisting client session, candidate event
  risk, broker spread, max risk, account-profit brakes, fast-stop,
  opposite-position, duplicate-intent, SL, broker fee and allocation
  constraints. No artificial trades, no live account changes.
- Store explicit `qualifiedContinuationCanary`, exact policy
  exception reason, capped lot and repeat/history flags in decision
  governance so the operator can see why a trade was or was not sent.

## Verification

- Qualified continuation probation unit tests ensure only truly
  verified DEMO positive mature sleeve qualifies, while unknown
  owner, LIVE, rollover, early/negative and scout routes still block.
- Exact-owner broker session and 90-minute durable canary SQL
  contract tests.
- Integration tests exercise 0.01 broker signal, duplicate
  suppression, identity fail-closed and history fail-closed.
- No existing positions altered. Actual trade completion must be
  checked in `trading.trades` after deployment. Successful tests
  do not count as new broker trades.

## Further model work

This policy correction specifically fixes the unnecessary **second
veto** on already-qualified M1 continuation; it does not claim
Plan B's hour weights are profitable if removed. The latter model
must be recalibrated on time-ordered broker-fill and positive
bid/ask evidence; earlier clock-rescue cohorts did not show an
independently qualified positive expectancy.
