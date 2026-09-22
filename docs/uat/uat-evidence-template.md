# iRexPro UAT Evidence Record

> Use one copy per controlled UAT session. Never paste passwords, bearer tokens,
> refresh tokens, API keys, API secrets, or encrypted credential blobs.

## Test identity

- Date/time UTC:
- Tester:
- Environment: PAPER / DEMO
- Application URL:
- Git main SHA:
- Research run ID:
- Research decision: MODEL_PROMOTED_PAPER_UAT / MODEL_PROMOTION_HOLD / N/A
- UAT Runtime Smoke run ID/result:
- Authenticated readiness probe result:

## Model evidence

- Model mode:
- Model version:
- Model loaded: true / false
- Model artifact SHA-256:
- Approved for PAPER: true / false
- Approved for LIVE: true / false
- Selected horizon:
- Runtime feature/timeframe profile:
- Confidence threshold:
- Market-data scope: deterministic PAPER / real-provider DEMO
- Six-pair universe verified (DEMO only; N/A for deterministic PAPER): yes / no / N/A
- Pairs missing, if any:

## User / risk evidence

- UAT user ID:
- Onboarding complete: yes / no
- Kill switch clear: yes / no
- Server `canTrade`: true / false
- Risk profile/limits reviewed: yes / no
- Capital allocation:
- Risk rejection codes observed:

## Broker evidence

- Connection ID:
- Broker/provider:
- Broker account ID (non-secret):
- Account environment: DEMO / LIVE
- Connection status:
- Authorization status:
- Credential status metadata:
- Demo validated: yes / no
- Provider environment-truth source:
- Account currency:
- Last health check:

## Trading-session evidence

- Trading session ID:
- Execution mode:
- Authority generation:
- Session start UTC:
- Session end UTC:
- Scheduler enabled: yes / no
- Scheduler registered: yes / no
- Scheduler active: yes / no
- Scan interval:
- Last market-data UTC:
- Market-data age:
- Last decision:
- Last decision reason:
- Last confidence:
- Confidence changed across materially different scans: yes / no / not observed

## Execution lifecycle evidence

For each observed accepted signal/trade:

| Field | Value |
| --- | --- |
| Signal/trade/order ID | |
| Instrument | |
| Direction | |
| Quantity / lot | |
| Entry | |
| Stop loss | |
| Take profit | |
| Provider acknowledgement | |
| Fill state | |
| Open-position state | |
| Close reason | |
| Close confirmation | |
| Realised P&L | |
| Reconciliation result | |

## Start / Stop evidence

- Start confirmation shown: yes / no
- Duplicate Start prevented: yes / no
- Stop confirmation shown: yes / no
- Stop warned about AI-position closure: yes / no
- New exposure blocked before flatten: yes / no
- AI-owned positions targeted:
- Confirmed closed:
- Unresolved:
- Unknown/provider-pending:
- Final session state:
- Stop/flatten evidence reference:

## Manual close evidence

- Manual single-position close available: yes / no
- Position ID tested:
- Confirmation shown: yes / no
- Duplicate-click protection: yes / no
- Close result:
- Unknown outcome handled by reconciliation: yes / no
- Audit event reference:

## Fault / recovery evidence

- Browser refresh retained server-authoritative session: yes / no
- Secondary read-model failure behavior:
- Authentication/session expiry behavior:
- Broker reconnect behavior:
- Provider timeout behavior:
- Provider outage behavior:
- Kill-switch behavior:
- Reconciliation recovery behavior:

## Security / truth checks

- No credential/token leaked in UI/log/evidence: yes / no
- PAPER model remained `approved_for_live=false`: yes / no
- DEMO verification was not represented as LIVE certification: yes / no
- Broker certification and model approval displayed independently: yes / no
- Unknown provider outcome was not fabricated as success: yes / no

## Defects

| Severity | Summary | Issue/PR | Blocking? |
| --- | --- | --- | --- |
| | | | |

## Exit decision

- PAPER pipeline UAT: PASS / HOLD / NOT RUN
- DEMO real-time performance UAT: PASS / HOLD / NOT RUN
- Reason:
- Next action:
- Reviewer:
- Review timestamp UTC:
