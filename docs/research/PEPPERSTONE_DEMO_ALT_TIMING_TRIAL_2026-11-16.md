# Pepperstone DEMO-only reversal and early-transition trial — 16 Nov 2026

**User-authorized scope:** Time-limited **DEMO** trading trial for the existing
Plan-B `CONFIRMED_REVERSAL` and `EARLY_TRANSITION` strategies, 20:00–21:00 UTC
(Ghana). **TREND_CONTINUATION remains paused.** No LIVE account trading.

## Confirmed bottleneck

The main Plan-B ensemble admits many reversal and early-transition decisions
that have passed its paper/market governance; M1 independently labels most
`ABSTAIN`, even though a subset has unanimous native-trained expert votes.
The old DEMO authority rejected a Plan-B reversal whenever its M1 label
was not `M1_CONFIRMED_REVERSAL` or a narrowly gated bridge; the early
transition route demanded `M1_EARLY_TRANSITION`. These are semantic
alignment requirements, **not** additional spread, cost or margin gates.

Hundreds of repeated per-minute observations are *not* hundreds of independent
orders and are not valid delayed entries after the market has moved.
Previous replay analysis found many of the historical rejected routes
unprofitable. Do NOT replay historical scans as broker orders.

## Temporary controlled change

`IREXPRO_PEPPERSTONE_DEMO_ALTERNATIVE_TRIAL=enabled` is an explicit
feature flag, **disabled by default**. The code autonomously stops granting
trial authority at **2026-11-16 21:00:00 UTC** and rejects decisions older
than two minutes or before 20:00. The entry layer rechecks cutoff, session,
broker identity and trial count before any signal is submitted.

New broker-native demo authorization is allowed only when ALL apply:

- Exact owned connection identified as `pepperstone-ctrader` / `DEMO`;
  existing scanner phase `DEMO_EARLY_TRANSITION_PROFESSIONAL`.
- Plan-B strategy is **only CONFIRMED_REVERSAL or EARLY_TRANSITION**.
- Plan-B `paperAdmitted=true`; governance `paperExecutionEligible=true`,
  independent broker-native spread and execution-cost evidence valid,
  event risk CLEAR, not a blocked sleeve, and portfolio snapshot available.
- Plan-B ensemble score ≥0.60; directional quality ≥0.54; forecast after-cost
  net expected R ≥0.12. M1 candidate confidence ≥0.67 and directional
  quality ≥0.55; M1 label is only `ABSTAIN` or `M1_EARLY_TRANSITION`.
- Three independent, **unanimously aligned** broker-native expert votes,
  score ≥0.65, snapshot age 0–300 seconds. Opposing expert / missing
  prices / unavailable snapshot are not authorizable.
- Existing loss-streak, portfolio net loss brake, broker fee floor,
  duplicate same-side intent, opposite open position, margin, capital
  allocation, currency exposure, stop-loss, reentry, news, spread and
  account-level risk checks remain unchanged.
- **At most 0.01 lot per trial**, and **six actual new trial intents**
  total during the one-hour window, owner/broker-scoped. The trial marker
  `m1_pepperstone_demo_alternative_trial=true` is added to executed
  trade-intent metadata, and `DEMO_ALTERNATIVE_TIMING_TRIAL` identifies
  the route in trade reports.

`m1_tactical_decisions.governance.demoAlternativeTrial` persists
individual eligible/blocked reasons for forward audit. This permission
does NOT promote models or alter existing open positions. It does not
force a minimum number of trades: if no candidate meets the surviving
safety checks, there may be zero trades. Six is a maximum, not a target.

The requested opposite-side **COUNTER** still runs as virtual research only;
this trial grants permission only to native selected reversal/transition
directions. Sending both directions simultaneously is not supported by
this trial.

## Safety and rollback

Feature off: set `IREXPRO_PEPPERSTONE_DEMO_ALTERNATIVE_TRIAL=` and restart
only `irexpro-api-staging` at a checked safe point. The source control
change remains independently reversible. The continuation pause stays
`IREXPRO_PEPPERSTONE_DEMO_PAUSE_TREND_CONTINUATION=enabled`.

Preserve the pre-deployment API dist/.env backup, check for OPEN positions,
verify API health, ensure broker/demo/session scope, confirm no old
signals were backfilled, and inspect new decision governance and trade
metadata before claiming real broker execution. After 21:00 UTC the
code refuses new trial entries without any scheduled external action.

## Validation

- `pepperstone-demo-alternative-trial.spec.ts`: closed window,
  broker scope, no historical replay, model and risk prerequisite
  preservation, unanimous expert agreement and lot cap.
- `m1-tactical-scheduler.service.spec.ts`: complete risk/dispatch
  integration test for a Plan-B reversal with M1 `ABSTAIN`, confirming
  0.01-lot signal and trail metadata through the standard broker gate.
- Original continuation-pause tests retained.

**No guaranteed winnings or trade count.** The prospective trial is
speculative and its results must be assessed after actual costs and
broker reconciliation; real-account promotion remains unauthorized.

## 20:20 UTC follow-up — review of overlapping timing gates

Fresh read-only owner-scoped PostgreSQL history (16 Nov 00:00–20:20)
contained 517 Plan-B CONFIRMED_REVERSAL and 195 EARLY_TRANSITION
decision rows. Of these, 516 and 195 respectively were paper-admitted
and governance-eligible. When retrospectively evaluating the new
DEMO micro-trial's market/economic floor, independent M1 quality,
and aligned fresh three-vote native expert corroboration, **66 reversal
and 17 transition scans** had qualifying research features.

These 83 are *repeated M1 scanning decisions*, not 83 independent
trades or permissions to replay stale prices. This retrospective
count is a screening sanity check only; it does not certify after-fee
profitability or include final broker/portfolio vetoes.
The initial 20:10–20:19 deployed window had zero broker entries; the
one fresh Plan-B confirmed-reversal scan missed M1 quality.

## Final safety hardening

The temporary M1 semantic-bridge trial must never inherit the older
confirmed-direction-flip privilege to close an existing opposite broker
position. The scheduler now excludes trial authority from automatic
opposite-position closings; it waits and records an active-opposite
blocker instead. An additional pre-dispatch timebox/staleness check
after the capital and currency exposure calculations prevents a
slow risk evaluation from authorizing a trial signal after 21:00.

Regression integration tests now verify that a strong hypothetical
DEMO trial reversal **cannot** close an older opposite position or
open a hedge through the standard entry path. These are limited
safety corrections only: the continuation pause, Plan-B quality
floors, broker risk and execution lot cap are unchanged.

All permission flags should remain unchanged after 21:00: the trial
check rejects new orders once the timebox has ended. Do not claim
that old existing positions automatically close at 21:00; exits
remain managed by existing broker risk/execution mechanisms.
