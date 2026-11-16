# iRexPro — temporary Trend Continuation pause experiment
## 16 November 2026

### Why
A per-trade audit on the owned Pepperstone cTrader USD DEMO account found:
- Fri 13 Nov: `TREND_CONTINUATION` 17 closed, 11 wins, net +$32.45;
  `CONFIRMED_REVERSAL` 2, 1 win, net +$127.60;
  `EARLY_TRANSITION` 1, 1 win, net +$10.30.
- Mon 16 Nov (through ~15:20 UTC): `TREND_CONTINUATION` 10 closed,
  2 wins, net -$313.36. Early and reversal routes had zero executed trades.
- The Monday decision log independently recorded 478 reversal and 188 early
  transition candidates, both with zero broker-native authorizations.
  Common blockers: `MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED`,
  `MULTIMODEL_EARLY_TRANSITION_NOT_M1_CONFIRMED`.
- The engine identity, M1 policy version, and running API/AI processes persisted
  from Friday to Monday. Therefore the difference is more likely market
  conditions/admission than an overnight model replacement, though the model's
  sensitivity to regime changes remains a serious weakness.

### Reversible action, exactly scoped

Set `IREXPRO_PEPPERSTONE_DEMO_PAUSE_TREND_CONTINUATION=enabled` in
`apps/api/.env` and restart only the API at a checked safe point.

The feature applies only when:
- Existing M1 professional-DEMO rollout is active,
- An exact owner-plus-broker connection check resolves to
  `pepperstone-ctrader` with `account_type='DEMO'`,
- The selected executable route is the primary Plan-B `TREND_CONTINUATION`,
  or its `BOOTSTRAP_CONTINUATION`, `QUALIFIED_CONTINUATION`, or
  `EXTENSION_EXHAUSTION_DEMO_SCOUT` fallback path,
- An otherwise eligible NEW entry is evaluated.

The entry's decision is persisted with `executionAuthority='NONE'`,
`M1_PEPPERSTONE_DEMO_TREND_CONTINUATION_PAUSED` blocker and
`governance.demoContinuationPause`. No order is dispatched. Existing positions
are NOT changed/closed. The broker scope lookup fails closed for a candidate
requiring the pause, rather than silently allowing a continuation position.

The `EARLY_TRANSITION`, `CONFIRMED_REVERSAL`, and verified M5 early-transition
handoff paths retain all existing confirmation, spread, news, equity,
portfolio-risk, sizing, loss-streak, broker and session gates. We do **not**
force these models to enter or promote research-only signals merely to increase
trade count.

This is a prospective DEMO experiment. Friday's three non-continuation trades
are too few to establish the profitability of an alternative strategy.

### Controls and rollback
- Feature is **disabled by default**. The OFF state preserves prior behavior.
- In `apps/api/.env`, set `IREXPRO_PEPPERSTONE_DEMO_PAUSE_TREND_CONTINUATION=`
  (empty), then restart only `irexpro-api-staging` to restore old route
  eligibility. Do not alter LIVE broker credentials or restart the AI engine.
- Validate no open positions before restart, record the session status,
  verify API health, and inspect recent post-restart decision governance for
  the exact blocker.
- Use next-market-session route comparisons and after-commission net P&L for
  go/no-go; a zero-trade session does not prove improvement, and forcing
  unconfirmed reversals is prohibited.

### Source
- `apps/api/src/modules/ai/pepperstone-demo-continuation-pause.ts`
- `apps/api/src/modules/ai/m1-tactical-scheduler.service.ts`
- `apps/api/src/modules/ai/pepperstone-demo-continuation-pause.spec.ts`
- Scheduler integration tests for explicit primary authorization, qualified
  continuation canary, other-broker exclusion and separately qualified reversal.
