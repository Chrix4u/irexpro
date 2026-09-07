/**
 * Pure account/security logic for the mobile Account hub.
 *
 * RN-IMPORT-FREE MODULE: this file must never import `react`,
 * `react-native`, or any Expo package — only plain TypeScript. A later task
 * exercises every export with a zero-dependency test harness, so all
 * validation, mapping, derivation, and state-machine logic for the account
 * hub lives here: Personal Information editing (Phase E/F), password change
 * validation (Phase I), the MFA TOTP enrollment reducer (Phase G), the
 * verification resend-cooldown/expiry helpers (Phase H), the security-activity
 * timeline labels/tones (Phase J), the self-contained JWT/session/device view
 * helpers (Phase J), account-status guidance (Phase K), and the pre-auth
 * appeal validation (Phase K). Screens under `src/screens/account/` (and the
 * pre-auth AppealScreen) import from this module; they only render and
 * orchestrate.
 *
 * All `@irexpro/types` imports are type-only (erased at compile time), so the
 * module stays runtime-dependency free.
 */

import type {
  MyProfileView,
  SecurityEventSeverity,
  TradingExperienceLevel,
  UpdateMyProfileRequest,
  UserStatus,
} from '@irexpro/types';

// ─── Shared constants ──────────────────────────────────────────────────────

export const PROFILE_NAME_MAX_LENGTH = 100;
export const TIMEZONE_MAX_LENGTH = 50;
export const DOB_EARLIEST_YEAR = 1900;

const DATE_OF_BIRTH_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const TIMEZONE_PATTERN = /^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/u;

/** All valid self-reported trading experience levels (enum member order). */
export const TRADING_EXPERIENCE_LEVELS: readonly TradingExperienceLevel[] = [
  'BEGINNER',
  'INTERMEDIATE',
  'ADVANCED',
  'PROFESSIONAL',
];

/** Pill-selector options for the trading experience level field. */
export const PROFILE_EXPERIENCE_OPTIONS: ReadonlyArray<{
  value: TradingExperienceLevel;
  label: string;
}> = [
  { value: 'BEGINNER', label: 'Beginner' },
  { value: 'INTERMEDIATE', label: 'Intermediate' },
  { value: 'ADVANCED', label: 'Advanced' },
  { value: 'PROFESSIONAL', label: 'Professional' },
];

// ─── Editable form values ──────────────────────────────────────────────────

/**
 * Editable Personal Information form fields.
 *
 * Server values are nullable; the form stores them as strings where an empty
 * (or all-whitespace) value means "not set". `tradingExperienceLevel` uses ''
 * for "not set" so the whole form stays string-friendly for inputs.
 */
export interface ProfileFieldValues {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  countryCode: string;
  timezone: string;
  preferredCurrency: string;
  tradingExperienceLevel: TradingExperienceLevel | '';
}

export type ProfileFieldKey = keyof ProfileFieldValues;

// ─── Field validators (null = valid) ───────────────────────────────────────

/** First name: required, 1–100 characters after trimming. */
export function validateFirstName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Enter your first name.';
  if (trimmed.length > PROFILE_NAME_MAX_LENGTH) {
    return 'First name must be 100 characters or fewer.';
  }
  return null;
}

/** Last name: required, 1–100 characters after trimming. */
export function validateLastName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Enter your last name.';
  if (trimmed.length > PROFILE_NAME_MAX_LENGTH) {
    return 'Last name must be 100 characters or fewer.';
  }
  return null;
}

/** Normalize a country code: trim + uppercase. */
export function normalizeCountryCode(value: string): string {
  return value.trim().toUpperCase();
}

/** Whether a country code is a two-letter ISO 3166-1 alpha-2 code. */
export function isValidCountryCode(value: string): boolean {
  return COUNTRY_CODE_PATTERN.test(normalizeCountryCode(value));
}

/**
 * Country code: optional (empty = "not set"), but when present it must be a
 * two-letter ISO 3166-1 alpha-2 code.
 */
export function validateCountryCode(value: string): string | null {
  const normalized = normalizeCountryCode(value);
  if (normalized.length === 0) return null;
  if (!isValidCountryCode(normalized)) {
    return 'Country code must be a two-letter ISO code, for example GH.';
  }
  return null;
}

/**
 * Timezone: required, at most 50 characters, and IANA-shaped
 * (e.g. "Africa/Accra", "UTC", "Etc/GMT+5").
 */
export function validateTimezone(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Enter your timezone, for example Africa/Accra.';
  if (trimmed.length > TIMEZONE_MAX_LENGTH) {
    return 'Timezone must be 50 characters or fewer.';
  }
  if (!TIMEZONE_PATTERN.test(trimmed)) {
    return 'Enter a valid timezone, for example Africa/Accra.';
  }
  return null;
}

