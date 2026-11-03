# iRexPro — z.ai DEMO implementation batch 01
Date: 2026-11-03. Base: main ae90fb4f. Scope: model productivity and cTrader DEMO operations.

## Read-only operational diagnosis
- cTrader DEMO connection: CONNECTED/VERIFIED, active FULL_AUTO EUR session.
- Last executed DEMO trade closed at 2026-11-03 02:05:29 UTC; no further executed entries at audit time.
- Live broker spot quotes for all six majors were fresh, generally under 10s old.
- 240 M1 decisions in latest 20 minutes, 0 BROKER_NATIVE authorized and 0 fills.
- Co-occurring blockers: Plan-B admission, drift, net predicted return, M1 timing.
- Increasing trade frequency without qualifying a model risks repeating the negative-after-cost trade cohorts.

## Changes implemented
- P4: New primary blocker-cause attribution persisted on DEMO decisions; authenticated status and UI explanations distinguish costs, model admission, drift, timing and account risk. Original vetoes remain intact.
- P2: DEMO per-decision report-only M5 ATR14 / broker-observed-P90 cost-break-even stop proposals with a 0.10R cost target. No executable SL/TP changes.
- P3: DEMO telemetry records candidate, Plan-B and expert scores separately; not relabeled as calibrated win probabilities.
- P8: Economics-first offline research gate requires complete independent evidence, DSR/PBO, holdout, cost stress and DEMO A/B, and can NEVER grant LIVE authorization.
- P9: cTrader history collector stores last successful persistence and failure counters by pair/timeframe and retries failed context once without blocking independent live quotes.
- P5: Model drift root cause observable; the fail-closed OOD veto remains unchanged.

## Not yet executable
- P1: Route-specific partial exits / trailing are research-only; previous 76-trade selected-winners replay cannot justify broker orders.
- P2: Changed risk geometry is not executed until original-risk sizing and complete P&L replay qualify.
- P3: No new calibrated predictor promoted.
- P5: No permission to enter on out-of-distribution signals without positive out-of-sample economics.
- P6: No trained, purged-test-positive meta-label filter.
- P7: Existing weak early-transition qualification still holds.
- P10: trailingStopPips field remains historical, NOT an enforced cTrader trailing-stop promise. Explicit trailing + TIME_TO_WORK close taxonomy not implemented.

## Tests and release posture
- Targeted API, web and collector Jest tests pass; compile check passed before latest API additions.
- Five Python economics gate assertion tests pass; pytest is unavailable on server.
- All order risk, exposure, mandatory stop, final dispatch boundary and LIVE authority remain unchanged.
- This is an honest first batch, NOT a claim that all z.ai proposals have been executed or that DEMO orders are now firing.

## Next DEMO A/B boundary
Before an executable revised model is enabled: train and validate the economic edge, full entry-to-exit all-trade replay with real broker costs, independent policy version and risk-bounded DEMO A/B cohort, explicit rollback, full CI. Do not lower confidence/expectancy thresholds simply to cause trades.
