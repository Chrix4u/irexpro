# Pepperstone DEMO continuous advisory quality-sensitive risk, 17 Nov 2026

## Owner goal and observed evidence

At 08:22 UTC, 30 Pepperstone USD DEMO broker positions had completed since midnight: 14 after-fee wins, 16 after-fee losses, combined realized net -$441.78. Confirmed Reversal net -$286.07 over 17 trades; Early Transition net -$155.71 over 13. Commission totaled $363.06. All 30 entries had independent expert final state ABSTAIN; 24 of 30 had M1 tactical ABSTAIN. Four alternate Plan-B positions had M1_TREND_CONTINUATION labels despite the reversal/transition entry route; all four closed negative. These are limited historical observations, not proof of a particular future prediction rule.

The owner's instruction was to continue the strategies and improve independent directional validation and risk-responsive entry sizing, WITHOUT restoring a cumulative trade-count quota or changing LIVE.

## Owner and broker scoped opt-in

New switch: IREXPRO_PEPPERSTONE_DEMO_ADVISORY_QUALITY_RISK=enabled. OFF by default. Only after the same configured owner and the actual Pepperstone cTrader USD DEMO account are verified, and an already admitted unlimited-continuous EARLY_TRANSITION/CONFIRMED_REVERSAL advisory is selected, the scheduler can reduce its maximum requested lot. Never alters executable entry authority, original broker stop/TP, any existing positions, spreads, margin, 0.25% per-trade stop risk, overall drawdown restrictions, or independent LIVE accounts. No arbitrary trade count/date cutoff.

New pure-risk artifact: pepperstone-demo-continuous-advisory-quality-risk-v1.

- BOTH trained expert and M1 tactical ABSTAIN: maximum 50% of original suggested volume, not automatically full 3-4 lots. A single abstention caps 75%. Same-side expert votes are not independent confirmed permission.
- M1 TREND_CONTINUATION label mismatched with Plan-B alternate entry: additional 0.65x volume factor, based on observed morning losses, without a blanket block.
- Read fresh completed broker-native M5 and H1 closing-momentum evidence as of the original decision timestamp. M5 against the proposed side by >=0.35 starting stop-distance: additional 0.85 factor. Both M5 and H1 opposed: additional 0.70. Stale, missing, unfinished or future bars are UNAVAILABLE, never claimed to confirm direction.
- Independently query ONLY prior, broker-verified, CLOSED, fully fee-settled positions for exact owner, DEMO connection, instrument, side and Plan-B route. At most eight distinct trades from the prior 24h, closed strictly before decisionTime, computing net after signed commission and swap divided by initial risk-at-stop. If >=3 valid samples, >=60% losses and mean net R negative, multiply by additional 0.70. Incomplete financials or missing risk-at-stop do not enter the denominator. No scanner opinion is treated as an outcome.
- The final factor ranges from 0.20 to 1.00. The actual requested volume is the smaller of the original cap and scaled cap BEFORE the established currency exposure validation and broker-aware sizing. It may still be lower or rejected by legitimate margin/specification checks. A historical DB lookup failure leaves the double-abstain discount in effect, not a hidden full-volume fallback.
- Entry metadata records the pre-screen cap, quality artifact, fraction, reasons, M5 and H1 results, number of complete historical broker samples, and average net R. Does not claim the model was retrained.

## Interpretation and rollback

This is an adaptive DEMO exposure budget, not proof of higher future after-fee expectancy. It may lower profits as well as losses and reduce some otherwise fillable orders. Unlike a static restrictive gateway, it allows ongoing trials so long as the original broker and risk gates permit.

Disable only this overlay by setting IREXPRO_PEPPERSTONE_DEMO_ADVISORY_QUALITY_RISK=disabled and restarting the API. Previous progressive TP-relative profit retention, risk-check execution, continuous study and original broker SL/TP remain.

Required: pure-helper edge tests, scheduler end-to-end signal sizing test after four prior entries without a quota, production Nest build, version push, explicit feature opt-in, PM2 restart, compiled code/status confirmation, and post-deploy observed fill metadata validation if a real DEMO order is executed.
