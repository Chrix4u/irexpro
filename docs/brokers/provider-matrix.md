# iRexPro Broker Integration Matrix

> Sprint 50 — server-authoritative broker support matrix (Directive §AC/§BD).
>
> **Honesty rule:** this matrix reflects implementation evidence in the
> repository, NOT marketing claims. A broker is only `SUPPORTED` when a
> runtime adapter exists and its capabilities are covered by tests. Rows
> marked `RESEARCH_REQUIRED` need operator verification against current
> official provider documentation before any build begins.

## Legend

| Status | Meaning |
| --- | --- |
| SUPPORTED | Adapter registered at runtime; capability contract tested; live-verified or fully covered by integration tests |
| BETA | Adapter implemented + registered + shared §AN contract suite passing; NOT yet live-verified against the provider |
| NOT_STARTED | Catalog entry exists; no adapter (fail closed at runtime) |
| PARTNER_APPROVAL_REQUIRED | Planned route needs operator/partner approval before build |
| RESEARCH_REQUIRED | Candidate broker; official API/eligibility must be verified first |

**BETA ≠ production-LIVE.** Implementation status describes the adapter
evidence only — it is never production-LIVE approval. See
[Production-LIVE verification](#production-live-verification) below.

## Matrix

| Broker / Platform | Connection route | Adapter in repo | Demo | Live | Environments | Auth model | Status | Test coverage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| MetaTrader 4/5 (via MetaApi) | METATRADER | `metatrader.adapter.ts` (591 LOC) | ✅ | ✅ | DEMO, LIVE | API token (`METAAPI_TOKEN`) | **SUPPORTED** — production-LIVE **VERIFIED** (`evidenceRef: production operation — MetaApi bridge, live in production`) | Margin, connection, schema specs + provider contract tests |
| iRexPro Paper Broker | PAPER | `paper-broker.adapter.ts` | ✅ | ❌ (by design) | DEMO | Session (internal) | **SUPPORTED** | Paper adapter specs; LIVE-isolation enforced by registry |
| OANDA (v20 REST) | NATIVE_API | `oanda/oanda.adapter.ts` (Sprint 51 PR-7) | ⚠️ | ❌ fail-closed | DEMO (fxpractice) — LIVE (fxtrade) declared but **UNVERIFIED** | Personal access token (encrypted at rest) | **BETA** — production-LIVE **UNVERIFIED** | Shared §AN contract suite + 107 unit/contract tests; live verification pending (see `oanda-v20-adapter.md`) |
| cTrader Open API (multi-broker) | CTRADER | — | ⚠️ | ⚠️ | DEMO, LIVE planned | OAuth 2.0 (per-broker app approval) | **PARTNER_APPROVAL_REQUIRED** — honestly blocked on partner approval; no adapter, no fabrication | None — requires OAuth app + partner approval |
| Pepperstone (via cTrader/MT4/MT5) | CTRADER / METATRADER | — (reuse cTrader/MT adapter) | ⚠️ | ⚠️ | TBD | TBD | RESEARCH_REQUIRED | None |
| IC Markets (via cTrader/MT4/MT5) | CTRADER / METATRADER | — (reuse adapters) | ⚠️ | ⚠️ | TBD | TBD | RESEARCH_REQUIRED | None |
| FP Markets (via cTrader/MT4/MT5) | CTRADER / METATRADER | — (reuse adapters) | ⚠️ | ⚠️ | TBD | TBD | RESEARCH_REQUIRED | None |
| IG | NATIVE_API | — | ⚠️ | ⚠️ | TBD | API key + session | RESEARCH_REQUIRED | None |
| Saxo Bank | NATIVE_API (OpenAPI) | — | ⚠️ | ⚠️ | TBD | OAuth 2.0 | RESEARCH_REQUIRED | None |
| FXCM | SDK / FIX | — | ⚠️ | ⚠️ | TBD | TBD | RESEARCH_REQUIRED | None |
| Interactive Brokers | Client Portal / TWS / FIX | — | ⚠️ | ⚠️ | TBD | OAuth / gateway session | RESEARCH_REQUIRED | None |

⚠️ = capability believed available from public provider documentation but
**not verified against current official docs from this repository** — an
operator must confirm before implementation (Directive §AA: platform
availability ≠ third-party integration permission).

## Registry contract

The runtime source of truth for this matrix is
`apps/api/src/modules/broker/registry/`:

- `broker-catalog.ts` — versioned static definitions (`BROKER_CATALOG`, v1)
- `broker-provider-registry.service.ts` — merges catalog with live adapter
  availability. **A catalog entry without a registered adapter can never be
  reported as `SUPPORTED`** (enforced + tested in
  `broker-provider-registry.spec.ts`).

Clients (web, admin, mobile) MUST render `GET /api/v1/broker/registry` —
never maintain independent broker lists (Directive §AU).

## Production-LIVE verification

Implementation status (`SUPPORTED` / `BETA` / …) and `adapterAvailable`
describe **what is built**, not **what is approved for production LIVE
execution**. The registry therefore carries a separate, server-authoritative
`productionLiveVerification` object on every entry (architect Phase H):

```jsonc
{
  "status": "UNVERIFIED" | "VERIFIED",
  "verifiedAt": "<ISO date> | null",
  "evidenceRef": "<doc/ticket id — never secrets> | null"
}
```

Semantics:

- **Absent or `UNVERIFIED` ⇒ production-LIVE fails closed.**
  `BrokerProviderRegistryService.isProductionLiveEligible(id)` returns
  `false`, and `BrokerService` rejects with `ForbiddenException`:
  - `createConnection` with `accountType: LIVE` —
    *"Broker X is not production-LIVE verified — LIVE connections are
    fail-closed (BETA is DEMO-only)"*
  - `enableLiveTrading` on any connection —
    *"Broker X is not production-LIVE verified — LIVE trading is fail-closed
    (BETA is DEMO-only)"*
- **`isConnectable` is unchanged** (adapter presence): a BETA provider
  remains connectable for **DEMO** use — the two facts are rendered
  distinctly by UI consumers.
- `VERIFIED` requires **operator-attested evidence**, recorded as
  `verifiedAt` + `evidenceRef` (a doc/ticket reference — never secrets).

Current evidence state:

| Broker | `productionLiveVerification` | Effect |
| --- | --- | --- |
| metatrader5 | `VERIFIED`, `verifiedAt: null`, `evidenceRef: "production operation — MetaApi bridge, live in production"` | LIVE allowed (all other gates still apply) |
| oanda | `UNVERIFIED` | LIVE connections + enable-live fail closed; DEMO connectable |
| paper-broker | not set (materialized `UNVERIFIED`) — LIVE unsupported by design (DEMO-only environments array) | LIVE already rejected by the §11 environment gate |
| ctrader | not set (materialized `UNVERIFIED`) — partner-blocked, no adapter | Not connectable at all; LIVE fail-closed |

### Evidence required before OANDA's production status changes

OANDA stays `UNVERIFIED` until an operator attests
**practice-account verification records** — the full operator checklist in
`docs/brokers/oanda-v20-adapter.md` ("Requirements before SUPPORTED"),
minimally:

1. **Connect**: a real DEMO BrokerConnection against
   `https://api-fxpractice.oanda.com` (OANDA practice personal access
   token) that connects end-to-end.
2. **Account-info round-trip**: `GET /v3/accounts/{id}/summary` reads back
   balance/margin fields correctly for that connection.
3. **Order round-trip on the practice account**: market fill, resting
   limit, SL/TP modification, partial close, close-all, and history —
   recorded against the practice account.

The records (dates, ticket ids, screenshots or exported provider
confirmations) are documented in `docs/brokers/oanda-v20-adapter.md`; then
and only then does `BROKER_CATALOG`'s OANDA entry change to
`productionLiveVerification: { status: 'VERIFIED', verifiedAt, evidenceRef }`
(and the status may move toward `SUPPORTED` per the full checklist). Until
then **no LIVE OANDA connection can be created or enabled** — fail closed,
by code, not by convention.

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

## Implementation order (Directive §AP)

1. ~~Universal broker core (IBrokerAdapter + registry + capabilities)~~ ✅
2. ~~Capability registry + provider matrix~~ ✅ (Sprint 50)
3. ~~Provider contract test suite for existing adapters~~ ✅ (existing specs)
4. cTrader adapter (unlocks Pepperstone / IC Markets / FP Markets in one
   implementation) — blocked on partner approval
5. OANDA native adapter
6. IG, Saxo, FXCM, IB adapters
7. MetaTrader remains the currently supported production route
