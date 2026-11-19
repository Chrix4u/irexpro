# iRexPro DEMO — simple owner choice for strategy loss pauses

The account owner requested a simple, visible decision rather than silent strategy restrictions or a temporary one-entry exception.

The AI Trader now asks:

> Pepperstone DEMO (USD) — [strategy], [instrument] [BUY/SELL] was paused after losses. Do you want to keep it paused or allow it to continue trading?

Exactly two choices: **Keep Paused** and **Continue Trading**. No recovery-cap wording, extra checkbox, 1.00-lot rule, or one-hour expiry appears in the strategy modal.

## Server-side behavior

- `CONTINUE_TRADING` is an explicit authenticated owner choice for a particular Pepperstone **DEMO USD** broker connection, strategy, instrument and direction, persisted across trading-session restarts on that same broker connection.
- `KEEP_PAUSED` revokes any previous Continue Trading choice for that same pair/side/strategy.
- A Continue Trading selection bypasses **only that route's model-specific historical loss-streak brake**. It does not directly place any order, flip directions, bypass the portfolio-wide loss pause, or change required broker margin, stops, spreads, session, cost, model qualification or all other account-wide safety controls.
- The normal strategy's existing lot-size logic is used; there is **no additional 1.00-lot ceiling** and **no one-entry or one-hour quota** created by this owner choice.
- Only the verified owner can make the decision; the backend rechecks the active DEMO broker-backed loss incident before accepting a new choice. Other accounts cannot read or change it.
- Stored owner choices are audited in `trading.demo_strategy_brake_owner_decisions`. Migration `1795030000000-EnableDemoStrategyOwnerContinue` retains legacy historic `RESUME_LIMITED` rows for audit but never treats them as a new indefinite approval.
- Early Transition, Confirmed Reversal and Trend Continuation are eligible for strategy-level notices if a real scanner brake is active. Ordinary scanner/market risk gates remain operational.
- The owner requested Trend Continuation be re-enabled for DEMO. Change only the owner-scoped `IREXPRO_PEPPERSTONE_DEMO_PAUSE_TREND_CONTINUATION=disabled` setting; this is **not** a promotion to LIVE and does not override its other normal trade qualification gates.

## Validation

Use the targeted migration runner with **only** this migration class because the repository-wide TypeORM migration command currently attempts to load a Jest test file.

Run backend Jest `demo-strategy-brake-owner.service.spec.ts` and frontend Jest `StrategyLossBrakeNotice.spec.tsx`. Build `apps/api` and `apps/web` independently, activate builds with saved rollback copies, and verify API health, authenticated-route protection and the AI Trader page.

Historical caution: Trend Continuation's inspected November DEMO trade history showed a significantly negative net P&L. Re-enabling it is at the owner's request for further **DEMO** observation, not a claim that the strategy is profitable.
