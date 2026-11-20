# iRexPro — owner DEMO drift forensic: first live read-only result

Run November 19, 2026, approximately 21:25 UTC. Pepperstone cTrader
USD DEMO only. This is a **one-day retrospective quote experiment**,
not a tradable strategy test, executed broker P&L or live recommendation.

- 1,942 M1 directional decision rows sampled, 331 de-duplicated
  20-minute directional episodes, covering parts of two UTC market days.
- Ordinary 15-minute M1 candle-shadow outcomes: only 64/331 episodes
  yielded complete valid labels. Their combined **estimated**
  after-spread return was −12.73R, mean −0.1989R, estimated profit factor
  0.5515. Missing labels were not counted as wins or losses.
- OOD Trend Continuation: 245 selected episodes, 52 valid shadow
  outcomes, mean **−0.2299R**, estimated profit factor 0.511.
- NORMAL Trend Continuation: 38 episodes, only 9 labeled, mean
  +0.0256R. This tiny and selectively labeled group is not comparable
  with OOD as though the samples were randomized.
- The same-instrument/side/route/day comparison had **ZERO** strata
  with at least two complete labels for both normal and OOD conditions.
  Normal matched-group label coverage 24.32%, OOD coverage 21.57%;
  no causal threshold promotion can follow.
- The separately sampled rejected-drift worker had 313 valid
  counterfactual labels, **all 313** with additional nondrift blockers
  and **zero** drift-only blockers. That worker samples one eligible
  rejected event per instrument per fixed UTC 16-minute bucket, which
  is not the ordinary shadow-worker's selection rule.
- Rejected OOD Trend Continuation shadow outcomes by instrument:
  USDJPY n73 mean −0.1495R; USDCAD n72 −0.1133R;
  EURUSD n71 −0.1009R; AUDUSD n70 −0.0240R.
- STRESSED USDCAD had 10 counterfactual labels averaging +0.2153R,
  **not** enough independent evidence and all also had other blockers.

These estimated returns are derived from broker-native M1 candles
and a decision-time P90 spread-cost approximation. They do NOT account
for guaranteed fills, actual commission, slippage, margin, spread
widening at execution, or live stop orders. They cannot establish that
relaxing admission thresholds would improve profit. Existing executed
Confirmed Reversal trades were net negative; retrain or recalibrate
direction and entry using broker-native outcomes and unseen future
market sessions rather than blindly overriding drift or loss evidence.

Research scripts (read-only, no broker actions):
`node apps/api/scripts/audit-owner-demo-drift-outcomes.cjs 1`
from the repository's app/api directory, or
`cd apps/api && node scripts/audit-owner-demo-drift-outcomes.cjs 1`.

No execution policy, stop, risk or LIVE permission change in this study.
