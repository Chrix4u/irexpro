# iRexPro Universal Broker Program — Provider Matrix

> Authoritative broker/provider matrix for the iRexPro Universal Multi-Broker
> platform: research evidence, implementation status, capability declarations,
> environment support, production-LIVE verification state, regional (Ghana)
> eligibility, and remaining blockers for every broker evaluated.
>
> **Provenance note.** This document merges two histories: the registry-driven
> matrix from Sprints 50–51 (main) and the Sprint 56 broker-completion research
> program (19-broker landscape, verification program, Ghana findings, source
> log), re-integrated after main moved. Vocabulary is main's
> (`BrokerAvailabilityStatus` × `productionLiveVerification`); the Sprint 56
> verification program is preserved as the evidence layer on top.
>
> **Honesty rule (Directive §AB / §AQ):** this matrix reflects implementation
> evidence in the repository, NOT marketing claims. No status may claim more
> than repo evidence supports — **unit/contract/sandbox tests never flip
> anything to LIVE-VERIFIED.**

## Status vocabulary (never conflated)

Primary axis — the runtime vocabulary of
`apps/api/src/modules/broker/registry/broker-definition.ts`
(`BrokerAvailabilityStatus`), crossed with the separate
`BrokerProductionLiveVerification` evidence field (`UNVERIFIED` / `VERIFIED`):

| Status | Meaning |
| --- | --- |
| SUPPORTED | Adapter registered at runtime; capability contract tested; live-verified or fully covered by integration tests |
| BETA | Adapter implemented + registered + shared contract suite passing; NOT yet live-verified against the provider |
| NOT_STARTED | Catalog entry exists; no adapter (fail closed at runtime) |
| PARTNER_APPROVAL_REQUIRED | Planned route needs operator/partner approval before build (or before real-account use — see the cTrader blocker below) |
| UNAVAILABLE | No legitimate programmatic trading path for iRexPro (API retired, institution-only, or no public API) |

Doc-level research status (not a catalog enum): **RESEARCH_REQUIRED** —
candidate broker whose official API facts are researched (source log below)
but which has no adapter implementation and no catalog entry yet.

