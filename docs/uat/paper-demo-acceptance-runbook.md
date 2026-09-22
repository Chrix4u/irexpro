# iRexPro PAPER & DEMO UAT Acceptance Runbook

## Purpose

This runbook defines the first controlled UAT sequence after the six-pair XGBoost
research pipeline reaches a decision. It is intentionally limited to:

1. internal PAPER execution using iRexPro's deterministic simulator; and
2. real-provider DEMO execution using real market/provider APIs with virtual broker funds.

The distinction is important: the built-in Paper Broker is intentionally deterministic,
uses a fixed simulated clock/price walk, and currently exposes EURUSD only. PAPER proves
the execution/risk/reconciliation pipeline; **DEMO is the first real-time market-performance
test of the six-pair trained model**.

It does **not** authorize LIVE / real-money trading.

The order is deliberate:

`MODEL_PROMOTED_PAPER_UAT` → PAPER UAT → DEMO UAT → evidence review → separate LIVE certification and model approval.

---

## 1. Entry criteria

Do not start PAPER UAT until all of the following are true:

- the exact-main Six Pair Research Run completed successfully;
- the research logs contain `MODEL_PROMOTED_PAPER_UAT`;
- the staging AI runtime reports a loaded `trained_xgboost_mtf` model;
- the model is `approved_for_paper=true`;
- the model is `approved_for_live=false`;
- API live/ready health checks pass;
- the test user can authenticate;
- onboarding/risk prerequisites are complete;
- the personal kill switch is clear;
- a paper-broker connection exists and is CONNECTED;
- an explicit AI capital allocation exists for that paper connection.

If the research run reports `MODEL_PROMOTION_HOLD`, stop here. Preserve the
evidence and investigate the exact failed research/untouched-test gate. Do not
lower model-quality gates merely to begin UAT.

---

## 2. Security rules

Never:

- paste a bearer token into chat, a ticket, a PR, or source control;
- commit broker credentials;
- put credentials in shell history if the environment is shared;
- use a LIVE account during this runbook;
- change a LIVE broker connection to FULL_AUTO;
- treat DEMO verification as LIVE certification;
- treat PAPER model approval as LIVE model approval.

The UAT probe redacts token/secret/password-like fields from any error payload it
prints, but operators must still avoid exposing secrets in the first place.

---

## 3. Automated runtime smoke

The GitHub `UAT Runtime Smoke` workflow verifies the public application and API
handoff:

- login route;
- API liveness;
- API readiness;
- protected trading endpoints return the expected unauthenticated boundary;
- CORS/preflight contract for browser trading requests;
- research completion is classified as PAPER promotion versus promotion hold.

The smoke workflow is necessary but not sufficient: it does not impersonate a
real user and it does not place a trade.

---

## 4. Authenticated UAT readiness probe

Script:

`scripts/uat/verify-paper-demo-readiness.mjs`

Requirements:

- Node.js 20+;
- a short-lived bearer token for a dedicated UAT user;
- staging API reachable from the operator machine.

### PAPER — read-only readiness

Use a shell/environment mechanism that does not persist the token in source
control.

```bash
export IREXPRO_UAT_BEARER_TOKEN='<short-lived token>'
export IREXPRO_UAT_MODE='PAPER'
node scripts/uat/verify-paper-demo-readiness.mjs
```

By default the script is read-only.

It checks:

- authenticated profile;
- onboarding status;
- risk state;
- kill switch;
- broker connectivity;
- exact paper-broker selection;
- explicit capital allocation;
- active trading-session truth;
- AI scheduler/runtime status when a session exists;
- trained-model identity when required;
- six-pair runtime universe;
- execution read models;
- Live Account overview read model.

Expected final marker:

`UAT_READINESS_PASS mode=PAPER mutation_mode=read_only`

### PAPER — controlled session probe

Only after the read-only probe passes:

```bash
export IREXPRO_UAT_ALLOW_MUTATIONS='true'
node scripts/uat/verify-paper-demo-readiness.mjs
```

If no session is already active, the harness starts a `PAPER_ONLY` session on
the selected paper-broker connection.

