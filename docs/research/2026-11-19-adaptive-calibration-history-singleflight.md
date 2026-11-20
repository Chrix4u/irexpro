# iRexPro — scoped adaptive calibration history query sharing

## Evidence

At 19:07 UTC on November 19, several owner DEMO PostgreSQL worker
queries were taking 28–77 seconds and using parallel workers/physical disk
reads on the heavily loaded VPS. One expensive query originated in
`adaptive-prediction-calibration.service.ts`, fetching up to 4,000
historical ensemble outcomes for **every** candidate calibration request.

## Change

A bounded five-second settled/in-flight history cache allows different
instruments, BUY/SELL directions, strategies and confidence values to
share the exact **read-only historical rows** when, and only when,
the owner, broker connection, set of model versions, model outcome
version and exact evaluated-at cutoff match.

The query itself and evidence filters are unchanged. Each candidate
is still calibrated separately with its own instrument, route,
direction, regime, input confidence and expected net R. No prediction,
broker authority, safety blocker, loss-control state or order action
is cached. A request that fails is evicted and returns the previously
existing unavailable-evidence result. Separate accounts, policy
versions and cutoffs cannot reuse rows. Active queries remain shared
even when they take longer than five seconds, and the settled cache
limits memory use.

This reduces duplicate *database scans*, but does not fix a missing
PostgreSQL index or prove better after-fee trading performance. A
future index review must be planned around shared VPS load; do not
run large online index builds while the server is saturated.

## Verification

Test independent directional outcomes using one in-flight query,
cross-account/version/time isolation, and failure eviction. Build
and deploy the API with no LIVE policy change. Observe database
load, model response latency and after-fee DEMO results before
claiming any performance improvement.
