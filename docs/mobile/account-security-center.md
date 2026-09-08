# Mobile Account / Profile / Security Center

## Sprint 55 — M12 Production-Readiness Slice

---

## 1. Overview

This document describes the Account, Profile, and Security Center shipped in
the iRexPro Expo app (`apps/mobile`) as Sprint 55's M12 production-readiness
slice. It covers what the feature provides, the endpoint contracts it
consumes, the security behaviors it enforces, the session-management
architecture decision behind "Sessions & Devices", the test coverage that
proves the security properties, and what was deliberately deferred.

The slice consists of:

- An identity-first **Account hub** (tab-level screen) with a Personal
  Information sub-screen backed by the typed `GET/PATCH /users/me` contract.
- A **Security hub** with Password change, TOTP two-factor enrollment and
  disable, email + phone verification, Sessions & Devices, and the Security
  Activity timeline.
- An **Account Access** screen (honest status/restriction/appeal guidance) and
  a public, enumeration-safe **pre-auth appeal** flow reachable from the login
  screen.
- A **zero-dependency pure-logic test harness**
  (`apps/mobile/scripts/test-account-security.cjs`) wired into Mobile CI, plus
  this architecture/limitation document.

All account-security business logic lives in two RN-import-free pure modules
so it is testable in Node without jest-expo:

| Module | Contents |
| --- | --- |
| `src/lib/account-security-logic.ts` | Profile validators + request builder, password policy gate, MFA enrollment reducer, verification cooldown/expiry copy, security-activity labels/tones/relative time, self-contained JWT payload decoder, session/device view helpers, account-status guidance, appeal validation. Zero runtime imports. |
| `src/lib/account-security-errors.ts` | Sanitized error mappers (`accountSecurityError`, `verificationCodeError`, `isMfaSetupExpiredRejection`); only runtime dependency is the RN-safe `ApiClientError` class from `@irexpro/api-client`. |

`src/lib/account-security.ts` remains the RN-adjacent facade: it hosts
`beginMfaSetup` (the `{ password }` re-auth contract guarded by the api-client
contract test) and re-exports the pure modules' public surface so existing
importers are unaffected.

---

## 2. Information architecture

The app uses hand-rolled navigation (no navigation library); the Account tab
is a hub that routes to sub-screens by local state:

```
Account tab (hub)
├── Identity card (initials avatar, status pill, contact rows, MFA indicator)
├── Personal Information  → PersonalInformationScreen (GET/PATCH /users/me)
├── Security              → SecurityScreen (hub)
│   ├── Password                      → ChangePasswordScreen
│   ├── Two-Factor Authentication     → MfaScreen (enable + disable flows)
│   ├── Email & Phone Verification    → VerificationScreen
│   ├── Sessions & Devices            → SessionsScreen
│   └── Security Activity             → SecurityActivityScreen
├── Account Access         → AccountAccessScreen (status, restrictions, appeal guidance)
└── Sign Out               → auth-context logout()

Pre-auth (from Login screen)
├── Forgot password        → ForgotPasswordScreen
└── "Can't access your account?" → AppealScreen (public POST /account-appeals)
```

Every screen follows the app-wide conventions: single-flight busy guards,
sanitized error banners (`accountSecurityError`/`verificationCodeError`),
skeleton loading states, destructive-action confirmation alerts, 46 dp touch
targets, and the dark inline design tokens.

---

## 3. Endpoint contracts consumed

