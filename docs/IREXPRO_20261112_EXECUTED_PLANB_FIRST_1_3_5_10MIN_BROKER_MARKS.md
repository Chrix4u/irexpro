# iRexPro — actual Pepperstone DEMO entry timing by originating trade route
**12 November 2026 | Account-currency USD | Read-only trade-scoped mark audit**

## Scope and provenance
Enhanced existing broker quote mark observer
`apps/api/scripts/audit-short-horizon-broker-marks.cjs` to attach the
**executed trade intent's actual authority** and Plan B originating
route. It groups original broker fills, not later scanner decisions.
The independent `QUALIFIED_CONTINUATION` 0.01-lot trade is now
segregated from the `PRIMARY_PLAN_B` 2/4-lot orders.

Run:
```bash
cd apps/api
IREXPRO_HORIZON_AUDIT_START=2026-11-10T00:00:00Z \
IREXPRO_HORIZON_AUDIT_END=2026-11-12T23:10:00Z \
node scripts/audit-short-horizon-broker-marks.cjs
```

The audit looks at each ACTUAL executed and closed broker trade and
queries exact owner/account/pair Pepperstone bid/ask marks observed
when it was STILL OPEN at 1, 3, 5 and 10 minutes. A SELL closes
at ASK, BUY at BID. Net mark includes its eventual recorded broker
commission and swap as a cost estimate. Each group retains
`closedBeforeHorizon` and `quotesMissingWhileOpen` to show
selection and data-coverage limits.

## Findings

44 closed broker fills: actual total −$1,259.71,
of which 43 `PRIMARY_PLAN_B` −$1,258.72 and one independent
`QUALIFIED_CONTINUATION` −$0.99.

| Origination | Broker fills | Actual net | First minute conditional net win count | Third minute conditional net win count |
|---|---:|---:|---:|---:|
| PRIMARY_PLAN_B / TREND_CONTINUATION | 33 | −$1,301.95 | 8/29 markable | 7/29 markable |
| PRIMARY_PLAN_B / CONFIRMED_REVERSAL | 7 | −$44.72 | 0/7 markable | 3/7 markable |
| PRIMARY_PLAN_B / EARLY_TRANSITION | 3 | +$87.95 | 1/3 markable | 0/3 markable |
| independent M1 / QUALIFIED_CONTINUATION | 1 | −$0.99 | 0/1 markable | 0/0 available |

For primary **AUDUSD SELL / TREND_CONTINUATION**:
seven broker fills, five eventual net winners, **+$322 actual net**.
At 1 minute, 2 of 5 markable trades were profitable with sum
**−$136**. At 3 minutes, **1 of 6** markable positive,
sum **−$188**. At 5 minutes, **2 of 5** positive,
sum **−$30**. At 10 minutes, **1 of 4** markable positive,
sum **−$44**. This is consistent with an initially adverse
price path, but not sufficient to claim that delayed entry is
executable, better or first-touch stop-safe.

For primary **EURUSD SELL / TREND_CONTINUATION**:
four fills, three eventual net wins, **+$346 actual net**.
At 3 minutes all **3 of 3** markable were net positive, sum
**+$142**; at 5 minutes all **3 of 3** markable net positive,
sum **+$192**. One trade was already closed before both
horizons, so these exclude that trade.

A hypothetical after-one-minute or after-three-minute market
entry has NOT been evaluated causally with a complete shifted
SL/TP path. This audit **does not justify adding an entry delay**
yet. Similarly, the 5/10 minute comparisons exclude positions
that were already closed (survivor bias), and the quotes are
M1 marks sampled tens of seconds after selected horizon rather
than exact executable quotes at the target second. Actual future
fees and capital utilization may differ. Spread widening can
still result in a broker stop fill worse than the requested SL.

## Implementation and safety

- Two new research groups: `byExecutionPathAndPlanBRoute`
  and `byExecutionPathAndPairSideRoute`; no production scanner,
  policy, broker risk or order path consumes them.
- New tests prove the 2/4-lot primary route is NEVER pooled with
  the experimental 0.01-lot route, including quote missingness and
  closed-before-horizon accounting.
- The existing primary no-trade problem remains: as of 23:12 UTC,
  two focus pairs were still scanning with zero final approvals
  in the last 12 minutes. The current connected broker is active.
- Next research must compare a prospective, independently
  timestamped M1/M5 pullback-entry plan with exact executable
  bid/ask and stop FIRST TOUCH; require multiple independent
  days, robust estimated paid fees and matched capital risk
  before a DEMO-only execution canary is considered.
- No changes to model authority, timing gates, user controls,
  position size, stop, target, risk limits or LIVE deployment.
