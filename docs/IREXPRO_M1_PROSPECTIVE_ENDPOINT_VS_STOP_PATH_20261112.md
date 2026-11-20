# iRexPro — independent M1 counterfactual integrity, v2
**12 November 2026 | Pepperstone DEMO | observer-only change**

## Why the M1 research needed a second correction

The independent M1 observer introduced at 17:32 UTC tracks signals
that M1 itself qualifies while Plan B independently rejects. A
previous audit script demanded a valid bid/ask in every M1 minute to
score any 3/5/6/7/10-minute outcome. This discarded valid *directional
price-move* evidence when a middle minute's bid/ask was unavailable.

The alternative—ignoring the missing middle quote and claiming a
stop-loss survived—would be more dangerous. Therefore **two distinct
levels of evidence** are now explicit:

- **Endpoint-only directional mark:** verified positive bid/ask at
  hypothetical entry and exit, net of an estimated 1.1 pip commission
  and slippage reserve. Does **not** establish whether a broker stop
  or take profit was hit between those marks.
- **Fully observed stop path:** positive bid/ask evidence in each
  intervening M1 period. Allows a conservative stop-first OHLC
  approximation and 1.5/2/3-pip early profit exits. Still not
  tick-accurate fills.

BUY first-touch now uses executable BID estimates for both stop and
profit exit, rather than optimistic midpoint highs. SELL continues
to use estimated ASK. Same-bar stop always wins.

## Prospective v2 sample as of ~17:55 UTC

- 5 independently eligible, Plan-B-disagreed scanner observations
  had matured beyond the maximum horizon plus a 2-minute buffer.
- The predefined first-of-15-minute, pair-only sample yielded
  1 independently priced EURUSD SELL episode.
- Three-minute path: 1 fully observed stop-path proxy.
- Five-, six-, seven-, and ten-minute intervals: entry and exit
  quote marks were observed, **but a 17:35 UTC minute did not
  contain any broker-verified positive spread**. For those horizons
  stop survival cannot be claimed.
- Five-minute endpoint-only quote mark was +0.7 theoretical pips,
  seven-minute mark 0.0, and ten-minute mark +0.6, after estimated
  costs. These are **not actual trades or proven realizable returns**.

## Retrospective cross-check

A separate explicitly labeled `--retrospective` replay of
previously collected decisions is not treated as prospective
evidence or DEMO qualification.

- EURUSD five-minute endpoint mark: 6 observations, -17.3 pips;
  6 fully observed stop paths. Frozen one-pip pullback trial:
  5 hypothetical fills, -7.9 pips.
- AUDUSD five-minute endpoint mark: 16 observations, -21.1 pips,
  but only **5** had enough intervening positive-quote evidence
  for stop-path simulation. Of these the frozen pullback trial
  had 3 hypothetical fills, -3.3 pips.
- These small, losing, retrospective cohorts **do not justify
  removing Plan B as an execution gate**.

## Implemented / verified

- `apps/api/scripts/audit-independent-m1-profit-window.cjs` v2:
  immutable first-of-15-minute sampling, as-of eligibility,
  dynamic max-horizon+2 minute maturation, separate direction
  and stop-path evidence, frozen passive-pullback counterfactual,
  deterministic fee reserve, exact broker ownership and account,
  no database writes and no order calls.
- `apps/api/scripts/run-m1-opportunity-audit.sh` rejects reports
  lacking v2 provenance, explicit prospective status,
  explicit `qualifiesForDemoExecution:false`, and the
  data-completeness invariants. Reports remain private 0600.
- The scheduled observer now runs at 06:15–21:45 UTC every 30 minutes
on weekdays, using low process priority, a 90-second timeout, a
single-flight lock and a 12-minute study maturity buffer. It never
submits orders or grants execution authority.
- 18 dedicated Node tests passed, including BUY bid/ask first-touch,
  missing middle quote, pessimistic same-bar stop, passive entry
  failure, maturity gating, and invalid legacy signals.

## Broker-trading status verified at ~17:55 UTC

The FULL_AUTO Pepperstone DEMO session remained ACTIVE. In the last
20 minutes, 40 EURUSD and 40 AUDUSD evaluations, zero execution
approvals, and 2 and 4 independent-M1 research-eligible signals
respectively. Most recent executed position still the AUDUSD SELL
opened 10:09 UTC (closed 10:16); last EURUSD trade closed
10:19 UTC. **Trading has not resumed.**

**Do not interpret a single profitable quote endpoint or duplicate
model-rejection wrapper as proof that blindly lifting all model
restrictions will create a profitable bot.** The leading task is
a genuinely calibrated entry-and-exit policy validated prospectively
on uninterrupted real bid/ask and observed broker fill costs.
