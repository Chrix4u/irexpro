# Show the true Plan-B cause of no DEMO entries — 2026-11-05

## Evidence
The cTrader DEMO engine had an ACTIVE FULL_AUTO session but no new
broker-authorized entries. The market-feed collector recovered from the
21:29–22:00 UTC gap, and M1 decisions were again being recorded.

By ~22:52 UTC (17:52 America/New_York), the 60-minute focused-pair
window had 12 non-ABSTAIN candidates and no broker authorization.
Every candidate carried **REGIME_ROLLOVER_RISK** and
**SESSION_QUALITY**, which were stored inside
`governance.multimodelEnsemble.reasons`, not the top-level `blockers`.

The existing “Why no new trades?” dashboard showed only generic
`ENSEMBLE_NOT_PROMOTABLE_ADMISSION`,
`MULTIMODEL_PLAN_B_NOT_ADMITTED` and `PAPER_NET_EXPECTED_R` because
its SQL counted only top-level blockers. This obscured the specific,
correct reason for much of the current lack of trading.

## Changes

- The existing 60-minute, authenticated **current cTrader DEMO
  session / three focused pairs** aggregate now also returns the
  3 most frequent *underlying* Plan-B model reasons.
- It also includes an explicit count of proposals in the New York
  daily rollover regime. Counts reflect the last 60 minutes, not
  proof that the current market is still in rollover. The
  account, broker connection and trading permission are unchanged.
- SQL deduplicates each reason within a decision before counting it,
  enforces a fixed allowlist and returns no IDs or secrets.
- The existing blocker counts, model admission funnel and broker
  authorized counts are retained. The UI validates the new bounded
  aggregates and reports precise neutral labels.
- In the trading card a separate rollover message and the top
  underlying model reasons follow the existing generic blockers.

## Tests and safety

- API and web shape tests: session missing/invalid fields, allowlisted
  labels, safe maximum candidate bounds, preserved legacy duplicate
  blocker counts and no implication of broker order authorization.
- Read-only SQL tested on the VPS DEMO data: 16 recent proposed
  candidate decisions, all 16 classified as rollover, with no broker
  authorization; 16 each `REGIME_ROLLOVER_RISK` and `SESSION_QUALITY`.
- **Zero execution changes**: no modification to confidence, cost,
  drift, risk, volumes, broker dispatch or model promotion.
