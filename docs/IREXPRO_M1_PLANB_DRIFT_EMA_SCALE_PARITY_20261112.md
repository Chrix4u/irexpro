# iRexPro — M1 / Plan B drift feature scale parity
**12 November 2026 | Pepperstone cTrader DEMO | Conservative source fix**

## Confirmed defect

The M1 continuation governance used the SAME frozen six-feature
drift envelope as Plan B, calibrated on the original 4,599-sample
development corpus. However its EMA separation was calculated
incorrectly:

- Plan B, via `m1CandidateToPlanBInput`: `clamp01(alignedEmaSeparationAtr/2)`.
- M1 governance, via `evaluateM1TacticalGovernance`: `Math.max(0,alignedEmaSeparationAtr)`.

As a result, an actual ATR-normalized EMA separation of 0.8868
produced Plan B input **0.4434** (within its 0.050248–0.844420
hard interval), but M1 input **0.8868** (>0.844420, HARD_HIGH).
The persisted **EURUSD SELL at 17:55 UTC** illustrates this:
M1 drift OUT_OF_DISTRIBUTION (only `emaSeparation:HARD_HIGH`);
Plan B drift NORMAL. Other Plan B/authority admission blockers
remained, so this was NOT automatically an executable trade.

Real-day after-13:00 read-only ledger analysis found 65 routed
records with EMA `HARD_HIGH` diagnostics and 1 example where
the mismatch alone accounted for the M1 out-of-distribution
classification. The original raw EMA may exceed the calibrated range
even though `raw/2` does not. Many other records had independent
extension/RSI/market-regime vetoes and stay blocked.

## Fix

M1 drift governance now uses
`Math.max(0,Math.min(1,alignedEmaSeparationAtr/2))`, matching
the Plan B transformation *before* the shared calibrated envelope.
Its M15 strength is now clamped to [0,1] on the same shared scale.
The envelope numerical boundaries remain unchanged.

Regression tests assert:
- raw EMA separation 1.04 (correct normalized 0.52) no longer
  generates false M1 EMA hard-high OOD;
- raw 1.82 (normalized 0.91) remains genuinely OOD and blocked;
- market spread, macro-event, full-sleeve, higher-timeframe and
  invalid/negative payoff checks retain their existing vetoes.
- no changes to stop, margin, account risk, volume, rollout,
  Plan B coefficients, target geometry or broker code.

## Do not infer trading profitability

This is **feature-calculation correctness**, not a trading signal or
out-of-sample proof. In the independently checked latest AUDUSD
prospective episodes, 8 priced full-path candidates were negative
after estimated costs over 3–10 minutes. The independent M1 route
should not be globally promoted to DEMO execution from these data.

Acceptance requires a future actual broker-native filled trade that
passes other independent constraints; passing this correction and
unit tests alone is NOT restoration of continuous trading.
