\# iRexPro Current Project State



\## Current Sprint Checkpoint

Current sprint: Sprint 29 + UX feature (merged to `main`).

Last completed: PR #24 — Premium Onboarding UX and Persistent Design System (MERGED to `main`, merge commit `2a4b608`).

Previous: PR #23 — Auth-principal hotfix (MERGED to `main`).


\## PR #24 — Premium Onboarding UX and Persistent Design System (MERGED)

PR: https://github.com/christianagbotah/irexpro/pull/24
Merge commit: `2a4b6087e69afd90d81f474d33d7fab58aa5c6fc`
Head commit at merge: `582831ede672404aa54d682f15eea3aa4b86a36e`
Branch: `feature-onboarding-ux-timezone-risk-tooltips-notifications`

### What was merged

- **TimezoneSelect**: searchable IANA timezone selector with standard ARIA editable combobox pattern (role="combobox" on input, aria-expanded, aria-controls, aria-autocomplete="list", conditional aria-activedescendant, role="listbox", role="option", aria-selected). Browser auto-detection. 48-entry fallback list. Full keyboard navigation.
- **InfoTooltip**: accessible tooltip (hover + focus + touch + Escape). 7 risk-setting tooltips with exact spec copy.
- **NotificationProvider**: centralized toast system. notify is referentially stable (useMemo with []).
- **ConfirmDialog**: accessible confirmation modal with focus trap, Escape, overlay close, focus restoration.
- **mapApiError**: API error to safe user-facing message mapper.
- **Premium CSS**: +1,463 lines appended to globals.css (progressive enhancement).
- **Premium page redesigns**: /onboarding/profile, /onboarding/risk, /onboarding/broker, /dashboard.
- **Persistent UI/UX design system**: `docs/design/IREXPRO_UI_UX_DESIGN_SYSTEM.md` (737 lines, 28 sections). Mandatory reference in CURSOR_WORKFLOW.md and DEVELOPMENT_RULES.md.

### TimezoneSelect accessibility fix

Original implementation placed aria-activedescendant on a <button> trigger (triggered jsx-a11y/role-supports-aria-props). Fixed by converting to standard ARIA editable combobox pattern where the search <input> has role="combobox".

### Post-merge verification

- Web test: **44 passed (4 suites)**
- Web lint: **0 warnings, 0 errors**
- Web build: pass
- Admin build: pass
- Mobile typecheck: pass
- Types typecheck: pass
- API-client typecheck: pass
- API test: **1,054 passed (70 suites)**
- API build: pass
- git diff --check: clean

### Remaining requirement

A rendered cross-viewport browser review (360px, 390px, 768px, 1024px, 1440px) was not available in the sandbox environment. Static CSS inspection and component tests found no overflow risks, but a rendered browser review should be performed in staging before production release.


\## Sprint 28 — Secure Password Reset Backend Flow (in progress)

Sprint 28 implements secure forgot-password and reset-password functionality, then wires the existing placeholder frontend pages to real backend endpoints.

### Backend changes

**New entity + migration:**
- `apps/api/src/modules/auth/entities/password-reset-token.entity.ts` — `PasswordResetToken` entity (schema: `identity.password_reset_tokens`). Fields: `id`, `userId`, `tokenHash`, `channel` (EMAIL/PHONE), `destinationHash` (nullable), `expiresAt`, `usedAt`, `requestedAt`, `requestedIp`, `userAgent`, `attemptCount`, `createdAt`, `updatedAt`. Indexes on `userId`, `tokenHash`, `expiresAt`.
- `apps/api/src/database/migrations/1751900000000-CreatePasswordResetTokens.ts` — non-destructive migration (CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS). Uses `gen_random_uuid()` from pgcrypto.

**New services:**
- `apps/api/src/modules/auth/password-reset.service.ts` — `PasswordResetService` with `requestReset()`, `resetWithToken()`, `resetWithCode()`. Generates high-entropy tokens (32 bytes hex for email, 6-digit code for phone), hashes with SHA-256 (only hash stored), enforces 15-min email / 10-min phone expiry, single-use (`usedAt`), invalidates prior unused tokens on new request, max 5 failed phone code attempts, hashes new password with argon2, audits request + completion (no raw token/code in audit metadata).
- `apps/api/src/modules/auth/password-reset-delivery.service.ts` — `PasswordResetDeliveryService` with clean provider abstraction. Email flow: builds reset link `${WEB_BASE_URL}/reset-password?token=...`. Phone flow: delegates to SMS provider registry. Safe "not configured" behavior: if no email/SMS provider is configured, logs a safe operational warning (no raw token) and returns `delivered: false`.

**New DTOs:**
- `forgot-password.dto.ts` — `identifier` (email or phone).
- `reset-password.dto.ts` — supports email token flow `{ token, password }` and phone code flow `{ identifier, code, password }`. Password validation: min 12 chars, must contain letters + numbers.

**New endpoints:**
- `POST /auth/forgot-password` — accepts `{ identifier }`, always returns generic message. Does NOT reveal account existence. Audits `USER_PASSWORD_RESET_REQUESTED`.
- `POST /auth/reset-password` — accepts `{ token, password }` (email) or `{ identifier, code, password }` (phone). Returns success message. Returns 401 for invalid/expired/used token. Returns 400 for weak password. Audits `USER_PASSWORD_RESET_COMPLETED`.

**Config additions:**
- `app.webBaseUrl` (env: `WEB_BASE_URL`) — base URL for web app reset links.
- `email.smtpUrl` (env: `EMAIL_SMTP_URL`) — SMTP URL for email provider (optional).
- `email.fromAddress` (env: `EMAIL_FROM_ADDRESS`) — from address for reset emails.

**Security controls:**
- Raw token/code is NEVER stored — only SHA-256 hash.
- Raw token/code is NEVER logged — only safe metadata in audit logs.
- Raw token/code is NEVER returned in API responses — delivered only via email link or SMS.
- Token expiry enforced (15 min email, 10 min phone).
- Single-use enforced (`usedAt` set on successful reset; reuse rejected).
- Prior unused tokens invalidated when a new one is issued.
- Phone code: max 5 failed attempts before invalidation.
- No account enumeration — forgot-password always returns the same generic message.
- Password hashed with argon2 (same as register/login).

**Session invalidation status (resolved):**
Authentication now uses a durable `User.sessionVersion` generation. Access/refresh JWTs carry that generation, refresh rotation advances it atomically, logout/password change/password reset revoke prior sessions by advancing it, and stale/replayed refresh generations fail closed. Successful password reset revokes existing sessions transactionally with the password change; no Redis token blacklist is required for this invariant.

### Frontend changes

**packages/types:** Added `ForgotPasswordRequest`, `ForgotPasswordResponse`, `ResetPasswordRequest`, `ResetPasswordResponse` types.

**packages/api-client:** Added `forgotPassword(body)` and `resetPassword(body)` methods.

**Web (apps/web):**
- `forgot-password/page.tsx` — wired to real backend. Accepts email or phone. Shows generic success message always.
- `reset-password/page.tsx` — wired to real backend. Reads `?token=...` from URL (email flow). Supports phone code flow toggle. Validates password match + strength. Links back to login after success.

**Admin (apps/admin):**
- `(auth)/forgot-password/page.tsx` — wired to real backend (same endpoint as web).
- `(auth)/reset-password/page.tsx` — wired to real backend (same endpoint as web). Links back to `/admin/login`.
- Admin reset does NOT bypass security — same endpoints, same validation.

**Mobile (apps/mobile):**
- `ForgotPasswordScreen.tsx` — wired to the real backend via the shared API client. Accepts email or phone and preserves the generic anti-enumeration response.
- `ResetPasswordScreen.tsx` — native phone-code recovery is implemented: after requesting reset instructions, a phone user can enter the six-digit SMS code and a new password, using the same server-authoritative reset endpoint. Successful reset clears the local SecureStore session because the server has revoked prior session generations.
- Email reset remains on the verified HTTPS web reset flow. Raw email reset credentials are intentionally not placed in a custom mobile URI scheme; production Universal Links/App Links require verified Apple/Android domain-signing metadata before they should carry recovery credentials.

### Email delivery (Sprint 28 amendment — real SMTP via nodemailer)
Email reset link flow is implemented with REAL SMTP delivery via nodemailer.
The reset link is `${WEB_BASE_URL}/reset-password?token=<raw-token>`. When
`EMAIL_SMTP_URL` + `WEB_BASE_URL` are set, the `NodemailerEmailProvider` sends
a real reset email via the configured SMTP server. If either is missing, the
service logs a safe warning (no raw token) and returns `delivered: false` — the
API still returns the generic message. If SMTP send fails, the service returns
false (no account enumeration).

