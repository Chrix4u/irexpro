# Owner Pepperstone USD demo — post-close maturity audit (20 November 2026)

## Purpose
Measure whether an **original, pre-entry TP or SL** appeared first in broker-native
sampled bid/ask quotes after a real exit, by a fixed **5-, 15-, 30- or 60-minute**
horizon. This research corrects the misleading practice of counting a price
touch later in the day as proof the exit was too early.

## Implementation
- `apps/api/scripts/audit-owner-demo-20261120-0430-tp-first.cjs` refreshes
  the owner-only broker trade + validated quote-path source.
- `apps/api/scripts/audit-owner-demo-postclose-maturity.cjs` produces
  `/home/lightworld/webapps/irexpro-research/exit-payoff/latest-postclose-maturity.json`.
- Run `node --test apps/api/scripts/audit-owner-demo-postclose-maturity.test.cjs`
  from the repository root to validate conservative classification.
- Each horizon excludes trades not yet old enough to be judged (right-censored),
  missing/incomplete quote paths, and still-open trades. Entry and settlement
  timestamps divide protected closes before/after the 09:28:43 UTC protection
  rollout; positions spanning the change are excluded from both cohorts.
- All outputs are **read-only**. There are no broker orders, SQL writes,
  position amendments, model promotions, risk-gate changes or lot-size changes.

## Initial as-of 10:49:12 UTC snapshot
For the 24 protected closed trades, the 30-minute horizon had 17 mature
and evaluable paths: **9 original TP first**, **2 original SL first**,
**6 neither**. Another 2 had not reached 30 minutes and 5 had incomplete
coverage. After activation, only **3** protected exits were fully evaluable
at 30 minutes (2 TP, 1 SL), too few for a performance conclusion.

EURUSD quote-path coverage was incomplete in this snapshot. Do not read
the missing target hits as proof of correct or incorrect exit timing.

## Interpretation and qualification
- All TP/SL touches are **sampled hypothetical post-close price paths**, NOT
  actual executable broker fills or a cost-inclusive alternative trade outcome.
- The original intent TP/SL can diverge from subsequently amended broker levels.
- A later target may be preceded by broker-side stop triggers, adverse
  excursion, rising margin requirements or an unavailable quote.
- Compare actual settled net, adverse excursions, profit-lock capture, risk
  normalized results and market day for any future alternative-exit policy.
- A single-day snapshot, even with better capture, does not justify changing
  live accounts, increasing lot sizes, or enabling stop amendments.