**BETA ≠ production-LIVE.** Implementation status describes the adapter
evidence only — it is never production-LIVE approval. See the
[Verification program](#verification-program-how-a-provider-becomes-live-selectable)
below.

### Mapping from the Sprint 56 research vocabulary

The Sprint 56 research used a 6-status model. It maps onto this vocabulary as
follows (nothing was lost, only re-expressed):

| Sprint 56 status | Merged vocabulary |
| --- | --- |
| IMPLEMENTED (paper) | SUPPORTED — DEMO-only by design; production-LIVE verification not applicable |
| IMPLEMENTED (MetaTrader, LIVE retained) | SUPPORTED + production-LIVE **VERIFIED** (retained production route) |
| IMPLEMENTED (OANDA) | BETA + production-LIVE UNVERIFIED |
| IMPLEMENTED, partner-blocked (cTrader + aliases) | BETA + production-LIVE UNVERIFIED + **partner-approval blocker** (see per-broker record) |
| DEMO VERIFIED | Evidence level, not a status: harness-attested DEMO evidence recorded in this matrix + `demoValidated` on the connection |
| PRODUCTION LIVE VERIFIED | `productionLiveVerification.status = VERIFIED` (operator-attested evidence) |
| PARTNER APPROVAL REQUIRED | `PARTNER_APPROVAL_REQUIRED` catalog status, or the partner-approval blocker on a BETA entry |
| RESEARCH REQUIRED | RESEARCH_REQUIRED (doc-level; catalog `NOT_STARTED` once an entry exists) |
| UNSUPPORTED | UNAVAILABLE — the unsupported-with-reasons set below |

## Matrix

| Broker / Platform | Connection route | Adapter in repo | Demo | Live | Auth model | Status | Test coverage |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MetaTrader 4/5 (via MetaApi) | METATRADER | `metatrader.adapter.ts` | ✅ | ✅ | API token (`METAAPI_TOKEN`) | **SUPPORTED** — production-LIVE **VERIFIED** (`evidenceRef: production operation — MetaApi bridge, live in production`) | Adapter, margin, order-state, schema specs + shared contract suite + error-redaction tests |
| iRexPro Paper Broker | PAPER | `paper-broker.adapter.ts` | ✅ | ❌ (by design) | Session (internal) | **SUPPORTED** | Paper adapter + contract suite + always-on verification harness |
| OANDA (v20 REST) | NATIVE_API | `oanda/oanda.adapter.ts` (Sprint 51 PR-7) | ✅ | ❌ fail-closed | Personal access token (encrypted at rest) | **BETA** — production-LIVE **UNVERIFIED** | Shared contract suite + 107 unit/contract tests; live verification pending (see `oanda-v20-adapter.md`) |
| cTrader Open API (universal engine) | CTRADER | `adapters/ctrader/` (Sprint 56) | ✅ | ❌ fail-closed | OAuth 2.0 (operator app + user token) | **BETA** — production-LIVE **UNVERIFIED**, **partner-approval-blocked** for real accounts | cTrader suite: message-types, client protocol, adapter mapping, fake-transport + shared contract suite (150 tests at Sprint 56 implementation) |
| Pepperstone (via cTrader) | CTRADER | shared cTrader engine (alias) | ✅ | ❌ fail-closed | OAuth 2.0 (broker-side approval) | **BETA** — UNVERIFIED, partner approval per broker | Inherits the cTrader engine suite |
| IC Markets (via cTrader) | CTRADER | shared cTrader engine (alias) | ✅ | ❌ fail-closed | OAuth 2.0 (broker-side approval) | **BETA** — UNVERIFIED, partner approval per broker | Inherits the cTrader engine suite |
| IG | NATIVE_API | — | ⚠️ | ⚠️ | API key + session | RESEARCH_REQUIRED | None |
| Saxo Bank | NATIVE_API (OpenAPI) | — | ⚠️ | ⚠️ | OAuth 2.0 | RESEARCH_REQUIRED | None |
| FXCM | SDK / FIX | — | ⚠️ | ⚠️ | SDK session / FIX logon | RESEARCH_REQUIRED | None |
| Interactive Brokers | Client Portal / TWS / FIX | — | ⚠️ | ⚠️ | OAuth / gateway session | RESEARCH_REQUIRED | None |
| FP Markets | CTRADER / METATRADER | — (reuse adapters) | ⚠️ | ⚠️ | TBD | RESEARCH_REQUIRED | None |

⚠️ = capability believed available from public provider documentation but
**not verified against current official docs from this repository** — an
operator must confirm before implementation (Directive §AA: platform
availability ≠ third-party integration permission). Research-only and
unsupported brokers (Deriv, Dukascopy, LMAX, and the excluded set) are
documented in their own sections below.

## Registry contract

The runtime source of truth for this matrix is
`apps/api/src/modules/broker/registry/`:

- `broker-catalog.ts` — versioned static definitions (`BROKER_CATALOG`, v1)
  with `BrokerAvailabilityStatus`, normalized `BrokerCapability` sets,
  environments, connection routes, authentication type, and
  `productionLiveVerification`.
- `broker-provider-registry.service.ts` — merges catalog with live adapter
  availability. **A catalog entry without a registered adapter can never be
  reported as `SUPPORTED`** (enforced + tested in
  `broker-provider-registry.spec.ts`); `adapterAvailable` is rendered
  separately from catalog status.

Clients (web, admin, mobile) MUST render `GET /api/v1/broker/registry` —
never maintain independent broker lists (Directive §AU). The Expo SDK 55
mobile stack merged on main (#210, #283) consumes this same catalog.

## Verification program (how a provider becomes LIVE-selectable)

Three evidence levels exist. Only level 3 changes `productionLiveVerification`,
and only operator action produces levels 2 or 3 — **unit/contract/sandbox
tests never produce DEMO-VERIFIED or LIVE-VERIFIED evidence**:

1. **Implementation evidence** (unit / contract / sandbox tests in this repo)
   — establishes SUPPORTED / BETA status and DEMO connectability. Never LIVE
   approval.
2. **DEMO-VERIFIED evidence** — an operator runs the credential-gated
   verification harness with real DEMO/practice credentials and records the
   sanitized evidence (timestamps, step results, provider order ids — never
   credentials) in this matrix. Per connection,
   `POST /broker/connections/:id/validate-demo` runs the capability-aware
   checklist and sets `demoValidated` (a FAIL **revokes** a stale pass —
   fail-closed). This strengthens main's connect-time auto-write of
   `demoValidated` (a weak connect-implies-validated proxy) into
   checklist-driven validation with audit evidence.
3. **PRODUCTION LIVE VERIFIED** — operator-attested LIVE-environment evidence,
   recorded as `productionLiveVerification: { status: 'VERIFIED', verifiedAt,
   evidenceRef }` in `BROKER_CATALOG`. The only change that flips the field.

### Exactly what flips a state

| State | Flipped by |
| --- | --- |
| Catalog status (SUPPORTED / BETA / …) | Code change in `BROKER_CATALOG` + registered adapter + passing contract suite — never the reverse of evidence |
| `productionLiveVerification` UNVERIFIED → VERIFIED | Operator edits `BROKER_CATALOG` with attested `verifiedAt` + `evidenceRef` (doc/ticket reference — never secrets). Tests never flip it. |
| `demoValidated` (per connection) | `validate-demo` PASS sets it; FAIL revokes it; a successful DEMO connect auto-writes it (weak proxy, re-validated by the checklist) |
| LIVE connection creation / `enableLiveTrading` | Server-side fail-closed gates (below) — no UI override |

### Production-LIVE verification (registry semantics)

`BrokerProviderRegistryService.isProductionLiveEligible(id)` is true only
when the entry is in the catalog, has a registered adapter, and carries
`productionLiveVerification.status === 'VERIFIED'`. Otherwise:

- `createConnection` with `accountType: LIVE` — `ForbiddenException`
  *"Broker X is not production-LIVE verified — LIVE connections are
  fail-closed (BETA is DEMO-only)"*
- `enableLiveTrading` — `ForbiddenException` *"… LIVE trading is fail-closed
  (BETA is DEMO-only)"* (also requires a `demoValidated` DEMO connection,
  CONNECTED state, and explicit LIVE environment support).

`isConnectable` is unchanged (adapter presence): a BETA provider remains
connectable for **DEMO** use — the two facts are rendered distinctly by UI
consumers.

Current evidence state:

| Broker | `productionLiveVerification` | Effect |
| --- | --- | --- |
| metatrader5 | `VERIFIED`, `verifiedAt: null`, `evidenceRef: "production operation — MetaApi bridge, live in production"` | LIVE allowed (all other gates still apply) |
| oanda | `UNVERIFIED` | LIVE connections + enable-live fail closed; DEMO connectable |
| paper-broker | not set (materialized `UNVERIFIED`) — LIVE unsupported by design (DEMO-only environments array) | LIVE already rejected by the environment gate |
| ctrader, pepperstone-ctrader, icmarkets-ctrader | `UNVERIFIED` — additionally partner-approval-blocked (below) | DEMO connectable once OAuth app credentials are supplied; LIVE fail-closed |

### The provider-verification harness (operator program)

The 18-step canonical checklist (connect → account-info → market-data →
positions snapshot → market order → position verify → modify SL/TP → partial
close → full close → trade history → pending limit order → pending modify →
pending cancel → order history → margin info → reconciliation → reconnect →
provider error path) runs from
`verification/provider-verification-harness.ts`. Operator entry points:

- `verification/oanda.demo-verification.spec.ts` — env-gated on
  `OANDA_PRACTICE_TOKEN` + `OANDA_PRACTICE_ACCOUNT_ID`
- `verification/ctrader.demo-verification.spec.ts` — env-gated on
  `CTRADER_ACCESS_TOKEN` + `CTRADER_CTRID_ACCOUNT_ID` (+ platform
  `CTRADER_CLIENT_ID/SECRET`)
- `verification/paper.harness.spec.ts` — always-on (no credentials); proves
  the machinery in CI

**CI is credential-free** — the gated suites report SKIPPED in every CI run.
Every step is PASS/FAIL/SKIPPED with sanitized detail (capability gaps SKIP
honestly); money fields must be decimal strings; evidence is redacted by
construction. The DEMO mode is runtime-guarded (the harness never runs LIVE).

### Evidence required before OANDA's production status changes

OANDA stays `UNVERIFIED` until an operator attests practice-account
verification records — the full operator checklist in
`docs/brokers/oanda-v20-adapter.md` ("Requirements before SUPPORTED"),
minimally: (1) a real DEMO BrokerConnection against
`https://api-fxpractice.oanda.com` connecting end-to-end; (2) account-info
round-trip; (3) the order round-trip on the practice account (market fill,
resting limit, SL/TP modification, partial close, close-all, history). The
records (dates, ticket ids, provider confirmations) are documented there,
then `BROKER_CATALOG`'s OANDA entry may move to `VERIFIED`. Until then no
LIVE OANDA connection can be created or enabled — fail closed, by code.

---

## Per-broker records

### MetaTrader 4/5 via MetaApi (`metatrader5`) — **SUPPORTED** · production-LIVE **VERIFIED**

| Field | Value |
| --- | --- |
| Route/platform | MetaApi cloud (MT4/MT5 accounts of any MetaApi-supported broker) |
| Adapter | `adapters/metatrader.adapter.ts` |
| Official API | [MetaApi cloud SDK](https://metaapi.cloud) (platform token + per-user account UUID) |
| Auth model | API_TOKEN — platform-level `METAAPI_TOKEN`; user-level account UUID in AES-256-GCM-encrypted credentials |
| DEMO support | ✅ (account-type detection `type.includes('DEMO')`) |
| LIVE support | ✅ — production-LIVE **VERIFIED**: the retained production route (live-proven in production via the MetaApi bridge). This is an operator-evidenced retention, not a harness-attested verification — the harness path exists for a formal run. |
| Ghana eligibility | Broker-specific (each MT broker's own onboarding); MT itself imposes no regional constraint |
| Automated trading | Per broker + account (MT EAs/algo trading allowed by brokers generally) |
| Partner approval | MetaApi subscription (existing) |
| Capabilities | As declared in `BROKER_CATALOG`: account/balance/position/order/history reads, market data + streaming, DEMO/LIVE, order placement/modification, close-all, margin calculation. Current implementation is market-order focused — no pending LIMIT/STOP order placement yet. |
| Test evidence | Adapter + margin + order-state + connection/schema specs; shared §AN contract suite; Sprint 56 error-redaction hardening (provider errors pass through `redactString` — credential markers never leak) |
| Remaining blockers | None for current scope; pending-order placement types are future adapter work |

### iRexPro Paper Broker (`paper-broker`) — **SUPPORTED** · DEMO only

| Field | Value |
| --- | --- |
| Route/platform | Internal deterministic simulator (no external calls, ever) |
| Adapter | `adapters/paper-broker.adapter.ts` |
| Official API | n/a (simulated) |
| Auth model | n/a (SESSION_AUTH, internal) |
| DEMO support | ✅ (it *is* the paper/DEMO environment) |
| LIVE support | ❌ — `environments: ['DEMO']`; never a LIVE-money provider; the service gate fails LIVE creation closed |
| Ghana eligibility | n/a (internal) |
| Automated trading | n/a |
| Partner approval | none |
| Capabilities | Market + working LIMIT/STOP/STOP_LIMIT orders, modify, cancel, positions, partial close, close position, close-all, SL/TP, order + trade history, margin info, account info, pricing, market data (NOT streaming — truthful) |
| Adapter status | Realistic deterministic order lifecycle (Sprint 56, re-ported): working orders with honest fill rules, positions with SL/TP triggers, partial closes, closed-trade history, idempotent replay; injectable price feed + clock, zero randomness, decimal-string money |
| Production-LIVE verification | **Not applicable** (PAPER provider) |
| Test evidence | Paper adapter spec (60 tests at Sprint 56 implementation) + shared contract suite + the always-on 18-step `paper.harness.spec.ts` |
| Remaining blockers | none |

### OANDA v20 (`oanda`) — **BETA** · production-LIVE **UNVERIFIED**

| Field | Value |
| --- | --- |
| Route/platform | OANDA v20 REST (practice/live strictly isolated) |
| Adapter | `adapters/oanda/` (main's Sprint 51 PR-7 implementation — authoritative; the Sprint 56 parallel implementation was superseded) |
| Official API | [developer.oanda.com/rest-live-v20](https://developer.oanda.com/rest-live-v20/) (23 reference pages read during Sprint 56 research; hosts probe-verified) |
| Auth model | `Authorization: Bearer <personal access token>` (user-level, from the fxTrade account portal; stored AES-256-GCM-encrypted) |
| DEMO support | ✅ `api-fxpractice.oanda.com` (practice token) |
| LIVE support | `api-fxtrade.oanda.com` exists but LIVE is **fail-closed** (`productionLiveVerification: UNVERIFIED`). Directive: OANDA stays UNVERIFIED until genuine provider verification evidence exists — passing unit/contract tests NEVER flips this. |
| Ghana eligibility | ⚠️ **Compliance flag**: OANDA's region selector (read live) does not list Ghana; African countries route to OANDA Global Markets Ltd (BVI, FSC SIBA/L/20/1130) — and v20 API accounts are documented as unavailable to the Global Markets/TMS divisions. Ghana-resident OANDA LIVE onboarding is effectively unavailable; practice tokens remain usable for development. Do not promise OANDA LIVE to Ghana-based users. |
| Automated trading | ✅ (API by design; 120 req/s per IP documented) |
| Partner approval | none (personal token from the account portal) |
| Capabilities | As declared in `BROKER_CATALOG` (account/balance/position/order/history reads, market data, REST, API_TOKEN, DEMO/LIVE, order placement/modification, close-all, margin calculation). Honest omissions: no `MARKET_DATA_STREAMING` (REST polling; v20 SSE streams documented but unused), no stop-limit order type (v20 retail FX spot has none — guard fails closed). `clientExtensions.id` carries the idempotency key (duplicate rejection mapped to `DUPLICATE_ORDER`); the local `idempotency_key` + advisory lock stays authoritative. |
| Adapter status | **BETA** — implemented, registered, contract-tested (see `docs/brokers/oanda-v20-adapter.md` for the full engineering record: endpoint mapping, error model, environment isolation) |
| Production-LIVE verification | **UNVERIFIED** — the env-gated operator harness (`oanda.demo-verification.spec.ts`) is the path to DEMO-VERIFIED; LIVE requires live-environment evidence recorded in `BROKER_CATALOG` |
| Test evidence | Shared §AN contract suite + 107 unit/contract tests |
| Remaining blockers | Operator verification runs (DEMO + LIVE) with real credentials; Ghana compliance decision |

### cTrader Open API (`ctrader`) — **BETA** · universal engine · **PARTNER-APPROVAL-BLOCKED**

| Field | Value |
| --- | --- |
| Route/platform | cTrader Open API 2.0 (Spotware) — one universal engine covers **any cTrader-affiliated broker** (account-level `brokerTitleShort` discovered at runtime) |
| Adapter | `adapters/ctrader/` (transport, client service, adapter, OAuth helpers, message types) |
| Official API | [help.ctrader.com/open-api](https://help.ctrader.com/open-api) · [openapi.ctrader.com](https://openapi.ctrader.com) · [.proto messages](https://github.com/spotware/openapi-proto-messages) |
| Auth model | OAuth 2.0: application `client_id`/`client_secret` (platform env `CTRADER_CLIENT_ID/CTRADER_CLIENT_SECRET`, operator-supplied) + user consent (`id.ctrader.com/my/settings/openapi/grantingaccess/`, scope `trading`) → user access token (encrypted at rest); token endpoint `openapi.ctrader.com/apps/token` |
| Protocol | **JSON over WebSocket** (officially supported on port 5036 only): `{"clientMsgId", "payloadType", "payload"}` with clientMsgId-echo matching; heartbeat (payloadType 51) every 10s; rate limits 50 req/s general / 5 req/s historical; DEMO `wss://demo.ctraderapi.com:5036` vs LIVE `wss://live.ctraderapi.com:5036` — hard isolation, never crossed (verified via account discovery `isLive` cross-check) |
| DEMO support | ✅ |
| LIVE support | Environment supported by the protocol, but LIVE is **fail-closed** (`productionLiveVerification: UNVERIFIED`) |
| Ghana eligibility | Broker-specific (cTrader brokers serving Ghana — see the Pepperstone/IC Markets records) |
| Automated trading | ✅ by design (OAuth-scoped trading) |
| Capabilities | Full truthful surface: all four order types (MARKET/LIMIT/STOP/STOP_LIMIT), modify (incl. post-fill SL/TP amend), cancel, positions, partial close, close position, close-all, SL/TP, order + trade history, margin info, account info, pricing, market data (NOT streaming — request/response). MARKET-order SL/TP attach post-fill via position amend (proto forbids them on the new-order message); a failed amend throws — the fill is real but the position is flagged for reconciliation, never a dishonest success. |
| **Partner approval (the blocker)** | **REQUIRED before any real-account usage**: an Open API application must be registered at openapi.ctrader.com with a cTrader ID and approved by Spotware (manual email review). Until the operator supplies the approved app's `CTRADER_CLIENT_ID/SECRET`, the adapter is implemented and contract-tested but real-account connect fails closed (`AUTHENTICATION_FAILED`, unconfigured credentials never open a socket). The Playground (own-cTID token) exists for initial testing. Server-side `clientOrderId` dedupe is undocumented — local idempotency + advisory lock stays authoritative. |
| Adapter status | **BETA** — implemented this sprint (JSON/WS, OAuth2, full trading surface, contract-tested; zero new npm dependencies — Node native WebSocket + fetch); idempotency key propagates to `clientOrderId` + `label` + `comment` |
| Production-LIVE verification | **UNVERIFIED — externally blocked on partner approval + real credentials** (operator harness: `ctrader.demo-verification.spec.ts`, env-gated) |
| Test evidence | cTrader suite (message-types, client protocol, adapter mapping, fake-transport, contract suite — 150 tests at Sprint 56 implementation, re-ported to main's interface) incl. host isolation, redaction, error-code mapping, execution-event semantics; correction round 1 added the adversarial battery (in-flight ceiling, concurrent correlation, duplicate-heartbeat/zombie-timer, pool-isolation, credential-fragment redaction, log-payload secrecy); correction round 2 added the deterministic transport-serialization suite (exact wire order under 300+50 concurrent submissions, single-drain re-entrancy, queue ceiling, disconnect-with-queued, heartbeat-FIFO, DEMO/LIVE outbox independence, payload secrecy) + client send-failure mapping |
| Token lifecycle (correction round 1) | Access-token expiry tracked inside the encrypted credential (`additionalParams.accessTokenExpiresAt` + `refreshToken`); `BrokerOAuthTokenLifecycleService` refreshes BEFORE provider use when expired/near-expiry (5-min margin) and persists the new pair ATOMICALLY (one UPDATE: ciphertext+iv+tag+keyId+ROTATED) BEFORE it is used — cTrader invalidates the previous pair on refresh. Rejected refresh → credential INVALID (fail-closed, re-authorization required); transient refresh failures never poison the credential. Wired into `connectBroker` + `healthCheck` (reconnect/health paths always run on the current token). |
| Token lifecycle (correction round 2 — concurrent refresh) | Cross-replica serialization on `broker_connections`: a DB-atomic refresh LEASE (`credential_refresh_lease_expires_at`, 30 s, self-expiring) allows exactly ONE provider refresh per stale `credential_generation` (a hung winner's lease expires — no stall); losers bounded-wait and ADOPT the winner's persisted pair (never a second provider call, never a write, never a false INVALID because another request rotated successfully); persistence is a generation CAS (`credential_generation = observed+1 WHERE = observed`) so a stale refresh response can NEVER overwrite a newer pair (adopts it); exactly one rotation audit event per generation. Proven: 20 simultaneous `ensureFreshTokens()` → provider refresh count EXACTLY 1, all callers adopt the same new generation, stored credential stays ROTATED, no false INVALID (concurrency spec + PG-integration spec for CI). |
| Transport serialization (correction round 2) | Production `send()` passes EVERY frame through one bounded FIFO outbox per environment connection with a SINGLE drain loop (never overlapping writes, re-entrant sends only enqueue); deterministic backpressure via typed `CtraderTransportSendError('queue-overflow'|'not-open')` — no silent drops; heartbeat enqueues FIFO (never reorders requests); disconnect/intentional close clear the queue (no replay on reconnect); payloads never logged. |
| OAuth flow store (correction round 2 — replica-safe) | Flow state is the `broker.broker_oauth_flows` PostgreSQL table (replaces the process-local Map): server-generated opaque ids bound to user/broker/redirect URI; explicit PENDING/AUTHORIZED/LINKING/CONSUMED states with CAS transitions (single-use complete; single-use link with a 60-s stale-LINKING recovery; a failed link restores AUTHORIZED so the DEMO-fallback UX survives); hard TTLs (10 min pending / 5 min authorized) fail closed + lazy sweeps bound storage; the token bundle is AES-256-GCM encrypted at rest; cross-user lookups behave as not-found. Cross-instance proof: authorize on A → complete on B → link on A; exactly-one concurrent consumers; third-instance restart continuation. |
| User OAuth connection flow (correction round 1) | End-to-end flow implemented: `POST /broker/connections/oauth/authorize` (server-side single-use flow, user-bound, 10-min TTL) → external id.ctrader.com consent (external browser/system browser — cTrader password never captured) → redirect to the platform's registered redirect URI (env `CTRADER_REDIRECT_URIS` allowlist: web callback page + optional mobile deep link `irexpro://broker/oauth/callback`) → `complete` (server-side code exchange with the PLATFORM app credentials + account discovery 2149) → `link` (encrypted credential persistence through the canonical createConnection path; LIVE fails closed for UNVERIFIED brokers — OAuth never weakens the production-LIVE gate). Web UI: onboarding broker page OAuth branch + `/onboarding/broker/callback` account picker. Mobile (SDK55): BrokerScreen OAuth branch with deep-link completion. **Superseded by the correction-round-2 mobile boundary below — the custom scheme is no longer the production provider callback.** |
| Mobile OAuth boundary (correction round 2) | The provider authorization code NO LONGER reaches the app via the `irexpro://` custom scheme. Production flow: cTrader → REGISTERED HTTPS server callback (`GET /broker/connections/oauth/callback[/:slot]`, public, no data in the HTML body) → server exchanges the code IMMEDIATELY and maintains the flow correlation → server issues an opaque ONE-TIME handoff token (32 random bytes, SHA-256 digest + 120 s TTL stored, user-bound, replay/expired/cross-user fail closed) → controlled deep-link handoff `irexpro://broker/oauth/handoff?token=…` (custom-scheme interception yields nothing reusable — no code/tokens/secret ever reach the app) → `POST /broker/connections/oauth/handoff` (authenticated, single-use) → account selection continues. Correlation without a provider `state` parameter uses operator-registered callback SLOTS (`CTRADER_MOBILE_CALLBACK_URIS`, e.g. `…/callback/m1…mN` — exact-registered-URI matching, exactly-one-PENDING-flow-per-slot enforced, ambiguity fails closed HARD): `authorize {channel:'mobile'}` claims a free slot (single slot ⇒ platform-wide serialization — register more slots for parallelism). Web channel unchanged (HTTPS callback page; client-supplied redirect URIs must be HTTPS — custom schemes rejected). Mobile SDK55: external browser + handoff deep-link listener + 10-min await watchdog; Account/Security Center behavior preserved. |
| Adapter context (correction round 3 — #291 factory contract, issue #288 substance) | ONE mutable adapter context per persisted `BrokerConnection.id` via `BrokerAdapterRegistry.getAdapterForConnection` (#291 contract — not a competing mechanism); metadata-only root instances; `createEphemeralAdapter` for credential tests (never cached); aliases resolve to the canonical registration and share the FACTORY + client infrastructure, NEVER the adapter object; four fail-closed factory protections (no-factory / root-singleton output / wrong-provider output / reused-instance output → ConflictException). The cTrader factory is alias-aware: the REQUESTED broker id (`ctrader`, `pepperstone-ctrader`, `icmarkets-ctrader`) is preserved on the isolated adapter (`CTraderAdapter.requestedBrokerId`) for broker-specific verification while `brokerId` stays canonical. All account-operation consumers (BrokerService, ExecutionOrchestrator, StateReconciliation, DEMO validation) resolve through the session API. |
| SPOT event correlation (correction round 3) | Spot waiters require `ctidTraderAccountId` + `symbolId` + complete bid/ask — an event for account B can never satisfy account A's waiter on the shared environment connection. Adversarial proof: two accounts/one DEMO connection, B's event first, wrong-symbol/partial-quote rejections, two concurrent per-account waiters, adapter-level getCurrentPrice race. |
| Account-session leases (correction round 3) | Refcounted lease ownership per adapter context: `ensureAccountSession(env, account, token, owner)` acquires; `removeAccountSession(env, account, owner)` releases ONE owner (session teardown only when the last owner releases; env connection closes when the last session goes); `releaseOwnerSessions(owner)` covers both environments. Disconnecting one BrokerConnection never removes a session another connection using the same cTrader account/environment requires. |
| Credential-test disposal (correction round 3) | `testConnection()` disposes every temporary session in a finally path — success AND partial failures (post-2102 discovery/trader-fetch failures) — via ephemeral adapters; lease refcounting guarantees persisted connections' sessions sharing the account are never invalidated. Rotation validates on an ephemeral context and releases the connection's context only after the new credentials persist. |
| Broker alias identity (correction round 3) | Centralized policy (`ctrader-broker-identity.ts`): the expected identity token derives from the REQUESTED alias id (no fabricated provider-title table); the discovered `brokerTitleShort` (2149) must match after normalization (fail-closed on missing/empty titles) at adapter connect AND OAuth `linkAccount`; generic `ctrader` stays broker-agnostic. An IC-Markets-discovered account cannot connect or link as `pepperstone-ctrader` (and vice versa). |
| BrokerService race ordering (correction round 3) | Disconnect: the guarded persisted-state transition wins BEFORE any irreversible provider teardown (a lost race leaves the provider session + adapter context + no audit side effects for the concurrent winner; a won transition's teardown is best-effort and recoverable; the adapter context is released after both). Health-check suspension: guarded-write-only (the unguarded status write is removed) — release/audit/SUSPENDED-event happen ONLY when the guarded transition actually succeeded. Deterministic race specs cover both. |
| OAuth refresh stale-owner fencing (correction round 4 — finding 1) | Terminal INVALID writes are generation/lease-guarded conditional UPDATEs: a stale refresh owner (expired lease, generation superseded by a takeover winner's N+1) can NEVER poison the newer usable pair and never emits a false refresh-failed audit against it — it converges onto the newer pair. Genuine current-owner rejection marks exactly that generation INVALID once, releases its own lease atomically, one sanitized audit. Proofs A-F incl. PostgreSQL integration. |
| OAuth LINKING exactly-once (correction round 4 — finding 2) | The stale-LINKING reclaim window is REMOVED: AUTHORIZED → LINKING is single-shot (no timeout reclaim, no cross-replica reclaim). A paused linker can never be overtaken; different-account takeover rejected with zero side effects; exactly one connection, one linked audit, one flow consumer, no account-selection mutation. Crashed linker → recovery by EXPIRY (user restarts OAuth). |
| Transport write certainty (correction round 4 — findings 3+4) | A synchronous socket-send failure mid-drain is never swallowed: the uncertain frame (WRITE_ATTEMPTED_OUTCOME_UNKNOWN) is never replayed; the unwritten queue is cleared + REPORTED (NOT_WRITTEN); the transport generation is marked unhealthy; the client is notified IMMEDIATELY (onWriteFailure) — pending requests fail with per-frame certainty, never starve to the 10 s timeout; reconnection uses a NEW transport generation. Every event callback is generation-fenced (monotonic transportGeneration per attach) AND socket-identity-fenced inside the transport — an old socket's message/close/error/late-open can never act on the current generation. Frame/token contents never logged. |
| Provider-dispatch certainty + reconciliation (correction round 4 — findings 5-7) | `ProviderDispatchCertainty` (DEFINITELY_NOT_SENT / SENT_RESPONSE_RECEIVED / MAY_HAVE_REACHED_PROVIDER) on every state-changing failure (PLACE/CLOSE/CANCEL/MODIFY/CLOSE_ALL) across MetaTrader, OANDA, cTrader, paper. Automatic retry ONLY for DEFINITELY_NOT_SENT; uncertain writes become RECONCILIATION_PENDING immediately (certainty persisted in reason + audit metadata) and converge via provider READS through the Round-3 connection-scoped adapter — never resubmission, no assumed broker-side dedup. Fill-bearing convergence fixed: applyFill is the authority + guarded resolveReconciliationFillState (a status write can never invent a fill). |
| Provider identity (correction round 4 — findings 8-10) | Versioned canonical identity model (v1): branded aliases resolve to reviewed families (PEPPERSTONE ['pepperstone'], IC_MARKETS ['icmarkets']) with EXACT title matching — unreviewed variants ("Pepperstone (UK)") fail closed; uncataloged aliases use exact-token equality (substring matching removed). Server-derived identity persisted: `broker_connections.provider_broker_identity` (migration 1753900000000) — sanitized, server-only, NULL = unknown. Identity-scoped LIVE verification: a connection gains LIVE eligibility ONLY from VERIFIED evidence exactly matching its identity; unknown identity fails closed; technology-level evidence never blanket-authorizes. ALL three cTrader-family entries remain UNVERIFIED. |
| Execution authority (correction round 5 — #295/#298/#301/#361) | TradingSession is the authoritative execution target (executionMode + authorityGeneration persisted; one ACTIVE session per user enforced by partial unique; exact-connection binding — no latest-active discovery anywhere). RiskService issues a durable, immutable, short-TTL, single-use RiskGrant binding signal digest + session generation + mode + exact connection + provider identity/verification fingerprint + risk-profile version + control revisions + exact order payload digest. The FINAL DISPATCH BOUNDARY re-verifies every fact from CURRENT durable state immediately before a NEW-exposure provider call and consumes the grant atomically — exactly one dispatch winner; zero provider calls on any drift (session ended, mode changed, connection suspended, credential rotation, kill switch, verification downgrade, grant consumed by a replica). |
| Risk correctness (correction round 5 — #296/#313/#316/#317/#330/#331) | ExactDecimal (fixed-scale BigInt, strict fail-closed parse, exact comparisons, conservative UP/DOWN division) replaces binary floats in all safety-critical math; risk engine has zero :SKIPPED continuations (query failures reject RISK_ENGINE_QUERY_FAILED); daily loss uses the session opening balance; drawdown uses a monotonically CAS-maintained peak equity; maxTradeRiskPercent (risk-at-stop) and maxLeverageAllowed (effective order leverage) enforced; MARKET SL/TP validated against fresh connection-scoped quotes (BUY ask / SELL bid); LOW_LIQUIDITY rejected per profile; unknown regimes fail closed. |
| Durable linking + lifecycle safety (correction round 5 — #332/#302/#314/#315/#303) | OAuth connection linking is idempotent by server-computed logical account key (cTrader aliases canonicalize to one technology; per-user partial unique at INSERT; post-commit audit/event work rides a durable outbox — an audit failure can never make a committed connection look uncommitted; retries ADOPT the existing connection). Signals carry durable (userId, signalId) identity with digest conflict detection + freshness/skew gates. Trade transitions are expected-state CAS (late provider responses never regress reconciled terminal truth). RECONCILIATION_PENDING retains exposure reservation until definitively resolved. Kill switch blocks NEW/INCREASE exposure only — close/cancel/reconcile/risk-reducing remain available. |
| Remaining blockers | 1) Open API application approval + operator-supplied OAuth app credentials; 2) DEMO verification run with a real user token; 3) LIVE verification evidence before LIVE is selectable; 4) GitHub Actions restore + exact-head CI/security matrix (ZERO runs on `64aaa96` — CI truth) |

### Pepperstone via cTrader (`pepperstone-ctrader`) — **BETA** (universal engine alias)

Catalog alias entry reusing the universal `ctrader` adapter (one engine, no
duplicated execution code). Pepperstone offers cTrader
([platform page](https://www.pepperstone.com/en/trading-platforms/ctrader/),
verified live 2026-09-08). DEMO ✅; LIVE fail-closed by the same verification
gate as `ctrader`; the partner-approval chain is Spotware Open API app + a
Pepperstone cTrader account (broker-side OAuth approval). Ghana: Pepperstone
serves international clients incl. Africa (onboarding entity UK/AU; verify
per-client at signup — flagged, not legal advice). Status: **BETA**,
production-LIVE **UNVERIFIED**, partner approval required per broker.

### IC Markets via cTrader (`icmarkets-ctrader`) — **BETA** (universal engine alias)

Same universal engine. IC Markets offers cTrader
([platform page](https://www.icmarkets.com/global/en/trading-platforms/ctrader),
verified live 2026-09-08). DEMO ✅; LIVE fail-closed by the verification gate;
same partner chain. Ghana: IC Markets international entity serves African
clients (verify per-client — flagged). Status: **BETA**, production-LIVE
**UNVERIFIED**, partner approval required per broker.

---

## Sprint 56 correction round 1 (architect 10-point audit)

Corrections landed on `feat/broker-completion` after the architect's review
(local commits only — GitHub suspended at the time; see the worklog):

1. **cTrader OAuth token lifecycle (audit point 1)** — expiry tracking,
   pre-use refresh, ATOMIC access+refresh pair replacement (cTrader
   invalidates the previous pair on refresh), reconnect on the refreshed
   token, fail-closed INVALID on refresh rejection. Adversarial tests prove
   access/refresh tokens and the client secret never appear in HTTP
   responses, audit metadata, logs, exception text, or persisted plaintext
   fields (ciphertext-only at rest).
2. **Demo/live separation (audit point 2)** — unchanged architecture (5036,
   demo/live hosts, per-env connections, isLive cross-check); hardened with
   explicit cross-environment rejection/pool-isolation tests. The iRexPro
   production-LIVE verification rule is untouched: cTrader, Pepperstone and
   IC Markets remain BETA/production-LIVE **UNVERIFIED**.
3. **Heartbeat (audit point 3)** — unchanged (10 s, single timer, cleanup,
   post-auth start, capped reconnect); hardened with duplicate-timer,
   zombie-timer, pre-auth and shutdown tests.
4. **Serialized transport (audit point 4)** — bounded in-flight ceiling
   (500/connection) with fail-fast retryable rejection; concurrency tests
   prove clientMsgId correlation and wire ordering; disconnect rejects all
   pending; reconnect never replays non-idempotent commands.
5. **Rate limits (audit point 5)** — unchanged (50/5 rps token buckets,
   fail-closed, no sleep queue); error messages carry no credential material.
6. **End-to-end user OAuth flow (audit point 6)** — was MISSING (PR #287
   shipped api+docs only); now implemented across API + web + mobile (see
   the cTrader record above). No cTrader password is ever captured; the
   mobile deep link must be operator-registered (server allowlist,
   fail-closed honest message otherwise).
7. **Alias truthfulness (audit point 7)** — catalog wording verified: BETA +
   production-LIVE UNVERIFIED for the whole cTrader family; web/mobile
   render from the server registry (no client-side "LIVE verified" badges;
   LIVE is offered only for VERIFIED entries).
8. **Demo-validation boundary (audit point 8)** — unchanged fail-closed
   semantics (ownership, DEMO-only, server evidence, FAIL revokes,
   productionLiveVerification untouched); adversarial redaction tests kept
   green.
9. **Paper isolation (audit point 9)** — unchanged (self-contained adapter,
   LIVE mode rejected, no cross-provider dispatch, constructor-injected
   feed/clock, dedupe replay); no strategy/model/allocation changes.

## Ghana / regional regulatory landscape (research summary)

- **SEC Ghana** (Securities Industry Act 2016, Act 929, amended by Act 1062):
  no retail FX/CFD margin-broker licensee category; publishes
  unlicensed-entities lists and fraud warnings for online trading schemes
  (22 Jul 2026 notice).
- **Bank of Ghana**: scam alerts for online trading schemes; FX-dealer
  licensing (Act 723) is wholesale/bank-side.
- Net effect (inference, flagged, not legal advice): offshore retail margin-FX
  via foreign brokers is **unregulated but not criminalized for individuals**;
  no local Ghanaian FX-margin brokers with APIs exist.
- iRexPro implications: onboarding flows through offshore entities (Deriv
  SVG, Pepperstone/IC Markets international entities, Dukascopy CH/LV),
  provider-level KYC, and clear risk disclosures referencing SEC Ghana
  warnings. OANDA LIVE is effectively unavailable to Ghana residents (region
  selector + BVI division). The UX must never promise a provider to a region
  it cannot serve.

---

## Automated-trading constraints summary

| Provider | Constraint (researched) |
| --- | --- |
| MetaTrader brokers | EAs/algo trading permitted per broker + account; no MT-level constraint |
| cTrader (all aliases) | Automated trading by design (OAuth `trading` scope); 50/5 req/s; 10s heartbeat |
| OANDA | API by design; 120 req/s per IP (429 has no documented Retry-After) |
| Deriv | Automation endpoints (Start/Pause/Resume/Stop) — retail automation by design |
| Dukascopy | JForex strategies automate by design; FIX 4.4 restricted to professional participants |
| IG | Session-token model (CST/X-SECURITY-TOKEN, RSA password encryption); order-type matrix unverified (docs portal WAF-blocked) |
| Saxo | OAuth2; 24h SIM developer tokens (long-running automation needs token refresh) |
| IBKR | **Structural constraint**: Client Portal gateway requires browser 2FA login — no supported automated login for individuals; session ≤24h with 5-min idle timeout (`/tickle` loop); single session per username; 10 req/s pacing with 429 penalty box. Poor fit for an unattended server-side platform. |
| LMAX Global | Directed at professional clients only (site banner) — pro/prop tier |
| Paper broker | n/a (internal simulator) |

---

## Researched-only brokers (no adapter, no catalog entry — RESEARCH_REQUIRED)

### IG — RESEARCH_REQUIRED
REST Trading API + Lightstreamer streaming; demo `demo-api.ig.com` / live
`api.ig.com` (verified reachable); auth = `X-IG-API-KEY` + RSA-encrypted
password login → `CST`/`X-SECURITY-TOKEN` session headers (mechanics verified
from the official
[ig-webapi-javascript-sample](https://github.com/IG-Group/ig-webapi-javascript-sample));
order confirmations via `GET /confirms/{dealReference}`. Official docs portals
are WAF-blocked from the research sandbox (order-type matrix/rate limits
unverified). Ghana client acceptance **UNVERIFIED** (all IG domains blocked).
Native adapter required (own protocol). Blockers: docs access, Ghana
verification, sprint scope.

### Saxo OpenAPI — RESEARCH_REQUIRED
Full OpenAPI (trading/portfolio/market data/websockets) with OAuth2
authorization-code + client secret (SIM auth `sim.logonvalidation.net`, API
base `gateway.saxobank.com/sim/openapi`; 24h SIM developer tokens; mechanics
verified from official
[openapi-samples-js](https://github.com/SaxoBank/openapi-samples-js)). Order
types incl. Market/Limit/StopIfBid/StopLimit/TrailingStop. Ghana: not in the
home.saxo region list (`en-gh` 404) — effectively not serving Ghana retail
directly. Native adapter required. Blockers: Ghana eligibility, sprint scope.

### Interactive Brokers — RESEARCH_REQUIRED
Client Portal Web API (local Java gateway on localhost:5000; browser 2FA
login; **automated login not supported for individuals**; session ≤24h with
idle timeout 5 min → `/tickle` every ~minute; 10 req/s pacing; 429 penalty
box) + TWS socket API. Paper accounts supported (DU-prefix). Ghana client
acceptance UNVERIFIED (site blocked). The gateway session model is a
**structural constraint for an unattended server-side platform** (documented
in [cpwebapi docs](https://interactivebrokers.github.io/cpwebapi/)). Native
adapter required if pursued.

### Deriv — RESEARCH_REQUIRED (top additional candidate)
Official REST `api.derivws.com` + WebSocket trading channels
(`/trading/v1/options/ws/{public,demo,real}`) + classic WS
`wss://ws.derivws.com/websockets/v3` (live-probed); OAuth2 or personal access
tokens (`Deriv-App-ID` header); automation endpoints (Start/Pause/Resume/Stop)
— retail automation by design; demo (virtual) + live. **Ghana: first-party
VERIFIED** (live API `landing_company 'gh'` → Deriv (SVG) LLC; Ghana KYC doc
set incl. SSNIT/Voter ID; MT5 financial + swap-free also available for 'gh').
25 FX underlyings via the API platform; CFD/spot FX via Deriv MT5 (MetaApi
lane). Recommended as the next adapter (docs:
[developers.deriv.com](https://developers.deriv.com)).

### Dukascopy — RESEARCH_REQUIRED
JForex Java API (strategy automation, Maven SDK) + FIX 4.4 (professional);
demo accounts available (Ghana appears in the demo country dropdown;
restricted-solicit list excludes Ghana). No REST trading API. Java/FIX
integration cost is the blocker.

### LMAX Global — RESEARCH_REQUIRED (professional tier)
FIX 4.4 + .NET/Java APIs; demo environment `web-order.london-demo.lmax.com`
(mirrors live); directed at **professional clients** (site banner); Ghana
UNVERIFIED. Route only pro/prop-tier users if pursued.

### FXCM — RESEARCH_REQUIRED
Officially maintained APIs on github.com/fxcm: ForexConnect
(C++/C#/Java/Python; connect `www.fxcorporate.com/Hosts.jsp`,
Connection="demo"/"Real", username/password; full order-type surface) + FIX
4.4 (institutional; credentials via api@fxcm.com after demo; 200 price
updates/s; Sun 17:00–17:15 ET → Fri 16:55 ET weekly session). The legacy
REST/JSON API portal (`apiportal.fxcorporate.com`) was unreachable from the
research sandbox — current status UNVERIFIED. Ghana UNVERIFIED (site behind
Cloudflare challenge).

### FP Markets — RESEARCH_REQUIRED
cTrader availability **UNVERIFIABLE** from the research sandbox (site
Cloudflare-blocked; the platforms page returns 403; historically offered
cTrader, since reportedly discontinued for new accounts). Not in the runtime
catalog until verified — recorded here honestly. Also reachable via the
MetaTrader lane (MT4/5) like other MT-first brokers.

---

## Unsupported / excluded (with reasons) — UNAVAILABLE

| Broker | Reason |
| --- | --- |
| FOREX.com (StoneX/GAIN) | REST API program retired — `api-docs.forex.com`/`api.forex.com` NXDOMAIN; GitHub org has no public repos (first-party evidence). MT4 lane covers it. |
| City Index | Public API program retired (developers portal NXDOMAIN; GitHub org archived as `cityindex-attic`). CIAPI host alive but undocumented. |
| XTB | xAPI public program appears retired (developers.xtb.com NXDOMAIN; marketing site has no API program). |
| Exness | No public retail trading API (Partner API = affiliate stats; TA API = historical data only). MT4/5 covered by the MetaTrader lane. |
| Swissquote | No public retail trading API (FX FIX = private institutional tier). |
| Plus500 | No client trading API (CF-blocked; no API program found). |
| XM, FBS, OctaFX, HF Markets (HFM), Axi, Tickmill, ThinkMarkets | MT4/5-only (or admin/partner APIs) — fully covered by the MetaTrader lane; no separate programmatic API. OctaFX site 410-Gone. |

---

## Research checklist for every RESEARCH_REQUIRED broker (Directive §AA)

Before any adapter implementation, verify and record:

1. Current platform availability (MT4/MT5/cTrader/native)
2. Third-party connection mechanism (is programmatic access permitted at all?)
3. API availability + current official docs URL
4. Account eligibility (account types allowed to connect)
5. Regional eligibility (incl. Ghana availability and the regulating entity)
6. Authentication method (token / OAuth / session / FIX logon)
7. Demo availability
8. Production availability + partner/ISV approval requirements
9. Terms of service constraints on automated trading
10. Rate limits and streaming support

Outcomes are recorded in this file, and the broker's catalog entry status is
updated to match the evidence (never the reverse).

## Implementation order (Directive §AP — post-merge state)

1. ~~Universal broker core (IBrokerAdapter + registry + capabilities)~~ ✅
2. ~~Capability registry + provider matrix~~ ✅ (Sprint 50)
3. ~~Provider contract test suite for existing adapters~~ ✅
4. ~~OANDA native adapter~~ ✅ (Sprint 51 PR-7; BETA, verification pending)
5. ~~cTrader adapter (unlocks Pepperstone / IC Markets / FP Markets in one
   implementation)~~ ✅ implemented this sprint — real-account use blocked on
   partner approval (operator-supplied OAuth app credentials), verification
   pending
6. MetaTrader remains the supported production-LIVE route (VERIFIED —
   retained production route)
7. Next candidates: **Deriv** (top research pick, Ghana first-party
   verified), then IG / Saxo / IBKR per the research records above

## Source log (official pages read during the Sprint 56 research program)

- cTrader: help.ctrader.com/open-api (getting started, protocol-buffers-json,
  sending-receiving-json, connection, account-authentication, api-application,
  creating-new-app, error-handling, terms-of-use, faq, proxies-endpoints),
  openapi.ctrader.com, github.com/spotware/openapi-proto-messages + OpenApiPy
  + OpenAPI.Net, community.ctrader.com threads (36073, 46632, 46693).
- OANDA: developer.oanda.com/rest-live-v20 (introduction, development-guide,
  best-practices, authentication, troubleshooting-errors, account/order/
  trade/position/transaction/pricing endpoint + definition pages),
  oanda.com/region-selector + /bvi-en (Ghana findings).
- IG: github.com/IG-Group/ig-webapi-javascript-sample (full source).
- Saxo: github.com/SaxoBank/openapi-samples-js (boilerplate, oauth2-code-flow,
  orders, portfolio); live gateway probe (401 OPENAPIAUTHORIZE).
- FXCM: github.com/fxcm/ForexConnectAPI + fxcm/FIXAPI,
  apiwiki.fxcorporate.com Getting Started (archived).
- IBKR: interactivebrokers.github.io/cpwebapi (home/quickstart/authentication/
  endpoints/use-cases) + /tws-api.
- Deriv: developers.deriv.com (api-overview, authentication, ws-demo,
  ws-public), live API probes (landing_company 'gh').
- Dukascopy: dukascopy.com /swiss/english/forex/api/jforex-api/ + /fix-api/.
- LMAX: lmax.com/global + official LMAXGlobal-API-FAQs.pdf (19 pages).
- Pepperstone: pepperstone.com/en/trading-platforms/ctrader/ (accessed
  2026-09-08). IC Markets: icmarkets.com/global/en/trading-platforms/ctrader
  (accessed 2026-09-08). FP Markets: platform pages (Cloudflare-blocked —
  recorded as unverifiable).
- City Index / FOREX.com / XTB / Exness / Swissquote / Plus500 / XM / FBS /
  OctaFX / HF Markets / Axi / Tickmill / ThinkMarkets: official hosts probed
  (NXDOMAIN / 403 / 410 / challenge responses recorded as first-party
  evidence for the exclusion table above).
- Ghana: sec.gov.gh (licensees, unlicensed-entities lists), bog.gov.gh
  (notices).

---

## Round 6 — Unified Execution Authority (WIP branch wip/round6-unified-authority)

Provider verification truth (UNCHANGED — truthfulness policy preserved):
- cTrader (`ctrader`): BETA / production-LIVE **UNVERIFIED** — no verified evidence exists.
- Pepperstone-via-cTrader (`pepperstone-ctrader`): BETA / **UNVERIFIED** (alias, identity-scoped).
- IC Markets-via-cTrader (`icmarkets-ctrader`): BETA / **UNVERIFIED** (alias, identity-scoped).
- MetaTrader 5 (MetaAPI): DEMO-capable; LIVE unverified.
- OANDA v20: BETA (contract-tested).
- Paper broker: internal simulator only.

Round-6 authority chain implemented (all fail-closed for NEW exposure):
signal generatedAt identity digest → user ACTIVE + eligibility/KYC/disclosures →
shared trading-policy revision (cross-replica) → user TradingAuthorityGeneration →
exact ACTIVE TradingSession + generation → durable executionMode → exact
BrokerConnection → credential generation fencing → server-derived provider identity →
shared provider-verification revision → fresh monotonic exact-connection account
snapshot (LIVE) → account currency + DailyRiskPeriod provenance → risk-profile
revision (kill-switch generation) → exact-decimal risk decision → immutable
RiskGrant (canonical authorityBindingDigest, tenant-scoped) → SEMI_AUTO fresh
re-risk after user confirmation → shared execution-control revision →
ProviderDispatchCommitment (single short transaction: grant + confirmation
consumption + order DISPATCH_COMMITTED) → exactly one state-changing provider
attempt → dispatch-certainty reconciliation.

## Round 6 Live-Execution Completion (branch feat/round6-live-execution-completion)

Provider verification truth (UNCHANGED — truthfulness policy preserved):
cTrader / Pepperstone-via-cTrader / IC Markets-via-cTrader remain BETA /
production-LIVE **UNVERIFIED**; MetaTrader 5 remains DEMO-capable / LIVE
unverified; OANDA v2 BETA (contract-tested); paper broker internal. No LIVE
provider verification was fabricated or weakened in this round.

What the completion layer adds ON TOP of the unified authority chain:

- **§1a snapshot routing + instrument seam** — `getBrokerAccountState` reads
  the snapshot authority (no 'USD' fabrication); connect/health/reconciliation
  WRITE accepted snapshots; `getInstrumentSpecForConnection` proves
  contractSize/instrument constraints (the CONTRACT_SIZE_UNAVAILABLE blocker
  is closed).
- **§1b authority-invalidation hooks** — revoke / health-suspend /
  credential INVALID / identity drift (logical re-key) / manual rotate /
  OAuth refresh-rejected all bump the authority generation + invalidate
  NEW-exposure authority.
- **§5/§18 final market-safety gate** — proven fresh quote (30s), spread
  sanity (2%), entry deviation vs the risk-validated reference (1%);
  NEW-EXPOSURE PLACE only; typed fail-closed codes; zero provider calls on
  failure. Unprovable market state is NEVER invented.
- **§7 order-capability contract** — every adapter DECLARES its order-kind
  matrix (OANDA: no STOP_LIMIT — fail-closed at both layers; cTrader:
  MARKET SL/TP deferred to the filled position); the orchestrator enforces
  the declaration PRE-COMMITMENT.
- **§8 protective-order reconciliation** — every OPEN trade's provider
  SL/TP verified against the risk-gate-approved internal authority each
  60s cycle (ExactDecimal, 0.05% rounding tolerance); missing/deviated →
  ONE modifyOrder repair per cycle; refused repair = CRITICAL audit.
- **§10 serialized AI exit pipeline** — POST /ai/internal/exit-signals →
  structure → confidence → session → signal identity (#302 discipline) →
  §14 serialization → closeTrade(AI_CLOSE_SIGNAL); duplicate redelivery
  recovers the first delivery's durable outcome (never a re-close).
- **§12/§19 crash-window convergence** — DISPATCH_COMMITTED orders +
  PENDING trades now ENTER the reconciliation sweep; provider echo by
  clientOrderId proves arrival (provider state applied); absence is
  UNCERTAIN → RECONCILIATION_PENDING + MAY_HAVE_REACHED_PROVIDER (never
  auto-closed).
- **§13/§14 per-account dispatch lease + adversarial exactly-once** — the
  full dispatch critical section is strictly serialized per broker account
  (in-process); concurrent duplicate dispatches produce exactly ONE
  provider call (typed DUPLICATE loser).
- **§16 autonomous session lifecycle** — full state machine; a daily-loss/
  drawdown breach degrades the ACTIVE session to SUSPENDED_RISK_LIMIT
  (CAS + generation bump + grant invalidation).
- **§17 four-level stop** — kill-switch ACTIVATION now emergency-flattens
  every OPEN position (control-exempt, market-safety-exempt closes; one
  refused close never aborts the flatten).
- **§20 audit chain** — trades carry risk_grant_id + order_id + trade_intent_id
  provenance (migration 1754400000000; AI decision → intent → grant →
  order → provider dispatch → outcome → reconciliation is reconstructible
  by direct ids).
