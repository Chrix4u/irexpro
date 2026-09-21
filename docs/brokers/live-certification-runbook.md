# Live Certification Operator Runbook

> **Purpose.** Step-by-step operator procedure for running a
> **production-LIVE certification** of a broker route with the Phase 3
> operator CLIs, retaining the durable evidence artifact, and completing the
> (manual, review-gated) catalog transition.
>
> **This is the HOW-TO.** The protocol itself — why each gate exists, the
> honesty rules, and the broker-by-broker certification state — lives in
> [`production-live-certification.md`](./production-live-certification.md).
> Read §1–§4 of that document before your first run.
>
> **Real money moves.** The certification places and closes a REAL canary
> order on a LIVE provider account. Every safeguard below is non-negotiable.

---

## 1. Prerequisites

### 1.1 The environment gate (operator shell only — NEVER CI)

```bash
export IREXPRO_ALLOW_LIVE_CERTIFICATION=true
```

- The value must be the **exact string `true`** — `TRUE`, `True`, `yes`, `1`,
  empty, or absent all keep certification **disabled** (fail-closed; the CLI
  and the harness both refuse with zero provider calls).
- **CI never sets it.** No GitHub workflow in this repository references
  `IREXPRO_ALLOW_LIVE_CERTIFICATION` (verified by grep over `.github/` — it
  must stay that way). A certification run may never be triggered by a
  pipeline; only a human operator in an interactive shell can arm the gate.

### 1.2 Operator identity and evidence directory

| Env var | Required | Meaning |
| --- | --- | --- |
| `IREXPRO_LIVE_CERT_OPERATOR_ID` | yes | The accountable operator identity, recorded in the durable evidence artifact. |
| `IREXPRO_LIVE_CERT_EVIDENCE_DIR` | yes (CLI) | An **explicit** directory for the evidence artifact. The harness's default of the current working directory (`.`) is unsafe for operator runs — the CLI refuses to run without this. Use a directory in your operational evidence store, e.g. `/srv/irexpro-evidence/live-certification`. |

### 1.3 Provider credentials (names only — values never echoed, never logged)

| Provider (positional arg) | Required credential env | Notes |
| --- | --- | --- |
| `metatrader5` | `METAAPI_LIVE_CERT_TOKEN` (fallback: `METAAPI_TOKEN`) + `METAAPI_LIVE_CERT_ACCOUNT_ID` | MetaAPI platform token with access to the target LIVE MT5 account; the account id is the MetaApi account UUID. |
| `oanda` | `OANDA_LIVE_CERT_TOKEN` + `OANDA_LIVE_CERT_ACCOUNT_ID` | A fxTrade **LIVE** personal access token (Manage API Access). A practice token will FAIL the LIVE classification — environment-scoped by OANDA. |
| `ctrader` (also `pepperstone-ctrader`, `icmarkets-ctrader`) | `CTRADER_LIVE_CERT_ACCESS_TOKEN` + `CTRADER_LIVE_CERT_CTRID_ACCOUNT_ID` + `CTRADER_CLIENT_ID` + `CTRADER_CLIENT_SECRET` | OAuth access token for the LIVE cTrader account (id.ctrader.com consent flow) + the platform's Open API application credentials. |

### 1.4 Explicit maximum canary exposure (never derived from AI)

| Provider | Env var |
| --- | --- |
| `metatrader5` | `METAAPI_LIVE_CERT_MAX_CANARY_EXPOSURE` |
| `oanda` | `OANDA_LIVE_CERT_MAX_CANARY_EXPOSURE` |
| `ctrader` family | `CTRADER_LIVE_CERT_MAX_CANARY_EXPOSURE` |

A **positive decimal string** in the canary instrument's quote currency
(e.g. `2000` ≈ USD for a EURUSD canary). This cap is supplied by you, the
operator — it is **never** derived from an AI signal, a strategy, or any
market view. If the provider's own minimum order exceeds the cap, the harness
refuses with zero orders placed.

Optional per-provider canary instrument (defaults to the provider's first
catalog symbol): `METAAPI_LIVE_CERT_INSTRUMENT` / `OANDA_LIVE_CERT_INSTRUMENT`
/ `CTRADER_LIVE_CERT_INSTRUMENT`.

