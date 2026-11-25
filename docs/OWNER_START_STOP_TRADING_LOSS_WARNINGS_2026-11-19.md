# iRexPro: Start/Stop controls discretionary DEMO trading pauses

Owner clarification on 19 November 2026: the user has **Start Trading** and **Stop Trading** controls and does not want model-specific or historical-loss based pauses applied automatically or an approval modal requiring a choice to resume.

## Execution behavior

The narrowly scoped switch `IREXPRO_OWNER_DEMO_LOSS_PAUSES_ADVISORY_ONLY=enabled` converts the following historical loss-based brakes into **observations, not trading vetoes**:
- Per-instrument / side / strategy recent or persistent loss-streak / negative-payoff cooldowns;
- Account-level two-hour portfolio three-consecutive-net-loss cooldown;
- Five-minute cooldown following a rapid stop-loss.

The existing scanner still records each measured brake and a persisted `ownerLossPausePolicy.warningCodes` / reason in `trading.m1_tactical_decisions`. It does not close open trades or place orders itself. It does not change normal position sizing.

The setting is **fail-closed outside scope**. It is only applicable when ALL of the following can be independently verified:
- The configured `VPS_FOREX_SCANNER_USER_ID` matches the scanner's authenticated user;
- The exact active trading session belongs to that user and is `FULL_AUTO`;
- The broker connection is non-deleted `pepperstone-ctrader`, account type `DEMO`, currency `USD`;
- The explicit deployment environment flag is enabled.

The policy does **not** bypass missing broker cost/currency evidence; missing broker or session identity; model Plan-B admission/quality tests; fresh-price/spread checks; allowed instruments, cost/risk rules, account drawdown/daily loss, margin, stop-loss and take-profit, existing-position conflict checks, stop/start session authority, or the trading system's other qualification requirements. LIVE/PAPER/other broker accounts retain their previous logic.

The previous owner decision endpoints remain accessible for read-only warnings, but the POST action is retired for this particular owner DEMO flag. The AI Trader page no longer presents either the strategy loss restriction modal or the portfolio three-loss approval modal. It shows a compact informational warning and instructs the owner to use **Stop Trading** when they wish to stop.

**Important:** Existing historical records of 17–18 November DEMO trading include significant net losses. Turning off discretionary historical cooldowns is the user's stated DEMO-only preference, not evidence that an entry qualifies or that the model has become profitable.

## Verification

- Unit-test the pure policy with all three active warnings, missing evidence, inactive sessions, LIVE broker and unrelated owner.
- Verify the strategy and portfolio owner status endpoints are informational and the old POST approvals fail.
- Build and deploy the API + web separately with versioned rollback copies.
- Verify real scanner telemetry shows `ownerLossPausePolicy.advisoryOnly=true` and warning codes when a future eligible loss-streak candidate appears. If the next scanner candidate fails model admission, it may still correctly produce no trade.
- Never automatically turn on a stopped AI session: the user's Start button remains the only intended control.

This supersedes the owner-choice workflow in `OWNER_DEMO_STRATEGY_BRAKE_ALERT_2026-11-18.md` for the scoped owner DEMO flag.
