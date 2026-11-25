# iRexPro — Six-hour DEMO no-trade incident and bounded loss-streak recovery
**12 November 2026 — staging, Pepperstone cTrader DEMO**

## Actual incident

After the 10:19:03 UTC EURUSD trade close, the active FULL_AUTO
Pepperstone DEMO generated M1 evaluations but no new executed trades.
At 16:29 UTC: 120 EURUSD + 120 AUDUSD decisions in the preceding
hour, **zero authorizations**. The server-side API and AI worker were
online; the broker quotes were current.

The 240 decisions predominantly classified the market as TREND_EXTENDED
or TREND_WEAK, and most Plan B proposals were not admitted. These
remain legitimate quality blockers; do NOT strip the gates.

However, the exact broker ledger and M1 decisions revealed **already
Plan-B-admitted opportunities rejected at the last risk layer**:

- 11:46 and 11:53 UTC: AUDUSD SELL TREND_HEALTHY/continuation
  reached PRIMARY_PLAN_B. The exact-session portfolio NET loss
  brake correctly prevented new trades within its 120-minute
  loss-recovery cooldown. **Leave the portfolio brake untouched.**
- 14:25, 14:26 and 14:33 UTC: EURUSD SELL
  REVERSAL_CONFIRMED + M1_EARLY_TRANSITION,
  PRIMARY_PLAN_B, no other recorded model veto.
  Blocked ONLY by `M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK`.
- The latest two same pair/side/route EURUSD SELL losses closed
  08:58:42 and 10:19:03 UTC. Both were **2 lots**; their P&Ls were
  -62 and -118 before commissions, with a 12 commission debit each.
  Their observed payoff R was around -0.9 each.
- The early loss streak was computed using a **seven-day**
  carry-forward window. It required a new WIN to move the pair/side
  out of EARLY_LOSS_STREAK, while denying every new entry on that
  exact route: a self-locking cold-start deadlock.

## Fix: finite cooldown, bounded primary-only canary

Only DEMO professional-primary Plan B with the exact connected
broker/native data, existing event/SL/margin/risk/reentry guards and
route timing can execute. No change to LIVE order permissions.

- Following the required two consecutive M1 early-transition
  losses (or three continuation losses), the **first 180 minutes**
  remain a hard no-trade EARLY_LOSS_STREAK.
- At 180 minutes after the latest closed loss, the pair/side remains
  empirically `eligible: false`, but its diagnostic changes to
  `EARLY_LOSS_STREAK_RECOVERY_CANARY`. Do not call it healthy.
- Only an independently admitted, fully governed
  **PRIMARY_PLAN_B** can attempt recovery; no fallback,
  M5 handoff, extension scout, unqualified shadow or conflicting
  strategy is promoted by this change.
- All recovery attempts receive a maximum **0.01 lot** cap, not
  the former four-lot cap. The original broker-native sizing,
  product lot minimum and risk validation may further reduce or
  reject this volume.
- At most **one broker-authorized recovery attempt per
  exact user + broker + instrument + direction per 240 minutes**.
  Query is as-of bounded and only counts audited `BROKER_NATIVE`
  decisions explicitly marked `recoveryCanary: true`.
- A temporarily unavailable recovery-history read is fail-closed:
  `M1_RECOVERY_CANARY_HISTORY_UNAVAILABLE`.
- If a 0.01-lot recovery WIN occurs, the larger position cap is
  **not immediately restored**. The per-pair/side remains in
  0.01-lot canary spacing while it has two losses among fewer
  than five actual route samples.
- Portfolio net-loss brake remains at 120 minutes for three
  consecutive portfolio net losses; it has not been disabled.
  The independent multimodel loss streak, fast-stop, demo
  commission, drawdown and account risk gates are untouched.

## Evidence and safety verification

- 25 reliability tests passed, including exact 180-minute boundary.
- 120 pre-existing full scheduler tests passed before correcting
  an initial test-fixture time typo; the two new integration
  tests then independently passed after the fixture correction.
  They verify 0.01 lot, 240-minute repeat suppression and
  fail-closed on unreadable recovery history.
- Read-only exact-owner recovery SQL contract tests passed.
- API NestJS production build passed.
- No manual broker orders were submitted to fabricate activity.
- Existing positions were not modified.

## Remaining prerequisite

Recovery does not bypass Plan B market timing, drift classification,
negative model admission, spread evidence, portfolio brakes,
capital allocation, or any broker-side order rejection. At
16:29 UTC the latest market was predominantly TREND_EXTENDED and
TREND_WEAK, and no primary signal was authorized. The operator
must verify new broker trades or absence of them from the
actual database AFTER this software deployment, not infer success
from a page animation or from test fixtures.
