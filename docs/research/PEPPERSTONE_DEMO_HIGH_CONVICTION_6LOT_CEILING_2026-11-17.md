# iRexPro owner-only Pepperstone USD DEMO high-conviction 6-lot *ceiling*
2026-11-17

## Purpose, not a trade-frequency or winning-rate promise
The owner requested that exceptionally strong DEMO predictions may use 4 or 6 lots if broker and account allow, but stop losses must not be made artificially tight. Previously the continuous advisory EARLY_TRANSITION and CONFIRMED_REVERSAL ceiling was 4 standard lots. At ~USD 48,000 equity and a 0.25% per-position stop-risk budget, a 10-pip EURUSD stop on 4 or 6 standard lots would expose approximately USD 400 or USD 600 *before fees* and will not pass the risk gate. The new optional tier is **only a pre-risk maximum cap**, not a fixed minimum, actual lot, or permission to exceed that limit. Raising the ceiling may have no effect in ordinary volatility.

## Toggle and exact eligibility
`IREXPRO_PEPPERSTONE_DEMO_HIGH_CONVICTION_6LOT=enabled`, opt-in. Pure evaluator artifact `pepperstone-owner-demo-high-conviction-6lot-ceiling-v1`, evaluates before final `resolveM1CurrencyExposureGuard`, which still calls `capM1DemoRequestedVolumeByRisk` and the ordinary broker-native cTrader sizing/risk checks.

Only the exact configured user's owner-verified Pepperstone **USD DEMO**, current unmetered continuous advisory, already model-admitted EARLY_TRANSITION or CONFIRMED_REVERSAL, with unchanged usual 4-lot provisional ceiling. Any prior 0.01/0.2 canary, fallback, guarded pullback or alternative tighter cap cannot be boosted; all accounts outside this scope get identical old behavior. No trading quota, fixed cooldown or new entry authority.

**Every** higher-ceiling condition must hold:
- Independent trained expert: `CONFIRM` + admitted, same direction, full broker-native timeframes, mean opportunity probability >=0.70, freshness <=90 seconds. An `ABSTAIN` with two same-direction votes does NOT qualify.
- Plan B: admitted, governance eligible, ensemble confidence >=0.80, direction quality >=0.68, after-fee forecast >=0.45R, broker spread valid, event risk `CLEAR`, not OOD.
- M1: genuine `M1_EARLY_TRANSITION` timing (not ABSTAIN), M1 confidence >=0.70 (current model policy caps M1 confidence at 0.738), M1 direction quality >=0.62, independently computed M5 trend `WITH` the trade, and H1 not opposing or unavailable.
- Risk geometry: original stop width >=1.5 times completed M1 ATR **and** >=3 times observed broker p90 spread; original take-profit >=1.5R. **No stop-loss, TP or risk-budget modifications are permitted** to qualify.
- Existing quality budget factor exactly 1.0 (no soft-risk reduction), no known recent false-reversal/continuation memory flag, not guarded pullback.

If all hold, the optional requested maximum goes from 4 to 6; then **unchanged** pre-execution 0.25% risk-at-stop, aligned-currency exposure, broker margin, min/max volume, spread, daily drawdown, duplicate order, and stop/TP checks apply. The position may still be 0, 1, 2, 4 or 6 lots depending on actual available risk and broker specifications; this does not guarantee any 6-lot fill.

The signal retains audit fields: artifact, eligibility, rejection reason, conditional ceiling, explicit unchanged stop. The experiment must be evaluated on verified commissions-inclusive realized outcomes, not a confidence meter or one day of wins.

## Tests and operations
Six pure tests cover confirmation, owner/LIVE scope, minimum stop geometry, low R, adverse signals, data freshness, and no risk/stop bypass. One real scheduler integration regression exercises the alternate trade path with weak expert: must **not** elevate beyond 4 lots even with toggle on. Nest build, GitHub push, actual owner account preflight and runtime PM2 restart must be verified before claiming activation.

Rollback: set `IREXPRO_PEPPERSTONE_DEMO_HIGH_CONVICTION_6LOT=disabled`, restart only API. Do not disable existing position profit protection, quality weighting, or continuous study. No LIVE changes.
