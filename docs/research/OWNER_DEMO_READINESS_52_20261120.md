# Owner Pepperstone DEMO — trading readiness at 52/100 (2026-11-20)

## User-reported symptom

Around 20:15–20:25 UTC, the trading cockpit's gauge remained around **52/100** and no new trade was opening. Distinguish a point-in-time **model-quality score** from an execution progress bar or an indication that a submitted order is being held.

## Verified live state

At 20:18:59 UTC, an exact-owner/exact-connected-broker read-only scan of `trading.m1_tactical_decisions` showed:

- The user-owned Pepperstone cTrader account was **USD DEMO**, broker `CONNECTED`, trading session `ACTIVE` with `FULL_AUTO` execution mode.
- Latest decisions were being written within the current minute. **40 actual model decisions over 5 minutes**, **80 over 10 minutes**; 40/40 and 80/80 had `execution_authority=NONE`; **32/40** five-minute candidates had M1 `ABSTAIN`.
- These decisions were across AUDUSD, EURUSD, USDCAD and USDJPY (BUY/SELL sides), not a frozen or crashed scanner. The newest examples repeatedly contained `MULTIMODEL_PLAN_B_NOT_ADMITTED`, `MULTIMODEL_GOVERNANCE_BLOCKED`, `ENSEMBLE_NOT_PAPER_ADMITTED`, `ENSEMBLE_NOT_PROMOTABLE_ADMISSION`, `MULTIMODEL_CONTINUATION_TIMING_NOT_READY`, and several `DRIFT_OUT_OF_DISTRIBUTION` blockers.
- The independent pre-existing read-only `irexpro-owner-demo-entry-blockade-watch` as of 20:15 showed **181 repeated model checks** since the last closed trade, **0 eligible alternative entries**, **0 new broker intents**, and **0 effective portfolio-brake vetoes**. At 20:25:55 the report remained on an active scanner with zero new intents and eligible alternates.
- Broker-native execution-spread evidence was present and execution spread was valid on inspected decisions; today's absence of new trades is primarily model admission and M1 entry confirmation, **not** a disconnected broker or newly activated fee-confluence research veto. The latter is explicitly shadow-only and only evaluates already-admitted Confirmed Reversal candidates.
- The current Plan B regime for many scanned signals is `TREND_WEAK`, with route `TREND_CONTINUATION`, `paperAdmitted=false`, `consensusPassed=4` vs required 6, and lower/negative baseline after-cost expected R. A current USDJPY SELL example had `ensembleScore=0.52435` and `sessionQuality=0.52`. Reversal and Early Transition require genuine, independent momentum/structure/regime conditions before being nominated; they cannot be fabricated by forcing a 100% gauge.
- `plan-b-multimodel-shadow.ts::sessionQuality()` deliberately gives a fixed **0.52** component outside 07:00–20:00 UTC, compared with 0.72 between 16:00–20:00 and 0.90 between 07:00–16:00 (special NY rollover exception). This is one weighted context component of the Plan B model, not a trading process's completion counter and **not by itself** a hard execution veto (threshold is 0.5). The trade meter uses `primaryConfidence=multimodelEnsemble.ensembleScore` from the latest persisted tactical decision and shows `round(score*100)`, subject to blocked-readiness caps. Thus an apparent 52-point plateau can recur while the scanner keeps processing candidate decisions.

## UX correction, without changing actual strategy authority

In `apps/web/src/app/trade/page.tsx`, the gauge previously used `FORMING` for an unapproved 52-point setup, inviting a mistaken reading that progress should reach 100% and then submit a trade. Changed the badge to `ENTRY NOT QUALIFIED`, added a clearly visible and accessible score-caption stating that e.g. `52/100 is a model score, not 52% of a trade completed`, and updated the meter's screen-reader text accordingly. The score still comes strictly from live backend evidence; the moving teal scan needle remains **visual activity only**. Existing last-hour real authorization/Plan B admission funnel and dominant gate details remain visible. No refresh animation now grants execution.

Pure helper `explainTradeReadinessScore` validates/clamps display scores and never changes authorization. Three new regression tests cover a steady 52, a ready score which does not guarantee a broker fill, and invalid values; all **63 tests** in `vps-scanner-status.spec.ts` passed. Full web TypeScript `tsc --noEmit` passed.

**No code was changed in the backend entry qualification, model probabilities, portfolio risk checks, broker margin, lot sizing, Start/Stop trading, fee research or original profit protection.** Given the after-cost losing portfolio observed today (post-17:37 capped Confirmed Reversal 1 winner / 4 losers, net -$496.76), forcing currently unqualified trades is unjustified.

## Safe web release

Frontend-only. Prepare an isolated Next.js build using `IREXPRO_WEB_RELEASE_BUILD_DIR=.next.readiness52-20261120` and the default `.next` output for the currently running server. The optional `next.config.mjs::distDir` override enables isolation. Validate the staged build including BUILD_ID and trade route compiled code before touching `.next`. Back up the previous build, swap only the web output, restart only `irexpro-web-staging`, validate public /trade response and unchanged API/profit protection process IDs, roll back if web fails. Do not confuse building and pushing code with deployed UI.