/** Normalize a preferred currency: trim + uppercase. */
export function normalizePreferredCurrency(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Preferred currency: optional (empty = "not set"), but when present it must
 * be a three-letter ISO 4217 alpha-3 code.
 */
export function validatePreferredCurrency(value: string): string | null {
  const normalized = normalizePreferredCurrency(value);
  if (normalized.length === 0) return null;
  if (!CURRENCY_PATTERN.test(normalized)) {
    return 'Currency must be a three-letter code, for example USD.';
  }
  return null;
}

/**
 * Date of birth: optional (empty = "not set"), but when present it must be
 * YYYY-MM-DD, a real calendar date (month/day exist, leap years respected),
 * in the past, and not earlier than 1900-01-01. Mirrors the backend's
 * "valid past calendar date" gate.
 */
export function validateDateOfBirth(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!DATE_OF_BIRTH_PATTERN.test(trimmed)) {
    return 'Enter your date of birth as YYYY-MM-DD.';
  }

  const [yearText, monthText, dayText] = trimmed.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(year, month - 1, day);

  // A rolled-over date (e.g. 2023-02-29 → March 1st) means the input is not
  // a real calendar date. Year 0000 also normalizes to 1900 here and fails.
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return 'Enter a real calendar date.';
  }

  const earliest = new Date(DOB_EARLIEST_YEAR, 0, 1);
  if (date.getTime() < earliest.getTime()) {
    return 'Date of birth must be 1900-01-01 or later.';
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (date.getTime() >= today.getTime()) {
    return 'Date of birth must be in the past.';
  }

  return null;
}

/** Whether a string is a valid trading experience level enum member. */
export function isValidTradingExperienceLevel(
  value: string,
): value is TradingExperienceLevel {
  return (TRADING_EXPERIENCE_LEVELS as readonly string[]).includes(value);
}

/**
 * Trading experience level: optional (empty = "not set"), but when present it
 * must be one of the four enum members.
 */
export function validateTradingExperienceLevel(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!isValidTradingExperienceLevel(trimmed)) {
    return 'Select a trading experience level.';
  }
  return null;
}

/**
 * Aggregate field-level validation errors for the Personal Information form.
 * Keys are present only for fields that currently fail validation.
 */
export function profileFieldErrors(
  values: ProfileFieldValues,
): Partial<Record<ProfileFieldKey, string>> {
  const errors: Partial<Record<ProfileFieldKey, string>> = {};

  const firstName = validateFirstName(values.firstName);
  if (firstName) errors.firstName = firstName;

  const lastName = validateLastName(values.lastName);
  if (lastName) errors.lastName = lastName;

  const dateOfBirth = validateDateOfBirth(values.dateOfBirth);
  if (dateOfBirth) errors.dateOfBirth = dateOfBirth;

  const countryCode = validateCountryCode(values.countryCode);
  if (countryCode) errors.countryCode = countryCode;

  const timezone = validateTimezone(values.timezone);
  if (timezone) errors.timezone = timezone;

  const preferredCurrency = validatePreferredCurrency(values.preferredCurrency);
  if (preferredCurrency) errors.preferredCurrency = preferredCurrency;

  const tradingExperienceLevel = validateTradingExperienceLevel(
    values.tradingExperienceLevel,
  );
  if (tradingExperienceLevel) errors.tradingExperienceLevel = tradingExperienceLevel;

  return errors;
}

// ─── Mappers / derivations ─────────────────────────────────────────────────

/** Map a typed profile view into editable form values (null → "not set"). */
export function toProfileFieldValues(view: MyProfileView): ProfileFieldValues {
  return {
    firstName: view.profile.firstName ?? '',
    lastName: view.profile.lastName ?? '',
    dateOfBirth: view.profile.dateOfBirth ?? '',
    countryCode: view.countryCode ?? '',
    timezone: view.timezone ?? '',
    preferredCurrency: view.preferredCurrency ?? '',
    tradingExperienceLevel: view.profile.tradingExperienceLevel ?? '',
  };
}

/**
 * Whether any editable field differs from the stored profile (trim-aware).
 * Country code and currency compare after normalization; the experience
 * level compares directly (enum member or "not set").
 */
