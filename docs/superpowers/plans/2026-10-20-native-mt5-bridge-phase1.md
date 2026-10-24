# Native MT5 Bridge Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first executable server-side foundation for `metatrader5-native`: truthful broker/platform/connector catalog semantics, a versioned bridge RPC contract, connection-scoped bridge sessions, and an `IBrokerAdapter` implementation that can be contract-tested without MetaApi.

**Architecture:** Keep the existing AI/risk/execution pipeline unchanged. `NativeMetaTrader5Adapter` maps the existing `IBrokerAdapter` contract onto a new `Mt5BridgeSessionRegistry`; production transport will attach to that registry in Phase 2, while Phase 1 uses a deterministic fake bridge session to prove mapping, isolation, idempotency and fail-closed behavior. The existing `metatrader5` MetaApi provider remains untouched.

**Tech Stack:** NestJS/TypeScript, Jest, existing broker adapter registry/contract suite, React/Next.js registry consumers.

**Spec:** `docs/superpowers/specs/2026-10-20-native-mt5-bridge-design.md`

## Global Constraints

- `metatrader5-native` is a new provider id; never mutate existing `metatrader5` persisted records in place.
- MT5 and cTrader are trading platforms, not brokers; customer-facing copy must distinguish Broker, Platform and Connection method.
- Preserve `IBrokerAdapter` as the only execution/risk provider boundary.
- Phase 1 is DEMO-only and production-LIVE UNVERIFIED.
- No broker password is stored or introduced into the API contract.
- Mutating bridge commands carry stable request/idempotency identity and uncertain outcomes never get guessed as success.
- Normal Stop AI remains selective to iRexPro-owned positions; `closeAllOrders()` retains account-wide emergency meaning.
- Existing MetaApi and cTrader routes must remain behaviorally unchanged.

## Review Focus

- Same MT5 account paired to two iRexPro connections: connection-scoped session binding must fail closed rather than cross-route commands.
- Session broker/account/mode identity changes after connection: adapter must reject the session before any new mutation.
- Bridge timeout after a mutating command: return/throw an uncertain provider result path; never retry by submitting a duplicate mutation.
- Netting vs hedging capability metadata: Phase 1 must expose the reported margin mode without pretending independent tickets on netting accounts.
- Existing `metatrader5` MetaApi catalog/adapter/certification tests must stay unchanged and green.

---

### Task 1: Separate broker, platform and connector semantics in the catalog

**Files:**
- Modify: `apps/api/src/modules/broker/registry/broker-definition.ts`
- Modify: `apps/api/src/modules/broker/registry/broker-catalog.ts`
- Modify: `apps/api/src/modules/broker/registry/broker-provider-registry.service.ts`
- Test: `apps/api/src/modules/broker/registry/broker-provider-registry.spec.ts`
- Test: `apps/api/src/modules/broker/registry/broker-provider-registry.ctrader-readiness.spec.ts`

**Interfaces:**
- Produces additive registry fields `platform` and `connectionMethod` for frontend display; existing fields remain backward compatible.
- Adds catalog id `metatrader5-native` with adapter id `metatrader5-native`, DEMO environment only, `productionLiveVerification: UNVERIFIED`, and customer label `MetaTrader 5 — iRexPro Native Bridge`.
- Renames only the display label of legacy `metatrader5` to `MetaTrader 5 — MetaApi Cloud`; provider id remains unchanged.

- [ ] **Step 1: Write failing registry tests** asserting the two MT5 routes are separate, the native route is DEMO-only/UNVERIFIED, and cTrader reports platform `CTRADER` rather than pretending cTrader is a broker brand.
- [ ] **Step 2: Run the focused registry tests and verify RED.**
- [ ] **Step 3: Add the additive registry fields and native catalog entry.**
- [ ] **Step 4: Run the focused registry tests and verify GREEN.**
- [ ] **Step 5: Commit** `feat(broker): distinguish broker platform and connector routes`.

### Task 2: Define the MT5 bridge RPC protocol and deterministic fake session

**Files:**
- Create: `apps/api/src/modules/broker/adapters/metatrader-native/mt5-bridge-protocol.ts`
- Create: `apps/api/src/modules/broker/adapters/metatrader-native/mt5-bridge-protocol.spec.ts`
- Create: `apps/api/src/modules/broker/adapters/metatrader-native/mt5-bridge-fake-session.ts`

**Interfaces:**
- Produces `Mt5BridgeCommandName`, `Mt5BridgeCommand`, `Mt5BridgeResponse`, `Mt5BridgeEvent`, `Mt5BridgeAccountIdentity`, `Mt5BridgeCapabilities`.
- Mutations include `requestId`, `idempotencyKey`, `expiresAt`, expected account/server/mode identity and iRexPro ownership marker.
- The fake session accepts scripted command handlers and records all command envelopes for contract assertions.

- [ ] **Step 1: Write failing protocol tests** for version rejection, expired commands, missing mutation idempotency, invalid sequence/account identity and secret-safe serialization.
- [ ] **Step 2: Run the protocol spec and verify RED.**
- [ ] **Step 3: Implement the version-1 protocol validators/types plus deterministic fake session.**
- [ ] **Step 4: Run the protocol spec and verify GREEN.**
- [ ] **Step 5: Commit** `feat(mt5): define native bridge protocol`.

### Task 3: Add connection-scoped MT5 bridge session registry

**Files:**
- Create: `apps/api/src/modules/broker/adapters/metatrader-native/mt5-bridge-session-registry.service.ts`
- Create: `apps/api/src/modules/broker/adapters/metatrader-native/mt5-bridge-session-registry.service.spec.ts`