---

## 2. Running a certification

From the repository root:

```bash
# MetaTrader 5 (via MetaApi)
pnpm --filter @irexpro/api run cert:live -- metatrader5

# OANDA (v20 REST, fxTrade LIVE)
pnpm --filter @irexpro/api run cert:live -- oanda

# cTrader Open API (universal engine)
pnpm --filter @irexpro/api run cert:live -- ctrader
pnpm --filter @irexpro/api run cert:live -- pepperstone-ctrader
pnpm --filter @irexpro/api run cert:live -- icmarkets-ctrader
```

The CLI validates every prerequisite BEFORE any provider call. If anything is
missing it refuses with a message naming exactly which environment VARIABLES
are missing — **values are never echoed** — and exits `1` with zero provider
contact.

On a completed run it prints (stdout): the `runId`, `brokerId`, overall
result, `certificationResult`, `evidenceState`, the artifact path, the
`evidenceSha256`, and the pass/fail/skip step counts.

**Exit code `0` ONLY for a certifiable PASS** (`isCertifiablePass`: every
required stage passed AND the evidence artifact was durably persisted and
read-back verified). Anything else — refusal, checklist FAIL, or
`EVIDENCE_PERSISTENCE_FAILED` — exits non-zero and authorizes nothing.

---

## 3. What the run does

The CLI is a thin wrapper: it adds no certification logic and weakens
nothing. It drives the EXISTING harness
(`apps/api/src/modules/broker/verification/provider-live-certification-harness.ts`)
through the complete **16-stage lifecycle** — LIVE certification is the full
sequence or nothing (no step allow-list):

| # | Stage |
| --- | --- |
| 1 | `connect` (LIVE classification enforced — a provider reporting DEMO is an immediate FAIL) |
| 2 | `account-discovery` (honest SKIPPED where the adapter has no discovery surface) |
| 3 | `account-state` (balance/equity/margin as decimal strings + currency) |
| 4 | `symbol-metadata` (min/max/step lot sizes, contract size, digits) |
| 5 | `price` (fresh bid/ask/spread sanity) |
| 6 | `margin-estimate` (fail-closed when unprovable) |
| 7 | `baseline-exposure-snapshot` (positions + working orders BEFORE any state-changing step) |
| 8 | `place-minimum-safe-order` (the capped canary) |
| 9 | `verify-provider-ack` |
| 10 | `query-order` |
| 11 | `query-position` |
| 12 | `modify-protective-levels` (risk-REDUCING SL move only; honest SKIPPED where unsupported) |
| 13 | `close-position` (ALWAYS attempted once a canary exists — real-money safety) |
| 14 | `verify-closed` |
| 15 | `reconcile-history` |
| 16 | `verify-zero-unexpected-open-exposure` (post-close state diffed against the baseline — ANY new position or working order is a CRITICAL FAIL) |

**Canary sizing** (the only sizing path):
`requestedSize = providerMinimum × 1` (the hardcoded `LIVE_CANARY_SAFETY_FACTOR`),
`derivedLotCap = floor(maxCanaryExposure / (contractSize × referencePrice))`
floored to a whole multiple of the provider's lot step, and
`actualSize = min(requestedSize, derivedLotCap)`. Exact BigInt decimal math —
never floats. The provider minimum exceeding your cap is a typed refusal with
zero orders.

**Close safety:** the canary close is attempted whenever a canary order
exists, regardless of intermediate step failures; stage 16 then proves the
account is back to its baseline state — the run never leaves its own canary
open, and any unexpected exposure it did cause is a CRITICAL FAIL.

---

## 4. Evidence durability

On completion the harness writes the sanitized JSON evidence artifact to:

```
${IREXPRO_LIVE_CERT_EVIDENCE_DIR}/live-certification-<brokerId>-<runId>-<UTC timestamp>.json
```

and **verifies the write by reading it back and comparing the SHA-256**
(`evidenceSha256`, computed over the canonical run record). If the write or
the read-back fails, the result is locked to the explicit
`EVIDENCE_PERSISTENCE_FAILED` state.

