# Owner Pepperstone USD DEMO: strictly time-limited 4–6 lot request experiment

**Requested by owner:** Nov 20 2026, before noon Ghana time.

**Deployed:** 2026-11-20 04:05 UTC after 25 Jest tests and successful API Nest build. No LIVE, other broker, or other user's settings changed.

## Fixed window and expiry

- Code eligibility begins **2026-11-20 03:57:00 UTC** but wasn't activated until API restart around 04:05.
- Eligibility automatically ends **2026-11-20 12:00:00 UTC**, identical to **noon in Ghana**.
- Expiry tested using exact inclusive/exclusive boundary and checked at the final pre-dispatch point and again during authoritative position sizing.
- Already-open demo positions are **not forcibly closed at noon**; only the permission to request increased lot sizes ends.
- The distinct scoped runtime flags live in API environment (do **not** log owner ID/connection or credentials):
  `IREXPRO_OWNER_PEPPERSTONE_DEMO_4PLUS_UNTIL_NOON_20261120=enabled` and a separately configured, exact owner demo connection ID.

## Scope / what was changed

- Only owner Pepperstone **cTrader DEMO in USD**, with a connected broker and active FULL_AUTO demo session, and with original qualifying continuous `CONFIRMED_REVERSAL` / `EARLY_TRANSITION` admissions.
- Raises requested maximum from 4 to **6 lots**; does not force a floor or change original trade side, SL/TP or entry confidence. The explicit requested volume is still clipped by the normal broker risk and currency exposure controls.
- Temporarily removes the **advisory-only quality fraction lot multiplier** for the eligible trial signal (e.g. historical 50% multiplier), but the independent M5 reversal disagreement soft cap is retained.
- Temporarily raises the **M1 DEMO prescreen stop-risk percentage** from 0.25% to **0.75%** for those signals, as a pre-screen ONLY. Does not modify the durable user risk profile (2% max at deployment), broker margin, currency exposure, stop-loss, hard risk gate, leverage or account drawdown risk scaling.
- Lifts the owner DEMO allocation-aware **product** cap from 4 to 6 in PositionSizingService only while the server clock remains within the trial. Actual risk-limited, fee/spread-aware position size may be **below 4 lots**.
- Neither LIVE/PAPER account authorization, other brokers nor other users can inherit this opt-in.

## First actual trade, not just an internal request

At approximately **04:06:08 UTC**, one AUDUSD SELL `CONFIRMED_REVERSAL` signal created under the trial:

- 4.20 lots **requested** in the executed trade intent.
- **3.44 lots actually opened** by the USD DEMO broker at 04:06:13 UTC.
- Initial recorded risk-at-stop about **$172**.
- This is **not** a four-lot-or-more fill. No realized net P&L was yet available while OPEN.

The difference is intentional: stop-risk, cost reserve and broker risk sizing remain authoritative and can reduce requested volume. Future trials can yield 4+ actual fills if risk permits, but nothing is guaranteed.

## Monitor & comparison

- Read-only monitor `apps/api/scripts/audit-owner-pepperstone-demo-noon-lot-trial.cjs` is attached to existing half-hourly owner guard research monitor (no new order-capable timers).
- Current JSON at `/home/lightworld/webapps/irexpro-research/owner-noon-lot-trial/latest-report.json`.
- Tracks requested >=4, **actual broker-filled >=4**, smaller actual fills, pending/reconciled outcomes, realized net USD **after** commission and swap, strategy and pair breakdown. P&L from OPEN trades is **not invented** or marked settled.
- Reports `ACTIVE` only before noon; `EXPIRED_AUTOMATICALLY` from exactly noon.
- Lot magnitude does not improve trade selection expectancy: a larger lot increases both actual winning and losing dollar amounts.

## Verified protections

- Pure helper tested across wrong owner, broker, currency, LIVE, wrong connection, disabled flag and before/at/after expiry.
- Nest API compile succeeded on second attempt (first attempt revealed invalid references in trial scope; fixed before deployment).
- Started only after source code, risk and tests succeeded; API health HTTP 200 after restart.
- Research monitor runs under read-only SQL transaction and has **no trading authority**.

No claim of net profitability or 4+ broker fill is made until actually observed in owner broker confirmed data.
