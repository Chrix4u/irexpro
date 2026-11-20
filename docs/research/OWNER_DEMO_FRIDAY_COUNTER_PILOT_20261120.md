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
