# Expert-Opposite Challenger — independent opposite side qualification

**Date:** 16 November 2026. **Trial:** 20:00–21:00 Africa/Accra (UTC).
**Classification:** Completed owner-scoped forensic research; NOT an order-execution release.

## The requirement

If an accepted Plan-B BUY reversal is opposed by the trained broker-native expert
voting SELL, assess whether the independently generated SELL hypothesis
qualifies for its own real trading entry. Do not automatically invert
BUY orders, inherit the BUY stops/targets or override the explicitly paused
trend-continuation strategy.

## Implemented

The new program `apps/api/scripts/audit-pepperstone-expert-opposite-challenger.cjs`
reads matching BUY/SELL decisions for the exact owner, active Pepperstone
cTrader **DEMO USD** account, matched instrument and **same M1 bar**.
It uses only information recorded by the original decision time
(with a five-second tolerance for the paired scanner write) and declines
anything missing, postdated or outside the frozen trial window.

Its independent SELL qualifications require ALL of:
- Original plan-B admitted reversal or early transition, expert genuinely
  opposing the source direction
- The expert's **final state = CONFIRM**, admitted=true, three native unanimous
  votes, confidence >=0.65, fresh as-of decision
- Independently scanned *opposite* route must be **CONFIRMED_REVERSAL** or
  **EARLY_TRANSITION**; a SELL classified as paused TREND_CONTINUATION
  cannot enter through the challenger
- Opposite Plan-B paper admission + governance approval and ensemble >=0.60,
  direction quality >=0.54
- Opposite projected net expected R >=0.12 **after costs**, valid current
  broker spread, usable execution costs, CLEAR event risk, and no
  out-of-distribution drift
- Opposite M1 directional quality >=0.55, M1 confidence >=0.67 and
  its own nonzero risk/target with reward greater than risk

Even passing these criteria produces only
`RESEARCH_QUALIFIED_NO_BROKER_AUTHORITY`. A separate, owner-authorized,
timeboxed future DEMO deployment would still require capital, allocation,
margin, existing-position, correlated exposure, daily drawdown, order limit,
execution price, and broker-native final checks. Nothing here bypasses them.

The script writes a private 0600 decision audit to:
`/home/lightworld/webapps/irexpro-research/expert-opposite-challenger/latest-report.json`.
Nine deterministic tests verify independent direction and stop/target
geometry, no time leakage, fixed demo timebox, paused route exclusion,
and read-only scoped SQL.

## What actually happened during the 8–9 PM trial

Final read-only PostgreSQL audit at 21:00:57 UTC:
- Actual trial trade intents: **zero**
- Actual trades opened 20:00–21:00: **zero**
- Current open positions: **zero**
- Three fresh final reversal decision records carried
  `M1_QUALITY_NOT_QUALIFIED`.
- The 8 PM expert-opposed candidate audit found **four** accepted BUY
  reversal decisions whose trained expert directional vote was SELL,
  on USDJPY 20:08 and USDCAD 20:16, 20:29, 20:32.
- In **all four**, the expert's FINAL state was **ABSTAIN** despite
  3 SELL votes, with estimated opportunity probabilities
  0.2586, 0.1703, 0.1532 and 0.1771.
- In **all four**, the actual scanned SELL hypothesis remained
  `TREND_CONTINUATION`, was *not admitted*, and predicted
  negative cost-adjusted R of -0.153, -0.120, -0.131, -0.083.
- Thus none qualifies as an independently accepted opposite-direction
  order. Nothing was overlooked: votes are not executable recommendations.

## What comes next

The user's central business problem is **not only gate strictness**.
All of the initial follow-up research failed to uncover an actual
positive-expectancy independently justified SELL order. We should test
a genuine expert-counter directional model on unseen demo quotes with
independent risk/target and risk-adjusted profitability; do not label
a negative-continuation SELL as a confirmed reversal merely to force
trade count. Only after a prospective after-cost edge and credible
risk controls should a new expressly timeboxed DEMO pilot be enabled.
No live orders, no backdated orders and no extension of the 21:00 cutoff.
