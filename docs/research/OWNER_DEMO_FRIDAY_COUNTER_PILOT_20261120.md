# iRexPro — owner Friday independent counter-direction DEMO window (2026-11-20)

**User question:** Independent expert says SELL when Plan B says BUY. Why not independently consider SELL instead?

## Live diagnosis and genuine defect

At 20:58:17.906 UTC on owner Pepperstone cTrader USD DEMO, EURUSD BUY Confirmed Reversal passed Plan B (7/7, estimated +0.168649 R) but M1 ABSTAIN and trained expert was SELL with three opposing bearish votes, state **ABSTAIN** and **not independently admitted**. Independently scored EURUSD SELL was TREND_CONTINUATION, Plan-B not admitted, estimated net **−0.206033 R**, drift **STRESSED**; no SELL order would have satisfied positive expectancy or own-side reversal/early-transition requirements.

The user-enabled dedicated counter-direction pilot (`IREXPRO_PEPPERSTONE_DEMO_COUNTER_PILOT=enabled`) was hard-expired **2026-11-17T00:00Z**, an actual availability defect. It was distinct from the continuously enabled same-direction `IREXPRO_PEPPERSTONE_DEMO_CONTINUOUS_ALTERNATES`. This meant even a later *independently valid* counter-direction entry could not qualify on the existing trial route.

## Owner-only Friday pilot revision

Only `apps/api/src/modules/ai/pepperstone-demo-counter-pilot.ts` constants changed, without changing its evaluator algorithm or scheduler architecture:

- Artifact `pepperstone-demo-independent-counter-entry-friday-v2` distinguishes this experimental cohort from the expired Monday window.
- Active period **2026-11-20 21:12 UTC through 22:00 UTC**, aligned with ordinary Friday spot forex close; the exact broker may close individual pairs earlier. It will not continue trading under this trial into Monday.
- At most **2 eligible counter-direction entries** in this new window, preserving the existing **4.00-lot maximum**, but the account's preexisting **0.25% allocated-capital stop risk** ceiling and all portfolio, margin, execution spread, broker, session, and stop/target validation rules remain mandatory. This is a maximum not an instruction to trade 4 lots.
- The counter proposal requires its **own** freshly evaluated Plan-B **CONFIRMED_REVERSAL or EARLY_TRANSITION** route, independent paper admission, positive **>=0.12R** after baseline cost, strict direction/score, normal drift, own M1 quality, own valid stop-loss and target, and exact owner Pepperstone DEMO connection. An opposing original reversal/transition must independently have been admitted, and the own-side native trained expert must show **CONFIRM** (not just 3 raw direction votes), admitted true, >=0.65 confidence, >=0.60 opportunity probability and <=180 seconds freshness.
- No forced inverse, no continuation promotion, no AI stop change, no counter trade on LIVE, no suppression of loss/risk checks, no automatic order purely because the independent expert is opposed.
- **The concrete EURUSD SELL of 20:58 still fails.** The patch only restores the availability of the existing strict pilot for *future independently validated* counter entries.

Nine targeted Jest tests passed at ~21:15 UTC, covering positive own-side paths, expiration/start/staleness, exact account, expert ABSTAIN, negative expectancy, stop/target, risk cap, symmetric BUY/SELL. Independently transpiled staged module uses matching runtime exports, no evaluator-body changes byte-for-byte when comments are removed, new constants and artifact validated, old compiled module kept until flat-only release.

## Verified deployment and first forward decisions

On **2026-11-20 21:19:41 UTC**, deployed the counter-only compiled module with an exact owner Pepperstone USD DEMO **flat-only guard** checked at 21:19:22 and again at 21:19:25, backed up both prior .js/.map files to `/home/lightworld/webapps/irexpro-research/deploy-backups/owner-friday-counter-20261120T211922Z`. Only `irexpro-api-staging` restarted, PID **2797464 -> 2862101**. Profit protection PID **2452772** and weak-reversal scorecard PID **2742168** were unchanged. The API configuration file SHA256 was unchanged, all preexisting account risk features remained enabled, and public API health returned **HTTP 200**. Stage validation confirmed the compiled `evaluateCounterPilot` function body was **identical** to the previous deployed function when compilation removed source comments; only the trial constants and artifact changed.

Post-deploy causal database inspection at **21:21:09 UTC**, exact owner/broker/account scoped, read **10 new decisions**, all with `governance.counterPilot.artifact=pepperstone-demo-independent-counter-entry-friday-v2`, zero `OUTSIDE_WINDOW`, and all 10 with `NO_OPPOSING_ADMITTED_REVERSAL`. **0 independently eligible counter orders, 0 new authorized orders, 0 forced inversions.** Scanner decision freshness continued at 21:21:01 UTC. Independent exact owner DEMO flat check succeeded again at **21:21:10 UTC**, API HTTP 200, critical background profit-protection PID unchanged.

**Status:** The counter route is now ACTIVE and available for future strictly qualified opposite-side demo entries through 22:00 UTC. This removes the stale expiry gating but does not claim any currently eligible SELL/BUY, broker fill, or demonstrated profitability. It is a finite pre-weekend demo test and automatically expires at market-close cutoff, not a permanent change or live-money promotion.