**Interfaces:**
- Produces `attach(connectionId, session)`, `detach(connectionId, sessionId)`, `getHealthySession(connectionId, expectedIdentity)`, `request(connectionId, command)` and sanitized `health(connectionId)`.
- Enforces one active writer session per BrokerConnection id and immutable account/server/mode identity for the life of the attachment.

- [ ] **Step 1: Write failing session-registry tests** for account isolation, duplicate writer rejection, stale heartbeat rejection, identity drift, detach/reconnect generation fencing and timeout certainty.
- [ ] **Step 2: Run the focused spec and verify RED.**
- [ ] **Step 3: Implement the minimal registry with generation/session fencing and fail-closed health.**
- [ ] **Step 4: Run the focused spec and verify GREEN.**
- [ ] **Step 5: Commit** `feat(mt5): add native bridge session registry`.

### Task 4: Implement `NativeMetaTrader5Adapter`

**Files:**
- Create: `apps/api/src/modules/broker/adapters/metatrader-native/native-metatrader5.adapter.ts`
- Create: `apps/api/src/modules/broker/adapters/metatrader-native/native-metatrader5.adapter.spec.ts`
- Create: `apps/api/src/modules/broker/adapters/metatrader-native/native-metatrader5.contract-suite.spec.ts`
- Modify: `apps/api/src/modules/broker/interfaces/order-capability.spec.ts`

**Interfaces:**
- Produces `NativeMetaTrader5Adapter implements IBrokerAdapter` with `brokerId = 'metatrader5-native'`.
- Consumes `Mt5BridgeSessionRegistry` only; no MetaApi dependency.
- Maps account/balance/positions/margin/ticks/rates/order mutation/history/reconciliation commands to normalized broker types.

- [ ] **Step 1: Write failing adapter tests** covering DEMO connect identity, real Bid/Ask, OHLCV, margin, MARKET placement with SL/TP, modify, partial close, emergency close, list/get order, closed trades and disconnect.
- [ ] **Step 2: Run adapter tests and verify RED.**
- [ ] **Step 3: Implement the minimal adapter mapping and order capability declaration.**
- [ ] **Step 4: Run adapter unit tests plus shared broker contract suite and verify GREEN.**
- [ ] **Step 5: Commit** `feat(mt5): implement native bridge broker adapter`.

### Task 5: Register the native provider without disturbing MetaApi

**Files:**
- Modify: `apps/api/src/modules/broker/broker.module.ts`
- Modify: `apps/api/src/modules/broker/adapters/broker-adapter.registry.spec.ts`
- Modify: `apps/api/src/bootstrap.spec.ts`

**Interfaces:**
- Registers a metadata/root `NativeMetaTrader5Adapter` and a connection-isolation factory using the shared `Mt5BridgeSessionRegistry`.
- Keeps legacy `MetaTraderAdapter` registered as `metatrader5`.

- [ ] **Step 1: Write failing registry/bootstrap tests** proving both `metatrader5` and `metatrader5-native` are registered and resolve to different adapter classes with isolated mutable contexts.
- [ ] **Step 2: Run tests and verify RED.**
- [ ] **Step 3: Wire providers/factory in `BrokerModule`.**
- [ ] **Step 4: Run registry/bootstrap/order-capability tests and verify GREEN.**
- [ ] **Step 5: Commit** `feat(mt5): register first-party native provider`.

### Task 6: Update web/mobile connection wording and route presentation

**Files:**
- Modify: `apps/web/src/app/onboarding/broker/page.tsx`
- Modify: `apps/web/e2e/broker.spec.ts`
- Modify: `apps/mobile/src/screens/BrokerScreen.tsx`
- Modify: `apps/mobile/src/screens/broker-screen.logic.ts`
- Modify: `apps/mobile/src/screens/__tests__/broker-screen.logic.test.ts`

**Interfaces:**
- Customer-facing heading becomes `Trading account connections` / `Connect trading account` while API/entity names stay compatible.
- Native MT5 displays `Broker: detected after terminal pairing`, `Platform: MetaTrader 5`, `Connection: iRexPro Native Bridge` and does not ask for an API key/secret.
- Legacy MT5 displays `Connection: MetaApi Cloud (optional hosted route)`.
- cTrader remains OAuth and is described as a platform route; discovered broker identity remains account-specific.

- [ ] **Step 1: Write failing web/mobile tests** for labels and the absence of API-key fields on `metatrader5-native`.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement additive UI route presentation without changing backend credential semantics for existing providers.**
- [ ] **Step 4: Run focused web/mobile tests and verify GREEN.**
- [ ] **Step 5: Commit** `feat(ui): clarify trading account connection methods`.

### Task 7: Phase-1 verification and handoff to pairing/gateway/EA Phase 2

**Files:**
- Modify: `docs/superpowers/plans/2026-10-20-native-mt5-bridge-phase1.md` only if verification discovers a documented gap.

**Interfaces:**
- Produces a server-side native MT5 provider that is contract-testable but still fail-closed without an attached real bridge session.
- Phase 2 will add persistent pairing tokens, TLS gateway transport, signed EA enrollment, `iRexProBridgeEA.mq5`, web/mobile pairing UI and DEMO certification evidence.

- [ ] **Step 1: Run all touched API broker/registry specs.**
- [ ] **Step 2: Run API build and lint on touched files.**
- [ ] **Step 3: Run web/mobile focused tests.**
- [ ] **Step 4: Run full API suite in the verified VPS-native dependency environment; distinguish environment failures from code failures with evidence.**
- [ ] **Step 5: Run `git diff --check`, inspect changed-file list and confirm no secrets/generated artifacts are committed.**
- [ ] **Step 6: Push branch, open PR, wait for required CI/security gates, merge with expected-head SHA, then deploy exact merged main SHA.**