| Route | Transport | Request | Response | Notes |
| --- | --- | --- | --- | --- |
| `GET /auth/me` | Bearer | — | `AuthUser` | Identity source of truth (status, verified flags, `mfaEnabled`) |
| `GET /users/me` | Bearer | — | `MyProfileView` | Typed profile view (Sprint 55 contract) |
| `PATCH /users/me` | Bearer JSON | `UpdateMyProfileRequest` | `MyProfileView` | Only changed fields are sent; DOB change resets KYC server-side |
| `POST /auth/change-password` | Bearer JSON | `ChangePasswordRequest` | `AuthActionResponse` | **NEW (Sprint 55)**; revokes all sessions + retires pending MFA |
| `POST /auth/sessions/revoke-others` | Bearer JSON | no body | `AuthTokens` | **NEW (Sprint 55)**; fresh pair for the caller |
| `GET /auth/security-events` | Bearer query | `?limit=&offset=` | `SecurityEventListResponse` | **NEW (Sprint 55)**; `no-store`, paginated |
| `POST /auth/mfa/setup` | Bearer JSON | `{ password }` | `MfaSetupResponse` | Re-auth gate; secret is enrollment material |
| `POST /auth/mfa/enable` | Bearer JSON | `{ code }` | `AuthActionResponse` | Revokes all sessions on success |
| `POST /auth/mfa/disable` | Bearer JSON | `{ code, password }` | `AuthActionResponse` | Revokes all sessions on success |
| `POST /auth/verification/email/request` | Bearer | — | `AuthActionResponse` | Rate-limited server-side |
| `POST /auth/verification/email/confirm` | Bearer JSON | `{ token }` | `AuthActionResponse` | Web deep-link flow; link-only in-app |
| `POST /auth/verification/phone/request` | Bearer | — | `AuthActionResponse` | Rate-limited server-side |
| `POST /auth/verification/phone/confirm` | Bearer JSON | `{ code }` | `AuthActionResponse` | 401 = code mismatch |
| `POST /auth/logout` | Bearer | — | `LogoutResponse` | Global revocation ("sign out everywhere") |
| `POST /account-appeals` | public | `SubmitAccountAppealRequest` | `SubmitAccountAppealResponse` | Pre-auth; enumeration-safe generic response |

Shared contract types live in `packages/types` (`MyProfileView`,
`UpdateMyProfileRequest`, `ChangePasswordRequest`, `SecurityEventView`,
`SecurityEventListResponse`, …); the wire shapes are pinned by
`packages/api-client/scripts/test-contracts.cjs`.

---

## 4. Security behaviors

### 4.1 MFA enrollment material is memory-only (provable)

The one-time enrollment secret + `otpauth://` URI live exclusively in the
`mfaEnrollmentReducer` state while `status === 'verifying'`. The reducer
maintains the invariant

```
material !== null  ⟺  status === 'verifying'
```

and hard-wipes the material on `CODE_ACCEPTED`, `CODE_REJECTED`, `RESTART`,
and `CANCEL`. The harness asserts this invariant across **every** reachable
`(state, event)` pair of the full transition table, so the secret provably
leaves program state at the logic level the moment enrollment ends, is
discarded, or is restarted. The material is never written to SecureStore,
AsyncStorage, the filesystem, or logs (see the static regression guard in
§6.2), and it dies with the component on unmount.

### 4.2 Passwords and codes are cleared at request start

In every flow that transmits a secret — change-password (all three fields),
`beginMfaSetup` (password), `enableMfa` (six-digit code), `disableMfa`
(password + code), and phone-code confirmation — the screen captures the
value into a local `const`, calls `setState('')` to clear the input state
**before** the request is awaited, and passes only the captured const to the
API layer. Secrets are never kept in component state past the request line,
never restored for retry, and never logged.

### 4.3 Sanitized error copy policy

All user-visible error copy comes from `accountSecurityError` /
`verificationCodeError`, which discriminate purely on
`error instanceof ApiClientError` + numeric `statusCode` (0 / 401 / 400 / 422 /
429 / ≥500 / other) and map to fixed strings. Raw server messages and payload
bodies are never reflected to the user. The single place a raw message is
inspected — `isMfaSetupExpiredRejection` matching the backend's
"MFA setup expired" 400 — is detection-only: the raw string is never
rendered; callers substitute their own static restart copy. Non-`ApiClientError`
throwables (framework errors, plain objects, strings) fall back to generic
copy.

### 4.4 Revoke-others token persistence order (persist-before-expose)

`POST /auth/sessions/revoke-others` bumps the server's global session
generation and returns a fresh token pair to the caller. The mobile flow
persists **before** exposing anything in memory:

1. `saveTokens(pair)` — write the new pair to SecureStore first;
2. `setAccessToken(pair.accessToken)` — only then arm the API layer;
3. `setSession(user, pair.accessToken)` — sync the auth context;
4. re-derive the "This device" session view from the **new** access token.

If SecureStore is unavailable the newly-issued pair cannot be kept, so the
flow fails closed: `setAccessToken(null)` + `clearTokens()` + forced
re-login — mirroring the auth-context rotation ladder. The same
persist-before-expose order is used by login/refresh in `auth-context.tsx`.

### 4.5 Enumeration-safe appeal copy

