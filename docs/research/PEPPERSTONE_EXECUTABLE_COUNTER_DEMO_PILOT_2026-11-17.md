# iRexPro independently executable expert COUNTER — Pepperstone DEMO pilot

**Implementation date:** 16 November 2026.
**Active experiment:** **Monday 16 November 2026 21:00 to Tuesday 17 November 00:00 UTC/Ghana**, with an automatic cutoff at midnight.
**Scope:** exact owner's connected Pepperstone cTrader **DEMO** FULL_AUTO
session only. **LIVE broker accounts are excluded** from this code path.
**Activation flag:** `IREXPRO_PEPPERSTONE_DEMO_COUNTER_PILOT=enabled`.
**Exact safety caps:** at most **four newly submitted counter trade intents**
across the trial time window; at most **4.00 standard lots** per entry,
**subject to the unchanged 0.25% allocation risk-at-stop limit** and
normal broker-native margin, available equity and currency exposure screens.
Four lots is an upper bound, NOT a minimum or default size.
Existing account allocation, margin, daily-loss, portfolio loss-streak,
currency correlation, broker-native spread, stop-loss, position-conflict,
and other order-execution gates remain active and may reduce or reject a trade.

## What is truly executable

New pure decision module:
`apps/api/src/modules/ai/pepperstone-demo-counter-pilot.ts`.

The MAIN M1 scheduler already builds BOTH independently scored BUY and SELL
candidates for each pair and completed-minute market snapshot. During the
new timebox only, it identifies a current candidate whose independently
evaluated BUY/SELL trained broker-native expert has **finally admitted
CONFIRM** (not just three directional votes). To qualify as an
EXPERT COUNTER entry, the other direction must have produced a genuine
Plan-B admitted, governance-eligible CONFIRMED_REVERSAL or EARLY_TRANSITION
at the same decision slot; the expert must oppose that earlier proposed
side.

The candidate *being traded* must independently qualify through its
OWN:
- Plan-B `CONFIRMED_REVERSAL` or `EARLY_TRANSITION`, never the paused
  TREND_CONTINUATION route;
- paper admission and Plan-B governance approval;
- ensemble score >=0.60 and direction quality >=0.54;
- predicted after-cost net expected R >=0.12 with usable broker-native
  spread/cost, CLEAR macro event risk and no out-of-distribution drift;
- M1 directional score >=0.55 and M1 confidence >=0.67, for a documented
  M1 ABSTAIN/early-transition timing mismatch only;
- genuine same-side expert `CONFIRM`, admitted=true, complete three-vote
  broker-native unanimity, confidence >=0.65, mean predicted opportunity
  probability >=0.60 and <=180-second freshness;
- independently generated stopLoss, takeProfit and stop distance with
  target distance larger than risk.

The counter does NOT inherit opposing side SL/TP, invert a rejected
trade intent, re-run stale historical signals, or force-close/hedge an
already-open opposite broker position.

After research qualification, a counter goes through the existing
M1 `AiSignalService.receiveSignal` path; all normal risk checks still
apply, with a **new** counter-pilot metadata marker
`m1_pepperstone_demo_counter_pilot=true`,
`multimodel_execution_authority_path=DEMO_EXPERT_COUNTER_ENTRY_PILOT`,
and original opposing route/side recorded. A legitimate counter order
therefore appears in the actual broker trade/intents table; it is NOT
merely another virtual shadow. The same generic trial budget counts
every *submitted* tagged trade intent of any final status in the
session-specific timebox to avoid retry-abuse; rejected scans never
consume the four-entry budget.

## Timeboxed late-evening DEMO trial and rollover safety

The operator authorized live **DEMO** broker execution (never LIVE funds)
during the 21:00–00:00 Ghana-time window. This includes the rollover-risk
period; broker-native spread verification, macro risk, the portfolio
net-loss brake and stop-risk/margin sizing remain strict and may veto
all entries. Historical candidates are not replayed, and the maximum
decision age is 120 seconds. A larger lot ceiling **does not**
raise the stop-loss risk allowance or relax market/entry quality.
The previously configured 20:00–21:00 alternative micro-trial is expired,
and trend continuation remains paused.

## Proof before activating

Unit tests in
`pepperstone-demo-counter-pilot.spec.ts`
exercise both BUY/Sell counter symmetry, real expert admission versus
three-vote ABSTAIN, negative own-side after-cost return, wrong broker,
stale decision or window, missing stops, continuation pause and volume
limits. Integration tests in
`m1-tactical-scheduler.service.spec.ts`
prove a fully qualified counter reaches the actual
`receiveSignal` function with its own BUY-side SL/TP and risk-capped up-to-4.00-lot allowance,
explicit counter route/tag and owner demo broker; a counter with a
finished time window cannot submit. No live test credentials or
uncontrolled real orders are used by these deterministic tests.

Deployment must not proceed without passing focused/full regression,
typecheck and API build, a protected API-dist/.env backup, owner-scoped
active DEMO+zero-open-position preflight, exact continuation pause
verification, PM2 restart and live /health HTTP 200. Do not set the
counter flag on other accounts or restart the separate trading engine
unless necessary. The hard-coded window self-expires at midnight Ghana time
even if the activation flag remains in the environment.

## Reading outcomes

Count ACTUAL fills from `trading.trades` joined to tagged
`trading.trade_intents`; use actual net USD after commission and swap
for realized P&L. Report separately (1) fresh M1 scans, (2)
independently qualified counter candidates, (3) broker-submitted trade
intents and (4) broker-confirmed actual fills. A simulation-only
positive mark must never be mistaken for a filled position or realized
profit. A favorable test cannot guarantee profits in later sessions.
