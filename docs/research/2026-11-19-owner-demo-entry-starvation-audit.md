# iRexPro — verified owner DEMO entry starvation, November 19, 2026

## Verified connected VPS, 21:09–21:21 UTC

- API health HTTP 200, PM2 online; scanner continues to persist completed-bar M1 decisions.
- Explicit Trend Continuation pause not enabled in apps/api/.env; guarded
  pullback and owner DEMO advisory-only historical loss pauses are enabled.
  A saved per-candidate `demoContinuationPause.enabled=false` is NOT on its own
  adequate proof of this configuration, because the check runs only after
  earlier candidate qualification.
- 21:21 UTC 60-minute owner Pepperstone USD DEMO read-only report:
  464 recorded M1 directional assessments, 358 tactical ABSTAIN,
  106 non-ABSTAIN, zero BROKER_NATIVE authorizations and zero new broker
  orders. 105/106 non-ABSTAIN decisions had overlapping `PLAN_B_NOT_ADMITTED`,
  `ENSEMBLE_NOT_PAPER_ADMITTED` and `ENSEMBLE_NOT_PROMOTABLE_ADMISSION`
  causes. 55 were OOD and 28 STRESSED; 27 also failed early-transition
  pair/side reliability. ZERO pause/probation vetoes in these 106.
- Last observed owner USD DEMO broker order: 19:33 UTC USDCAD SELL, closed
  19:38 UTC, net after commission and swap −$29.89.
- Across a separate rolling two-hour view, the trained expert ABSTAINed
  on all 183 M1 non-ABSTAIN candidates sampled. Event risk was CLEAR and
  robust broker-observed spread evidence available on all 183. Plan B
  reversal and early-transition admissions are therefore rare and not merely
  being stopped by order plumbing.
- For those 183 the highest overlapping Plan B rejection reasons were
  META_EXPECTED_VALUE (129), EXPECTED_R (127), DIRECTION_QUALITY (100);
  median gross forecast was −0.047R, 90th percentile +0.237R, median
  direction quality 0.530. These forecast distributions are NOT broker fills.

## Misleading blocker presentation corrected

The 19:33 USD/CAD SELL was legitimately admitted by the separately
owner-verified `DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE` alternate despite
the tactical route ABSTAINing. Its recorded decision still displayed the
`MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED` PRIMARY-route blocker, even though
that PRIMARY path was not the effective route used. Such contradictory
telemetry can make an authorized fill appear blocked.

The scheduler now suppresses superseded primary-authority blockers from
the *active* decision-blocker list for an independently admitted DEMO
alternate; it retains the complete original primary decision in
`multimodelAuthority` and `primaryPlanBBlockersSupersededByDemoAlternate`
for review. This changes only decision status/reporting, **not**
`canExecute`, broker order submission, admission tests, stops, position
sizing, money-at-risk, account switching or LIVE permissions.

Added `apps/api/scripts/audit-owner-demo-entry-starvation.cjs` (owner-only,
READ ONLY). It counts all BROKER_NATIVE decisions, **including** alternate
authority when M1 itself ABSTAINed, and does not infer the current VPS flag
from conditionally executed pause checks. Live 60-minute run passed;
nine CLI tests and the targeted scheduler regression passed.

## Priority next

Do not remove all drift and model admission gates to obtain more losing
trades. Investigate prospectively calibrated Plan B meta probability,
directional quality, previously losing Confirmed Reversal fills, and
broker-native expert admission. Validate candidate model improvement
against distinct later trading days with after-cost fills and broker-native
quotes, and only then select any DEMO policy experiment. LIVE remains out
of scope until independently profitable evidence exists.