The pre-auth appeal flow (like forgot-password) always shows the generic card
"If an eligible account exists, the request has been received for review."
for **every** server response, regardless of whether the identifier matched an
account. The only non-generic path is a network-unreachable failure
(`statusCode === 0`, the request never left the device — zero enumeration
signal), which offers a sanitized retry. Identifier and reason are cleared
after submission to prevent accidental re-submission.

### 4.6 Other pinned behaviors

- Verification status (email/phone) and account status are read exclusively
  from server data (`/auth/me`, `MyProfileView`) — never inferred on-device.
- The resend cooldown is client-owned (60 s, started only after a successful
  request) and never fabricated; server-side expiry windows are described
  with static honest copy ("about 15 minutes" / "about 10 minutes").
- The JWT payload decoder (`decodeJwtPayload`) reads only non-secret claims
  (iat/exp) of the token the device already holds, returns `null` for any
  malformed input, and never verifies or logs. It is self-contained (no
  `atob`/`Buffer`/`TextDecoder`) so it behaves identically on Hermes and Node.
- Access tokens are held in memory; only the token pair in SecureStore
  (keychain, `WHEN_UNLOCKED`) is persisted. AsyncStorage is prohibited.

---

## 5. Session management architecture decision (critical)

### 5.1 Current model — global sessionVersion generation

The backend's session model is a **global per-user generation counter**
(`sessionVersion`):

- Access and refresh JWTs embed the user's current `sessionVersion`; every
  authenticated HTTP request (JWT strategy) and **every WebSocket message**
  revalidates the presented token's generation against the user's current
  value, disconnecting revoked sockets immediately (recently hardened:
  realtime HS256 pinning + revoked-socket cleanup).
- Refresh-token rotation is a compare-and-swap (CAS) update: the rotation
  only succeeds when the stored generation still matches the token's claim;
  a raced/revoked token fails closed with 401.
- "Sign out everywhere", password change, reset-password, MFA enable/disable,
  and account restriction all bump the generation, which invalidates every
  outstanding token (stateless — nothing to look up per session).

This model was deliberately chosen and recently hardened; it is simple,
stateless, fail-closed, and already proven across HTTP and WS.

### 5.2 Why per-session listing and revoke-one were NOT built

A "list my sessions and revoke one device" feature requires a fundamentally
different server-side model:

- JWTs would need a per-session identifier claim (`sessionId`), and every
  authenticated request — HTTP **and** every WS message — would need to check
  a per-session registry (existence + revoked flag) instead of comparing one
  integer claim. That adds a hot-path lookup and a new revocation surface
  across two transports.
- Session rows would need lifecycle management (creation on login, rotation
  on refresh, GC on expiry) — a new persistence domain with its own
  consistency and race semantics, directly touching the recently hardened
  revocation behavior.
- The CAS refresh-rotation semantics would need reworking around per-session
  records.

That is a larger architectural change with real regression risk to the
revocation guarantees this slice depends on, so it was consciously deferred
rather than bolted on (see §5.4).

### 5.3 What WAS built

- **Sign out other sessions** — `POST /auth/sessions/revoke-others`: a CAS
  bump of the global `sessionVersion` (invalidate every other device) with
  **immediate re-issuance of a fresh token pair to the caller**, so this
  device stays signed in. The client rotates SecureStore + in-memory state
  with the persist-before-expose order (§4.4).
- **Sign out everywhere** — the existing `POST /auth/logout` global
  revocation, unchanged.
- **This device's session view** — derived from the access token's own
  `iat`/`exp` claims via the pure, fail-closed `currentSessionView` (real
  claims only; honest "Unavailable from the current token" fallback).

### 5.4 Honest limitation and proposed follow-up architecture

The Sessions & Devices screen states plainly: *"iRexPro immediately signs out
every other device. A full list of individual devices with per-device
sign-out requires a server-side session registry — planned as a follow-up."*
No per-device rows are fabricated.

Proposed follow-up: a server-side **auth-session registry** — a
`user_auth_sessions` table (id, userId, device label, client metadata,
createdAt, lastSeenAt, revokedAt, generation) written on login and rotation,
with `sessionId` added to token claims. Listing is then a simple owned-row
query (privacy-safe projection, like security-events), and revoke-one is a
row-level revocation checked by the same JWT/WS validation path. This should
be designed with its own ADR and migrated carefully; it is explicitly out of
scope for Sprint 55.

---

## 6. Test coverage map

### 6.1 Harness suites ↔ behaviors

