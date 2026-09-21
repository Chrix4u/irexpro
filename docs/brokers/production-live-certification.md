# Production-LIVE Certification Protocol

> **Purpose.** This document defines the ONLY legitimate process by which an
> iRexPro broker route may be certified for **production REAL-MONEY
> execution**, the evidence that must exist for every certification claim,
> and the operator tooling that produces that evidence.
>
> **Honesty rule (Directive §AB / §AQ, unchanged).** `SUPPORTED` or
> `productionLiveVerification: VERIFIED` is NEVER inferred from unit tests,
> contract suites, sandbox/paper runs, or the absence of failures. Only
> operator-attested evidence from the REAL provider — produced by the
> certification harness in this document — may support a VERIFIED entry.
> The catalog's verification state is flipped ONLY by an authorized operator
> catalog edit + a matching record in
> [`provider-matrix.md`](./provider-matrix.md); tests NEVER flip it.
>
> **Round 7 status of this document.** The operator tooling described here
> now EXISTS in the repository
> (`apps/api/src/modules/broker/verification/provider-live-certification-harness.ts`).
> No LIVE certification run has yet been executed with it — **every
> non-MetaApi route remains UNVERIFIED** until an operator run produces
> evidence. The MetaApi/MetaTrader route retains its pre-existing
> production-operation attestation (see its record below).

---

## 1. The certification gate (non-negotiable)

Real-money state-changing certification requires ALL of the following, in
order. Any missing element aborts the certification with **zero provider
state-changing calls**:

1. **The environment gate.** `IREXPRO_ALLOW_LIVE_CERTIFICATION=true` must be
   explicitly set in the operator's environment. The setting is
   Joi-validated (absent, empty, or any value other than the exact string
   `true` = disabled). CI never sets it; no GitHub workflow references it.
   A certification run may NEVER be triggered merely because a test suite or
   pipeline executes.
2. **An explicit target.** `brokerId` + the provider `accountId` being
   certified + a credential-source description (the credentials themselves
   NEVER enter the harness, evidence, logs, or the repository — they are read
   from operator environment variables).
3. **An operator identity.** `operatorId` (+ optional `evidenceDir`). The
   operator is accountable for the run and recorded in the evidence artifact.
4. **An explicit maximum canary exposure.** `maxCanaryExposure` — a decimal
   string in the canary instrument's quote currency. The certification order
   size is derived ONLY from the provider's own instrument minimum, capped at
   `min(provider minimum × 1, cap)`, floored to whole lot-step multiples. It
   is **never** derived from an AI signal, a strategy, or any market view. If
   the provider minimum exceeds the cap, the harness refuses with zero
   orders.
5. **LIVE classification proven by the provider.** The adapter runs in LIVE
   mode and the provider-observed account classification must be LIVE. A
   provider reporting DEMO under a LIVE certification is an immediate FAIL
   (mirroring the connect-time and health-check enforcement in
   `broker.service.ts` — a mislabeled environment is a security event).

## 2. The certification stages

The harness
(`provider-live-certification-harness.ts`) drives the REAL adapter through
the following checklist. Every step records PASS / FAIL / SKIPPED with
sanitized detail; a step whose prerequisite failed is SKIPPED (never silently
attempted); overall PASS requires zero failures, at least one executed PASS,
and the full canary lifecycle:

| # | Stage | What is proven |
| --- | --- | --- |
| 1 | `connect` | Authentication + session establishment with the real credential |
| 2 | `account-discovery` | Account enumeration (SKIPPED with honest reason where the provider has no discovery surface) |
| 3 | `account-state` | Equity/balance/margin as decimal strings + account currency + LIVE classification re-verified |
| 4 | `symbol-metadata` | Contract size, min/step/max size, digits — per-instrument truth, decimal strings |
| 5 | `price` | Fresh quote with bid/ask/spread sanity |
| 6 | `margin-estimate` | Required margin for the canary size (unprovable = FAIL, fail-closed) |
| 7 | `baseline-exposure-snapshot` | Open positions + working orders recorded BEFORE any state-changing step |
| 8 | `place-minimum-safe-order` | The capped canary order on the real account |
| 9 | `verify-provider-ack` | Provider acknowledgement persisted with the provider order id |
| 10 | `query-order` | Order lookup by provider id returns the expected state |
| 11 | `query-position` | Position lookup proves the canary exposure exists |
| 12 | `modify-protective-levels` | SL moved in the risk-REDUCING direction only (SKIPPED where unsupported) |
| 13 | `close-position` | The canary is closed |
| 14 | `verify-closed` | Position gone, close economically reflected |
| 15 | `reconcile-history` | Order/trade history contains the canary, terminal |
| 16 | `verify-zero-unexpected-open-exposure` | Post-close state vs the baseline snapshot: the canary is gone AND **no other position or order appeared** — any unexpected delta is a CRITICAL FAIL |

