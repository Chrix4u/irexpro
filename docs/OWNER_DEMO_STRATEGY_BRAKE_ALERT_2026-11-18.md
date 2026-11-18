# DEMO account-owner strategy-loss alerts and bounded recovery

The owner reported that DEMO trading was silent after the last position closed at 16:53:40 UTC on 18 November 2026, despite scanner decisions. The same-account 3-hour scan had three independently eligible alternative strategy signals blocked by `M1_MULTIMODEL_LOSS_STREAK_BRAKE`, without the existing portfolio-wide loss-pause modal triggering.

## What was implemented

- Owner-only authenticated `GET /ai/external/vps-forex/m1-tactical/strategy-loss-alerts`: read exact active Pepperstone cTrader USD DEMO account, group recent selected alternative signals with active strategy brakes by **strategy, instrument, direction and latest broker close incident**, show historical profit factor, payoff sample, persistent-loss state and cooldown. Never expose another user's data.
- Owner-only `POST /ai/external/vps-forex/m1-tactical/strategy-loss-alerts/decision`: explicitly accept **KEEP_PAUSED** or **RESUME_LIMITED** for that exact current broker-verified brake incident, with a required additional-loss acknowledgement for the latter. Append-only audited decisions in `trading.demo_strategy_brake_owner_decisions` (new migration).
- AI Trader page polls the authenticated owner state every 4 seconds independently of chart/position updates; auto-opens a modal for the first unreviewed incident, displays each additional affected pair/side, and leaves a persistent banner with manual re-review controls. The existing portfolio-wide modal takes priority when both need a decision.
- A limited recovery is **not a blanket override**. It expires in **one hour** and can admit at most **one fresh trade intent** for the exact strategy/pair/direction/incident, with at most **1.00 lot**. Counting an intention before broker fill prevents concurrent duplicate submissions and intentionally fails closed for an unsuccessful attempt.
- The broker's original account/session ownership, market data, model Plan-B admission, spread, stop/target, loss portfolio pause, margin, session, and every other pre-existing risk gate remain effective. No LIVE account permissions or automatic reversal were added.
- Consent is checked again at the scanner decision point; missing SQL evidence or mismatched broker/session/incident fails closed. The server, not the client component, determines authority.

## Installation/verification

The owner-decision migration CreateDemoStrategyBrakeOwnerDecisions1795020000000
was **applied and verified on the authorized staging database on 18 November 2026**,
including the recorded public.migrations entry and the new trading table.

**Existing project caveat:** The generic TypeORM migration CLI glob picks up an
unrelated *.spec.ts test file and fails with ReferenceError: describe is not defined.
For this deployment, a temporary TypeORM DataSource loaded **only the named migration**
and called runMigrations({transaction:'each'}). Do not rerun the broad CLI
until its migration discovery pattern is repaired.

Verify tests:

```bash
cd apps/api
./node_modules/.bin/jest src/modules/ai/demo-strategy-brake-owner.service.spec.ts --runInBand
cd ../web
./node_modules/.bin/jest src/components/trading/StrategyLossBrakeNotice.spec.tsx --runInBand
```

The new modal informs the owner of real restrictions without claiming that a permission guarantees orders. This is not a relaxation of hard account loss, out-of-distribution, or broker risk barriers.