`pnpm --filter @irexpro/mobile test` runs
`apps/mobile/scripts/test-account-security.cjs` — a zero-dependency harness
(same pattern as `packages/api-client/scripts/test-contracts.cjs`: transpile
the TS sources with the workspace TypeScript, evaluate the CommonJS output,
assert with `node:assert`). 124 tests across 10 suites:

| Suite | Tests | Behaviors pinned |
| --- | --- | --- |
| profile field validation and request building | 35 | All 7 validators (valid + invalid + boundaries: names 1/100/101 + trim, country case/normalize, timezone accept/reject, 3-letter currency, DOB leap-year/pre-1900/future/malformed, experience enum member vs non-member), `profileFieldErrors` aggregation, `toProfileFieldValues`, trim-aware `isProfileDirty`, changed-only `buildUpdateMyProfileRequest` (incl. unchanged-DOB never sent → no accidental KYC reset), `deriveInitials`, `PROFILE_EXPERIENCE_OPTIONS` |
| account status and verification presentation | 5 | `accountStatusMeta` all 5 statuses (label + tone) + unknown fallback, `accountStatusGuidance` per status, `isRestrictedAccountStatus`, `verificationBadges` (null/empty/ISO timestamps) |
| password change policy validation | 8 | `validateNewPasswordPolicy` boundaries (11/12/127/128/129, letter, number), `validateChangePasswordSubmission` gate ordering (current required/≤128 → new policy → confirm empty vs mismatch) |
| MFA enrollment state machine | 16 | Full transition table (every reachable `(state, event)` pair → exact next state), `material ⟺ 'verifying'` invariant across all pairs, `failureReason ⟺ 'failed'` invariant, material wipe on `CANCEL`/`RESTART`/`CODE_ACCEPTED`/`CODE_REJECTED`, `RESTART`/`CANCEL` from every state, no-op strictness, `isMfaSetupExpiredRejection` (server 400 message shape vs other 400s/401/plain errors) |
| verification code, resend cooldown, and expiry copy | 9 | `validateSixDigitCode` (5/6/7 digits, non-numeric, trim), `resendCooldown` (0/mid/ceil/over — clamped ≥ 0), `formatCooldown` (Ns / m:ss / floor / negative), `verificationExpiryHint` distinct honest copy |
| JWT session decoding and device view | 15 | `decodeJwtPayload`: real-shaped hand-built JWT (base64url `-`/`_`, multi-byte UTF-8 é + emoji, 300-char payload), standard-base64 `+`/`/`/`=` acceptance, wrong segment counts, invalid chars, lone 6-bit group, non-object JSON, broken UTF-8 → `null`, never throws; `currentSessionView` (valid iat/exp → ms; missing/string/negative/Infinity → `null`); `deviceSummary` (number/string Version); `formatSessionTimestamps` |
| sanitized error mappers | 12 | `accountSecurityError` statusCode 0/401/400/422/429/5xx/other → each fixed copy, marker probes prove payload messages are never reflected, non-`ApiClientError` throwables → safe fallback; `verificationCodeError` 401 → code-mismatch copy + fallbacks; real `instanceof ApiClientError` semantics (api-client transpiled by the same harness) |
| pre-auth appeal validation | 7 | `validateAppealSubmission` identifier 0/1/255/256, reason 19/20/2000/2001, trim-awareness, gate ordering, length constants |
| security activity timeline | 7 | `securityEventLabel` for every allowlisted action + unknown → generic fallback (never an error), `securityEventTone` (INFO/absent/WARNING/CRITICAL), `formatRelativeTime` (just now, minutes, hours, days, ≥7 d ISO fallback, unparseable raw string, future clock skew) |
| sensitive-memory/storage static regression guard | 10 | See §6.2 |

### 6.2 Sensitive-memory/storage regression guard

The harness inspects the **transpiled source text** of both pure modules
(not just their behavior) and fails the build if the pure layer ever:

- contains `SecureStore` or `AsyncStorage` (no persistence from the account
  logic — enrollment material/codes/passwords can never be stored);
- contains `console.` (no logging of secrets);
- contains an `fs`/`node:fs` require (no filesystem access);
- has any runtime import at all for `account-security-logic.ts` (fully
  standalone), or any runtime import other than `@irexpro/api-client` +
  `./account-security-logic` for `account-security-errors.ts`.

