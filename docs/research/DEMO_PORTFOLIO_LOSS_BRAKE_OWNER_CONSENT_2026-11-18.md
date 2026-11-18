# Owner-controlled DEMO portfolio-loss pause

18 November 2026. Scope: the authenticated owner of the active Pepperstone cTrader USD DEMO FULL_AUTO account. LIVE and other users are never eligible.

## Problem

On 18 November, three consecutive net DEMO losses (-$39.26, -$37.96, -$81.88; -$159.10 total) activated the two-hour portfolio-wide loss-streak entry brake. It silently prevented entries from 12:05:33 to 14:05:33 Ghana time, despite scanner activity and some qualified Early Transition/Confirmed Reversal alternatives.

## Implemented policy

The authenticated owner receives a visible AI Trader banner and a risk-warning popup on each NEW, unacknowledged active portfolio pause, updated through polling every 12 seconds. It shows actual losses, expiry and implications. Choices:

- Keep trading paused: persist the owner's WAIT selection.
- Review later: close dialog while maintaining the visible warning banner, without approving an override.
- Explicitly check the risk acknowledgement and select Accept risk — Resume DEMO entries: record RESUME only for this exact loss incident, with user/session/broker association and a time-limited expiration.
- Reinstate safety pause: a later WAIT decision revokes consent for this same incident.

Authenticated API endpoints:
- GET /api/v1/ai/external/vps-forex/m1-tactical/portfolio-loss-pause
- POST /api/v1/ai/external/vps-forex/m1-tactical/portfolio-loss-pause/decision

Every decision is append-only in the new migration-created trading.demo_portfolio_brake_consents table. The incident closed timestamp must match the current real broker close. RESUME requires affirmative boolean acknowledgement. The latest decision wins. Approval is limited to the original 120-minute pause and active, same owner/broker USD DEMO FULL_AUTO session. A newer incident invalidates the earlier approval.

**Only this account's portfolio-loss-streak veto is overridable.** Other broker and account financial controls, daily loss, max drawdown, stop loss and take profit, margin, other strategy brakes, cost/volatility checks, execution gates and lots remain unchanged. The scheduler checks consent again immediately before new order-intent submission. No automatic approval, LIVE promotion, model changes, or broker order directly from the UI.

This UI alert is in-app when the AI Trader dashboard is open. It is not SMS, email or mobile push for a signed-out user. A future centralized notification center could extend notifications to additional risk halt types and channels.

## Test and release

Tests cover owner/account scope, stale and expired incident, consent acknowledgement, a signed settlement sum, HOLD and RESUME transitions, revocation, and UI risk display. Run normal TypeScript/Next/Jest checks, apply migration before restarting the API, deploy the new built UI, verify authenticated status and non-owner unauthorized access. Stopping the DEMO trading session removes the authorization; accepting risk never changes a real-money account.