If the harness starts a session itself, it attempts to stop that exact session
in `finally`, including on a failed assertion. It does not stop a pre-existing
user session.

Default runtime wait is 90 seconds. Override only if needed:

```bash
export IREXPRO_UAT_STATUS_TIMEOUT_SECONDS='120'
```

### Pre-promotion infrastructure check

The script normally requires the trained MTF model. For infrastructure-only
checks before model promotion:

```bash
export IREXPRO_UAT_REQUIRE_TRAINED_MODEL='false'
```

Never use that setting as evidence that trained-model PAPER UAT passed.

---

## 5. PAPER acceptance sequence

After the trained model is active, complete these checks in order.

### 5.1 Runtime truth

Verify the AI Trading screen reports:

- model: Trained MTF XGBoost;
- model loaded: true;
- a non-baseline model version;
- the trained MTF model identity is visible;
- PAPER scheduler instruments reflect the deterministic paper broker (currently EURUSD);
- multi-timeframe runtime context;
- scan interval is visible;
- confidence threshold is visible;
- market-data timestamp/age is human-readable;
- no stale `heuristic scaffold` warning remains.

Record screenshots or exported evidence.

### 5.2 Confidence behavior

Observe several simulated market scans.

Pass only if:

- confidence is sourced from the trained model;
- confidence can change between materially different simulated market inputs;
- unchanged market data does not fabricate a new confidence value;
- `NO TRADE` below threshold is explained truthfully;
- confidence is never presented as guaranteed profit probability.

### 5.3 Start / Stop

Start AI Trading using the normal UI.

Confirm:

- explicit confirmation modal appears;
- the session becomes ACTIVE;
- runtime registration is visible;
- Start is not double-submitted.

Stop AI Trading.

Confirm:

- explicit confirmation warns that AI-owned positions will be closed;
- new AI exposure is stopped first;
- AI-owned open positions are flattened;
- unresolved/unknown broker outcomes are reported honestly;
- final session state is stopped/ended;
- no position is silently reported closed when closure was not confirmed.

### 5.4 Signal and risk pipeline

Capture at least one of each when naturally available:

- confidence-below-threshold NO TRADE;
- risk rejection;
- accepted signal;
- resulting paper order;
- resulting open position;
- completed/closed position.

For each accepted signal, verify the path remains:

AI model → signal candidate → strategy → risk → execution → broker adapter.

The Python AI engine must not directly execute a trade.

### 5.5 Position lifecycle

For an opened paper position verify:

- instrument;
- direction;
- quantity/lot size;
- entry;
- stop loss where applicable;
- take profit where applicable;
- current/open state;
- close state;
- realised P&L after close;
- audit/activity timeline.

If the individual-position manual-close feature is available in the current UAT
stack, test its confirmation, pending state, close result, duplicate-click
protection, and reconciliation result.

### 5.6 Session and fault recovery

Verify:

- browser refresh does not invent a new session;
- session state reloads from the server;
- temporary secondary read-model failure does not corrupt Start/Stop authority;
- expired login/session results in a clear re-authentication path;
- reconnect restores truthful broker/runtime state;
- kill switch blocks new exposure server-side.

---

## 6. PAPER exit criteria

PAPER UAT may be declared functionally passed only when:

- automated runtime smoke passes;
- authenticated readiness probe passes with trained-model requirement enabled;
- model identity is trained MTF XGBoost;
- the deterministic PAPER scheduler is healthy for the paper-broker instrument scope;
- confidence is dynamic and truthful for the simulated inputs;
- Start/Stop works;
- at least one full paper trade lifecycle is evidenced, unless market/risk
  conditions legitimately produce no qualifying entry during the agreed
  observation window;
- any NO TRADE outcome is explained by real model/risk/market state, not by a
  broken scheduler or missing data;
- no critical security, tenant-isolation, risk, reconciliation, or execution
  defect remains open.

If the deterministic PAPER feed yields no qualifying entry, do not reduce the
confidence/risk threshold simply to manufacture a trade. Use the evidence to distinguish
"model chose not to trade" from "pipeline failed to trade."