export function isProfileDirty(
  base: MyProfileView,
  values: ProfileFieldValues,
): boolean {
  const stored = toProfileFieldValues(base);
  return (
    stored.firstName.trim() !== values.firstName.trim() ||
    stored.lastName.trim() !== values.lastName.trim() ||
    stored.dateOfBirth.trim() !== values.dateOfBirth.trim() ||
    normalizeCountryCode(stored.countryCode) !== normalizeCountryCode(values.countryCode) ||
    stored.timezone.trim() !== values.timezone.trim() ||
    normalizePreferredCurrency(stored.preferredCurrency) !==
      normalizePreferredCurrency(values.preferredCurrency) ||
    stored.tradingExperienceLevel !== values.tradingExperienceLevel
  );
}

/**
 * Build the PATCH /users/me request body from the form.
 *
 * Only fields that (a) are set to a non-empty value and (b) differ from the
 * stored profile are included — unchanged fields are never re-sent, and
 * empty values cannot unset server data (the request contract has no
 * null semantics). Callers gate the save on `isProfileDirty`, so a valid
 * invocation always produces at least one field.
 */
export function buildUpdateMyProfileRequest(
  base: MyProfileView,
  values: ProfileFieldValues,
): UpdateMyProfileRequest {
  const request: UpdateMyProfileRequest = {};

  const firstName = values.firstName.trim();
  if (firstName.length > 0 && firstName !== (base.profile.firstName ?? '').trim()) {
    request.firstName = firstName;
  }

  const lastName = values.lastName.trim();
  if (lastName.length > 0 && lastName !== (base.profile.lastName ?? '').trim()) {
    request.lastName = lastName;
  }

  const dateOfBirth = values.dateOfBirth.trim();
  if (dateOfBirth.length > 0 && dateOfBirth !== (base.profile.dateOfBirth ?? '')) {
    request.dateOfBirth = dateOfBirth;
  }

  const countryCode = normalizeCountryCode(values.countryCode);
  if (countryCode.length > 0 && countryCode !== normalizeCountryCode(base.countryCode ?? '')) {
    request.countryCode = countryCode;
  }

  const timezone = values.timezone.trim();
  if (timezone.length > 0 && timezone !== (base.timezone ?? '').trim()) {
    request.timezone = timezone;
  }

  const preferredCurrency = normalizePreferredCurrency(values.preferredCurrency);
  if (
    preferredCurrency.length > 0 &&
    preferredCurrency !== normalizePreferredCurrency(base.preferredCurrency ?? '')
  ) {
    request.preferredCurrency = preferredCurrency;
  }

  if (values.tradingExperienceLevel !== '' && values.tradingExperienceLevel !== base.profile.tradingExperienceLevel) {
    request.tradingExperienceLevel = values.tradingExperienceLevel;
  }

  return request;
}

/**
 * Two-letter avatar initials.
 *
 * Names win when present (first letters of first + last name; a single name
 * contributes its first two letters). Otherwise the fallback takes the first
 * two alphanumeric characters of the email or phone. Always uppercase.
 */
export function deriveInitials(view: {
  profile: { firstName: string | null; lastName: string | null };
  email: string | null;
  phone: string | null;
}): string {
  const first = (view.profile.firstName ?? '').trim();
  const last = (view.profile.lastName ?? '').trim();

  if (first.length > 0 && last.length > 0) {
    return (first.charAt(0) + last.charAt(0)).toUpperCase();
  }
  if (first.length > 0 || last.length > 0) {
    const single = first.length > 0 ? first : last;
    return single.slice(0, 2).toUpperCase();
  }

  const contact = (view.email ?? view.phone ?? '').trim();
  const letters = contact.replace(/[^A-Za-z0-9]/g, '');
  if (letters.length > 0) {
    return letters.slice(0, 2).toUpperCase();
  }
  return '?';
}

// ─── Status / verification presentation ────────────────────────────────────

/** Visual tone for a status pill. */
export type AccountStatusTone = 'positive' | 'neutral' | 'warning' | 'danger';

const ACCOUNT_STATUS_META: Record<
  UserStatus,
  { label: string; tone: AccountStatusTone }
> = {
  ACTIVE: { label: 'Active', tone: 'positive' },
  PENDING_VERIFICATION: { label: 'Pending verification', tone: 'warning' },
  SUSPENDED: { label: 'Suspended', tone: 'danger' },
  PERMANENTLY_LOCKED: { label: 'Permanently locked', tone: 'danger' },
  CLOSED: { label: 'Closed', tone: 'neutral' },
};

/**
 * Presentation metadata for an account status:
 * ACTIVE → positive, PENDING_VERIFICATION → warning,
 * SUSPENDED / PERMANENTLY_LOCKED → danger, CLOSED → neutral.
 * Unknown runtime values fall back to a neutral humanized label.
 */