This is a real static guard: adding a storage or logging call to the pure
account layer fails CI even if behavior tests still pass.

### 6.3 Security-regression proof table

Each required Sprint 55 security-regression proof and where it is tested:

| # | Required proof | Where it is tested |
| --- | --- | --- |
| 1 | MFA enrollment material is memory-only (wiped on terminal/reset transitions; non-null only while `verifying`) | Mobile harness — *MFA enrollment state machine* suite (invariant + wipe assertions across every `(state, event)` pair) |
| 2 | The pure account layer never persists or logs secrets (no SecureStore/AsyncStorage/fs, no console) | Mobile harness — *sensitive-memory/storage static regression guard* suite (transpiled-source guard) |
| 3 | Passwords/codes cleared from UI state at request start (screen-level hardening) | Screen code in `src/screens/account/*` (capture-to-const + `setState('')` before await); component-level automated tests deferred to jest-expo post-#210 — the logic-level wipe is proven by proof 1 |
| 4 | `beginMfaSetup` `{ password }` re-auth contract on the wire | api-client contract test — `testMfaSetupPasswordContract` (1 request, URL, POST, exact `{password}` body, Bearer + JSON headers) |
| 5 | Sanitized error copy; raw server messages/payloads never reflected | Mobile harness — *sanitized error mappers* suite (per-status fixed copy + marker probes + non-ApiClientError fallbacks) |
| 6 | change-password: current-password re-auth before mutation, 401 on mismatch, all-sessions revocation, pending-MFA retirement, weak-password 400 | API specs — `auth-change-password.spec.ts`, `auth-account-security-http.spec.ts` |
| 7 | revoke-others: CAS generation bump, fresh caller pair, no-store, body/cookie transports | API specs — `auth-revoke-others-sessions.spec.ts`, `auth-account-security-http.spec.ts`; api-client contract — `testRevokeOtherSessionsContract` + `testRevokeOtherSessionsNetworkErrorContract` |
| 8 | security-events: ownership + server-side allowlist + 4-field privacy projection + clamped pagination + 503 fail-closed | API specs — `audit-user-security-events.spec.ts`, `auth-security-events.spec.ts`, `auth-account-security-http.spec.ts`; api-client contract — `testListSecurityEventsContract` |
| 9 | Revoked sessions are rejected on HTTP and per-message on WS (generation revalidation) | API specs — `auth-session-revocation.spec.ts`, `jwt-algorithm-policy.spec.ts` (pre-existing, recently hardened HS256/revocation work) |
| 10 | Typed profile contract: `GET/PATCH /users/me` wire shape; DOB-change-only KYC reset | api-client contract — `testUpdateMyProfileContract`; API suite (users service specs); mobile harness — *profile field validation* suite pins changed-only request bodies (unchanged DOB never sent) |
| 11 | Appeal endpoint is enumeration-safe (generic response; public pre-auth flow) | API suite (account governance specs); mobile — AppealScreen generic-response pattern mirrors `ForgotPasswordScreen` |
| 12 | Client validators mirror backend policy exactly (password 12–128 + letter + number; appeal 1–255/20–2000; DOB calendar/past/≥1900) | Mobile harness — *password change policy*, *pre-auth appeal validation*, *profile field validation* suites; API specs pin the server side |

### 6.4 CI wiring

`.github/workflows/mobile-ci.yml` runs, in order: frozen-lockfile install →
api-client contract tests → **mobile account-security pure-logic tests**
(`pnpm --filter @irexpro/mobile test`) → Expo asset checks →
`validate:release-config` → `expo install --check` → typecheck → Android/iOS
bundle smoke. The harness adds no dependencies, so the lockfile is untouched.

---

## 7. Deferred until post-#210

The following were consciously deferred (tracked against the repo's
no-new-packages posture for the mobile app until the expo SDK / expo-router
migration in #210 lands):

- **QR rendering** of the `otpauth://` enrollment URI (no pure-JS QR
  dependency added; the secret and URI are shown as selectable text).
- **Clipboard copy** affordance for the secret (expo-clipboard not a
  dependency; long-press selection is the interim affordance).
- **jest-expo component/screen tests** (jest infra + lockfile changes; the
  pure logic is covered meanwhile by the zero-dependency harness).
- **Per-device session registry** (server-side auth-session table; see §5.4).
- **Email deep-link confirmation in-app** (email verification completes via
  the web link flow; the app only shows server-confirmed status).