Do not use PAPER P&L as evidence of real-world market performance. The Paper Broker's
prices, clock, fills, and EURUSD-only instrument scope are deliberately simulated.

---

## 7. Real-provider DEMO preparation

Before DEMO UAT, prepare at least one supported provider practice account.

For the first real-time UAT cycle, prefer **MetaTrader 5 via MetaApi** because it is
the most mature provider adapter in the current repository and supports provider-backed
historical candles across M1/M5/M15/H1/H4. The exact connected account must still prove
that EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD and USDCHF are present with valid broker
symbol specifications; do not assume every broker account exposes identical symbol names.

Preferred evidence should include:

- provider/broker;
- account ID (non-secret);
- environment = DEMO/practice;
- account currency;
- connection ID;
- validation timestamp;
- provider/adapter version;
- capability verification;
- credential status without exposing credential values.

Never copy API secrets or access/refresh tokens into the evidence package.

---

## 8. DEMO authenticated probe

Specify the exact real-provider DEMO connection:

```bash
export IREXPRO_UAT_MODE='DEMO'
export IREXPRO_UAT_BROKER_CONNECTION_ID='<demo connection uuid>'
export IREXPRO_UAT_BEARER_TOKEN='<short-lived token>'
node scripts/uat/verify-paper-demo-readiness.mjs
```

Read-only must pass first. For real-time six-pair performance UAT, the selected provider
must expose all six configured majors (EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF);
the readiness probe fails closed if any are missing.

For a controlled DEMO session:

```bash
export IREXPRO_UAT_ALLOW_MUTATIONS='true'
node scripts/uat/verify-paper-demo-readiness.mjs
```

The selected connection must report `accountType=DEMO`.

The scheduler may run automatic execution against the broker sandbox, but this
does not confer or imply LIVE authorization.

---

## 9. DEMO acceptance sequence

Verify with actual provider APIs and virtual broker funds:

- account/environment truth;
- balance/equity;
- real provider market-data flow for all six configured majors;
- trained-model runtime identity;
- AI decisions;
- order submission;
- provider acknowledgement;
- fill state;
- SL/TP/protective orders;
- position monitoring;
- reconciliation;
- individual/manual close where implemented;
- AI-generated exit;
- Stop AI Trading flatten;
- disconnect/reconnect;
- token/session expiration recovery;
- provider outage/error handling;
- kill switch;
- audit trail;
- no credential leakage.

Capture authoritative DEMO evidence according to the broker validation contract.

---

## 10. DEMO exit criteria

DEMO passes only when:

- the connection is authoritatively DEMO/practice;
- provider-backed market and execution calls succeed;
- at least one end-to-end DEMO order lifecycle is reconciled;
- Stop/flatten is verified;
- errors/unknown outcomes are reconciled rather than guessed;
- DEMO evidence record is complete;
- no test result implies LIVE certification.

---

## 11. What happens after DEMO

Real-money testing remains a separate gate.

Required classes of evidence remain independent:

- broker/provider Production LIVE certification;
- exact active AI model LIVE approval;
- account eligibility/jurisdiction;
- explicit LIVE enablement;
- risk controls;
- reconciliation health;
- valid credentials/account state;
- operator authorization.

A PAPER-approved XGBoost model must remain `approved_for_live=false` until the
separate LIVE model-approval process is completed.

---

## 12. Evidence package for each UAT session

Record:

- git/main SHA;
- research run ID;
- research decision marker;
- model version;
- model artifact SHA-256 when available;
- test user identifier (non-secret);
- broker connection ID;
- broker/provider;
- PAPER or DEMO environment;
- execution mode;
- capital allocation;
- test start/end timestamps UTC;
- runtime smoke result;
- authenticated probe result;
- screenshots for runtime/model state;
- relevant order/trade IDs;
- risk rejection codes;
- Stop/flatten outcome;
- reconciliation outcome;
- defects found and linked issue/PR.

Do not record passwords, bearer tokens, refresh tokens, API keys, API secrets, or
encrypted credential blobs.