Stage 16 is the net-safety proof: a certification run that leaves ANY
unexpected open exposure on the account has failed, regardless of the other
stages.

## 3. Evidence artifacts (durable — Round 7.1 P0-2)

On completion the harness writes a sanitized JSON evidence artifact to
`${evidenceDir}/live-certification-<brokerId>-<runId>-<UTC timestamp>.json`
and returns it. The artifact contains: the unique `runId` (generated at run
start, embedded in every artifact name — two same-second runs can never
overwrite each other), the stage table with timestamps, the summary,
`mode: 'LIVE'`, `operatorId`, the masked target account id, the canary record
(instrument, provider minimum, cap, actual size), the baseline/post exposure
fingerprints (counts + masked ids only), and the durability metadata:
`evidenceSha256` (sha256 over the canonical run record), `evidenceState`
(`PERSISTED` / `PERSISTENCE_FAILED`) and `certificationResult`.

**A PASS requires durable evidence (Round 7.1, non-negotiable).**
`certificationResult` may be `PASS` only when every required stage passed AND
the artifact was durably written AND read-back verified (re-read + hash
comparison). If the artifact write or its verification fails — unwritable or
missing evidence dir, disk error, tampered content — the result is the
explicit `EVIDENCE_PERSISTENCE_FAILED` state: the checklist outcome survives
only as ephemeral console output and the run certifies NOTHING. Use the
exported `isCertifiablePass(evidence)` guard; never promote a provider from a
console PASS.

