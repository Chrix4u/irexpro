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

## Correction round 1 (delivered on this branch)

Round 1 closed the 10-point audit of PR #287 (token lifecycle, bounded
in-flight transport, end-to-end web/mobile OAuth flow, adversarial test
batteries, docs). Issue #289's substance (server-owned OAuth onboarding for
web and mobile) was implemented end-to-end in that round.

## Correction round 2 (delivered on this branch — PR #290 review)

The architect's independent code review of PR #290 found four remaining
production-readiness gaps; all four are closed:

1. **Real cTrader transport serialization** — production `send()` now uses a
   bounded single-drain FIFO outbound queue per environment connection
   (never overlapping writes; deterministic overflow; no silent drops; no
   replay on reconnect; payloads never logged).
2. **Replica-safe OAuth authorization state** — the process-local flow Map is
   now the encrypted `broker.broker_oauth_flows` PostgreSQL store with
   PENDING/AUTHORIZED/LINKING/CONSUMED CAS transitions, hard TTLs, and
   cross-instance single-use semantics (authorize on A → complete on B →
   link on A is proven).
3. **Concurrent OAuth refresh protection** — per-connection DB-atomic
   refresh lease + credential-generation CAS across replicas: exactly one
   provider refresh per stale generation, losers adopt the winner's pair,
   no false INVALID, stale responses can never overwrite a newer pair.
4. **Production mobile OAuth callback boundary** — Spotware's authorization
   code now lands on a REGISTERED HTTPS server callback that exchanges it
   server-side and hands the app only a one-time, user-bound, 2-minute
   opaque handoff token via a controlled deep link; the custom scheme never
   carries the provider code, tokens, or secret.

**Issue #289 acceptance evidence (updated):** the server-owned OAuth
onboarding is complete for web AND mobile: authorize (web/mobile channels) →
external consent → server-side code exchange → replica-safe encrypted flow
store → mobile handoff token boundary → account picker → link (LIVE
fail-closed for UNVERIFIED brokers everywhere). Remaining external
dependency: approved Spotware Open API application credentials
(CTRADER_CLIENT_ID/SECRET + registered redirect URIs incl. the mobile HTTPS
callback slots) — an operator/partner action, not a code gap.

**Issue #288 note:** at round 2 it remained open by design (shared mutable
adapter connection context — architect-owned). Round 3 (below) closes its
substance via the #291 connection-scoped factory contract.

cTrader, Pepperstone-via-cTrader and IC-Markets-via-cTrader remain **BETA**
with `productionLiveVerification = UNVERIFIED`; no fail-closed gate was
weakened. Production-LIVE eligibility still requires items 1–5 above.

## Correction round 3 (delivered on this branch — post-round-2 integration corrections)

The architect's post-round-2 review identified eight integration corrections
against the connection-scoped factory/session architecture developed in
#291/#288; all eight are closed (commits `085d35f` + `31f7b23` after
`ba10983`):

1. **Connection-scoped mutable adapter contexts** (findings 1 + 2 + 7) — the
   #291 `BrokerAdapterRegistry` factory/session contract is adopted as the
   ONE mechanism (no competing singleton/factory): metadata-only roots,
   per-`BrokerConnection.id` sessions, ephemeral credential-test adapters,
   alias→canonical resolution sharing the factory/infrastructure (never the
   adapter object), and all four fail-closed factory protections retained.
   This closes the SUBSTANCE of issue #288.
2. **SPOT event correlation** (finding 3) — waiters match
   `ctidTraderAccountId` + symbolId + complete quote; adversarial
   two-account same-environment proof.
3. **Account-session leases** (finding 4) — refcounted ownership per
   adapter context; disconnecting one connection never removes a session
   another requires.
4. **Credential-test lifecycle** (finding 5) — finally-safe disposal on
   success and partial failures without invalidating persisted connections'
   sessions.
5. **Broker alias identity validation** (finding 6) — centralized
   normalization/matching policy on the discovered `brokerTitleShort`;
   fail-closed brand/alias mismatch at adapter connect AND OAuth link;
   generic `ctrader` stays agnostic; no fabricated provider mappings.
6. **BrokerService races** (finding 8) — provider teardown strictly after
   the guarded disconnect transition (lost race = zero side effects);
   suspension release/audit/event only when the guarded transition actually
   won (unguarded status write removed).

Issue #288's substance (shared mutable adapter connection context) is
closed by item 1; the issue itself stays with the architect to re-review
and reconcile with the #291 branch (the contract ported here is byte-level
#291 semantics with the cTrader factory wired that #291 deferred).

cTrader, Pepperstone-via-cTrader and IC-Markets-via-cTrader remain **BETA**
with `productionLiveVerification = UNVERIFIED`; no production-LIVE
fail-closed gate was weakened in any round.
