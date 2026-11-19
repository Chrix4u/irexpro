# Owner DEMO historical-loss recovery sizing — 19 November 2026

The owner requested that Start/Stop control discretionary DEMO strategy pauses. A new USDCAD BUY at 00:42:35 UTC on 19 November executed at **0.01 lot**, revealing a separate, older loss-history recovery-canary constraint. The order metadata explicitly identified `EARLY_LOSS_STREAK_RECOVERY_CANARY` and `m1_pepperstone_demo_pre_screen_lot_cap=0.01`; this was not caused by the recently removed strategy-loss brake.

## Change

With `IREXPRO_OWNER_DEMO_LOSS_PAUSES_ADVISORY_ONLY=enabled`, when the scanner independently verifies the same configured owner, a non-deleted Pepperstone cTrader **USD DEMO** broker connection, and an **ACTIVE FULL_AUTO** broker-bound trading session, the historical-loss recovery-canary's fixed **0.01-lot ceiling** and **240-minute repeat cooldown** become advisory. The existing historical-loss reason is retained in the recorded M1 decision. This does not modify already-open positions or revoke a stop-loss.

The scope change does **not** disable the original model/expert and Plan-B admission requirements for the recovery path. It does not waive broker execution checks, spreads, valid stop-loss/target, 0.25% DEMO maximum stop-risk, account risk, portfolio exposure, margin, or currency-concentration checks. It does not guarantee any requested minimum lot size. Existing special independent canaries—including cross-sleeve reversal and qualified continuation probation—retain their own separate caps and spacing. All other users, accounts, LIVE accounts and stopped sessions retain the prior small-size canary behavior.

## Proof / audit

- Unit tests cover exact-owner DEMO verification and preservation of the original 0.01 cap outside scope.
- A scheduler integration regression test models old M1 loss evidence followed by an otherwise admitted Trend Continuation signal, asserting normal volume cap and no historical-canary cooldown. The original legacy test continues to assert 0.01 lot and four-hour spacing outside scope.
- Scanner governance records `ownerDemoRecoveryCanarySizing` with `historicalLossRecoveryAdvisory`, `volumeCap`, and `enforceHistoricalCanarySpacing`, permitting after-the-fact verification.
- The rule does not set an arbitrary minimum of 3/4 lots; broker risk must size or reject the entry.

This is an owner-scoped DEMO trading behavior update. Evaluate new realized net P&L after commissions and do not promote to LIVE solely because trade frequency increases.
