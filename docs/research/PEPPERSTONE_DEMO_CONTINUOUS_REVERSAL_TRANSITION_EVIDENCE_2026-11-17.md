# Pepperstone DEMO continuous reversal and early-transition evidence — 17 November 2026

## Owner decision

The owner explicitly requested **no fixed number of trades and no scheduled experiment expiry** for qualified Confirmed Reversal and Early Transition DEMO entries, allowing ongoing evidence gathering. The 16 Nov 23:36–17 Nov 20:00 trial had already filled its **4/4 authorized order quota** by 17 Nov 01:52 UTC, with four executed trades and net P&L **−$57.90** after recorded commission. That is the immediate reason for the change.

## Exact change

An explicit, reversible server-side flag `IREXPRO_PEPPERSTONE_DEMO_CONTINUOUS_ALTERNATES=enabled` authorizes **only** the configured `VPS_FOREX_SCANNER_USER_ID` on an independently verified, connected **Pepperstone cTrader DEMO** trading account, during the professional FULL_AUTO DEMO session. This switches the *already admitted* Plan-B `EARLY_TRANSITION` and `CONFIRMED_REVERSAL` advisory research mode from the former *4-order, 20:00 Nov 17 UTC expiry* pilot to ongoing **no cumulative experiment entry quota, no calendar expiry**. It does not reset, mutate, or delete earlier trade records.

Both confirmation and dispatch paths enforce exact owner-scoped DEMO identity. The dispatch path **revalidates** the broker identity and enabled flag. Old counter/advisory fixed-budget behavior stays available if the new flag is OFF. All other fixed-date trials retain their original limits. Every allowed new order continues to carry the immutable `m1_pepperstone_demo_continuous_evidence=true` marker, `DEMO_CONTINUOUS_REVERSAL_EARLY_EVIDENCE` execution authority path, original `m1_pepperstone_demo_advisory_alternates` attribution, and `m1_pepperstone_demo_alternative_trial_expires_at=null`. The status endpoint indicates continuous mode with `maxEntries:null, endsAt:null`, rather than a misleading hard 4 cap.

The order's M1 decision must still be fresh (<=120 seconds); the trained independent expert, Plan-B, spread/economic and OOD checks must pass. **Risk protections remain**: broker original SL/TP, open exposure, 4.00-lot maximum suggested volume **subject to 0.25% risk-at-stop and broker margin**, risk gates, model loss streaks, portfolio drawdown/stop, event-risk veto, same-side deduplication and reentry cooldown, session binding, and after-fee profit protection. These checks are *not* trading quotas and can block unsafe entries regardless of study duration. No LIVE permissions, live-money promotion or auto-switch.

## Monitoring and statistical interpretation

Accumulate independent filled trades by route, instrument, direction, session clock bucket, stop-risk amount and first/last broker quote sample with realized net P&L after commission, swap and any broker costs. Distinguish 3/5/10/15-minute price path and valid early profit-lock from gross movement or shadow-only predictions. Evaluate rolling net expectancy, win/loss rate, max drawdown, profit factor and whether exited positions hit their original TP only in **later completed broker marks**; do not infer broker fills from post-exit prices.

**Evidence sufficiency is statistical, not an execution quota.** The trade engine does not automatically stop after a chosen sample size and cannot guarantee profit. The owner can use Start/Stop to end the DEMO session; internal loss/drawdown brakes can suspend trading before evidence is sufficient. The originally scheduled 20:05 one-shot review may evaluate the originally timeboxed cohort, but must not misrepresent the continuous trial as completed.

## Tests and rollout

The pure advisory evaluator must show a qualified fresh signal remains eligible *after* 2026-11-17 20:00 when continuous mode is specifically enabled and verified, and deny stale signals/wrong account/nonadmitted routes. A scheduler integration test must simulate 4 preexisting entries and verify **no more quota reads** while a new qualified owner-DEMO signal is dispatched after expiry with correct metadata. The previous finite trial policy, broker-risk and other pilot caps stay intact. No deployment claim until Nest API build, tests, restart and post-deploy readiness checks pass.
