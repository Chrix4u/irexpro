# Pepperstone DEMO reversal / early-transition expanded admission and exit-trend consultation — 2026-11-17

## Purpose

The owner requested an immediate, measurable trial of `CONFIRMED_REVERSAL` and `EARLY_TRANSITION` with fewer redundant model timing blockers, and an independent forward-trend consultation whenever a profitable trade might be closed early. This is a **timeboxed live-broker DEMO** experiment, not qualification for real-money LIVE. An earlier advisory trial already opened two Pepperstone DEMO positions: USDJPY early-transition net −$120.81 and AUDUSD confirmed-reversal net +$4.53 after commission. The latter was explicitly closed by the newly deployed Pepperstone profit protection.

## Isolated, opt-in gating adjustment

New explicit opt-in `IREXPRO_PEPPERSTONE_DEMO_RELAXED_ALTERNATE_TRIAL=enabled`, effective **only** in the existing owner-scoped Pepperstone cTrader USD DEMO advisory window `2026-11-16T23:36:00Z` – `2026-11-17T20:00:00Z`. Existing hard four-intent trial cap and 4.00 maximum suggested lots remain unchanged; historical usage is not reset. Account validation remains fail-closed. The existing `IREXPRO_PEPPERSTONE_DEMO_ADVISORY_ALTERNATES=enabled` is still required.

For separately Plan-B-paper-admitted, governance-passed reversal/early-transition candidates, remove only duplicate late-stage M1/expert **quality** hurdles:

| Condition | Existing | Owner DEMO test |
| --- | ---: | ---: |
| After-cost governance net expected R | >=0.12 | >=0.08 (existing base governance minimum) |
| M1 confidence floor | 0.67 | 0.64 |
| M1 direction quality floor | 0.55 | 0.45 |
| M1 timing route | ABSTAIN / M1_EARLY_TRANSITION | also accepts same-side M1_TREND_CONTINUATION |
| Independent native expert opportunity floor | 0.25 | 0.15 |
| Independent expert side, votes | matching side, >=2 favorable / <=1 opposing | unchanged |
| Plan-B admission & governance | must pass | unchanged |
| Native spread & after-fee cost availability | required | unchanged |
| Real-time news/event-risk veto | CLEAR | unchanged |
| Model OOD and blocked sleeve veto | enforced | unchanged |
| Valid protective stop and TP (target > stop) | enforced | unchanged |
| Broker/owner DEMO scope, margin, risk/SL, max lots, capacity and cumulative drawdown | enforced | unchanged |

Never use the raw expert pilot eligibility before its entry budget check; successful and rejected raw advisory candidates must not bypass the four-entry cap.

## Before-exit future-trend assessment

Upon a broker-validated profitable Pepperstone DEMO early-transition/reversal giveback crossing, the exit service now *starts* a nonblocking, decision-time `recordProfitLockTrendRecheck` that reads the latest independent Plan-B/expert thesis and causally fresh live M1 bar direction, price, TP, adverse bars, and fee evidence. Its `DEMO_PROFIT_LOCK_TREND_RECHECK` audit stores why a hypothetical additional runner might or might not be defensible, with no future-price leakage. The actual protective close executes in parallel **without waiting for or obeying** that research prediction.

This is intentional: the current Pepperstone adapter's broker stop is the **original losing SL**, not an independently verified positive locked stop. Deferring a due close merely because M1 forecasts a TP could exactly recreate the −$120.81 loss. A future active TP-grace policy can be considered only after implementing and verifying a genuine **broker-server-side profitable stop**, stop-adjustment idempotency, quote/fee buffer, protected grace expiry and broker reconciliation; otherwise a trend prediction must never veto an active profit-lock.

## Verification and scope

Tests exercise both baseline and relaxed advisor permission, reject nonadmitted candidates/opposing experts, block stale/LIVE or wrong broker contexts, and prove a Pepperstone profit-lock close still occurs even when a nonblocking trend consultation runs. Enabling the new flag is **not** a general loosening of other routes, a trial-duration extension, a renewal of quota, or a promotion.

No data deletion, model retraining or changes to existing active broker position stops or TP.