Env vars (all optional, safe "not configured" behavior):
- `WEB_BASE_URL` — base URL for reset links (e.g. https://irexpro.lightworldtech.com)
- `EMAIL_SMTP_URL` — SMTP connection URL (smtps://user:pass@smtp.example.com:465)
- `EMAIL_FROM` or `EMAIL_FROM_ADDRESS` — from address (aliases, either works)
- `ADMIN_BASE_URL` — reserved for future admin-specific reset links

All reset links (web + admin) use `WEB_BASE_URL` — a single universal reset
URL. Admin forgot-password calls the same endpoint and shows a generic message
pointing users to the web reset page. After reset, admin users log in at
/admin/login.

Security: raw token is NEVER logged. Email body is NEVER logged. SMTP errors
are logged without the raw token or email body. The recipient email is masked
in logs (e***e@example.com).

### Phone/SMS recovery
Phone code flow is implemented (6-digit code, 10-min expiry, max 5 attempts).
Twilio is now a live provider behind the shared `SmsProviderRegistry` when its
required production configuration is present. Hubtel and Arkesel remain honest
non-live placeholders and are excluded from live provider selection. The native
mobile app now completes the phone-code reset flow end to end through
`/auth/reset-password`.

### Tests added (34 new, 881 total across 53 suites)
- `password-reset.service.spec.ts` (21 tests): generic response for existing/non-existing/suspended users, phone-only user recovery, prior token invalidation, hash-only storage, no raw token in audit, valid token reset, argon2 password hashing, invalid/expired/used token rejection, phone code reset, empty identifier rejection, no account enumeration, high-entropy token (64 hex chars), 6-digit phone code, 15-min email expiry, 10-min phone expiry, no sensitive data in result.
- `password-reset-delivery.service.spec.ts` (13 tests — Sprint 28 amendment): sends email when SMTP+WEB_BASE_URL configured, reset link uses WEB_BASE_URL, does NOT send when SMTP missing, does NOT send when WEB_BASE_URL missing, SMTP failure returns false (no enumeration), raw token not logged, phone returns false (placeholder), raw code not logged, NodemailerEmailProvider send success, SMTP failure returns false, EMAIL_SMTP_URL missing returns false, email masked in logs.

### Rate limiting (Sprint 28 amendment)
`@nestjs/throttler` added. `ThrottlerGuard` applied to all `/auth/*` routes.
Per-route `@Throttle` overrides:
- `POST /auth/forgot-password`: 5 requests per 15 minutes per IP (prevents enumeration)
- `POST /auth/reset-password`: 10 attempts per 15 minutes per IP (prevents token brute-force)
Combined with single-use + expiry + max-5-phone-code-attempts in the service for defense-in-depth.

### Web auth horizontal scroll fix (Sprint 28 amendment)
Applied the same CSS fix from the admin login hotfix to the web auth layout
(`apps/web/src/app/globals.css`): `overflow-x: hidden` on `.auth-layout`,
`.auth-layout__brand`, `.auth-layout__form-side`; `min-width: 0` on flex
children; `overflow-wrap: anywhere` on headlines/subheadlines/features;
`flex-wrap: wrap` + `flex-shrink: 0` on logo; `max-width: 100%` +
`pointer-events: none` on decorative `::before`; mobile `@media (max-width:
480px)` shrinks the decorative circle to 300px and reduces headline/logo.
Affects /login, /register, /forgot-password, /reset-password.

No payment/webhook/broker/risk/AI logic changed. No secrets. No .env. No default admin credentials.




\## Hotfix — Admin Portal Auth Guard + First Admin Bootstrap

Branch: `hotfix-admin-auth-guard-bootstrap-admin`

### Problem
1. The admin portal showed the full sidebar/menu on `/admin/login` and all `/admin/*` routes — even when the user was not logged in. The `app/admin/layout.tsx` wrapped EVERY `/admin/*` route (including login) with the sidebar + AdminNav.
2. There was no secure way to create the first admin account. No default admin credentials exist (by design), and there was no bootstrap command.

### Fix — Part 1: Admin UI guard (route group restructuring)
Restructured `apps/admin/src/app/admin/` into two Next.js App Router route groups:
- `(auth)/` — public admin auth routes (`/admin/login`, `/admin/forgot-password`, `/admin/reset-password`). Bare layout, NO sidebar, NO admin nav.
- `(protected)/` — authenticated admin routes (`/admin/dashboard`, `/admin/users`, `/admin/brokers`, `/admin/payments`, `/admin/subscriptions`, `/admin/audit`). Uses the `AdminProtectedLayout` which implements a 4-state guard:
  1. `restoring === true` → loading state, no sidebar, no "Not signed in".
  2. `!user` → clean "Not signed in" card with link to login. No sidebar.
  3. `user && !hasAdminRole` → "Access denied" card with sign-out button. No sidebar.
  4. `user && hasAdminRole` → full admin shell (sidebar + nav + content). Only this branch shows the sidebar.

`AdminNav` is also role-aware (returns `null` if `!hasAdminRole`) as defense in depth. The old `app/admin/layout.tsx` was deleted; the old page directories were moved into the route groups.

### Fix — Part 2: Backend admin role enforcement (review, no changes needed)
Verified all admin endpoints have `@Roles(ADMIN, SUPER_ADMIN)` + `@UseGuards(RolesGuard)`:
- `GET /admin/users`, `GET /admin/users/:id` (users.controller.ts)
- `POST /subscriptions/dev/manual-activate` (subscriptions.controller.ts)
- All `performance-billing`, `broker-reconciliation`, `performance-fees` admin endpoints
- `JwtAuthGuard` is registered globally as `APP_GUARD`, so all routes require JWT unless `@Public()`.
- No admin endpoints were missing role guards. No backend changes needed.

### Fix — Part 3: First admin bootstrap (`seed:admin`)
New: `apps/api/src/modules/users/bootstrap-admin.service.ts` + `apps/api/scripts/bootstrap-admin.ts` + `pnpm --filter @irexpro/api seed:admin`.
- Reads admin details from env vars ONLY (never from argv): `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PHONE`, `BOOTSTRAP_ADMIN_PASSWORD`, `BOOTSTRAP_ADMIN_FIRST_NAME`, `BOOTSTRAP_ADMIN_LAST_NAME`, `BOOTSTRAP_ADMIN_COUNTRY_CODE`.
- Requires at least email OR phone. Requires password ≥12 chars with letters + numbers.
- Find-or-creates USER/ADMIN/SUPER_ADMIN roles. Find-or-creates the user (by email or phone). If user exists, promotes to SUPER_ADMIN (does NOT change password). If not, creates new SUPER_ADMIN with argon2-hashed password + ACTIVE status.
- Idempotent: running twice is safe (no duplicate roles or user_roles).
- NEVER exposed as an HTTP endpoint. NEVER logs the raw password. Transactional (rollback on error).
- There is NO default admin account. No hardcoded credentials. No public admin registration.

### Fix — Part 4: Admin login behavior
`/admin/login` accepts email or international phone. Uses the same `/auth/login` endpoint. After login, fetches `/auth/me`. If user lacks ADMIN/SUPER_ADMIN, shows "Access denied" on the login page with a sign-out button (does NOT redirect to dashboard). If user has admin role, redirects to `/admin/dashboard`.

### Tests added (22 new, 825 total across 50 suites)
- `bootstrap-admin.service.spec.ts` (15 tests): input validation, role find-or-create, first admin creation, password hashing, existing user promotion, idempotency, safe output (no password), transaction rollback.
- `roles.guard.spec.ts` (7 tests): ADMIN/SUPER_ADMIN allowed, USER rejected (403), no roles rejected, no user rejected, no-@Roles allowed, mixed roles allowed.

### `AuthUser` type change
Added `phone: string | null` to `AuthUser` (packages/types) and `AuthUserDto` (backend) so the frontend can display the phone for phone-only users. This is a frontend-safe field.

No payment/webhook/broker/risk/AI logic changed. No secrets. No .env. No default admin credentials.


\## Sprint 27 — Auth UI Refinement + Phone Registration + Remember Me (in progress)

Sprint 27 refines auth UI/UX and safely extends the auth contract for phone registration and remember-me behavior.

**Backend changes:**
- `LoginDto`: renamed `email` to `identifier` (accepts email OR phone); added optional `rememberMe` boolean.
- `RegisterDto`: `email` is now optional; added optional `phone` field; added optional `rememberMe`.
- `AuthService.register()`: validates at least one of email/phone is provided; normalizes phone via `normalizePhone()` utility; checks for duplicate phone (service + DB unique index); stores normalized phone.
- `AuthService.login()`: resolves identifier as email (contains @) or phone; normalizes phone for lookup.
- `AuthCookieService.setRefreshCookie()`: accepts `rememberMe` param — when true, sets 7-day maxAge; when false/omitted, sets session cookie (no maxAge).
- `AuthController`: passes `dto.rememberMe` to `setRefreshCookie` on login and register.
- `User entity`: `email` column changed to `nullable: true` (was NOT NULL) to support phone-only registration.
- New migration: `1751700000000-MakeEmailNullableForPhoneRegistration.ts` — alters `identity.users.email` to DROP NOT NULL. Non-destructive, idempotent.
- New migration: `1751800000000-AddPhoneUniqueIndex.ts` — creates partial unique index `ux_users_phone` on `identity.users(phone)` WHERE `phone IS NOT NULL AND phone <> ''`. Idempotent (IF NOT EXISTS).
- New utility: `apps/api/src/modules/auth/utils/phone.util.ts` — `normalizePhone()` (E.164-like: strips spaces/dashes/parens, handles local with calling code, handles international with +, handles 00 prefix) + `isEmail()` helper.
- `JwtPayload.email` changed to `string | null`.
- `AuthUserDto.email` changed to `string | null`.
- Payment/subscription interfaces: `CreateCheckoutSessionRequest.email` and `CreateCustomerParams.email` changed to `string | undefined`. Subscription checkout controller and performance-fee payment service pass `email ?? undefined` — NOT empty string. Payment providers receive `undefined` if the user has no email; they handle this gracefully (Stripe/Paystack accept checkout without customer email).
- 17 new tests: phone-only register, duplicate phone, both, no-creds, rememberMe variants, phone normalization (Ghana local, international, spaces/dashes, 00 prefix, null/empty), isEmail detection.
- **iRexPro does NOT hold user funds.** Users do not deposit/withdraw money into iRexPro. Trading relies on the user's broker account balance. Broker account funding/withdrawal happens through the broker, not through iRexPro. Payment/subscription modules are for platform billing (subscription fees + performance fees), not for user fund custody.

**Frontend changes:**
- `packages/types`: `LoginRequest` uses `identifier` + `rememberMe`; `RegisterRequest` has optional `email`/`phone` + `rememberMe`; `AuthUser.email` is `string | null`.
- `apps/web`: login uses "Email or international phone number" label + remember me checkbox; register has country code selector (Ghana default +233) + phone field + remember me; split auth layout fixed scroll (left static, right scrolls).
- `apps/admin`: login uses "Email or international phone number" + remember me checkbox; split auth layout fixed scroll.
- `apps/mobile`: login label updated to "Email or international phone (+233...)".
- "Stripe & Paystack subscription checkout" replaced with "Secure subscription management".
- Country code selector: searchable dropdown with 16 countries (GH, NG, GB, US, CA, ZA, KE, CI, TG, BJ, BF, SL, LR, AE, IN, CN). Default: Ghana +233. No external dependency.

**Remember-me strategy:**
- Web/admin: rememberMe controls httpOnly refresh cookie maxAge only. Access token remains in memory. No localStorage/sessionStorage.
- rememberMe=false → session cookie (cleared on browser close).
- rememberMe=true → 7-day persistent cookie.
- Mobile: continues using SecureStore (unaffected by rememberMe).

No payment/webhook/broker/risk/AI logic changed. No secrets. No .env.

Verification: 783 API tests pass (760 existing + 23 new), 47 suites. All frontend builds/typechecks pass.


\## Sprint 26 — Modern UI/UX Design System + Forgot Password Flow (PASS, merged to `main`)

Sprint 26 creates a modern, professional, responsive UI/UX foundation for iRexPro auth and dashboard shells across web, admin, and mobile. It also adds forgot-password/reset-password UI flows safely.

**Backend forgot/reset endpoint discovery:** the backend does NOT have `POST /auth/forgot-password` or `POST /auth/reset-password` endpoints. The auth controller only has register/login/refresh/logout/me. The audit-action enum already has `USER_PASSWORD_RESET_REQUESTED` and `USER_PASSWORD_RESET_COMPLETED` — so the backend is planned but not yet implemented. Sprint 26 creates polished UI pages only with safe generic messages. The next sprint requirement is to implement the backend password reset endpoints.

**UI components added:**
- `apps/web/src/components/ui/index.tsx` — Button, Input, Card, Alert, Badge, LoadingSpinner, EmptyState, AuthLayout (split-screen), DashboardShell (sidebar + header)
- `apps/admin/src/components/ui/index.tsx` — same primitives with admin amber accent
- `apps/web/src/app/globals.css` — full design system (enterprise fintech teal/slate palette, spacing scale, shadows, typography)
- `apps/admin/src/app/globals.css` — same with admin amber accent

**Web pages redesigned/added:**
- `/login` — split-screen AuthLayout with brand panel + login form, forgot-password link
- `/register` — split-screen with registration form
- `/dashboard` — DashboardShell (sidebar + header) with account status card, broker connection, subscription, recent activity
- `/forgot-password` — new — safe generic message ("If an account exists…")
- `/reset-password` — new — password + confirm with safe message

**Admin pages redesigned/added:**
- `/admin/login` — split-screen with admin brand panel + login form, forgot-password link
- `/admin/dashboard` — stat cards grid (users, subscriptions, revenue, brokers) + management cards with links
- `/admin/forgot-password` — new — safe generic message
- `/admin/reset-password` — new — password + confirm with safe message
- Admin sidebar redesigned with active state, user display, logout

**Mobile improvements:**
- LoginScreen — added "Forgot password?" link
- ForgotPasswordScreen — new screen with safe generic message
- App.tsx — supports forgot-password screen state

**Security rules for password reset UI:**
- Does not expose whether an email exists (generic message)
- Does not expose reset tokens in logs
- Does not store reset tokens in localStorage/sessionStorage
- Does not perform frontend-only password changes
- Backend remains source of truth
- Next backend requirement: implement POST /auth/forgot-password and POST /auth/reset-password

No payment/webhook/broker/risk/AI/migration logic changed. No secrets. No .env files.

Verification: 760 API tests pass (46 suites, unchanged from Sprint 25). Web build exit 0 (10 routes). Admin build exit 0 (12 routes). Mobile typecheck exit 0. All shared package typechecks exit 0. API build exit 0.


\## Sprint 25 — Authentication Security Hardening + Roles Session Contract (PASS, merged to `main`)

Sprint 25 hardens the authentication contract so web/admin/mobile can safely maintain sessions and the admin portal can reliably identify admin/back-office users. It addresses two Sprint 24 limitations: (1) web/admin sessions were lost on page refresh, and (2) /auth/me did not return frontend-safe roles.

**Chosen session strategy: Hybrid — httpOnly refresh cookie (web/admin) + SecureStore (mobile).**

Rationale: the backend is token-based (Bearer access token + refresh token in JSON body). Sprint 25 amendment adds httpOnly refresh cookie support so web/admin sessions survive page refresh without localStorage. The backend still returns tokens in JSON for mobile compatibility. Both flows work simultaneously:
- Web/admin: access token in memory (NOT localStorage); refresh token in httpOnly cookie set by the backend. On page refresh, the AuthProvider calls /auth/refresh (cookie sent automatically via credentials:'include') → gets new access token → calls /auth/me → session restored. No localStorage, no sessionStorage.
- Mobile: tokens persisted in Expo SecureStore (iOS Keychain / Android Keystore). Sessions survive app restarts. Mobile sends refreshToken in the JSON body to /auth/refresh. AsyncStorage is prohibited.

**Backend changes (minimal, fully tested):**
- `GET /auth/me` now returns a frontend-safe `AuthUserDto` (new file `apps/api/src/modules/auth/dto/auth-user.dto.ts`) that explicitly allowlists only safe fields: `id`, `email`, `firstName`, `lastName`, `countryCode`, `status`, `roles`, `mfaEnabled`, `lastLoginAt`, `createdAt`. Sensitive fields (`passwordHash`, `mfaSecret`, `deletedAt`, `userRoles`, `profile` PII) are never included.
- `roles` is now always present in the /auth/me response — it comes from the JWT payload (set by `JwtStrategy.validate()` from the user's assigned roles at token-sign time).
- `firstName`/`lastName` are loaded from the `UserProfile` relation.
- New `AuthCookieService` (`apps/api/src/modules/auth/auth-cookie.service.ts`) — manages the httpOnly refresh cookie: `setRefreshCookie`, `clearRefreshCookie`, `getRefreshTokenFromCookie`. Cookie settings: httpOnly=true, secure=true in production, sameSite=none in production (cross-origin admin → API), path=/api/v1/auth, maxAge=7 days.
- `POST /auth/login` and `POST /auth/register` now set the httpOnly refresh cookie on the response (in addition to returning tokens in JSON for mobile).
- `POST /auth/refresh` now checks the httpOnly cookie first, then falls back to the JSON body `refreshToken`. Both paths work. `RefreshTokenDto.refreshToken` is now optional.
- `POST /auth/logout` now clears the httpOnly refresh cookie.
- 17 new tests: 5 in `auth.service.spec.ts` (getAuthUserDto safe fields, roles, sensitive exclusion, not-found, null profile) + 4 in `auth.service.spec.ts` (refreshTokens valid/invalid/not-found/suspended) + 8 in `auth-cookie.service.spec.ts` (set cookie, secure/sameSite settings, clear cookie, get from cookie, cookie name).
- No payment/webhook/broker/risk/AI/migration logic changed.

**Frontend changes:**
- `packages/types`: `AuthUser` updated to match the backend DTO — `roles` is now `UserRole[]` (not optional), added `firstName`/`lastName`, removed `phone`/`timezone`/`preferredCurrency`/`updatedAt` (not in the DTO). Doc updated to reflect hybrid strategy.
- `packages/api-client`: `refresh()` now takes optional `refreshToken?` — when omitted (web/admin), relies on the httpOnly cookie via credentials:'include'. When provided (mobile), sends it in the JSON body.
- `apps/web`: AuthProvider now restores session on page refresh — on mount, calls `api.refresh()` (no args, cookie flow) → `api.me()` → user populated. Added `restoring` state to prevent UI flash during restore. `/login` and `/register` redirect to `/dashboard` if already authenticated (after restore completes). `/dashboard` shows "Restoring session…" during restore.
- `apps/admin`: same session restore pattern as web. `hasAdminRole` uses real `roles[]` from `/auth/me`. Dashboard shows "Access denied" if signed in without ADMIN/SUPER_ADMIN role. Admin login redirects if already authenticated admin.
- `apps/mobile`: `expo-secure-store` added; tokens persisted to SecureStore. Session restore on app launch. Logout clears SecureStore.

**Verification (all passing):**
- 760 API tests pass (743 existing + 17 new), 46 suites.
- API build exit 0.
- Web build exit 0, admin build exit 0.
- Mobile typecheck exit 0, packages typecheck exit 0.
- No secrets committed, no .env files committed.


\## Sprint 24 — Cross-Platform Auth UI Flow (PASS, merged to `main`)

Sprint 23 documents and hardens the actual staging frontend + admin deployment now that both portals load publicly in the browser on the real Webuzo VPS. The staging VPS now successfully serves:

- Web portal (client/trader): `https://irexpro.lightworldtech.com` (apps/web, port 3005)
- Admin portal (back-office): `https://irexproadmin.lightworldtech.com` (apps/admin, port 3006)
- Public API: `https://irexpro.lightworldtech.com/api/v1` (apps/api, port 3010)
- API health: `https://irexpro.lightworldtech.com/api/v1/health`
- AI engine (private/internal only): `http://127.0.0.1:8011/api/v1` — never publicly proxied

Sprint 23 is a **documentation and deployment-example hardening sprint only**. It does NOT change backend business logic, payment logic, webhook behavior, broker execution logic, risk gate logic, AI execution logic, database migrations, secrets, or commit any `.env` files. No Fovi architecture. No demo DB fallbacks. AI engine remains private.

Deliverables:

1. **Runbook §8.4 rewritten** (`docs/runbooks/production-deployment-vps-webuzo.md`) — verified two-domain staging topology: main domain (`irexpro.lightworldtech.com`) serves web + API; admin domain (`irexproadmin.lightworldtech.com`) serves admin portal. Nginx route tables for both domains. AI engine has no public location block on either domain.

2. **Runbook §8.5 added** — CORS alignment for two staging domains. Because admin is cross-origin with the API, `CORS_ORIGINS` must include both: `https://irexpro.lightworldtech.com,https://irexproadmin.lightworldtech.com`.

3. **Runbook §7.1.2 added** — staging PM2 process commands for four processes: `irexpro-api-staging` (port 3010), `irexpro-ai-staging` (port 8011, internal), `irexpro-web-staging` (port 3005), `irexpro-admin-staging` (port 3006). Includes `pm2 save` + `pm2 status` and a port→process map.

4. **Runbook §18 added** — public staging verification checklist with curl checks for: web home/login/dashboard, admin home/login/dashboard, public API health, local AI health (must succeed) + public AI health (must fail — AI is private), and CORS OPTIONS preflight checks for both origins.

5. **Nginx example updated** (`infrastructure/nginx/irexpro-staging.example.conf`) — now documents two server blocks: main domain (`/api/v1/` → 3010, `/_next/static/` → 3005, `/` → 3005) and admin domain (`/_next/static/` → 3006, `/` → 3006). No public proxy to 8011 on either domain.

6. **Backend `.env.example` CORS updated** — documents the staging-verified two-domain `CORS_ORIGINS` value.

7. **`apps/admin/.env.example` updated** — `NEXT_PUBLIC_APP_URL` now points at the verified admin subdomain (`https://irexproadmin.lightworldtech.com`), with a note that the API's CORS must include the admin origin.

PM2 process names and ports (verified staging):
- `irexpro-api-staging` → port 3010 (NestJS API, public via Nginx `/api/v1/`)
- `irexpro-ai-staging` → port 8011 (AI engine, internal only — never public)
- `irexpro-web-staging` → port 3005 (Next.js client web, public via main domain)
- `irexpro-admin-staging` → port 3006 (Next.js admin, public via admin subdomain)

No production safety rules were changed: AI never executes broker orders directly, risk gate remains mandatory, payment checkout never marks paid, only verified webhooks confirm payment, no floating-point money, no demo fallback, no localStorage/Fovi-style assumptions, no secrets committed, AI engine never publicly exposed. NestJS tests remain at 743 passing across 45 suites (unchanged — no backend source logic changed).


\## Sprint 22 — Staging Frontend/API Integration (PASS, merged to `main`)

Sprint 22 (revised) creates a proper cross-platform frontend foundation that is buildable, type-safe, and aligned with the verified staging API. iRexPro is a cross-platform system: a client/trader web app, an admin/back-office portal, a native mobile app, and two shared packages. All are scaffolded as real, buildable pnpm workspace packages — not placeholders.

Sprint 22 is a **frontend + documentation sprint only**. It does NOT change backend production logic, migrations, payment state transitions, webhook payment confirmation rules, broker execution rules, risk gate logic, AI trading/execution flow, or secrets. No `.env` files committed. No secrets in frontend/mobile env. No backend source logic changed.

Verified staging backend endpoints (from Sprint 21):
- Public API base: `https://irexpro.lightworldtech.com/api/v1`
- Local API: `http://127.0.0.1:3010/api/v1`
- AI engine (internal only): `http://127.0.0.1:8011/api/v1` — never exposed to frontend/mobile.

Cross-platform workspace structure created:

\- `apps/web` — Next.js 14 client/trader web app (App Router, TypeScript, port 3005). Buildable. Routes: `/`, `/login`, `/dashboard`, `/payments/success`, `/payments/cancel`, `/payments/callback`. Reads `NEXT_PUBLIC_API_BASE_URL` from env. Payment pages are display-only — never mark paid.

\- `apps/admin` — Next.js 14 admin/back-office portal (App Router, TypeScript, port 3006). Buildable. Routes: `/` (redirect), `/admin` (redirect), `/admin/login`, `/admin/dashboard`, `/admin/users`, `/admin/subscriptions`, `/admin/payments`, `/admin/brokers`, `/admin/audit`. Reads `NEXT_PUBLIC_API_BASE_URL` from env. Admin RBAC enforced by backend.

\- `apps/mobile` — Expo + React Native foundation for iOS and Android (TypeScript). Typechecks cleanly. Screens: Login, Dashboard, Account, Payments. Reads `EXPO_PUBLIC_API_BASE_URL` from env. Live trading and broker execution NOT implemented (foundation only).

\- `packages/types` (`@irexpro/types`) — shared frontend-safe TypeScript types (Auth, Subscription, Payment, Invoice, Broker view, Health, ApiError). No backend entities or secrets. Typechecks cleanly. All money values are integer minor-unit strings.

\- `packages/api-client` (`@irexpro/api-client`) — shared typed fetch client factory (`createApiClient`). Takes base URL as a parameter — never reads env directly, never hardcodes localhost. Supports `credentials: 'include'` for web (httpOnly cookies) and Bearer-token mode for mobile. Typechecks cleanly.

Env examples created (no secrets): `apps/web/.env.example`, `apps/admin/.env.example`, `apps/mobile/.env.example`. Each explicitly documents the backend-only secrets that must NEVER appear in frontend/mobile env: `AI_ENGINE_URL`, `NESTJS_INTERNAL_API_KEY`, `BROKER_ENCRYPTION_KEY`, `DB_PASSWORD`, `JWT_SECRET`, `PAYSTACK_SECRET_KEY`, `STRIPE_SECRET_KEY`, `METAAPI_TOKEN`, and others.

Backend `.env.example` aligned: `CORS_ORIGINS`, `PAYSTACK_CALLBACK_URL`, `STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL` now document staging-verified values. Runbook §8.4 rewritten for cross-platform deployment (web 3005, admin 3006, AI engine 8011 private, admin on `/admin` or separate subdomain). Integration spec at `docs/integration/frontend-staging-integration.md` covers the full cross-platform contract.

Verification (all passing):
\- `pnpm install` — all workspace packages install cleanly.
\- `pnpm --filter @irexpro/web build` — Next.js build succeeds, 7 routes generated.
\- `pnpm --filter @irexpro/admin build` — Next.js build succeeds, 10 routes generated.
\- `pnpm --filter @irexpro/mobile typecheck` — TypeScript typecheck passes (exit 0).
\- `pnpm --filter @irexpro/types typecheck` — passes (exit 0).
\- `pnpm --filter @irexpro/api-client typecheck` — passes (exit 0).
\- `pnpm --filter @irexpro/api test` — 743 tests pass, 45 suites (unchanged from Sprint 20).
\- `pnpm --filter @irexpro/api build` — NestJS build exit 0.

No production safety rules were changed: AI never executes broker orders directly, risk gate remains mandatory, payment checkout never marks paid (payment redirect pages are display-only), only verified webhooks confirm payment, no floating-point money, no demo fallback, no localStorage/Fovi-style assumptions (httpOnly cookies for web, Bearer token for mobile), no secrets committed, AI engine never referenced from frontend/mobile.




\## Sprint 21 — Staging Runbook Hardening (PASS, merged to `main`)

Sprint 21 hardens the production deployment runbook with findings from a real Webuzo VPS staging dry-run on AlmaLinux 9.8 (PostgreSQL 18, PM2, Nginx + Cloudflare). The dry-run used VPS app path `/home/lightworld/webapps/irexpro-staging`, public staging API `https://irexpro.lightworldtech.com/api/v1`, NestJS API local `http://127.0.0.1:3010/api/v1`, and AI engine local-only `http://127.0.0.1:8011/api/v1`.

Sprint 21 is a **documentation and deployment-examples sprint only**. It does NOT change any production application logic, migrations, payment logic, broker logic, risk gate logic, AI trading logic, database schemas, or secrets.

Verified staging findings documented in this sprint:

1. **PostgreSQL uuid-ossp on PG 18 / AlmaLinux:** migrations require `uuid_generate_v4()`. On Webuzo PG 18 the `uuid-ossp` extension can fail with a missing `libossp-uuid.so.16` error. Fix: install the AlmaLinux `uuid` package (or `uuid-dev`/`libossp-uuid16` on Ubuntu), run `ldconfig`, then retry `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"` and verify with `SELECT uuid_generate_v4()`. An emergency-only fallback (`public.uuid_generate_v4()` wrapping `gen_random_uuid()`) is documented but the proper package install is preferred.

2. **Correct DB env variable names:** the app reads `DB_USER`, NOT `DB_USERNAME`. Setting `DB_USERNAME` is silently ignored. Documented with a correct DB env block example.

3. **API ports:** staging-verified API port is `3010` (`APP_PORT=3010`, also `PORT=3010` for tooling). Frontend uses `3005` or `3006`. AI engine uses `8011`. Do not reuse frontend ports for the API.

4. **Health endpoints:** both the NestJS API and the AI engine expose health at `/api/v1/health`, NOT `/health`. The original Sprint 19 runbook incorrectly said `/health` (returns 404). Documented with curl examples for local API, local AI engine, and public endpoint.

5. **AI engine entrypoint:** the correct Uvicorn entrypoint is `app.main:app` (NOT `main:app` or `src.main:app`). The correct PM2 command is `.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8011`. `AI_ENGINE_ENV=production`, `AI_SIGNAL_MODE=paper`, `AI_ALLOW_MOCK_MARKET_DATA=false` in staging/production.

6. **AI engine remains private:** the AI engine is NOT publicly proxied through Nginx or Cloudflare. The NestJS API communicates with it internally at `http://127.0.0.1:8011`. Public traffic goes through the NestJS API only.

7. **CORS guidance:** API `CORS_ORIGINS` = real frontend/staging domain (e.g. `https://irexpro.lightworldtech.com`); localhost frontend origins may be temporarily included during staging. AI engine `AI_CORS_ORIGINS` = origin only, no path (e.g. `http://localhost:3010`, NOT `http://localhost:3010/api/v1`).

8. **Nginx/Webuzo reverse proxy:** do not define duplicate `location ^~ /` blocks. Recommended structure: `location /` proxies frontend to `127.0.0.1:3005`, `location ^~ /api/v1/` proxies NestJS API to `127.0.0.1:3010`, `location ^~ /_next/static/` proxies Next.js static assets. No public location block for AI engine 8011. Do not globally hide Content-Security-Policy. A version-controlled example config was added at `infrastructure/nginx/irexpro-staging.example.conf`.

9. **PM2/systemd startup:** documented the full verified sequence — `pm2 save`, `pm2 startup`, `systemctl daemon-reload`, `systemctl reset-failed pm2-root`, `systemctl restart pm2-root`, `systemctl status pm2-root --no-pager`, `pm2 status`. Noted that old failed systemd state can persist even while PM2 processes are online; `reset-failed` + `restart` cleans it.

10. **Verified Staging Dry-Run Checklist:** added §16 to the runbook — a go-live readiness gate covering source clone, pnpm install, PostgreSQL connection, uuid-ossp resolution, 8 migrations applied, API build, 743 tests / 45 suites passing, API start under PM2, API health at `/api/v1/health`, Python venv, AI engine start with `app.main:app`, AI health at `/api/v1/health`, PM2 startup saved, and public Cloudflare/Nginx API health.

11. **Sprint 20 runtime DI failure documented:** the runbook now records that the real staging dry-run discovered a runtime NestJS DI failure (`ExecutionService` could not resolve `CredentialEncryptionService`), that Sprint 20 fixed it by exporting `CredentialEncryptionService` from `BrokerModule` and adding a bootstrap smoke test, and that operators must run the test suite before PM2 startup so this class of runtime failure is caught before deployment.

Files changed in Sprint 21: `docs/runbooks/production-deployment-vps-webuzo.md` (hardened with all 11 findings + new §16/§17 sections), `infrastructure/nginx/irexpro-staging.example.conf` (new — version-controlled Nginx staging example, no secrets), `infrastructure/pm2/ecosystem.config.js` (comments + AI engine port updated to staging-verified 8011 + entrypoint documentation — no structural/behavior change), `docs/project-state/CURRENT_STATE.md` (this section).

No production safety rules were changed: AI never executes broker orders directly, risk gate remains mandatory, payment checkout never marks paid, only verified webhooks confirm payment, no floating-point money, no demo fallback, no localStorage/Fovi-style assumptions, no secrets committed. NestJS tests remain at 743 passing across 45 suites (unchanged from Sprint 20 — no source logic changed).


\## Sprint 20 — Runtime Bootstrap Fix (PASS, merged to `main`)

Sprint 20 fixes a staging runtime bootstrap DI failure discovered during VPS dry-run. On the real Webuzo VPS staging deployment, migrations passed and all 739 tests passed, but the NestJS API failed at runtime under PM2 with:

  Nest can't resolve dependencies of the ExecutionService
  (TradeRepository, TradingSessionRepository, BrokerService, BrokerAdapterRegistry, ?, AuditService, DataSource, DomainEventBus).
  Please make sure that the argument CredentialEncryptionService at index [4] is available in the ExecutionModule context.

Root cause: `CredentialEncryptionService` was declared as a provider in `BrokerModule` but was NOT included in `BrokerModule`'s `exports` array. `ExecutionService` (in `ExecutionModule`, which imports `BrokerModule`) injects `CredentialEncryptionService` at constructor index [4]. Because the service was not exported across the module boundary, NestJS could not resolve it at runtime. The existing unit tests did not catch this because each spec builds an isolated `TestingModule` with manually-mocked providers — the real module boundary / export graph was never exercised.

Fix: added `CredentialEncryptionService` to `BrokerModule`'s `exports` array. The service remains a single provider owned by `BrokerModule` — it is NOT re-declared anywhere else. This is the proper NestJS module-boundary fix: no hacks, no manual instantiation, no duplicate providers.

Bootstrap smoke test: added `apps/api/src/bootstrap.spec.ts` — a runtime DI smoke test that compiles the REAL feature-module graph (all 21 modules from AppModule) so that any missing provider export surfaces as a test failure in CI rather than at runtime. The test mocks `@nestjs/typeorm` and `@nestjs/bullmq` at the module level (no-op forRoot, forFeature provides mock repository tokens, registerQueue provides mock queue tokens) to avoid requiring live PostgreSQL/Redis connections, while every real feature module is imported unchanged. The test verifies: (1) the full graph compiles without DI errors, (2) `ExecutionService` is resolvable (the exact resolution that failed on staging), (3) `CredentialEncryptionService` is a single shared instance, (4) `BrokerAdapterRegistry` has both adapters registered.

This test would have caught the staging DI failure before deployment — verified by temporarily reverting the fix and confirming the test fails with the exact staging error message.

No production safety rules were changed: AI never executes broker orders directly, risk gate remains mandatory, payment checkout never marks paid, only verified webhooks confirm payment, no floating-point money, no demo fallback, no localStorage/Fovi-style assumptions, no secrets committed.


\## Sprint 19 — Production Deployment Foundation (in progress)

Sprint 19 prepares iRexPro for safe VPS / Webuzo production deployment. It is a **documentation and deployment-foundation sprint only** — it does NOT change any production logic, payment-state transitions, webhook processing, broker credential handling, risk engine rules, execution engine rules, or the AI-to-trade flow. All Sprints 10–18 safety invariants remain exactly as they were.

Deliverables (Sprint 19 branch `sprint-19-production-deployment`):

\- Production deployment runbook for VPS / Webuzo: `docs/runbooks/production-deployment-vps-webuzo.md` — covers system requirements, PostgreSQL setup, Redis setup, environment variable setup, build process, migration run process, PM2/systemd process management, Nginx reverse proxy + TLS, health-check verification, logs, rollback process, and a full deployment checklist.

\- Secrets policy runbook: `docs/runbooks/secrets-never-committed.md` — the authoritative list of files and values that must never be committed to git, with a pre-push self-check.

\- PM2 ecosystem example: `infrastructure/pm2/ecosystem.config.js` — manages both the NestJS API and the Python AI engine from one config. Contains NO secrets (all read from gitignored `.env` files).

\- systemd unit examples: `infrastructure/systemd/irexpro-api.service` and `infrastructure/systemd/irexpro-ai-engine.service` — alternative to PM2 for teams that prefer native systemd. Contain NO secrets.

\- `.env.example` improvements (both `apps/api/` and `services/ai-engine/`) — added production-deployment pointers and per-variable production notes. No real secrets added; every value remains a `CHANGE_ME_*` / `PLACEHOLDER` / `dev_*` placeholder.

\- `.gitignore` hardened — added `*.egg-info/` to prevent Python package metadata from being tracked. Untracked 5 pre-existing `irexpro_ai_engine.egg-info/` files (kept on disk).

\- This document + `IMPLEMENTATION_ROADMAP.md` updated to reflect Sprint 19 start.

Sprint 19 safety rules preserved (no regressions from Sprints 10–18):

\- Checkout never marks invoice/transaction/subscription/assessment/HWM paid — only a verified provider webhook does.
\- Only a verified provider webhook may confirm payment.
\- Amount and currency must match before confirming payment.
\- HWM may update only through the verified performance-fee webhook success path; HWM cannot regress (Sprint 18 `max()` semantics).
\- `PerformanceFeeService` exposes no method that transitions an assessment to PAID or updates the HWM.
\- DB-level uniqueness on `(provider, provider_transaction_reference)` is enforced; 23505 is caught safely and never leaks.
\- Broker credentials remain AES-256-GCM encrypted; never in responses, logs, audit metadata, WebSocket events, or errors.
\- AI never executes broker orders directly.
\- Risk approval remains mandatory and non-bypassable.
\- All persisted money values remain bigint minor-unit strings. No floating-point money.
\- No demo-data / database-failure fallback in any production path. No SQLite. No Fovi-style Next.js API routes or localStorage auth.
\- Production failures fail closed.

No production logic, migrations, payment-state transitions, webhook processing, broker, risk, execution, or AI code was changed in Sprint 19. NestJS tests remain at 739 passing across 44 suites (unchanged from Sprint 18).


\## Sprint 18 — Payment Transaction Reference Uniqueness + Metadata Consistency Hardening

Sprint 18 hardens the payment-transaction reference uniqueness boundary and the performance-fee high-water-mark safety invariant. It is a defence-in-depth + consistency sprint — no new payment-state transitions were introduced and the webhook-only paid-state invariant is preserved unchanged.

\- DB-level uniqueness guard on `(provider, provider_transaction_reference)` is now enforced via the pre-existing migration `1751500000000-AddPaymentTransactionReferenceUniqueGuard` (partial unique index `ux_payment_transactions_provider_reference`, scoped `WHERE provider_transaction_reference IS NOT NULL AND <> ''`). The migration was already on disk and correct; Sprint 18 verified it, added tests around it, and documented the pre-migration duplicate-check runbook.

\- Both subscription checkout (`SubscriptionsService.initiateCheckout`) and performance-fee checkout (`PerformanceFeePaymentService.initiatePerformanceFeeCheckout`) already caught the 23505 unique-violation from this guard (Sprint 18 PART C): they release the processing claim back to PENDING, audit at CRITICAL severity with `reason: 'PROVIDER_REFERENCE_CONFLICT'`, and throw a sanitized `ConflictException`. They NEVER mark the invoice/transaction/assessment/subscription paid and never leak the raw `QueryFailedError` / constraint name. Sprint 18 added regression tests proving this for both flows.

\- Performance-fee checkout metadata now includes `transactionId` in BOTH the provider-bound `createCheckoutSession` metadata AND the stored `providerPayloadSummary` — consistent with subscription checkout. (The `createCheckoutSession` metadata already had `transactionId` since Sprint 14; Sprint 18 added it to `providerPayloadSummary` for debug-metadata parity and added a regression test.) No payment state transitions were changed.

\- High-water-mark anti-regression hardening: `WebhookProcessorService.handlePerformanceFeePaymentSucceeded` now updates the HWM using `max(currentHighWaterMark, endingRealisedBalance)` via BigInt comparison, so the HWM can never move downward even if a future change to the outstanding-assessment guard, a reconciliation backfill, or a manually-inserted assessment produces an `endingRealisedBalance` below the stored peak. The audit metadata now records `endingRealisedBalance` and a `hwmRegulated` flag so operators can see when the max() guard held the HWM at the old peak.

\- Removed the previously-orphaned `PerformanceFeeService.markAssessmentPaid()` method. It transitioned an assessment to PAID and updated the HWM directly, bypassing the verified payment-webhook path. It had NO production callers (the webhook processor inlines its own HWM logic), but its existence was a latent safety hazard. The invariant "HWM may update only through the verified performance-fee webhook success path" is now enforced structurally — `PerformanceFeeService` exposes NO method that writes `currentHighWaterMark` or transitions an assessment to PAID. The sole production write site is `WebhookProcessorService.handlePerformanceFeePaymentSucceeded`.

\- Repository hygiene: 541 tracked `dist/` build artifacts removed from git tracking (`git rm -r --cached apps/api/dist`). The `.gitignore` `dist/` entry (already present) now protects the working tree. No source code, migrations, tests, or docs were removed.

\- Sprint 18 tests added (all passing): HWM cannot regress after verified payment; HWM advances normally when endingRealisedBalance exceeds the old peak; `markAssessmentPaid` is not exposed by `PerformanceFeeService`; performance-fee checkout metadata includes `transactionId`; performance-fee `providerPayloadSummary` includes `transactionId`; DB unique-violation on `providerTransactionReference` is caught safely in performance-fee checkout (never marks paid, releases claim, audits CRITICAL, sanitized conflict, no error leak); DB unique-violation on `providerTransactionReference` is caught safely in subscription checkout (never marks paid, never activates subscription, releases claim, audits CRITICAL, sanitized conflict).

\- Existing webhook-only paid-state invariants remain intact and regression-tested: checkout never marks paid; only a verified provider webhook confirms payment; amount + currency must match; HWM updates only after confirmed performance-fee payment.

\- Pre-migration runbook added: `docs/runbooks/sprint-18-provider-reference-unique-guard.md` documents the duplicate-check SQL operators must run before applying migration `1751500000000` to any database with existing historical transaction data.

\- No Python files touched. No new migrations created. No new libraries installed.



Last verified status (Sprint 18):

\- NestJS: 739 tests passing, 44 suites (Sprint 17 baseline was 734; added stripe.provider.spec.ts, stripe-http.client.spec.ts, webhook-processor.stripe.spec.ts, subscriptions.service.stripe.spec.ts, performance-fee-payment.stripe.spec.ts + Stripe describe blocks in payment-routing.service.spec.ts). Sprint 18 added 8 tests and removed 3 obsolete markAssessmentPaid tests, resulting in 739 passing NestJS tests across 44 suites.

\- No pending migrations (reuses existing payments schema — no new migration this sprint)

\- No open handles

\- No Python files touched

\- StripePaymentProvider is now a real sandbox implementation of IPaymentProvider (previously a fail-closed placeholder) — createCheckoutSession (Checkout Session, mode: payment), verifyWebhookSignature (HMAC-SHA256 over "${timestamp}.${rawBody}", Stripe-Signature header, 300s replay tolerance), parseWebhookEvent (checkout.session.completed/payment_intent.succeeded -> success; checkout.session.expired/payment_intent.payment_failed -> failed), getTransactionStatus (Checkout Session/PaymentIntent retrieval)

\- StripeHttpClient (new, injectable native fetch wrapper, no SDK) sends application/x-www-form-urlencoded request bodies matching Stripe's documented REST format

\- Stripe fails closed unless STRIPE_ENABLED=true and STRIPE_SECRET_KEY is configured; app boots normally with no Stripe credentials set

\- Subscription checkout and performance-fee checkout both route to Stripe with zero business-logic changes — both already depend only on the generic IPaymentProvider interface; Sprint 16 reuse/idempotency/concurrency logic applies unchanged

\- Checkout never activates a subscription, marks an invoice/assessment paid, creates a FEE_PAID ledger entry, or updates HWM — only a verified Stripe webhook does

\- Provider routing: US/GB already listed stripe first in CountryConfig.enabledPaymentProviders — no seed changes needed; Paystack remains the auto-routed live choice for GH/NG/ZA when both providers are configured

\- GET /payments/providers exposes no Stripe secrets (secret key, publishable key, webhook secret) — only isLive/isSandbox and public capability fields

\- No secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, Authorization header, raw webhook payload, card data) in checkout responses, logs, errors, or audit metadata

\- Flutterwave, Hubtel, PayPal, Wise, and Braintree remain untouched fail-closed placeholders — explicitly out of scope for this sprint

\- Sprint 17 AUDIT (2026-07-06) — PASS, no code fixes required. Reviewed config fail-closed behaviour, StripeHttpClient, createCheckoutSession request shape/metadata, webhook signature verification (HMAC-SHA256, timestamp tolerance, timingSafeEqual, never throws), parseWebhookEvent mapping and safe-field extraction, amount/currency verification, getTransactionStatus read-only behaviour, subscription and performance-fee checkout integration, provider routing (US/GB vs GH/NG/ZA), module wiring (real PaymentsModule graph compiles), audit log metadata, and build-artifact (dist) tracking convention. All 734 tests pass (44 suites), db:migrate has no pending migrations, api:build succeeds, no open handles. One minor non-security observation noted: performance-fee checkout metadata (shared PerformanceFeePaymentService code, pre-existing since Sprint 14) does not pass a `transactionId` key into provider metadata the way subscription checkout does — invoiceId/assessmentId already uniquely identify the transaction, so this is a debug-metadata completeness gap only, not a payment-state or security risk, and applies identically to Paystack (already audited/passed). No fix applied — out of the Sprint 17 Stripe-specific audit scope. Note: Sprint 18 clarified this issue. The provider-bound createCheckoutSession metadata already included transactionId; the missing part was the stored providerPayloadSummary, which Sprint 18 now populates with transactionId.

\- SubscriptionsService.initiateCheckout no longer creates a new invoice/transaction on every call — reuses an existing DRAFT/ISSUED invoice + PENDING/PROCESSING transaction for the same (userId, planId, currency, countryCode, paymentPurpose) identity

\- An existing active provider session (PROCESSING + providerTransactionReference) is returned as-is — never a second provider session

\- DB-level partial unique index on payments.invoices backstops the app-level reuse check against real concurrent double-clicks; a losing 23505 is caught and safely resolved to the winner's invoice/transaction

\- Atomic conditional UPDATE (WHERE status IN (PENDING, FAILED)) claims a transaction before any provider call, preventing two concurrent requests from both creating a provider session for the same row

\- Optional Idempotency-Key support (header or body field) — same key+params replay the same result; same key+different params fails with 409; only a SHA-256 hash of the key is ever persisted, never the raw value

\- Active ACTIVE/TRIAL subscription for the same plan blocks a new checkout before any invoice/transaction is touched; a PAID invoice or SUCCEEDED transaction likewise blocks checkout

\- FAILED/CANCELLED/REFUNDED transactions supersede (cancel) the stale invoice and allow a fresh checkout attempt

\- Provider call failure reverts the transaction to PENDING (not FAILED) so a retry reuses it instead of creating a new invoice

\- Checkout still never activates a subscription, never trusts frontend success, and never marks anything paid — only a verified webhook does (Sprint 10-15 invariant unchanged and regression-tested)

\- Sprint 15 Paystack audit fixes (amount/currency webhook verification, Ghana live-provider routing) remain in place and regression-tested

\- No secrets (provider keys, idempotency keys, webhook secrets, Authorization header) in checkout responses, audit metadata, or providerPayloadSummary

\- AUDIT FIX: the 23505-unique-violation recovery path could re-throw a raw QueryFailedError to the API caller in a narrow race window (winner's invoice committed, its transaction not yet) — now converted to a safe ConflictException asking the caller to retry shortly

\- AUDIT FIX: idempotency-key fingerprint now also binds paymentPurpose and amountMinor — a mid-flight price change with the same idempotency key now fails closed (409) instead of replaying a stale-priced session

\- AUDIT FIX: an empty/whitespace-only Idempotency-Key header no longer shadows a valid idempotencyKey body field



\## Critical Safety Rules

\- No live broker withdrawals.

\- No auto-charge.

\- Do not mark invoice PAID without verified webhook.

\- Do not update high-water mark outside verified payment webhook.

\- Do not trust frontend payment success.

\- Do not charge deposits/top-ups.

\- Do not charge unrealised/open trades.

\- Do not charge demo/paper/backtest/mock trades.

\- Do not expose secrets, credentials, tokens, raw webhook payloads, card data, or mobile money PINs.

\- All money values must remain decimal-safe.

\- Paystack provider must fail closed unless PAYSTACK_ENABLED=true and a secret key is configured.

\- Paystack Transaction Verify (getTransactionStatus) is read-only confirmation only — never a substitute for webhook signature verification.

\- Stripe provider must fail closed unless STRIPE_ENABLED=true and a secret key is configured.

\- Stripe webhook signature verification must fail closed if the Stripe-Signature header, raw body, or STRIPE_WEBHOOK_SECRET is missing.

\- Stripe Checkout Session/PaymentIntent retrieval (getTransactionStatus) is read-only confirmation only — never a substitute for webhook signature verification.



\## Completed Sprint Summary

\- Sprint 1: Architecture foundation

\- Sprint 2: Backend foundation

\- Sprint 3: Broker adapter / MetaTrader integration

\- Sprint 4: Risk engine

\- Sprint 5: Trade execution engine

\- Sprint 6: Realtime events + Strategy Orchestrator

\- Sprint 7: Python AI Signal Engine

\- Sprint 8: Market data ingestion + paper scheduler

\- Sprint 9: Backtesting + PaperBrokerAdapter

\- Sprint 10: Subscription billing + payment gateway foundation

\- Sprint 10 audit: raw-body webhook, manual webhook risk, invoice audit fixed

\- Sprint 11: Performance fee + high-water mark engine

\- Sprint 11 audit: double-charge risk, wrong-plan policy leak, broker-scope leak fixed

\- Sprint 12: Broker trade reconciliation → realised P\&L ledger entries

\- Sprint 12 audit: currency minor-units + partial-failure ledger backfill fixed

\- Sprint 13: Performance fee billing cycle orchestrator

\- Sprint 13 audit: failed reconciliation treated as success fixed; null-broker duplicate lookup fixed

\- Sprint 14: Performance fee invoice checkout + provider assignment

\- Sprint 15: Paystack sandbox checkout integration (subscription + performance-fee) — webhook-only paid/HWM path preserved

\- Sprint 16: Subscription checkout idempotency + pending invoice reuse — DB-level duplicate guard, atomic provider-session claim, optional Idempotency-Key support

\- Sprint 16 audit: raw DB error leak on a narrow 23505 race, idempotency fingerprint missing paymentPurpose/amount, empty Idempotency-Key header precedence bug — all fixed

\- Sprint 17: Stripe sandbox checkout integration (subscription + performance-fee) — webhook-only paid/HWM path preserved; zero business-logic changes required in SubscriptionsService/PerformanceFeePaymentService/WebhookProcessorService

\- Sprint 17 audit: PASS, no fixes required — see Last verified status above for scope and detail

\- Sprint 18: Payment transaction reference uniqueness + metadata consistency hardening — HWM anti-regression (max() semantics), removed orphaned `markAssessmentPaid()`, performance-fee `providerPayloadSummary` now includes `transactionId`, `dist/` untracked from git, pre-migration duplicate-check runbook added. Migration `1751500000000` verified as pre-existing and correct. No new migrations, no new libraries, no Python changes. Sprint 18 merged to `main` and tagged `sprint-18-complete`.

\- Sprint 19: Production deployment foundation — VPS/Webuzo deployment runbook, secrets policy runbook, PM2 ecosystem + systemd unit examples (no secrets), `.env.example` production notes, `.gitignore` hardened (`*.egg-info/`), `irexpro_ai_engine.egg-info/` untracked. Documentation + infrastructure only — no production logic, migrations, or payment/risk/execution/AI changes. Merged to `main`, tagged `sprint-19-complete`.

\- Sprint 20: Runtime bootstrap DI fix — `CredentialEncryptionService` exported from `BrokerModule` so `ExecutionService` can resolve it at runtime; added `apps/api/src/bootstrap.spec.ts` runtime DI smoke test that compiles the real feature-module graph (all 21 modules). The staging dry-run discovered that migrations + 739 unit tests passed but the API crashed under PM2 with a DI resolution failure; Sprint 20 fixed the wiring and added the smoke test so this class of failure is caught in CI. 743 tests passing across 45 suites. Merged to `main`, tagged `sprint-20-complete`.

\- Sprint 21: Staging runbook hardening — hardened the production deployment runbook with 11 verified findings from the real Webuzo VPS staging dry-run on AlmaLinux 9.8 (PG 18, PM2, Nginx + Cloudflare): uuid-ossp/`libossp-uuid.so.16` fix, `DB_USER` (not `DB_USERNAME`), API port `3010` / AI engine port `8011`, health endpoints at `/api/v1/health` (not `/health`), AI engine entrypoint `app.main:app`, AI engine remains private (no public Nginx proxy), CORS guidance (origin only, no path for AI engine), Nginx `^~ /api/v1/` structure with no duplicate location blocks, PM2/systemd `reset-failed` startup sequence, a Verified Staging Dry-Run Checklist (§16), and a Sprint 20 DI-failure pre-deploy gate (§17). Added `infrastructure/nginx/irexpro-staging.example.conf`. PM2 ecosystem comments + AI engine port updated to staging-verified `8011`. Documentation + infrastructure only — no production logic, migrations, or payment/risk/execution/AI changes. 743 NestJS tests still passing across 45 suites. Merged to `main`, tagged `sprint-21-complete`.

\- Sprint 22: Cross-platform staging frontend/API integration — scaffolded a buildable cross-platform frontend foundation: `apps/web` (Next.js 14 client/trader, port 3005, routes /, /login, /dashboard, /payments/*), `apps/admin` (Next.js 14 admin portal, port 3006, /admin/* routes), `apps/mobile` (Expo + React Native, 4 screens), `packages/types` (shared frontend-safe TS types), `packages/api-client` (shared typed fetch client, env-driven base URL). All build/typecheck: web build ✅, admin build ✅, mobile typecheck ✅, packages typecheck ✅. Env examples for all three apps document never-in-frontend secrets. Payment redirect pages are display-only — never mark paid; payment truth is backend-only via verified webhooks. AI engine never referenced from frontend/mobile. No backend source logic, migrations, payment-state transitions, webhook rules, broker/risk/execution/AI logic, or secrets changed. 743 NestJS tests still passing across 45 suites; backend build exit 0. Merged to `main`, tagged `sprint-22-complete`.

\- Sprint 23 (in progress): Staging frontend/admin deployment verification — documented and hardened the actual staging deployment now that both portals load publicly. Verified two-domain topology: web at `https://irexpro.lightworldtech.com` (port 3005), admin at `https://irexproadmin.lightworldtech.com` (port 3006), API at `https://irexpro.lightworldtech.com/api/v1` (port 3010), AI engine private at `127.0.0.1:8011`. Runbook §8.4 rewritten for two domains; §8.5 added for cross-origin CORS (both domains in CORS_ORIGINS); §7.1.2 added for four staging PM2 processes (irexpro-api-staging, irexpro-ai-staging, irexpro-web-staging, irexpro-admin-staging); §18 added for public verification checklist (curl checks for web/admin/API health + AI-private check + CORS OPTIONS preflight for both origins). Nginx example updated with main + admin server blocks (no public proxy to 8011). Backend + admin `.env.example` CORS/URL docs aligned to staging. Documentation + deployment-example hardening only — no backend business logic, payment logic, webhook behavior, broker/risk/execution/AI logic, migrations, secrets, or `.env` files changed. AI engine remains private. 743 NestJS tests still passing across 45 suites; all frontend builds/typechecks pass.



\## Current Main Modules

\- apps/api/src/modules/payments

\- apps/api/src/modules/subscriptions

\- apps/api/src/modules/performance-fees

\- apps/api/src/modules/performance-billing

\- apps/api/src/modules/broker-reconciliation

\- apps/api/src/modules/broker

\- apps/api/src/modules/trading

\- apps/api/src/modules/risk

\- services/ai-engine



\## Model Strategy

\- Main implementation: Claude Sonnet 5

\- Fallback: Claude Sonnet 4.6

\- Small fixes/docs: Sonnet 4.5 or Composer

\- Opus 4.8 only for rare final/deep audits because it consumes too many tokens.

---

## Sprint 28 — Playwright Responsive & Accessibility Smoke Suite (PR #28)

Branch: `test/playwright-responsive-smoke`
PR: https://github.com/christianagbotah/irexpro/pull/28
Status: **MERGED.** GitHub Actions Web E2E check passed on the final head (`b250b03`); merge commit `6effd1f`.

### What was added
- **Playwright E2E suite** (`apps/web/e2e/`): 5 spec files (profile, risk, broker, dashboard, accessibility) + `fixtures.ts` + `network-isolation.spec.ts`, covering routes `/onboarding/profile`, `/onboarding/risk`, `/onboarding/broker`, `/dashboard`.
- **Playwright version**: `@playwright/test` 1.62.1. Chromium revision 1234 (Chrome for Testing 151.0.7922.34).
- **axe integration**: `@axe-core/playwright` 4.12.1. Scans run on Chromium across profile-default, profile-combobox-open, risk-tooltip-open, broker-dialog-open, dashboard-onboarding, and unauthenticated-dashboard states. Tags: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`. No rules disabled (the former `select-name` disable was removed after fixing the source).

### Deterministic route-interception strategy
- A SINGLE `page.route('**/api/v1/**')` handler intercepts every API call and dispatches by path + method, returning deterministic fixture data (mock auth user, tokens, profile, onboarding status, risk profile, supported brokers, broker connections, trading sessions). No real backend is contacted.
- Authentication isolation: the AuthProvider's `/auth/refresh` and `/auth/me` calls are intercepted. No real refresh-token cookie, no real JWT, no test passwords in source. Access token is a mock string (`mock-access-token-for-e2e-tests-not-a-real-jwt`).
- A catch-all returns an empty 200 for any unhandled `/api/v1/` route so no request escapes to a real server.
- `favicon.ico` is intercepted with 204 to avoid 404 noise.

### Five viewport projects
| Project | Viewport |
|---|---|
| mobile-small | 360 × 800 |
| mobile-standard | 390 × 844 |
| tablet-portrait | 768 × 1024 |
| tablet-landscape | 1024 × 768 |
| desktop | 1440 × 900 |

### Browser-test totals (verified)
- **Total E2E tests: 420 (84 per project × 5 projects).**
- **Passed: 420. Failed: 0. Skipped: 0. Retried: 0 (local, retries=0).**
- Total E2E duration (sum of per-project): ~280s (~4m 40s).
- Console errors: 0. Failed network requests: 0. Page exceptions: 0. Axe critical/serious violations: 0. Horizontal-overflow failures: 0. Bounding-box failures: 0.
- Network-isolation tests: 30 passed (6 tests × 5 projects) — no request to any production/staging/broker/payment/AI host.

### Accessibility issues found and fixed
1. **Risk input label associations** (`apps/web/src/app/onboarding/risk/page.tsx`): added `htmlFor` on each `<label>` and matching `id` on each `<input>` for the 5 risk limit fields (max daily loss, max drawdown, max risk per trade, max open trades, max leverage). Each generated `id` is unique and correctly linked to its label.
2. **Timezone offset color contrast** (`apps/web/src/app/globals.css`): changed `.timezone-select__option-offset` color from `var(--text-muted)` to `var(--text-secondary)` to meet WCAG AA contrast.
3. **Profile trading-experience `<select>` label** (`apps/web/src/app/onboarding/profile/page.tsx`): added `htmlFor="profile-trading-experience"` on the label and `id="profile-trading-experience"` on the `<select>`, resolving the axe `select-name` (critical) violation. The `disableRules(['select-name'])` in the accessibility spec was removed.

### Short-screen listbox defect and fix
- **Defect**: the timezone combobox dropdown (`.timezone-select__dropdown`, `position: absolute; top: calc(100% + 4px)`; inner list `max-height: 280px`) extended below the viewport on 4 of 5 viewports because the combobox sits low in the page. Reproduced overflow: mobile-standard +223px, tablet-portrait +223px, tablet-landscape +226px, desktop +94px. The original relaxed assertion only checked the dropdown's top edge (not the bottom), hiding the defect.
- **Fix** (`apps/web/src/components/forms/TimezoneSelect.tsx`): added a `useIsomorphicLayoutEffect` that measures available space below/above the combobox container, picks the direction with more room (flipping the dropdown above the trigger via a new `.timezone-select__dropdown--up` CSS modifier when needed), and caps the list `max-height` to the available viewport space so the dropdown always stays within the viewport. Re-measures on resize and scroll. Runs synchronously before paint (no flash). CSS: `.timezone-select__dropdown--up { top: auto; bottom: calc(100% + 4px); }` added to `globals.css`.
- **Relaxed assertion removed**: the profile spec's "open listbox bounding box stays within viewport" test now uses `assertBoundingBoxInViewport` (strict bottom-edge check, 1px subpixel tolerance).
- **Regression test added**: "short-screen: End selects last option, active option visible, listbox in viewport" — opens the combobox, presses End, asserts the active (last) option is scrolled into view and visible, asserts the dropdown stays within the viewport (bottom edge included), asserts no horizontal overflow, and verifies ArrowUp navigation still works — across all 5 projects.

### CI workflow
- `.github/workflows/web-e2e.yml` is **present on the remote repository and GitHub Actions successfully executed it on PR #28** (conclusion: success). The full five-viewport suite passed; the mandatory successful-state evidence capture passed; HTML reports and artifacts are uploaded according to policy.
- **GitHub Action dependencies were upgraded to Node-24-compatible versions**: `actions/checkout@v5`, `actions/setup-node@v5`, `actions/upload-artifact@v6` (all 5 occurrences), `pnpm/action-setup@v4.4.0`. Application/test runtime remains Node 22 (`NODE_VERSION: '22'`).
- Triggers: `workflow_dispatch`, `pull_request` (path-filtered to `apps/web/**`, `packages/api-client/**`, `packages/types/**`, lockfile, workspace, workflow file), `push` to main/develop (path-filtered). `permissions: contents: read`. Safe concurrency (cancel per ref). 30-minute timeout. No live backend or production secrets required.

### Artifact policy
- `playwright-report/`, `test-results/`, `.playwright/` are gitignored (both root `.gitignore` and `apps/web/.gitignore`).
- Screenshots: `only-on-failure`. Traces: `on-first-retry`. Videos: `retain-on-failure`.
- No screenshots are committed. Broker secrets are never rendered (password inputs verified by the credential-leak invariant test). No tokens/passwords appear in traces.

### Web unit-test count
- 44 tests across 4 suites (TimezoneSelect, ConfirmDialog, InfoTooltip, error-mapping). Jest config updated to ignore `e2e/` so Playwright specs aren't loaded under jest.

### API test and suite count
- 1054 tests across 70 suites (jest --silent, apps/api). All passing.

### Successful-run screenshot evidence
- **Mechanism**: `apps/web/e2e/evidence.spec.ts` captures representative success-state screenshots. The entire suite is skipped unless `E2E_CAPTURE_EVIDENCE=1` is set, so normal runs incur no overhead.
- **Cross-platform script**: `pnpm --filter @irexpro/web test:e2e:evidence` uses `cross-env` (added as a devDependency) to set `E2E_CAPTURE_EVIDENCE=1` portably, so the same script works on Linux CI, macOS, and Windows PowerShell/Command Prompt. The script invokes the locally installed Playwright binary directly (no `npx` version resolution).
- **Coverage** (16 screenshots total):
  - Mobile Standard (390×844): profile default, profile timezone combobox open, selected timezone, risk tooltip open, risk validation error, broker empty state, broker confirmation dialog, dashboard onboarding-incomplete state.
  - Tablet Portrait (768×1024): profile combobox open, risk tooltip open, broker dialog open, dashboard onboarding state.
  - Desktop (1440×900): profile default, profile combobox open, broker dialog, dashboard ready state.
- **No fixed Playwright sleeps**: the spec contains zero `page.waitForTimeout` calls. All waits are state-based: locator visibility, ARIA attribute assertions, `expect.poll` for computed-style stability, two-consecutive-measurement bounding-box stability checks, and a `requestAnimationFrame`-based scroll-stabilization loop in the hardened `assertBoundingBoxInViewport`. The rAF loop uses a bounded 150 ms timeout fallback to prevent indefinite waiting on non-scrollable pages; this is a safety fallback, not a fixed sleep.
- **Determinism**: every API call is intercepted with fixture data. "Incomplete" and "empty" states use deterministic mock overrides (onboarding-status / broker connections). No real backend, no real credentials, no broker secrets.
- **Storage**: `apps/web/test-results/evidence/<viewport>/<state>.png` (gitignored via the existing `test-results/` entry). No screenshots committed.
- **Safety** (three layers, clearly distinguished):
  1. **DOM safety assertions (automatic, before every screenshot)**: `assertDomSafeForScreenshot(page)` verifies the rendered DOM text contains no credential markers (`sk_live`, `pk_live`, `github_pat_`, `ghp_`, `gho_`, `Bearer `, JWT-shaped strings); every password/secret input is `type="password"`; password/secret input values are empty or known non-sensitive fixture values; no text input is named/labeled as a secret; no access token, refresh token, or broker API secret is rendered as page text. This is a DOM-text and input-property check.
  2. **Filename keyword check (automatic, defense-in-depth)**: verifies the static screenshot filenames contain no credential-bearing keywords. This is a FILENAME check only — it does not inspect screenshot pixels.
  3. **No pixel/OCR analysis**: the tests do not perform OCR, screenshot-pixel scanning, or image content analysis. Substantive content safety is provided entirely by layer 1 (DOM assertions before capture).

### Bounding-box assertion hardening (flake fix)
- `assertBoundingBoxInViewport` in `fixtures.ts` was hardened to eliminate a transient failure in `dashboard.spec.ts › cards remain within viewport`. The helper now (1) waits for the page scroll position to stabilize via a `requestAnimationFrame` loop (resolves when `window.scrollY` is unchanged across one rAF tick, with a 150 ms bounded fallback for non-scrollable pages) and (2) reads the bounding box twice and requires the two reads to match within 0.5 px before asserting viewport bounds. This proves layout has settled (no in-flight scroll or reflow) before the assertion, removing the race where `scrollIntoViewIfNeeded` resolved before the browser finished reflowing. No fixed Playwright sleep was added; no retry increase; no assertion loosening.

### Updated browser-test totals (with evidence spec)
- **Total tests discovered: 505** (7 spec files × 5 projects).
- **Active tests: 420** (84 per project × 5 projects) — all passing.
- **Evidence-skipped tests: 85** (17 per project × 5 projects) — skipped unless `E2E_CAPTURE_EVIDENCE=1`.
- **Evidence capture run: 19 passed** (16 screenshots + 3 safety checks) across mobile-standard, tablet-portrait, desktop.
- Playwright 1.62.1; Chromium revision 1234 (Chrome for Testing 151.0.7922.34).

### Fresh-DB UUID bootstrap hotfix (post-Sprint-28 migration integrity audit)
- **Defect identified:** the migration chain on `main` could not provision a completely fresh PostgreSQL database from `pnpm migration:run` alone. Migrations `1751200000000` (broker_reconciliation) and `1751300000000` (performance_billing) used `uuid_generate_v4()` (uuid-ossp) in their table `DEFAULT` clauses, but no migration installed the `uuid-ossp` extension. On a fresh DB, `CREATE TABLE ... DEFAULT uuid_generate_v4()` failed with `function uuid_generate_v4() does not exist`, aborting the chain at migration #6. The production runbook §2.2 worked around this with a manual operator pre-step, but that pre-step was not part of the migration chain.
- **Repair approach (2 new migrations, existing 14 untouched):**
  1. `1751150000000-EnsureLegacyUuidV4Compatibility` (bridge) — ensures `public.uuid_generate_v4()` exists before migrations #6/#7 run. If the function already exists (uuid-ossp or standalone fallback), this is a safe no-op. If it does not exist, creates a thin wrapper returning `gen_random_uuid()` (core PG 13+). Reversible `down()` only drops a function it created (tracked via COMMENT), never a pre-existing one.
  2. `1752200000000-NormalizeLegacyUuidDefaults` (latest) — ALTERs the three legacy `id` column defaults from `uuid_generate_v4()` to `gen_random_uuid()`. Does NOT regenerate IDs, modify existing rows, or touch financial data. Idempotent (skips columns already normalized).
- **Migration validation:** fresh empty-database provisioning (PGLite PG 16.4) — all 16 migrations pass without manual extension installation; `identity.users` exists; registration + login succeed; the three affected column defaults are `gen_random_uuid()`. Existing-DB upgrade scenario verified — existing UUID values and rows preserved; TypeORM detects the new migrations as pending and executes them safely despite the inserted older-timestamp bridge.
- **No production/staging DB touched:** validation used only a disposable in-memory PostgreSQL-compatible test environment (PGLite). No real PostgreSQL, staging, or production database was contacted.
- **Runbook updated:** `docs/runbooks/production-deployment-vps-webuzo.md` §2.3 and §6 corrected — migration count updated from 8 to 16; uuid-ossp manual-install guidance annotated as no longer required for fresh provisioning (retained for environments that already have uuid-ossp installed).

### Remaining limitations
- **pnpm version distinction**: the repository accepts pnpm versions greater than or equal to 9 (`pnpm >= 9.0.0` in `package.json` `engines`), while CI currently uses pnpm 10 (per `.github/workflows/api-ci.yml` and the new `.github/workflows/web-e2e.yml`). The surgical lockfile change was therefore validated independently with pnpm 10 using `pnpm install --frozen-lockfile` — pnpm 10.34.5 accepts the +14-line lockfile delta (only `cross-env@7.0.3` and its already-present transitive dep `cross-spawn@7.0.6`) without modification. Under pnpm 9/10, `pnpm install` may print an "Ignored build scripts" warning for workspace native deps (argon2, bufferutil, utf-8-validate, msgpackr-extract, unrs-resolver, @nestjs/core, @scarf/scarf) — these are pre-existing workspace dependencies unrelated to PR #28, and the warning is informational only (it does not prevent installation or tests). All validations in this audit were run via direct tool commands (`npx jest`, `npx next build`, `npx tsc`, `pnpm exec playwright test`) which succeed without the ignored-builds side effect. CI (pnpm 10) is unaffected.
- Axe scans run on Chromium only (skipped on other browsers); this is standard because axe violations are overwhelmingly viewport-independent.
- The E2E suite is deterministic (no real backend); it does not exercise the real NestJS API, real broker adapters, or real payment providers.
