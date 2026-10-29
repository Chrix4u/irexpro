# User-confirmed risk protection reset

Intent: when AI Trading is blocked by DAILY_LOSS_LIMIT_REACHED or MAX_DRAWDOWN_REACHED, the account owner may explicitly confirm a reset and continue. Historical realised P&L is never changed.

Behavior:
- The API requires explicit confirmation on the reset request.
- A reset clears the current daily-loss measurement window and resets the session drawdown baseline to fresh current broker equity.
- For an active SUSPENDED_RISK_LIMIT session, reset happens before authority resumes; authority generation still advances and outstanding grants stay fenced.
- For an ended session, the reset clears the daily-loss window; a new session then receives a fresh equity/peak baseline through the normal start flow.
- Only DAILY_LOSS_LIMIT_REACHED and MAX_DRAWDOWN_REACHED are resettable. Other risk/broker blocks remain fail-closed.
- Reset is scoped to the selected broker account and fully audited.
