# Sprint 56 Architect Readiness Boundaries

This note records the post-delivery architect review of Sprint 56 / PR #287.
It is intentionally release-truth documentation: it does not change provider
capabilities, execution behavior, risk behavior, or production-LIVE eligibility.

## What PR #287 establishes

- A cTrader Open API adapter implementation exists and is contract/unit tested.
- cTrader, Pepperstone-via-cTrader and IC-Markets-via-cTrader remain BETA.
- Their `productionLiveVerification` status remains `UNVERIFIED`; BETA status
  does not authorize production-LIVE use.
- Demo/live provider endpoints are separated in the cTrader client.
- Provider application authentication, account authentication, heartbeat,
  request correlation, bounded reconnect attempts and provider request-rate
  budgets are implemented in the backend adapter layer.
- Evidence-based DEMO validation is tenant-scoped and cannot set
  `productionLiveVerification`.

## What PR #287 does NOT establish

### End-user cTrader OAuth onboarding

The backend contains cTrader OAuth URL/token primitives, but PR #287 does not add
an end-to-end web/mobile consent initiation and callback journey. The existing
mobile broker screen remains the generic account-id/API-token connection flow.
Therefore Sprint 56 must not be described as complete end-user cTrader OAuth.

Tracked in issue #289: `cTrader: complete server-owned OAuth onboarding for web and mobile`.
Until #289 is completed, cTrader OAuth credentials are suitable only for
controlled/operator integration testing; normal users should not be required to
obtain or paste provider access/refresh tokens as the final production UX.

### Shared mutable adapter connection context

The current `IBrokerAdapter` contract on main is stateful (`setMode`, implicit
current account, parameterless account reads/disconnect). MetaTrader and OANDA
already use this pattern, and the Sprint 56 cTrader adapter follows it. Because
Nest providers are singleton by default, concurrent broker operations require a
platform-level context-isolation hardening rather than a cTrader-only workaround.

Tracked in issue #288: `Security: eliminate shared mutable broker-adapter connection context`.
The fix must make every provider operation target an explicit connection/account
context and add adversarial multi-user concurrency coverage.

## Release interpretation

PR #287 may be evaluated as a **backend BETA/provider-verification slice** only.
It must not be used as evidence that every researched broker is implemented, that
web/mobile cTrader OAuth onboarding is complete, or that any BETA/UNVERIFIED
provider is production-LIVE verified.

Production readiness for cTrader-backed providers additionally requires:

1. approved platform/provider application credentials;
2. completion of #288 and #289;
3. operator-run DEMO verification evidence;
4. provider-specific production-LIVE verification evidence;
5. exact-head repository CI/security gates on the final candidate.