export function accountStatusMeta(status: UserStatus): {
  label: string;
  tone: AccountStatusTone;
} {
  const meta = ACCOUNT_STATUS_META[status];
  if (meta) return meta;
  return { label: String(status).replaceAll('_', ' '), tone: 'neutral' };
}

/**
 * Contact verification state derived from the profile view's verification
 * timestamps. Verification is only ever read from server data — it is never
 * inferred on the device.
 */
export function verificationBadges(view: {
  emailVerifiedAt: string | null;
  phoneVerifiedAt: string | null;
}): { email: boolean; phone: boolean } {
  return {
    email: typeof view.emailVerifiedAt === 'string' && view.emailVerifiedAt.length > 0,
    phone: typeof view.phoneVerifiedAt === 'string' && view.phoneVerifiedAt.length > 0,
  };
}

// ─── Password change (Sprint 55 Phase I) ────────────────────────────────────
//
// Mirrors the backend POST /auth/change-password policy exactly: the new
// password is 12–128 characters and must contain at least one letter and one
// number (identical to reset-password). currentPassword is 1–128 characters.

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const HAS_LETTER_PATTERN = /[A-Za-z]/u;
const HAS_NUMBER_PATTERN = /[0-9]/u;

/**
 * New-password policy check (null = valid).
 * Order of checks mirrors the backend DTO so the first client-side error is
 * the same one the server would report.
 */
