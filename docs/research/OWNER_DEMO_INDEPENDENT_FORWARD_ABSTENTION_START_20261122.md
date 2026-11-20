# iRexPro independent forward abstention evaluation after Friday, 20 November 2026

## Goal and why the existing history is not a sealed test

The owner wants an early warning that a proposed entry looks like previous broker-net losing trades so the strategy can **abstain without sacrificing too many future winners**. Earlier entry patterns for November 18–20 were inspected repeatedly. Consequently any apparently useful Confirmed Reversal M5 contradiction, USDJPY BUY or Early Transition momentum symptom is now **discovery evidence**, not independent validation and not a legitimate reason to turn on a live trading blocker.

The already-running **owner Pepperstone USD DEMO-only research watcher**, launched and activated on November 18, had **seven hypotheses frozen before the November 20 review**. It freezes original pre-entry model features within 90 seconds of true broker opening and later joins actual broker-settled profits/losses and costs. It does not create broker orders or affect the existing 7-lot DEMO permission.

## Implemented untouched forward split

Changed `apps/api/scripts/watch-owner-demo-loss-pattern-shadow.cjs` and tests to add `prospectiveUnseen`. The **fixed future cutoff is Sunday November 22, 2026 at 22:00 UTC/Ghana**, the normal FX reopening period. This excludes every previously reviewed Nov18–20 entry, even if an old position happens to settle after the cutoff. Uses **entry opening time**, NOT settlement time. It never uses future outcomes as entry features, and missing/on-time-unverified entry captures cannot enter the supposedly frozen cohort.

The read-only, auditable `prospectiveUnseen.byOriginalFrozenRouteWarning` produces separate Confirmed Reversal and Early Transition evaluations for each of the seven originally frozen warnings. Each group reports:
- matched broker-settled warned versus unwarned sample counts and distinct entry trading days;
- actual gross P&L, signed commission, swap, after-cost net, after-cost profit factor and normalized pre-fill risk denominator;
- hypothetical **winning USD sacrificed** if skipping warned entries, versus the absolute booked losing USD it would have avoided; this is NOT an executable counterfactual;
- fee reconciliation coverage and missing data; an observed unprofitable group is not assumed to be an actionable profitable veto;
- an intentionally separate status `eligibleForManualStatisticalReview` only after at least **5 distinct independent entry days**, at least **20 fully settled warned** and **30 fully settled unwarned**, at least **3 entry days in each subgroup**, and exact signed-fee coverage on both groups.

These minimum counts are **a review readiness threshold**, not sufficient proof of an edge or permission to execute abstention. Seven warnings are tested, so false discovery/multiple comparisons and market-regime drift must still be considered. Each group stays `executableVetoEligible:false` and `autoEnableVeto:false` permanently; the report has no broker order authority. The overall watcher remains research-only and never promotes a model.

## Verification

At **14:24:45 UTC on November 20**, the running watcher emitted the new forward report, including **14 separate frozen warning × strategy scoreboards**, correctly showing **zero untouched future trades**, no qualified vetoes and an initial `asOfNowBeforeStart:true`. It also preserved broker-net historical data and route-specific frozen economic breakdowns. The restart only touched the research watcher, leaving the running API process untouched; API health was HTTP 200.

**26 Node tests passed**, including two dedicated tests for not leaking November 20 entry outcomes into the untouched cohort just because the exit happened in the future. The new metrics are produced by an existing private read-only watcher under `/home/lightworld/webapps/irexpro-research/loss-pattern-forward/latest-summary.json`, not a new scheduled job or trade-execution process.

## Interpretation and next decisions

The 154 settled on-time forward-enrolled trades in the previously reviewed cohort had **+$461.07 gross**, **-$2,077.20 commission**, **-$1,616.13 broker net**, with 69 gross-negative trades and zero gross-positive trades flipping individually to net-negative only because of fees. The highest priority remains **reducing true losing-entry frequency, improving reward-to-loss ratio, and validating profit retention after costs**, not merely increasing lots or making a blanket rule against opposing M1 momentum.

The existing owner-only 7-lot DEMO request permission and independent risk/stop/margin checks remain as before. No LIVE promotion, direction flipping, stop modification, strategy blocking, or untested production veto occurred in this change.