**A console PASS alone is NOT sufficient.** `isCertifiablePass` requires the
durable, read-back-verified artifact (`certificationResult: 'PASS'` +
`evidenceState: 'PERSISTED'` + a recorded `artifactPath`). Never promote a
provider from console output — retain the artifact in the operational
evidence store for the lifetime of the certification plus your
incident-retention policy.

---

## 5. The catalog transition (manual, reviewed — never automatic)

A certifiable PASS authorizes **nothing by itself**. The ONLY legitimate
transition is a **manual, reviewed edit** of
`apps/api/src/modules/broker/registry/broker-catalog.ts` — the harness and
the CLIs never flip it (pinned by tests).

For a certifiable PASS, the run prints the EXACT values to apply:

```ts
productionLiveVerification: {
  status: 'VERIFIED',
  verifiedAt: '<the run finishedAt from the artifact>',
  evidenceRef: 'live-certification artifact <artifact file name> (retained in the operator evidence store; never committed)',
  certifiedVia: 'HARNESS_CERTIFIED',
  certificationRunRef: '<runId>@sha256:<evidenceSha256>',
},
```

Then record the per-broker row in
[`provider-matrix.md`](./provider-matrix.md) and ship the change through
review, per
[`production-live-certification.md`](./production-live-certification.md) §4.

**Verify the transition** (also useful pre-review, and after any future
catalog edit):

```bash
pnpm --filter @irexpro/api run cert:verify-transition -- --evidence <path-to-artifact.json>
```

The verifier independently recomputes the evidence SHA-256 the same way the
harness does, re-checks the certifiable-PASS contract, and compares the
CURRENT catalog entry against the artifact:

- `TRANSITION_PENDING` (exit 0) — a PASS artifact exists but the entry is not
  yet `HARNESS_CERTIFIED` (UNVERIFIED, or legacy-attested). The honest
  pre-transition state; the exact values to apply are printed.
- `VERIFIED` (exit 0) — the entry's `verifiedAt`, sanitized `evidenceRef` and
  `certificationRunRef` match the artifact exactly.
- `ERROR` (exit 1) — the artifact fails re-verification (tampered/corrupted
  hash, non-PASS, persistence failure), or the catalog CLAIMS
  `HARNESS_CERTIFIED` with values the artifact disproves (wrong run, wrong
  hash, wrong date — fabricated or stale claims fail loudly).

**Downgrade path:** a failed re-certification, provider incident, or evidence
doubt flips the entry back to `UNVERIFIED` through the same operator edit
path — fail-closed and immediate via the verification-revision fence. See
[`production-live-certification.md`](./production-live-certification.md) §4,
item 5 (Downgrade/rollback) for the authoritative procedure.

---

## 6. Operator cautions

1. **Never commit evidence containing secrets — and the evidence cannot
   contain them by construction.** The harness sanitizes every free-text
   field (`sanitizeVerificationDetail`, the platform's `redactString`
   discipline), masks the target account id (only the last 4 characters
   survive), records exposure as counts + masked fingerprints, holds
   credentials memory-only, and refuses secret-shaped credential-source
   descriptions at the gate. The per-provider entry-point specs assert the
   raw token never appears in the evidence. Even so: commit only the
   NON-SECRET catalog reference (`evidenceRef` + `certificationRunRef` +
   `verifiedAt`); the artifact contents stay in your evidence store.
2. **Never enable the gate in CI.** No GitHub workflow references
   `IREXPRO_ALLOW_LIVE_CERTIFICATION` — keep it that way. CI is
   credential-free and gate-closed by design.
3. **cTrader is certified PER BROKER IDENTITY.** `ctrader`,
   `pepperstone-ctrader` and `icmarkets-ctrader` share one engine, but a
   certification run for one identity can never authorize another — run
   `cert:live` separately per broker id (each needs its own broker-side
   approval and its own catalog transition), and the identity-scoped
   verification policy enforces it.
4. **Never echo credential values.** The CLI names missing environment
   VARIABLES only. Keep that discipline in tickets, transcripts and review
   notes.
5. **The cap is yours.** `*_LIVE_CERT_MAX_CANARY_EXPOSURE` is an operator
   decision in the canary instrument's quote currency. Never source it from
   the AI engine, a strategy, or a market view.