export function validateNewPasswordPolicy(pw: string): string | null {
  if (pw.length < PASSWORD_MIN_LENGTH) {
    return `New password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (pw.length > PASSWORD_MAX_LENGTH) {
    return `New password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`;
  }
  if (!HAS_LETTER_PATTERN.test(pw)) {
    return 'New password must include at least one letter.';
  }
  if (!HAS_NUMBER_PATTERN.test(pw)) {
    return 'New password must include at least one number.';
  }
  return null;
}

/** Fields of the change-password form that can carry a validation error. */
export type ChangePasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';

export interface ChangePasswordSubmissionInput {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export interface ChangePasswordFieldError {
  field: ChangePasswordField;
  error: string;
}

/**
 * Submit-time gate for the change-password form.
 *
 * Returns the first failing field (currentPassword required/≤128, new
 * password policy, confirm match) or null when the whole submission is
 * client-valid. Screens keep the submit button disabled until this returns
 * null; the re-check on submit is a guard, not the only line of defense.
 */
export function validateChangePasswordSubmission(
  input: ChangePasswordSubmissionInput,
): ChangePasswordFieldError | null {
  if (input.currentPassword.length === 0) {
    return { field: 'currentPassword', error: 'Enter your current password.' };
  }
  if (input.currentPassword.length > PASSWORD_MAX_LENGTH) {
    return { field: 'currentPassword', error: 'Current password must be 128 characters or fewer.' };
  }

  const policyError = validateNewPasswordPolicy(input.newPassword);
  if (policyError) {
    return { field: 'newPassword', error: policyError };
  }

  if (input.confirmPassword.length === 0) {
    return { field: 'confirmPassword', error: 'Enter the new password again.' };
  }
  if (input.confirmPassword !== input.newPassword) {
    return { field: 'confirmPassword', error: 'New passwords do not match.' };
  }

  return null;
}

// ─── Six-digit verification code ────────────────────────────────────────────

const SIX_DIGIT_CODE_PATTERN = /^\d{6}$/u;

/**
 * Whether a value is a six-digit numeric code (TOTP or SMS verification).
 * Absorbs the former `isSixDigitCode` from account-security.ts — whitespace
 * is tolerated around the digits, exactly as before.
 */
export function validateSixDigitCode(code: string): boolean {
  return SIX_DIGIT_CODE_PATTERN.test(code.trim());
}

// ─── MFA TOTP enrollment state machine (Sprint 55 Phase G) ─────────────────
//
// Pure reducer for authenticator enrollment. The SCREEN drives all side
// effects (API calls, alerts); this machine owns the only place the one-time
// enrollment material (secret + otpauth URI) may live in memory.
//
// INVARIANT (provable by a zero-dependency harness):
//   material !== null  ⟺  status === 'verifying'
// Every terminal transition (CODE_ACCEPTED / CODE_REJECTED) and every reset
// (RESTART / CANCEL) sets material to null, so the secret provably leaves
// memory at the logic level the moment enrollment ends, is discarded, or is
// restarted. `failureReason` is non-null only while status === 'failed'.
//
// State meanings:
//   idle       nothing in progress (entry point; also the post-wipe reset)
//   password   collecting the current password for re-authentication
//   enrolling  beginMfaSetup request in flight (no material yet)
//   verifying  material received; user adds the authenticator + submits codes
//   succeeded  enableMfa accepted — all sessions revoked server-side
//   failed     enrollment was rejected terminally (e.g. setup expired) and
//              must be restarted; reason preserved in failureReason

export type MfaEnrollmentStatus =
  | 'idle'
  | 'password'
  | 'enrolling'
  | 'verifying'
  | 'succeeded'
  | 'failed';

/** One-time TOTP enrollment material. Must never be persisted or logged. */
export interface MfaEnrollmentMaterial {
  secret: string;
  otpauthUri: string;
}

export interface MfaEnrollmentState {
  status: MfaEnrollmentStatus;
  /** Non-null ONLY while status === 'verifying' (see invariant above). */
  material: MfaEnrollmentMaterial | null;
  /** Sanitized rejection copy; non-null ONLY while status === 'failed'. */
  failureReason: string | null;
}

export type MfaEnrollmentEvent =
  /** idle → password: the user chose to start enrollment. */
  | { type: 'START' }
  /** password → enrolling: the begin-setup request is leaving. */
  | { type: 'BEGIN_REQUESTED' }
  /** enrolling → verifying: one-time material received (kept in memory only). */
  | { type: 'ENROLLMENT_RECEIVED'; material: MfaEnrollmentMaterial }
  /** enrolling → password: the begin-setup request failed; retry password entry. */
  | { type: 'BEGIN_FAILED' }
  /** verifying → succeeded: the TOTP was accepted (material WIPED). */
  | { type: 'CODE_ACCEPTED' }
  /** verifying → failed: terminal rejection, e.g. expired setup (material WIPED, reason kept). */
  | { type: 'CODE_REJECTED'; reason: string }
  /**
   * failed → password: start a fresh enrollment. Note: re-entering 'verifying'
   * is only possible via ENROLLMENT_RECEIVED — CODE_REJECTED wipes the
   * material, so a retry necessarily begins with a new server-issued secret.
   */
  | { type: 'RETRY' }
  /** any → idle: flow-initiated reset (e.g. after an expired enrollment). Wipes material + reason. */
  | { type: 'RESTART' }
  /** any → idle: user discarded the enrollment. Wipes material + reason. */
  | { type: 'CANCEL' };

export const MFA_ENROLLMENT_INITIAL_STATE: MfaEnrollmentState = {
  status: 'idle',
  material: null,
  failureReason: null,
};

function mfaEnrollmentReset(status: MfaEnrollmentStatus): MfaEnrollmentState {
  return { status, material: null, failureReason: null };
}

/**
 * Advance the enrollment machine. Events that do not match the current state
 * are ignored (returned unchanged) — the screen never needs to guard against
 * racing transitions. Terminal and reset events always null the material.
 */
export function mfaEnrollmentReducer(
  state: MfaEnrollmentState,
  event: MfaEnrollmentEvent,
): MfaEnrollmentState {
  switch (event.type) {
    case 'START':
      if (state.status !== 'idle') return state;
      return mfaEnrollmentReset('password');

    case 'BEGIN_REQUESTED':
      if (state.status !== 'password') return state;
      return mfaEnrollmentReset('enrolling');

    case 'ENROLLMENT_RECEIVED':
      if (state.status !== 'enrolling') return state;
      return { status: 'verifying', material: event.material, failureReason: null };

    case 'BEGIN_FAILED':
      if (state.status !== 'enrolling') return state;
      return mfaEnrollmentReset('password');

    case 'CODE_ACCEPTED':
      if (state.status !== 'verifying') return state;
      // Sensitive-memory wipe at the logic level.
      return mfaEnrollmentReset('succeeded');

    case 'CODE_REJECTED':
      if (state.status !== 'verifying') return state;
      // Sensitive-memory wipe at the logic level; reason kept for the UI.
      return { status: 'failed', material: null, failureReason: event.reason };

    case 'RETRY':
      if (state.status !== 'failed') return state;
      return mfaEnrollmentReset('password');

    case 'RESTART':
      return MFA_ENROLLMENT_INITIAL_STATE;

    case 'CANCEL':
      return MFA_ENROLLMENT_INITIAL_STATE;

    default:
      return state;
  }
}

/**
 * Server-side rejection marker for an expired MFA enrollment (the backend
 * answers 400 with "MFA setup expired; start setup again" and exposes no
 * expiry field in the enrollment response — clients must match the message).
 * Detection only: raw server messages are NEVER rendered.
 */
const MFA_SETUP_EXPIRED_MESSAGE_PATTERN = /mfa setup expired/iu;

export function isMfaSetupExpiredRejectionMessage(message: string): boolean {
  return MFA_SETUP_EXPIRED_MESSAGE_PATTERN.test(message);
}

// ─── Verification resend cooldown + expiry hints (Sprint 55 Phase H) ────────

/** Client-side resend cooldown shared by the email and phone sections. */
export const RESEND_COOLDOWN_SECONDS = 60;

/**
 * Remaining cooldown in whole seconds, clamped to ≥ 0.
 *
 * `elapsedMs` is measured from the moment the request SUCCEEDED (cooldowns
 * are never started by failed requests). Ceil rounding guarantees the button
 * never re-enables early.
 */
export function resendCooldown(initialSeconds: number, elapsedMs: number): number {
  if (initialSeconds <= 0) return 0;
  const remainingMs = initialSeconds * 1000 - elapsedMs;
  if (remainingMs <= 0) return 0;
  return Math.ceil(remainingMs / 1000);
}

/**
 * Human label for a cooldown: "45s" below a minute, "1:05" (m:ss) above.
 * Never fabricates a countdown for server-side expiry windows — this formats
 * only the client-owned 60-second resend cooldown.
 */
export function formatCooldown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  if (safe < 60) return `${safe}s`;
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * Honest expiry copy for verification channels. The server exposes no expiry
 * timestamps in the request responses, so these are static, approximate
 * statements of the backend's documented token/code TTLs — never a live
 * countdown.
 */
export function verificationExpiryHint(kind: 'email' | 'phone'): string {
  if (kind === 'email') {
    return 'The link expires in about 15 minutes.';
  }
  return 'The code expires in about 10 minutes.';
}

// ─── Security activity timeline (Sprint 55 Phase J) ─────────────────────────
//
// The backend projects ONLY the caller's audit rows filtered to a server-side
// security-action allowlist (SecurityEventView: id/action/createdAt/severity).
// Known actions map to friendly labels; ANY other value renders as a generic
// label — never an error, never an assumed meaning.

const SECURITY_EVENT_LABELS: Readonly<Record<string, string>> = {
  USER_LOGIN_SUCCESS: 'Successful sign-in',
  USER_LOGIN_FAILED: 'Failed sign-in attempt',
  USER_LOGOUT: 'Signed out',
  USER_PASSWORD_CHANGED: 'Password changed',
  USER_PASSWORD_RESET_REQUESTED: 'Password reset requested',
  USER_PASSWORD_RESET_COMPLETED: 'Password reset completed',
  USER_MFA_ENABLED: 'Two-factor authentication enabled',
  USER_MFA_DISABLED: 'Two-factor authentication disabled',
  USER_MFA_SETUP_STARTED: 'MFA setup started',
  USER_MFA_CHALLENGE_FAILED: 'Failed MFA verification',
  USER_EMAIL_VERIFIED: 'Email verified',
  USER_PHONE_VERIFIED: 'Phone verified',
  USER_PHONE_VERIFICATION_FAILED: 'Failed phone verification',
  USER_SESSIONS_REVOKED_OTHERS: 'Other sessions signed out',
  USER_SUSPENDED: 'Account suspended',
  USER_REACTIVATED: 'Account reactivated',
  USER_PERMANENTLY_LOCKED: 'Account locked',
  USER_CLOSED: 'Account closed',
  USER_REGISTERED: 'Account created',
  USER_PASSWORD_CHANGE_FAILED: 'Failed password change',
};

/** Generic fallback for any action outside the known allowlist. */
const SECURITY_EVENT_FALLBACK_LABEL = 'Account security event';

/** Friendly label for a security-event action; unknown actions never error. */
export function securityEventLabel(action: string): string {
  return SECURITY_EVENT_LABELS[action] ?? SECURITY_EVENT_FALLBACK_LABEL;
}

/** Visual tone for a timeline row: INFO/absent → neutral, WARNING → warning, CRITICAL → danger. */
export function securityEventTone(
  severity?: SecurityEventSeverity,
): 'neutral' | 'warning' | 'danger' {
  if (severity === 'WARNING') return 'warning';
  if (severity === 'CRITICAL') return 'danger';
  return 'neutral';
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RELATIVE_DAYS_LIMIT = 7 * DAY_MS;

/**
 * Compact relative time: "just now", "5m ago", "3h ago", "2d ago".
 *
 * Events older than a week fall back to the ISO date portion of the timestamp
 * (e.g. "2025-06-01"). A timestamp that cannot be parsed is returned as-is —
 * the server value is shown honestly rather than fabricated. Small negative
 * deltas (server clock slightly ahead) are treated as "just now".
 */
export function formatRelativeTime(iso: string, nowMs: number): string {
  const timeMs = Date.parse(iso);
  if (Number.isNaN(timeMs)) return iso;

  const elapsedMs = nowMs - timeMs;
  if (elapsedMs < MINUTE_MS) return 'just now';
  if (elapsedMs < HOUR_MS) return `${Math.floor(elapsedMs / MINUTE_MS)}m ago`;
  if (elapsedMs < DAY_MS) return `${Math.floor(elapsedMs / HOUR_MS)}h ago`;
  if (elapsedMs < RELATIVE_DAYS_LIMIT) return `${Math.floor(elapsedMs / DAY_MS)}d ago`;
  return iso.slice(0, 10);
}

// ─── Session / device view (Sprint 55 Phase J) ──────────────────────────────
//
// Self-contained JWT payload decoding. React Native's Hermes engine has no
// Node Buffer and historically no atob; Node has no btoa — so the base64url
// decoder below is implemented manually (character lookup + 6-bit
// accumulation) and multi-byte UTF-8 is decoded by hand. It is pure string
// math: identical behavior in Hermes and Node, and it returns null for any
// malformed input instead of throwing.

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const BASE64_DECODE_LOOKUP: Readonly<Record<string, number>> = (() => {
  const lookup: Record<string, number> = {};
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    lookup[BASE64_ALPHABET.charAt(i)] = i;
  }
  return lookup;
})();

/**
 * Decode one base64url (or standard base64) segment into raw bytes.
 * Returns null when the segment contains an invalid character or has an
 * impossible length (a lone 6-bit group). Padding ('=') is ignored.
 */
function decodeBase64UrlBytes(segment: string): number[] | null {
  const compact = segment.replace(/=/gu, '');
  if (compact.length % 4 === 1) return null;

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < compact.length; i += 1) {
    const char = compact.charAt(i);
    const value = char === '-' ? 62 : char === '_' ? 63 : BASE64_DECODE_LOOKUP[char];
    if (value === undefined) return null;

    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
      // Drop the consumed high bits so `buffer` never grows past 13 bits
      // (shifts stay inside the 32-bit bitwise range for any input length).
      buffer &= (1 << bits) - 1;
    }
  }
  return bytes;
}

/**
 * Decode UTF-8 bytes to a string without TextDecoder (not guaranteed in
 * Hermes builds). Returns null for truncated or malformed sequences
 * (including overlong encodings and stray continuation bytes).
 */
function utf8BytesToString(bytes: number[]): string | null {
  let result = '';
  let index = 0;
  while (index < bytes.length) {
    const lead = bytes[index];

    if (lead < 0x80) {
      result += String.fromCharCode(lead);
      index += 1;
      continue;
    }

    const continuation = (leadBits: number, length: number, start: number): number | null => {
      let accumulator = leadBits;
      for (let k = 1; k < length; k += 1) {
        const byte = bytes[start + k];
        if (byte === undefined || (byte & 0xc0) !== 0x80) return null;
        accumulator = (accumulator << 6) | (byte & 0x3f);
      }
      return accumulator;
    };

    if (lead >= 0xc0 && lead <= 0xdf) {
      const codePoint = continuation(lead & 0x1f, 2, index);
      if (codePoint === null || codePoint < 0x80) return null;
      result += String.fromCharCode(codePoint);
      index += 2;
    } else if (lead >= 0xe0 && lead <= 0xef) {
      const codePoint = continuation(lead & 0x0f, 3, index);
      if (codePoint === null || codePoint < 0x800) return null;
      result += String.fromCharCode(codePoint);
      index += 3;
    } else if (lead >= 0xf0 && lead <= 0xf7) {
      const codePoint = continuation(lead & 0x07, 4, index);
      if (codePoint === null || codePoint < 0x10000 || codePoint > 0x10ffff) return null;
      const adjusted = codePoint - 0x10000;
      result += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
      index += 4;
    } else {
      return null;
    }
  }
  return result;
}

/**
 * Decode the payload segment of a JWT without verifying the signature.
 *
 * Pure convenience for reading NON-SECRET claims (iat/exp) of the token the
 * device already holds. Returns null for malformed input: wrong segment
 * count, invalid base64, broken UTF-8, or a payload that is not a JSON
 * object. Never throws, never verifies, never logs.
 */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const segments = jwt.split('.');
  if (segments.length !== 3) return null;

  const bytes = decodeBase64UrlBytes(segments[1]);
  if (bytes === null) return null;

  const text = utf8BytesToString(bytes);
  if (text === null) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Malformed JSON payload → null, never an exception.
  }
  return null;
}

/**
 * Start/expiry of the CURRENT session, derived from the access token's own
 * iat/exp claims (seconds since epoch → milliseconds). Null when the token is
 * malformed or the numeric claims are missing. Values are real claims only —
 * nothing is inferred or fabricated on the device.
 */
export function currentSessionView(accessToken: string): {
  startedAt: number;
  expiresAt: number;
} | null {
  const payload = decodeJwtPayload(accessToken);
  if (payload === null) return null;

  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return null;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null;

  return { startedAt: issuedAt * 1000, expiresAt: expiresAt * 1000 };
}

const OS_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  android: 'Android',
  ios: 'iOS',
  macos: 'macOS',
  web: 'Web',
  windows: 'Windows',
};

/**
 * Human device label from the platform shape ("Android 15", "iOS 18.2").
 * `Version` is a number on Android and a string on iOS; both are stringified.
 */
export function deviceSummary(platform: { OS: string; Version: string | number }): string {
  const os = platform.OS.trim();
  const version = String(platform.Version).trim();
  const osName =
    OS_DISPLAY_NAMES[os.toLowerCase()] ?? (os.charAt(0).toUpperCase() + os.slice(1));
  if (version.length === 0) return osName;
  return `${osName} ${version}`;
}

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** Device-local date-time label, e.g. "Jun 12, 2025, 14:30" (no Intl dependency). */
function formatDateTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${MONTH_LABELS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}, ${hours}:${minutes}`;
}

/** Human start/expiry strings for the current-session view. */
export function formatSessionTimestamps(view: {
  startedAt: number;
  expiresAt: number;
}): { started: string; expires: string } {
  return { started: formatDateTime(view.startedAt), expires: formatDateTime(view.expiresAt) };
}

// ─── Account access status guidance (Sprint 55 Phase K) ─────────────────────

/**
 * Honest per-status copy for the Account Access screen. Mirrors the backend's
 * restriction semantics exactly — including that suspension/locking revokes
 * existing sessions server-side. Never exposes administrative review details.
 */
export function accountStatusGuidance(status: UserStatus): string {
  switch (status) {
    case 'ACTIVE':
      return 'Your account is active.';
    case 'PENDING_VERIFICATION':
      return 'Verify your email or phone to activate trading features.';
    case 'SUSPENDED':
      return 'Your account is suspended. Trading and account changes are blocked. Existing sessions were revoked when the restriction was applied.';
    case 'PERMANENTLY_LOCKED':
      return 'Your account has been permanently locked. Signing in, trading, and account changes are no longer available.';
    case 'CLOSED':
      return 'This account is closed.';
    default:
      return 'Your account status is unavailable right now.';
  }
}

/**
 * Whether the status carries access restrictions (sessions revoked,
 * sign-in blocked, trading halted). PENDING_VERIFICATION is not a restriction —
 * sessions stay alive and only trading features wait for verification.
 */
export function isRestrictedAccountStatus(status: UserStatus): boolean {
  return status === 'SUSPENDED' || status === 'PERMANENTLY_LOCKED' || status === 'CLOSED';
}

// ─── Pre-auth account appeal (Sprint 55 Phase K) ────────────────────────────
//
// Mirrors the backend submit-account-appeal DTO: identifier 1–255 characters,
// reason 20–2000 characters. The appeal endpoint is PUBLIC and enumeration-
// safe, so validation is the only client-side gate — the response is always
// generic.

export const APPEAL_IDENTIFIER_MAX_LENGTH = 255;
export const APPEAL_REASON_MIN_LENGTH = 20;
export const APPEAL_REASON_MAX_LENGTH = 2000;

/** Fields of the appeal form that can carry a validation error. */
export type AppealField = 'identifier' | 'reason';

export interface AppealSubmissionInput {
  identifier: string;
  reason: string;
}

export interface AppealFieldError {
  field: AppealField;
  error: string;
}

/**
 * Submit-time gate for the appeal form: identifier required (1–255 after
 * trim), reason 20–2000 after trim. Returns the first failing field or null
 * when the submission is client-valid.
 */
export function validateAppealSubmission(
  input: AppealSubmissionInput,
): AppealFieldError | null {
  const identifier = input.identifier.trim();
  if (identifier.length === 0) {
    return { field: 'identifier', error: 'Enter your email or phone number.' };
  }
  if (identifier.length > APPEAL_IDENTIFIER_MAX_LENGTH) {
    return { field: 'identifier', error: 'Identifier must be 255 characters or fewer.' };
  }

  const reason = input.reason.trim();
  if (reason.length < APPEAL_REASON_MIN_LENGTH) {
    return { field: 'reason', error: 'Describe the issue in at least 20 characters.' };
  }
  if (reason.length > APPEAL_REASON_MAX_LENGTH) {
    return { field: 'reason', error: 'Reason must be 2000 characters or fewer.' };
  }

  return null;
}
