# iRexPro — prospective reversal/continuation after-cost outcome monitor
**13 November 2026 | Pepperstone cTrader DEMO, USD | Research only**

## Why it exists
The four executable DEMO focus pairs remain EURUSD, AUDUSD, USDCAD and USDJPY.
The 4 November 2026 primary Plan B source and model bundle are preserved.
Historical M1 reversal/continuation mismatch outcomes were **negative on
aggregate**; this does not justify an immediate broad gateway bypass.

`apps/api/scripts/audit-planb-reversal-continuation-prospective.cjs`
joins the newly frozen decision-time diagnostic
`governance.planBReversalM1ContinuationShadow` to broker-native M1 candles,
the original stop/target geometry, original execution-cost estimate and
**causally earlier** same-account/same-pair paid commission samples.

The audit:
- starts no earlier than **2026-11-13 00:45 UTC** (the frozen hypothesis rollout);
- rejects any rows with changed/missing artifact, wrong pair/side, missing
  shadow-only safety flags or execution authority other than NONE;
- operates on a read-only, owner-bound DEMO broker database snapshot;
- chooses the first observed mismatch in each 30-minute pair/side interval
  **before** seeing outcomes; it never cherry-picks an eligible minute;
- reports eligible and excluded mismatches separately; the excluded cohort
  is observational, **not** a matched randomized control group;
- excludes missing M1 candles, same-bar SL/TP ambiguities, missing as-of
  commission and invalid original execution geometry; reports those reasons;
- returns net-R after the original modeled execution costs plus historical
  commission P90, and stop-first / target-first / 15-minute mark proxies;
- never writes to the database, places a trade, sets a stop, starts/stops an AI
  session, changes a lot, lowers a brake, or promotes a model.

Run read-only:
```bash
cd /home/lightworld/webapps/irexpro-staging/apps/api
node --test scripts/audit-planb-reversal-continuation-prospective.test.cjs
node scripts/audit-planb-reversal-continuation-prospective.cjs
```

Private report (no user IDs or broker account numbers):
`/home/lightworld/webapps/irexpro-research/reversal-continuation-prospective/latest.json`

## Initial audited result
At **2026-11-13 01:10 UTC**, the first prospective window
00:45–01:10 UTC had **zero** persisted reversal/M1-continuation mismatch
rows. A second read-only check of the prior 60 minutes showed **480 scanner
decisions but zero rows containing the new observer field**. That is an
instrumentation/deployment issue, NOT evidence of no opportunities or a
profitable/unprofitable pattern. The API's PM2 start timestamp was
**23:58 UTC on 12 November**, whereas the compiled observer file was
updated at approximately **00:50 UTC on 13 November**. The running Node
process therefore predates that compiled code and may not have loaded it.
The audit now explicitly reports `observerCoverage.state` and refuses to
treat absent instrumentation as usable outcome evidence.

The same read-only check found **one ACTIVE FULL_AUTO AI session and zero
unsettled trades**. The deployment safety policy prohibits restarting or
deploying while the session is active. No restart was attempted, and no
trade admission was changed. Schedule a controlled restart only after
the operator stops the session and confirms no pending/reconciling trades.

The script unit tests passed **6/6**, Node syntax and git whitespace checks
passed. The latest installed strategy remains the primary Plan B strategy,
and the new report itself carries `brokerOrderAuthority='NONE'` and
`autoPromotionAllowed=false`.

## Next evidence requirement
Require at least 60 **independent, evaluable** candidates across 10 UTC
market days before considering the research sample mature; even that is
**not** evidence enough to switch on DEMO execution. Subsequent promotion
would separately need independent holdout days, BID/ASK tick first-touch
verification, net return and drawdown after realistic execution, robustness
across pairs and conditions, and existing portfolio/risk vetoes.

Broker-held open positions or an active automated session must block
staging restarts/deployment; a research-only script does not need a PM2
restart. LIVE is out of scope.