The evidence NEVER contains credentials, tokens, API keys, or
credential-shaped free text (every detail passes the platform's
`redactString` discipline; the target account id is masked with the
platform's masking util).

**Evidence retention.** Operators retain the artifact (and the console
transcript) in the operational evidence store for the lifetime of the
certification plus incident-retention policy. The repository accepts only the
NON-SECRET reference: the catalog `evidenceRef` string + `certificationRunRef`
(`runId@sha256:<hash>`) + `verifiedAt` date point at the retained artifact;
artifact contents are never committed.

## 4. Flipping a catalog entry to VERIFIED (the only path)

1. An operator runs the certification harness for the target broker/account
   with the gate + explicit cap, and retains the evidence artifact.
2. The overall result must be PASS with the canary lifecycle complete.
3. The SAME operator (or a second authorized operator for four-eyes) records
   in `provider-matrix.md` (per-broker record): adapter, auth route, DEMO
   verified?, LIVE verified?, account read, market data, margin, market
   orders, pending orders, modify/cancel, close, reconciliation, provider
   idempotency, timeout recovery, operator evidence reference, verification
   date, remaining limitations.
4. The operator edits `broker-catalog.ts`:
   `productionLiveVerification: { status: 'VERIFIED', verifiedAt: <date>,
   evidenceRef: <artifact reference>, certifiedVia: 'HARNESS_CERTIFIED',
   certificationRunRef: <runId@sha256:<hash> from the durable artifact> }`
   and ships the change through review. Legacy attestations carry
   `certifiedVia: 'LEGACY_ATTESTATION'` with `certificationRunRef: null`
   (truthful — no run reference is ever fabricated). The boot-time
   `SharedControlPlaneBootstrap` syncs the change into the cross-replica
   revision store — grants bound to older verification revisions fail closed
   at the final dispatch boundary. UI/API render the derived
   `certificationState` (`NOT_CERTIFIED` / `LEGACY_VERIFIED` / `CERTIFIED`)
   so historical attestation is never presented as a current protocol
   certification.
5. **Downgrade/rollback.** Any failed re-certification, provider incident, or
   evidence doubt flips the entry back to `UNVERIFIED` (same operator edit
   path). The verification-revision fence invalidates in-flight authority
   immediately — downgrade is fail-closed, upgrade is not automatic, and
   `BETA` is never auto-promoted.

## 5. Broker-by-broker certification state (honest, as of this document)

### MetaTrader 4/5 (via MetaApi) — catalog: SUPPORTED, production-LIVE **VERIFIED** (`certifiedVia: LEGACY_ATTESTATION` → `LEGACY_VERIFIED`)

> **Round 7.1 provenance note:** this VERIFIED state is a LEGACY operator
> attestation (historical production operation) — it PREDATES the Round-7
> certification protocol. No certification harness run was executed for it,
> no dated durable artifact exists, and `certificationRunRef` is truthfully
> null. It is NOT a current protocol certification and must never be
> presented as one. Under the CERTIFIED-only runtime gate
> (`isProductionLiveEligible`) this state is **LIVE-ineligible**: LIVE
> connection creation, enable-live, and LIVE dispatch all fail closed until a
> genuine operator certification run upgrades the entry to `HARNESS_CERTIFIED`
> (with a run reference); nothing upgrades it automatically. Operators follow
> `docs/brokers/live-certification-runbook.md` (`pnpm --filter @irexpro/api
> run cert:live -- metatrader5`).

| Item | State | Evidence |
| --- | --- | --- |
| Adapter | `metatrader.adapter.ts` + `metaapi-client.service.ts` (per-account RPC pooling, idempotency via stable `comment`/`clientId`, full certainty truth table) | repo + adapter/order-state/margin specs |
| Auth route | Platform `METAAPI_TOKEN`; per-user credential = encrypted MetaApi account UUID (AES-256-GCM at rest) | repo |
| DEMO verified? | ✅ harness-attested DEMO path (`demoValidated` flow) | repo |
| LIVE verified? | ⚠️ **legacy attestation only (LEGACY_VERIFIED — LIVE-ineligible)** — `evidenceRef: 'production operation — MetaApi bridge, live in production'`; `verifiedAt: null` (no single attestation date exists in repo history — the weakest evidence form in the program, recorded honestly). The runtime LIVE gate rejects this state; a current certification is REQUIRED for LIVE, not merely recommended | `broker-catalog.ts` |
| Round 7 hardening | Declared-vs-observed account-environment enforcement at connect AND health check (a LIVE MetaApi account declared DEMO is an immediate fail-closed security event); per-symbol `getSymbolSpecification` metadata (the FX-hardcoded geometry is gone — unprovable symbols are omitted, never fabricated); pending-order `cancelOrder` added | `broker.service.ts`, `metatrader.adapter.ts` |
| Account read / market data / margin | ✅ equity/balance/margin decimal strings; per-symbol specs; native margin RPC (fail-closed null) | specs |
| Market / pending orders, modify, cancel | ✅ MARKET/LIMIT/STOP/STOP_LIMIT; position SL/TP modify; pending cancel (Round 7); working-pending-order MODIFY via `conn.modifyOrder` (production-LIVE completion round Phase 4 — routed by working-set lookup, openPrice restated from the provider row, stop-limit limit price preserved); MT4-connected accounts honestly drop STOP_LIMIT from the capability declaration and fail fast on STOP_LIMIT requests (MT4 has no native stop-limit) | adapter specs |
| Close / partial close / close-all | ✅ | adapter specs |
| Reconciliation / provider idempotency / timeout recovery | ✅ open+history order lookup (`synchronizing` = retry-later); stable clientOrderId; certainty truth table (timeout/5xx = MAY_HAVE_REACHED_PROVIDER — never auto-resend) | specs |
| Operator evidence | Production-operation attestation (retained, informational); **a Round 7 harness re-certification is REQUIRED before any LIVE use** — run the operator CLI (`cert:live -- metatrader5`, see the runbook) or the MT5 live-certification spec with the gate + a real account to produce a dated, read-back-verified artifact | this protocol |
| Remaining limitations | getAccountInfo timestamps derive from the server clock (no provider-observed time on some surfaces); ownership = possession of the MetaApi account UUID (platform token reaches all accounts — per-user isolation is MetaApi-scoped); MT5 not yet in the shared §AN contract suite (P2 doc drift) | audits |

### OANDA (v20 REST) — catalog: BETA, production-LIVE **UNVERIFIED**

| Item | State |
| --- | --- |
| Adapter | `oanda/oanda.adapter.ts` (v20 REST; practice/live base-URL separation owned by the adapter; account ownership validated — token must see the account id in `/v3/accounts`) |
| Auth route | Personal access token (encrypted at rest); practice-vs-live environments provider-enforced via environment-scoped tokens |
| DEMO verified? | ✅ credential-gated practice harness (`oanda.demo-verification.spec.ts`, env `OANDA_PRACTICE_TOKEN`) |
| LIVE verified? | ❌ **UNVERIFIED** — fail-closed at createConnection-LIVE, enableLiveTrading, and the final dispatch boundary. Round 7 closed the remaining CODE gaps: pending-order cancel (`PUT /orders/{id}/cancel`), and the Phase-7c crash-window echo alignment (`clientExtensions.id = clientOrderId` so the provider-echo recovery can match). Production-LIVE completion round (Phase 5) added pending-order modification through the official v20 replace endpoint (`PUT /accounts/{id}/orders/{orderId}` — v20 cancels the original and creates a replacement with a new order id, surfaced to callers) and enforces the documented Ghana LIVE unavailability server-side (`liveUnavailableRegions: ['GH']` + risk-gate `PROVIDER_REGION_UNAVAILABLE`). Remaining honest P2s: no `/v3/transactions` recon surface, local margin approximation, no ETag/`X-RequestID` provider idempotency (correctly assumed absent by the write-certainty model), no v20 streaming (REST polling only) |
| LIVE certification path | Operator runs `oanda.live-certification.spec.ts` with `IREXPRO_ALLOW_LIVE_CERTIFICATION=true` + `OANDA_LIVE_CERT_TOKEN`/`OANDA_LIVE_CERT_ACCOUNT_ID` + explicit cap → evidence artifact → §4 process. **Do not mark VERIFIED without that artifact.** |

### cTrader Open API (universal engine; aliases: Pepperstone cTrader, IC Markets cTrader) — catalog: BETA, production-LIVE **UNVERIFIED** (×3)

| Item | State |
| --- | --- |
| Adapter | `adapters/ctrader/` — ONE shared engine; `pepperstone-ctrader`/`icmarkets-ctrader` are registry aliases through the canonical factory (no duplicated implementations; brand verification preserved) |
| Auth route | OAuth 2.0 (operator app `CTRADER_CLIENT_ID/SECRET`); DB-atomic refresh lease (cross-replica), generation-CAS token persistence, fail-closed INVALID on auth-class rejection |
| DEMO/LIVE host separation | Hard `wss://demo/live.ctraderapi.com` + connect-time isLive-vs-env verification (mismatch = AUTHENTICATION_FAILED) |
| DEMO verified? | ✅ credential-gated DEMO harness (`ctrader.demo-verification.spec.ts`) |
| LIVE verified? | ❌ **UNVERIFIED ×3** — **external blocker: Spotware partner approval + per-broker (Pepperstone, IC Markets) real-account approval.** Identity-scoped verification policy already enforces that one broker's future verification can never authorize another. Engine capabilities are production-grade (all four order kinds, order+position modify, cancel, partial close, volume-cents conversion, per-symbol specs, native margin, WS reconnect with bounded FIFO outback, timeout/frame accounting, DealList history reconciliation) |
| LIVE certification path | After partner approval: operator runs `ctrader.live-certification.spec.ts` with the gate + `CTRADER_LIVE_CERT_*` envs + explicit cap → evidence → §4 process, PER BROKER IDENTITY (the engine being shared does not certify the aliases jointly) |

### iRexPro Paper Broker — SUPPORTED, DEMO-only by design

No production-LIVE certification is applicable or possible: the catalog
declares `environments: ['DEMO']`, the PAPER_ONLY boundary refuses non-paper
connections, and `setMode(LIVE)` is ignored with a warning. Listed for
completeness — PAPER can never reach live infrastructure (proven by the
paper-live-boundary matrix).

---

## 6. What this protocol deliberately does NOT do

- It does **not** certify providers that have no adapter (`NOT_STARTED`,
  `PARTNER_APPROVAL_REQUIRED`, `UNAVAILABLE`, or research-only rows in
  provider-matrix.md) — those routes fail closed at runtime and no evidence
  path exists for them.
- It does **not** run in CI. The always-on suites prove the harness MACHINERY
  (gate, cap, sizing, classification, zero-unexpected-exposure diff) with
  fake adapters only; the real-provider entry points are `describe.skip`
  without both the env gate and real credentials.
- It does **not** place AI-derived or strategy-derived orders. The canary is
  a provider-minimum order, capped, placed by the operator's explicit
  instruction, closed in the same run, and proven to leave zero unexpected
  exposure.
- It does **not** weaken any execution-authority control: the certification
  runs through the adapter surface only, never through the risk-grant /
  final-dispatch-boundary chain (which is reserved for real trading flow and
  untouched by certification).

## 7. Operator quick reference

```bash
# 1. Gate (operator shell only — NEVER CI):
export IREXPRO_ALLOW_LIVE_CERTIFICATION=true

# 2. Credentials (operator env; never committed, never logged):
export OANDA_LIVE_CERT_TOKEN=...        # or METAAPI_LIVE_CERT_TOKEN=... /
                                        # CTRADER_LIVE_CERT_ACCESS_TOKEN=...

# 3. Run the broker's live-certification spec from apps/api:
pnpm --filter @irexpro/api exec jest src/modules/broker/verification/oanda.live-certification.spec.ts

# 4. The spec prints the sanitized evidence + the written artifact path.
#    Retain the artifact; record it via the §4 process. A PASS is required
#    before any catalog VERIFIED flip.
```

## 8. DEMO evidence records (reconciliation round, Section 5)

`BrokerDemoValidationService` now attaches a structured **DEMO evidence
record** to every `POST /broker/connections/:id/validate-demo` response and to
the corresponding `BROKER_DEMO_VALIDATION_PASSED/_FAILED` audit entry:

| Field | Meaning |
|---|---|
| `evidenceVersion` | Record schema version (currently `1`). |
| `provider` / `connectionId` / `environment` | Provider registry id, the validated connection, always `DEMO`. |
| `validatedAt` / `source` | Observation timestamp (checklist finish) and origin (`system`). |
| `adapterVersion` | Adapter implementation version (honestly `null` when the adapter declares none). |
| `account` | Provider-observed account truth (`providerAccountId`, `currency`, `accountTruth: PROVIDER_OBSERVED \| UNAVAILABLE`) — never user-declared input; failures degrade honestly with a sanitized reason. |
| `checks` / `summary` | The full sanitized checklist steps and pass/fail/skip counts. |
| `capabilitiesVerified` | Capabilities actually VERIFIED (PASS steps only — SKIPPED/FAILED never appear). |
| `orderLifecycleReconciliation` | Post-checklist observation that the validation's own position/orders are all closed/cancelled (`reconciled`), with honest `null` + reason when moot (`NO_VALIDATION_ARTIFACTS_PRODUCED`) or unreadable. |
| `overall` / `demoValidated` | The checklist outcome and the evidence-consistent boolean persisted on the connection. |
| `validUntil` / `revalidationRecommendedAfter` | Expiry semantics: a validation is a point-in-time observation, stale after 180 days (revalidation recommended 30 days before). Informational — this does NOT auto-revoke the persisted boolean and is NOT a certification. |
| `evidenceSha256` | SHA-256 over the canonical record (digest excluded) — tamper evidence for the audit-trail copy. |

**Evidence-class separation (non-negotiable):** a DEMO evidence record is
DEMO-environment evidence ONLY. It is **never** a provider LIVE certification
and never converts into one — LIVE certification is a separate operator-run
evidence class (§1–§7). The record deliberately carries no certification
vocabulary whatsoever.
