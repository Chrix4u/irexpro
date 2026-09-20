'use strict';

// Zero-dependency test harness for the mobile account-security pure logic.
//
// Mirrors packages/api-client/scripts/test-contracts.cjs: transpile the
// TypeScript sources with the workspace TypeScript (ts.transpileModule),
// evaluate the CommonJS output via `new Function`, and exercise every export
// with node:assert — no jest, no new packages, no lockfile changes.
//
// Modules under test (all RN-IMPORT-FREE):
//   - apps/mobile/src/lib/account-security-logic.ts   (pure logic/state machine)
//   - apps/mobile/src/lib/account-security-errors.ts  (sanitized error mappers)
// The harness also transpiles packages/api-client/src/index.ts the same way so
// the mappers can be tested with REAL ApiClientError instanceof semantics.
//
// Run: pnpm --filter @irexpro/mobile test

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// ─── Transpile + evaluate helpers (contract-harness pattern) ────────────────

function transpileSource(sourcePath) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: sourcePath,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  });

  const errors = (result.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.equal(
    errors.length,
    0,
    `${path.basename(sourcePath)} must transpile without syntax errors`,
  );
  return result.outputText;
}

function evaluateCommonJs(outputText, requireHook, extraScope) {
  const moduleRecord = { exports: {} };
  const paramNames = ['module', 'exports', 'require'];
  const paramValues = [moduleRecord, moduleRecord.exports, requireHook];
  for (const [name, value] of extraScope ?? []) {
    paramNames.push(name);
    paramValues.push(value);
  }
  const evaluate = new Function(...paramNames, outputText);
  evaluate(...paramValues);
  return moduleRecord.exports;
}

function unexpectedRequire(moduleLabel) {
  return (specifier) => {
    throw new Error(`Unexpected runtime import while testing ${moduleLabel}: ${specifier}`);
  };
}

// Load packages/api-client exactly like the contract harness does (real
// ApiClientError class with real instanceof semantics for the mapper tests).
function loadApiClient() {
  const sourcePath = path.resolve(__dirname, '../../../packages/api-client/src/index.ts');
  const outputText = transpileSource(sourcePath);
  const neverFetch = () => {
    throw new Error('fetch must not be called while loading the api-client module');
  };
  const exports = evaluateCommonJs(outputText, unexpectedRequire('api-client'), [
    ['fetch', neverFetch],
  ]);
  assert.equal(typeof exports.ApiClientError, 'function', 'api-client must export ApiClientError');
  return exports;
}

// Load an RN-free pure module under src/lib. Returns the evaluated exports and
// the transpiled source text (the static regression guard inspects the text).
function loadPureModule(basename, requireHook) {
  const sourcePath = path.resolve(__dirname, '../src/lib', basename);
  const outputText = transpileSource(sourcePath);
  const exports = evaluateCommonJs(outputText, requireHook);
  return { exports, outputText, sourcePath };
}

// ─── Module loading (done once, before suites) ─────────────────────────────

const logic = loadPureModule('account-security-logic.ts', unexpectedRequire('account-security-logic'));
const apiClient = loadApiClient();
const errorsModule = loadPureModule('account-security-errors.ts', (specifier) => {
  if (specifier === '@irexpro/api-client') return apiClient;
  if (specifier === './account-security-logic') return logic.exports;
  throw new Error(`Unexpected runtime import while testing account-security-errors: ${specifier}`);
});

const L = logic.exports;
const E = errorsModule.exports;

// ─── Tiny suite runner ─────────────────────────────────────────────────────

const suites = [];

function defineSuite(name, define) {
  const tests = [];
  const test = (testName, fn) => tests.push({ name: testName, fn });
  define(test);
  suites.push({ name, tests });
}

// ─── Shared fixtures ───────────────────────────────────────────────────────

const PROFILE_VIEW = {
  id: 'fixture-user-id',
  email: 'ada@example.com',
  phone: '+233201234567',
  status: 'ACTIVE',
  emailVerifiedAt: '2025-01-01T00:00:00.000Z',
  phoneVerifiedAt: null,
  countryCode: 'GH',
  timezone: 'Africa/Accra',
  preferredCurrency: 'USD',
  mfaEnabled: false,
  lastLoginAt: null,
  createdAt: '2025-01-01T00:00:00.000Z',
  profile: {
    firstName: 'Ada',
    lastName: 'Lovelace',
    dateOfBirth: '1990-06-15',
    kycStatus: 'NONE',
  },
};

const PROFILE_VALUES = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  dateOfBirth: '1990-06-15',
  countryCode: 'GH',
  timezone: 'Africa/Accra',
  preferredCurrency: 'USD',
};

/** Local-calendar YYYY-MM-DD for a Date (mirrors the validator's local logic). */
function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const TODAY = new Date();
const YESTERDAY = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - 1);
const TOMORROW = new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() + 1);

// base64url / base64 encoding helpers (Node Buffer is available to the HARNESS;
// the module under test implements its own decoder by design).
function base64UrlText(text) {
  return Buffer.from(text, 'utf8').toString('base64url');
}
function base64StandardText(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}
function makeJwt(payloadText, payloadEncoding) {
  const encode = payloadEncoding ?? base64UrlText;
  return `${base64UrlText('{"alg":"HS256","typ":"JWT"}')}.${encode(payloadText)}.${base64UrlText('fixture-signature')}`;
}

const MFA_MATERIAL = { secret: 'fixture-secret-not-a-credential', otpauthUri: 'otpauth://totp/fixture' };

const MFA_INITIAL = { status: 'idle', material: null, failureReason: null };
const MFA_PASSWORD = { status: 'password', material: null, failureReason: null };
const MFA_ENROLLING = { status: 'enrolling', material: null, failureReason: null };
const MFA_VERIFYING = { status: 'verifying', material: MFA_MATERIAL, failureReason: null };
const MFA_SUCCEEDED = { status: 'succeeded', material: null, failureReason: null };
const MFA_FAILED = { status: 'failed', material: null, failureReason: 'fixture rejection copy' };

const MFA_STATES = {
  idle: MFA_INITIAL,
  password: MFA_PASSWORD,
  enrolling: MFA_ENROLLING,
  verifying: MFA_VERIFYING,
  succeeded: MFA_SUCCEEDED,
  failed: MFA_FAILED,
};

const MFA_EVENTS = [
  ['START', () => ({ type: 'START' })],
  ['BEGIN_REQUESTED', () => ({ type: 'BEGIN_REQUESTED' })],
  ['ENROLLMENT_RECEIVED', () => ({ type: 'ENROLLMENT_RECEIVED', material: MFA_MATERIAL })],
  ['BEGIN_FAILED', () => ({ type: 'BEGIN_FAILED' })],
  ['CODE_ACCEPTED', () => ({ type: 'CODE_ACCEPTED' })],
  ['CODE_REJECTED', () => ({ type: 'CODE_REJECTED', reason: 'fixture rejection copy' })],
  ['RETRY', () => ({ type: 'RETRY' })],
  ['RESTART', () => ({ type: 'RESTART' })],
  ['CANCEL', () => ({ type: 'CANCEL' })],
];

// Full transition table: for every (state, event) pair, the exact next state.
const MFA_EXPECTED = {
  idle: {
    START: MFA_PASSWORD,
    BEGIN_REQUESTED: MFA_INITIAL,
    ENROLLMENT_RECEIVED: MFA_INITIAL,
    BEGIN_FAILED: MFA_INITIAL,
    CODE_ACCEPTED: MFA_INITIAL,
    CODE_REJECTED: MFA_INITIAL,
    RETRY: MFA_INITIAL,
    RESTART: MFA_INITIAL,
    CANCEL: MFA_INITIAL,
  },
  password: {
    START: MFA_PASSWORD,
    BEGIN_REQUESTED: MFA_ENROLLING,
    ENROLLMENT_RECEIVED: MFA_PASSWORD,
    BEGIN_FAILED: MFA_PASSWORD,
    CODE_ACCEPTED: MFA_PASSWORD,
    CODE_REJECTED: MFA_PASSWORD,
    RETRY: MFA_PASSWORD,
    RESTART: MFA_INITIAL,
    CANCEL: MFA_INITIAL,
  },
  enrolling: {
    START: MFA_ENROLLING,
    BEGIN_REQUESTED: MFA_ENROLLING,
    ENROLLMENT_RECEIVED: MFA_VERIFYING,
    BEGIN_FAILED: MFA_PASSWORD,
    CODE_ACCEPTED: MFA_ENROLLING,
    CODE_REJECTED: MFA_ENROLLING,
    RETRY: MFA_ENROLLING,
    RESTART: MFA_INITIAL,
    CANCEL: MFA_INITIAL,
  },
  verifying: {
    START: MFA_VERIFYING,
    BEGIN_REQUESTED: MFA_VERIFYING,
    ENROLLMENT_RECEIVED: MFA_VERIFYING,
    BEGIN_FAILED: MFA_VERIFYING,
    CODE_ACCEPTED: MFA_SUCCEEDED,
    CODE_REJECTED: MFA_FAILED,
    RETRY: MFA_VERIFYING,
    RESTART: MFA_INITIAL,
    CANCEL: MFA_INITIAL,
  },
  succeeded: {
    START: MFA_SUCCEEDED,
    BEGIN_REQUESTED: MFA_SUCCEEDED,
    ENROLLMENT_RECEIVED: MFA_SUCCEEDED,
    BEGIN_FAILED: MFA_SUCCEEDED,
    CODE_ACCEPTED: MFA_SUCCEEDED,
    CODE_REJECTED: MFA_SUCCEEDED,
    RETRY: MFA_SUCCEEDED,
    RESTART: MFA_INITIAL,
    CANCEL: MFA_INITIAL,
  },
  failed: {
    START: MFA_FAILED,
    BEGIN_REQUESTED: MFA_FAILED,
    ENROLLMENT_RECEIVED: MFA_FAILED,
    BEGIN_FAILED: MFA_FAILED,
    CODE_ACCEPTED: MFA_FAILED,
    CODE_REJECTED: MFA_FAILED,
    RETRY: MFA_PASSWORD,
    RESTART: MFA_INITIAL,
    CANCEL: MFA_INITIAL,
  },
};

// ─── Suite: profile field validation and request building ──────────────────

defineSuite('profile field validation and request building', (test) => {
  test('validateFirstName accepts a 1-character name', () => {
    assert.equal(L.validateFirstName('A'), null);
  });
  test('validateFirstName accepts exactly 100 characters', () => {
    assert.equal(L.validateFirstName('a'.repeat(100)), null);
  });
  test('validateFirstName rejects 101 characters', () => {
    assert.equal(L.validateFirstName('a'.repeat(101)), 'First name must be 100 characters or fewer.');
  });
  test('validateFirstName rejects empty and whitespace-only values (trimmed)', () => {
    assert.equal(L.validateFirstName(''), 'Enter your first name.');
    assert.equal(L.validateFirstName('   '), 'Enter your first name.');
    assert.equal(L.validateFirstName('\t\n'), 'Enter your first name.');
  });
  test('validateFirstName is trim-aware for padded valid names', () => {
    assert.equal(L.validateFirstName('  Ada  '), null);
  });
  test('validateLastName mirrors first-name boundaries (1/100/101/empty/trim)', () => {
    assert.equal(L.validateLastName('L'), null);
    assert.equal(L.validateLastName('b'.repeat(100)), null);
    assert.equal(L.validateLastName('b'.repeat(101)), 'Last name must be 100 characters or fewer.');
    assert.equal(L.validateLastName(''), 'Enter your last name.');
    assert.equal(L.validateLastName('  '), 'Enter your last name.');
    assert.equal(L.validateLastName('  Lovelace  '), null);
  });
  test('normalizeCountryCode trims and uppercases', () => {
    assert.equal(L.normalizeCountryCode(' gh '), 'GH');
    assert.equal(L.normalizeCountryCode('us'), 'US');
  });
  test('isValidCountryCode accepts case-insensitive 2-letter codes only', () => {
    assert.equal(L.isValidCountryCode('gh'), true);
    assert.equal(L.isValidCountryCode('GH'), true);
    assert.equal(L.isValidCountryCode('G'), false);
    assert.equal(L.isValidCountryCode('GHA'), false);
    assert.equal(L.isValidCountryCode('G1'), false);
    assert.equal(L.isValidCountryCode('12'), false);
  });
  test('validateCountryCode: empty means "not set" (valid); invalid rejected', () => {
    assert.equal(L.validateCountryCode(''), null);
    assert.equal(L.validateCountryCode('   '), null);
    assert.equal(L.validateCountryCode(' gh '), null);
    assert.equal(L.validateCountryCode('GHA'), 'Country code must be a two-letter ISO code, for example GH.');
    assert.equal(L.validateCountryCode('1G'), 'Country code must be a two-letter ISO code, for example GH.');
  });
  test('validateTimezone accepts IANA-shaped values (UTC, Africa/Accra, Etc/GMT+5)', () => {
    assert.equal(L.validateTimezone('Africa/Accra'), null);
    assert.equal(L.validateTimezone('UTC'), null);
    assert.equal(L.validateTimezone('Etc/GMT+5'), null);
    assert.equal(L.validateTimezone('America/New_York'), null);
  });
  test('validateTimezone rejects empty, over-length, and malformed values', () => {
    assert.equal(L.validateTimezone(''), 'Enter your timezone, for example Africa/Accra.');
    assert.equal(L.validateTimezone('   '), 'Enter your timezone, for example Africa/Accra.');
    assert.equal(L.validateTimezone('a'.repeat(51)), 'Timezone must be 50 characters or fewer.');
    assert.equal(L.validateTimezone('Africa//Accra'), 'Enter a valid timezone, for example Africa/Accra.');
    assert.equal(L.validateTimezone('New York'), 'Enter a valid timezone, for example Africa/Accra.');
    assert.equal(L.validateTimezone('Africa/Accra!'), 'Enter a valid timezone, for example Africa/Accra.');
  });
  test('validatePreferredCurrency: empty valid, 3 letters valid (case-insensitive), others rejected', () => {
    assert.equal(L.validatePreferredCurrency(''), null);
    assert.equal(L.validatePreferredCurrency('   '), null);
    assert.equal(L.validatePreferredCurrency('USD'), null);
    assert.equal(L.validatePreferredCurrency('usd'), null);
    assert.equal(L.validatePreferredCurrency(' ghc '), null);
    assert.equal(L.validatePreferredCurrency('US'), 'Currency must be a three-letter code, for example USD.');
    assert.equal(L.validatePreferredCurrency('USDD'), 'Currency must be a three-letter code, for example USD.');
    assert.equal(L.validatePreferredCurrency('U1D'), 'Currency must be a three-letter code, for example USD.');
    assert.equal(L.validatePreferredCurrency('123'), 'Currency must be a three-letter code, for example USD.');
  });
  test('validateDateOfBirth accepts a normal past date', () => {
    assert.equal(L.validateDateOfBirth('1990-06-15'), null);
  });
  test('validateDateOfBirth accepts the 1900-01-01 boundary and rejects pre-1900', () => {
    assert.equal(L.validateDateOfBirth('1900-01-01'), null);
    assert.equal(L.validateDateOfBirth('1899-12-31'), 'Date of birth must be 1900-01-01 or later.');
  });
  test('validateDateOfBirth respects real leap years (2024-02-29 ok, 2023-02-29 not)', () => {
    assert.equal(L.validateDateOfBirth('2024-02-29'), null);
    assert.equal(L.validateDateOfBirth('2023-02-29'), 'Enter a real calendar date.');
  });
  test('validateDateOfBirth rejects future and today dates (past-only)', () => {
    assert.equal(L.validateDateOfBirth('2099-12-31'), 'Date of birth must be in the past.');
    assert.equal(L.validateDateOfBirth(localDateString(TOMORROW)), 'Date of birth must be in the past.');
    assert.equal(L.validateDateOfBirth(localDateString(TODAY)), 'Date of birth must be in the past.');
  });
  test('validateDateOfBirth accepts yesterday and is trim-aware', () => {
    assert.equal(L.validateDateOfBirth(localDateString(YESTERDAY)), null);
    assert.equal(L.validateDateOfBirth('  1990-06-15  '), null);
  });
  test('validateDateOfBirth rejects malformed formats and impossible calendar parts', () => {
    for (const bad of [
      '15-06-1990',
      '1990/06/15',
      '1990-6-15',
      '1990-06-5',
      '19900615',
      '1990-06-15T00:00:00.000Z',
      'abcd-ef-gh',
      '0000-01-01',
      '1990-13-01',
      '1990-06-32',
    ]) {
      assert.notEqual(L.validateDateOfBirth(bad), null, `expected rejection for ${bad}`);
    }
  });
  test('validateDateOfBirth: empty means "not set" (valid)', () => {
    assert.equal(L.validateDateOfBirth(''), null);
  });
  test('profileFieldErrors aggregates only failing fields', () => {
    assert.deepEqual(L.profileFieldErrors(PROFILE_VALUES), {});
    const errors = L.profileFieldErrors({
      ...PROFILE_VALUES,
      firstName: '   ',
      timezone: 'New York',
    });
    assert.deepEqual(Object.keys(errors).sort(), ['firstName', 'timezone']);
    assert.equal(errors.firstName, 'Enter your first name.');
    assert.equal(errors.timezone, 'Enter a valid timezone, for example Africa/Accra.');
  });
  test('toProfileFieldValues maps nulls to empty strings and passes values through', () => {
    assert.deepEqual(L.toProfileFieldValues(PROFILE_VIEW), PROFILE_VALUES);
    assert.deepEqual(
      L.toProfileFieldValues({
        ...PROFILE_VIEW,
        countryCode: null,
        timezone: null,
        preferredCurrency: null,
        profile: {
          firstName: null,
          lastName: null,
          dateOfBirth: null,
          kycStatus: 'NONE',
        },
      }),
      {
        firstName: '',
        lastName: '',
        dateOfBirth: '',
        countryCode: '',
        timezone: '',
        preferredCurrency: '',
      },
    );
  });
  test('isProfileDirty: unchanged values are not dirty', () => {
    assert.equal(L.isProfileDirty(PROFILE_VIEW, PROFILE_VALUES), false);
  });
  test('isProfileDirty is trim-aware (whitespace-only edits are not dirty)', () => {
    assert.equal(
      L.isProfileDirty(PROFILE_VIEW, {
        ...PROFILE_VALUES,
        firstName: '  Ada  ',
        lastName: ' Lovelace ',
        dateOfBirth: ' 1990-06-15 ',
        timezone: ' Africa/Accra ',
      }),
      false,
    );
  });
  test('isProfileDirty normalizes country code and currency case before comparing', () => {
    assert.equal(
      L.isProfileDirty(PROFILE_VIEW, { ...PROFILE_VALUES, countryCode: 'gh', preferredCurrency: 'usd' }),
      false,
    );
  });
  test('isProfileDirty detects real identity and regional changes', () => {
    assert.equal(L.isProfileDirty(PROFILE_VIEW, { ...PROFILE_VALUES, firstName: 'Grace' }), true);
    assert.equal(L.isProfileDirty(PROFILE_VIEW, { ...PROFILE_VALUES, dateOfBirth: '1991-01-31' }), true);
    assert.equal(L.isProfileDirty(PROFILE_VIEW, { ...PROFILE_VALUES, timezone: 'UTC' }), true);
  });
  test('buildUpdateMyProfileRequest emits an empty request when nothing changed', () => {
    assert.deepEqual(L.buildUpdateMyProfileRequest(PROFILE_VIEW, PROFILE_VALUES), {});
  });
  test('buildUpdateMyProfileRequest: unchanged DOB is NOT included (no accidental KYC reset)', () => {
    const request = L.buildUpdateMyProfileRequest(PROFILE_VIEW, {
      ...PROFILE_VALUES,
      firstName: 'Grace',
      dateOfBirth: '1990-06-15',
    });
    assert.ok(!('dateOfBirth' in request), 'unchanged dateOfBirth must never be sent');
    assert.deepEqual(request, { firstName: 'Grace' });
  });
  test('buildUpdateMyProfileRequest: whitespace-padded unchanged DOB still not included', () => {
    const request = L.buildUpdateMyProfileRequest(PROFILE_VIEW, {
      ...PROFILE_VALUES,
      dateOfBirth: '  1990-06-15  ',
    });
    assert.deepEqual(request, {});
  });
  test('buildUpdateMyProfileRequest includes only genuinely changed fields', () => {
    const request = L.buildUpdateMyProfileRequest(PROFILE_VIEW, {
      ...PROFILE_VALUES,
      firstName: 'Grace',
      dateOfBirth: '1991-01-31',
      countryCode: 'us',
      preferredCurrency: 'eur',
      timezone: 'UTC',
    });
    assert.deepEqual(request, {
      firstName: 'Grace',
      dateOfBirth: '1991-01-31',
      countryCode: 'US',
      preferredCurrency: 'EUR',
      timezone: 'UTC',
    });
  });
  test('buildUpdateMyProfileRequest normalizes country/currency case in the emitted body', () => {
    assert.deepEqual(
      L.buildUpdateMyProfileRequest(PROFILE_VIEW, { ...PROFILE_VALUES, countryCode: ' ca ' }),
      { countryCode: 'CA' },
    );
    assert.deepEqual(
      L.buildUpdateMyProfileRequest(PROFILE_VIEW, { ...PROFILE_VALUES, preferredCurrency: 'jpy' }),
      { preferredCurrency: 'JPY' },
    );
  });
  test('buildUpdateMyProfileRequest cannot unset server values (empty fields are omitted)', () => {
    const request = L.buildUpdateMyProfileRequest(PROFILE_VIEW, {
      ...PROFILE_VALUES,
      countryCode: '',
      preferredCurrency: '   ',
      dateOfBirth: '',
    });
    assert.deepEqual(request, {});
    // Setting a previously-unset field DOES emit it.
    assert.deepEqual(
      L.buildUpdateMyProfileRequest(
        { ...PROFILE_VIEW, profile: { ...PROFILE_VIEW.profile, dateOfBirth: null } },
        PROFILE_VALUES,
      ),
      { dateOfBirth: '1990-06-15' },
    );
  });
  test('deriveInitials: two names → first letters; single name → first two letters', () => {
    assert.equal(L.deriveInitials(PROFILE_VIEW), 'AL');
    assert.equal(
      L.deriveInitials({ profile: { firstName: 'Madonna', lastName: null }, email: null, phone: null }),
      'MA',
    );
    assert.equal(
      L.deriveInitials({ profile: { firstName: null, lastName: 'Presley' }, email: null, phone: null }),
      'PR',
    );
  });
  test('deriveInitials: contact fallback uses first two alphanumerics; else "?"', () => {
    assert.equal(
      L.deriveInitials({ profile: { firstName: null, lastName: null }, email: 'grace@example.com', phone: null }),
      'GR',
    );
    assert.equal(
      L.deriveInitials({ profile: { firstName: null, lastName: null }, email: null, phone: '+233 20 123 4567' }),
      '23',
    );
    assert.equal(
      L.deriveInitials({ profile: { firstName: null, lastName: null }, email: null, phone: null }),
      '?',
    );
  });
});

// ─── Suite: account status and verification presentation ───────────────────

defineSuite('account status and verification presentation', (test) => {
  test('accountStatusMeta maps all five statuses to pinned labels and tones', () => {
    assert.deepEqual(L.accountStatusMeta('ACTIVE'), { label: 'Active', tone: 'positive' });
    assert.deepEqual(L.accountStatusMeta('PENDING_VERIFICATION'), {
      label: 'Pending verification',
      tone: 'warning',
    });
    assert.deepEqual(L.accountStatusMeta('SUSPENDED'), { label: 'Suspended', tone: 'danger' });
    assert.deepEqual(L.accountStatusMeta('PERMANENTLY_LOCKED'), {
      label: 'Permanently locked',
      tone: 'danger',
    });
    assert.deepEqual(L.accountStatusMeta('CLOSED'), { label: 'Closed', tone: 'neutral' });
  });
  test('accountStatusMeta falls back to a neutral humanized label for unknown values', () => {
    assert.deepEqual(L.accountStatusMeta('SOME_UNKNOWN_STATUS'), {
      label: 'SOME UNKNOWN STATUS',
      tone: 'neutral',
    });
  });
  test('accountStatusGuidance pins honest per-status copy', () => {
    assert.equal(L.accountStatusGuidance('ACTIVE'), 'Your account is active.');
    assert.equal(
      L.accountStatusGuidance('PENDING_VERIFICATION'),
      'Verify your email or phone to activate trading features.',
    );
    assert.equal(
      L.accountStatusGuidance('SUSPENDED'),
      'Your account is suspended. Trading and account changes are blocked. Existing sessions were revoked when the restriction was applied.',
    );
    assert.equal(
      L.accountStatusGuidance('PERMANENTLY_LOCKED'),
      'Your account has been permanently locked. Signing in, trading, and account changes are no longer available.',
    );
    assert.equal(L.accountStatusGuidance('CLOSED'), 'This account is closed.');
    assert.equal(
      L.accountStatusGuidance('SOME_UNKNOWN_STATUS'),
      'Your account status is unavailable right now.',
    );
  });
  test('isRestrictedAccountStatus: only SUSPENDED / PERMANENTLY_LOCKED / CLOSED are restricted', () => {
    assert.equal(L.isRestrictedAccountStatus('ACTIVE'), false);
    assert.equal(L.isRestrictedAccountStatus('PENDING_VERIFICATION'), false);
    assert.equal(L.isRestrictedAccountStatus('SUSPENDED'), true);
    assert.equal(L.isRestrictedAccountStatus('PERMANENTLY_LOCKED'), true);
    assert.equal(L.isRestrictedAccountStatus('CLOSED'), true);
  });
  test('verificationBadges derives strictly from verification timestamps', () => {
    assert.deepEqual(
      L.verificationBadges({ emailVerifiedAt: null, phoneVerifiedAt: null }),
      { email: false, phone: false },
    );
    assert.deepEqual(
      L.verificationBadges({ emailVerifiedAt: '', phoneVerifiedAt: '' }),
      { email: false, phone: false },
    );
    assert.deepEqual(
      L.verificationBadges({
        emailVerifiedAt: '2025-01-01T00:00:00.000Z',
        phoneVerifiedAt: '2025-01-02T00:00:00.000Z',
      }),
      { email: true, phone: true },
    );
    assert.deepEqual(
      L.verificationBadges({ emailVerifiedAt: '2025-01-01T00:00:00.000Z', phoneVerifiedAt: null }),
      { email: true, phone: false },
    );
  });
});

// ─── Suite: password change policy (Sprint 55 Phase I) ─────────────────────

defineSuite('password change policy validation', (test) => {
  test('validateNewPasswordPolicy accepts a compliant password', () => {
    assert.equal(L.validateNewPasswordPolicy('correct-horse-42'), null);
  });
  test('validateNewPasswordPolicy enforces the 12-character minimum', () => {
    assert.equal(
      L.validateNewPasswordPolicy('short1a'),
      'New password must be at least 12 characters.',
    );
    assert.equal(L.validateNewPasswordPolicy('a'.repeat(10) + '1'), 'New password must be at least 12 characters.');
    assert.equal(L.validateNewPasswordPolicy('a'.repeat(10) + '1B'), null);
  });
  test('validateNewPasswordPolicy enforces the 128-character maximum', () => {
    assert.equal(L.validateNewPasswordPolicy('a'.repeat(127) + '1'), null);
    assert.equal(
      L.validateNewPasswordPolicy('a'.repeat(128) + '1'),
      'New password must be 128 characters or fewer.',
    );
  });
  test('validateNewPasswordPolicy requires at least one letter and one number', () => {
    assert.equal(
      L.validateNewPasswordPolicy('12345678901234'),
      'New password must include at least one letter.',
    );
    assert.equal(
      L.validateNewPasswordPolicy('abcdefghijkl'),
      'New password must include at least one number.',
    );
  });
  test('validateChangePasswordSubmission returns null for a valid submission', () => {
    assert.equal(
      L.validateChangePasswordSubmission({
        currentPassword: 'fixture-current-password',
        newPassword: 'fixture-new-password-42',
        confirmPassword: 'fixture-new-password-42',
      }),
      null,
    );
  });
  test('validateChangePasswordSubmission gates current password first (required, then ≤128)', () => {
    assert.deepEqual(
      L.validateChangePasswordSubmission({
        currentPassword: '',
        newPassword: 'fixture-new-password-42',
        confirmPassword: 'fixture-new-password-42',
      }),
      { field: 'currentPassword', error: 'Enter your current password.' },
    );
    assert.deepEqual(
      L.validateChangePasswordSubmission({
        currentPassword: 'x'.repeat(129),
        newPassword: 'fixture-new-password-42',
        confirmPassword: 'fixture-new-password-42',
      }),
      { field: 'currentPassword', error: 'Current password must be 128 characters or fewer.' },
    );
  });
  test('validateChangePasswordSubmission reports new-password policy failures on the newPassword field', () => {
    assert.deepEqual(
      L.validateChangePasswordSubmission({
        currentPassword: 'fixture-current-password',
        newPassword: 'weak',
        confirmPassword: 'weak',
      }),
      { field: 'newPassword', error: 'New password must be at least 12 characters.' },
    );
  });
  test('validateChangePasswordSubmission distinguishes empty confirm from mismatched confirm', () => {
    assert.deepEqual(
      L.validateChangePasswordSubmission({
        currentPassword: 'fixture-current-password',
        newPassword: 'fixture-new-password-42',
        confirmPassword: '',
      }),
      { field: 'confirmPassword', error: 'Enter the new password again.' },
    );
    assert.deepEqual(
      L.validateChangePasswordSubmission({
        currentPassword: 'fixture-current-password',
        newPassword: 'fixture-new-password-42',
        confirmPassword: 'different-password-42',
      }),
      { field: 'confirmPassword', error: 'New passwords do not match.' },
    );
  });
});

// ─── Suite: MFA TOTP enrollment state machine (Sprint 55 Phase G) ──────────

defineSuite('MFA enrollment state machine', (test) => {
  test('initial state is idle with no material and no failure reason', () => {
    assert.deepEqual(L.MFA_ENROLLMENT_INITIAL_STATE, MFA_INITIAL);
  });

  for (const [stateKey, state] of Object.entries(MFA_STATES)) {
    test(`full transition table from "${stateKey}" (every event → exact next state)`, () => {
      for (const [eventName, makeEvent] of MFA_EVENTS) {
        const next = L.mfaEnrollmentReducer(state, makeEvent());
        assert.deepEqual(
          next,
          MFA_EXPECTED[stateKey][eventName],
          `${stateKey} + ${eventName} must produce the pinned next state`,
        );
      }
    });
  }

  test('INVARIANT: material is non-null ⟺ status "verifying" (across every state × event)', () => {
    for (const [stateKey, state] of Object.entries(MFA_STATES)) {
      for (const [eventName, makeEvent] of MFA_EVENTS) {
        const next = L.mfaEnrollmentReducer(state, makeEvent());
        assert.equal(
          next.material !== null,
          next.status === 'verifying',
          `${stateKey} + ${eventName}: material must be non-null exactly when status is "verifying"`,
        );
      }
    }
  });
  test('INVARIANT: failureReason is non-null ⟺ status "failed" (across every state × event)', () => {
    for (const [stateKey, state] of Object.entries(MFA_STATES)) {
      for (const [eventName, makeEvent] of MFA_EVENTS) {
        const next = L.mfaEnrollmentReducer(state, makeEvent());
        assert.equal(
          next.failureReason !== null,
          next.status === 'failed',
          `${stateKey} + ${eventName}: failureReason must be non-null exactly when status is "failed"`,
        );
      }
    }
  });
  test('enrollment material is WIPED on CANCEL, RESTART, CODE_ACCEPTED, and CODE_REJECTED', () => {
    for (const eventName of ['CANCEL', 'RESTART', 'CODE_ACCEPTED', 'CODE_REJECTED']) {
      const makeEvent = MFA_EVENTS.find(([name]) => name === eventName)[1];
      const next = L.mfaEnrollmentReducer(MFA_VERIFYING, makeEvent());
      assert.equal(next.material, null, `${eventName} must wipe the enrollment material`);
      assert.notEqual(next.status, 'verifying');
    }
  });
  test('RESTART and CANCEL wipe material and failureReason from EVERY state', () => {
    for (const [stateKey, state] of Object.entries(MFA_STATES)) {
      for (const eventName of ['RESTART', 'CANCEL']) {
        const makeEvent = MFA_EVENTS.find(([name]) => name === eventName)[1];
        assert.deepEqual(L.mfaEnrollmentReducer(state, makeEvent()), MFA_INITIAL, `${stateKey} + ${eventName}`);
      }
    }
  });
  test('BEGIN_FAILED wipes any residual state back to password entry', () => {
    assert.deepEqual(L.mfaEnrollmentReducer(MFA_ENROLLING, { type: 'BEGIN_FAILED' }), MFA_PASSWORD);
  });
  test('ENROLLMENT_RECEIVED only stores material from "enrolling" (never injects elsewhere)', () => {
    for (const [stateKey, state] of Object.entries(MFA_STATES)) {
      if (stateKey === 'enrolling') continue;
      const next = L.mfaEnrollmentReducer(state, {
        type: 'ENROLLMENT_RECEIVED',
        material: MFA_MATERIAL,
      });
      assert.deepEqual(next, state, `ENROLLMENT_RECEIVED must be a no-op from "${stateKey}"`);
      if (stateKey !== 'verifying') {
        assert.equal(next.material, null, `material must not be stored from "${stateKey}"`);
      }
    }
  });
  test('mismatched events are strict no-ops (same state object returned)', () => {
    assert.strictEqual(L.mfaEnrollmentReducer(MFA_PASSWORD, { type: 'START' }), MFA_PASSWORD);
    assert.strictEqual(
      L.mfaEnrollmentReducer(MFA_VERIFYING, { type: 'BEGIN_REQUESTED' }),
      MFA_VERIFYING,
    );
    assert.strictEqual(L.mfaEnrollmentReducer(MFA_SUCCEEDED, { type: 'CODE_REJECTED', reason: 'x' }), MFA_SUCCEEDED);
    assert.strictEqual(L.mfaEnrollmentReducer(MFA_FAILED, { type: 'CODE_ACCEPTED' }), MFA_FAILED);
    assert.strictEqual(L.mfaEnrollmentReducer(MFA_INITIAL, { type: 'RETRY' }), MFA_INITIAL);
  });
  test('isMfaSetupExpiredRejectionMessage matches the server 400 message shape', () => {
    assert.equal(L.isMfaSetupExpiredRejectionMessage('MFA setup expired; start setup again'), true);
    assert.equal(L.isMfaSetupExpiredRejectionMessage('mfa setup EXPIRED'), true);
    assert.equal(L.isMfaSetupExpiredRejectionMessage('MFA setup expired'), true);
    assert.equal(L.isMfaSetupExpiredRejectionMessage('Session state changed concurrently; please retry'), false);
    assert.equal(L.isMfaSetupExpiredRejectionMessage('MFA is already enabled'), false);
    assert.equal(L.isMfaSetupExpiredRejectionMessage(''), false);
  });
  test('isMfaSetupExpiredRejection: only ApiClientError 400 carrying that message', () => {
    const ApiClientError = apiClient.ApiClientError;
    const expired = new ApiClientError(400, 'MFA setup expired; start setup again');
    const other400 = new ApiClientError(400, 'MFA is already enabled');
    const unauthorized = new ApiClientError(401, 'MFA setup expired; start setup again');
    const plain = new Error('MFA setup expired; start setup again');
    const object = { statusCode: 400, message: 'MFA setup expired; start setup again' };
    assert.equal(E.isMfaSetupExpiredRejection(expired), true);
    assert.equal(E.isMfaSetupExpiredRejection(other400), false);
    assert.equal(E.isMfaSetupExpiredRejection(unauthorized), false);
    assert.equal(E.isMfaSetupExpiredRejection(plain), false);
    assert.equal(E.isMfaSetupExpiredRejection(object), false);
    assert.equal(E.isMfaSetupExpiredRejection(null), false);
  });
});

// ─── Suite: verification code, cooldown, expiry copy (Phase H) ─────────────

defineSuite('verification code, resend cooldown, and expiry copy', (test) => {
  test('validateSixDigitCode accepts exactly six digits (whitespace tolerated)', () => {
    assert.equal(L.validateSixDigitCode('123456'), true);
    assert.equal(L.validateSixDigitCode(' 123456 '), true);
    assert.equal(L.validateSixDigitCode('000000'), true);
  });
  test('validateSixDigitCode rejects 5/7 digits, non-numeric, and empty values', () => {
    assert.equal(L.validateSixDigitCode('12345'), false);
    assert.equal(L.validateSixDigitCode('1234567'), false);
    assert.equal(L.validateSixDigitCode('12345a'), false);
    assert.equal(L.validateSixDigitCode('123 45'), false);
    assert.equal(L.validateSixDigitCode(''), false);
    assert.equal(L.validateSixDigitCode('   '), false);
    assert.equal(L.validateSixDigitCode('12.34'), false);
  });
  test('resendCooldown counts down whole seconds from a fresh cooldown', () => {
    assert.equal(L.resendCooldown(60, 0), 60);
    assert.equal(L.resendCooldown(60, 30_000), 30);
    assert.equal(L.resendCooldown(60, 59_000), 1);
  });
  test('resendCooldown ceil-rounds so the cooldown never re-enables early', () => {
    assert.equal(L.resendCooldown(60, 59_999), 1);
    assert.equal(L.resendCooldown(60, 29_999), 31);
  });
  test('resendCooldown clamps to zero when elapsed (never negative)', () => {
    assert.equal(L.resendCooldown(60, 60_000), 0);
    assert.equal(L.resendCooldown(60, 61_000), 0);
    assert.equal(L.resendCooldown(60, 600_000), 0);
  });
  test('resendCooldown with a non-positive initial value is always zero', () => {
    assert.equal(L.resendCooldown(0, 0), 0);
    assert.equal(L.resendCooldown(0, 5_000), 0);
    assert.equal(L.resendCooldown(-5, 0), 0);
  });
  test('formatCooldown renders seconds below a minute and m:ss above', () => {
    assert.equal(L.formatCooldown(0), '0s');
    assert.equal(L.formatCooldown(45), '45s');
    assert.equal(L.formatCooldown(59), '59s');
    assert.equal(L.formatCooldown(60), '1:00');
    assert.equal(L.formatCooldown(65), '1:05');
    assert.equal(L.formatCooldown(119), '1:59');
    assert.equal(L.formatCooldown(120), '2:00');
    assert.equal(L.formatCooldown(3_600), '60:00');
  });
  test('formatCooldown floors fractional input and clamps negatives', () => {
    assert.equal(L.formatCooldown(45.9), '45s');
    assert.equal(L.formatCooldown(-5), '0s');
  });
  test('verificationExpiryHint returns distinct honest copy per channel', () => {
    const emailHint = L.verificationExpiryHint('email');
    const phoneHint = L.verificationExpiryHint('phone');
    assert.equal(emailHint, 'The link expires in about 15 minutes.');
    assert.equal(phoneHint, 'The code expires in about 10 minutes.');
    assert.notEqual(emailHint, phoneHint);
  });
});

// ─── Suite: JWT session decoding and device view (Phase J) ─────────────────

defineSuite('JWT session decoding and device view', (test) => {
  const REAL_PAYLOAD = JSON.stringify({
    a: 'ÿ~?ÿ',
    name: 'Zoé 🚀',
    note: 'x'.repeat(300),
  });

  test('decodeJwtPayload decodes a real-shaped hand-built JWT (base64url -/_ chars, multi-byte UTF-8, 300-char payload)', () => {
    const encodedPayload = base64UrlText(REAL_PAYLOAD);
    assert.ok(encodedPayload.includes('-'), 'fixture must exercise the base64url "-" alias');
    assert.ok(encodedPayload.includes('_'), 'fixture must exercise the base64url "_" alias');
    const jwt = makeJwt(REAL_PAYLOAD);
    assert.deepEqual(JSON.parse(REAL_PAYLOAD), { a: 'ÿ~?ÿ', name: 'Zoé 🚀', note: 'x'.repeat(300) });
    assert.deepEqual(L.decodeJwtPayload(jwt), { a: 'ÿ~?ÿ', name: 'Zoé 🚀', note: 'x'.repeat(300) });
  });
  test('decodeJwtPayload decodes standard-base64 payloads with "+" and "/" characters and "=" padding', () => {
    const payloadText = JSON.stringify({ a: 'ÿ~?ÿ' });
    const encoded = base64StandardText(payloadText);
    assert.ok(encoded.includes('+') || encoded.includes('/'), 'fixture must use standard-base64 characters');
    assert.ok(encoded.includes('='), 'fixture must include padding');
    assert.deepEqual(L.decodeJwtPayload(makeJwt(payloadText, base64StandardText)), { a: 'ÿ~?ÿ' });
  });
  test('decodeJwtPayload returns null for wrong segment counts (never throws)', () => {
    for (const jwt of ['', 'one-segment', 'two.segments', 'a.b.c.d']) {
      let result;
      assert.doesNotThrow(() => {
        result = L.decodeJwtPayload(jwt);
      });
      assert.equal(result, null, `expected null for ${JSON.stringify(jwt)}`);
    }
  });
  test('decodeJwtPayload returns null for invalid characters in the payload segment', () => {
    for (const badPayload of ['!!!', '***', 'a b', 'a?b']) {
      const jwt = `header.${badPayload}.signature`;
      assert.equal(L.decodeJwtPayload(jwt), null, `expected null for payload ${JSON.stringify(badPayload)}`);
    }
  });
  test('decodeJwtPayload returns null for a lone 6-bit group (impossible length)', () => {
    const jwt = `header.abcde.signature`;
    assert.equal(L.decodeJwtPayload(jwt), null);
  });
  test('decodeJwtPayload returns null for non-object JSON payloads', () => {
    for (const text of ['[1,2,3]', 'null', '42', '"text"', 'true', '{bad json']) {
      assert.equal(L.decodeJwtPayload(makeJwt(text)), null, `expected null for ${JSON.stringify(text)}`);
    }
  });
  test('decodeJwtPayload returns null for broken UTF-8 byte sequences', () => {
    const broken = Buffer.from([0xff, 0xfe, 0x41]).toString('base64url');
    assert.equal(L.decodeJwtPayload(`header.${broken}.signature`), null);
    const strayContinuation = Buffer.from([0x41, 0x80, 0x42]).toString('base64url');
    assert.equal(L.decodeJwtPayload(`header.${strayContinuation}.signature`), null);
  });
  test('decodeJwtPayload decodes numeric and nested claims faithfully', () => {
    const payload = { sub: 'user-123', iat: 1_700_000_000, exp: 1_700_003_600, role: 'USER', nested: { k: [1, 2] } };
    assert.deepEqual(L.decodeJwtPayload(makeJwt(JSON.stringify(payload))), payload);
  });
  test('currentSessionView returns ms-precision start/expiry for valid iat/exp claims', () => {
    const payload = { sub: 'user-123', iat: 1_700_000_000, exp: 1_700_003_600 };
    assert.deepEqual(L.currentSessionView(makeJwt(JSON.stringify(payload))), {
      startedAt: 1_700_000_000_000,
      expiresAt: 1_700_003_600_000,
    });
  });
  test('currentSessionView returns null for missing or string iat/exp claims', () => {
    assert.equal(L.currentSessionView(makeJwt(JSON.stringify({ exp: 2 }))), null);
    assert.equal(L.currentSessionView(makeJwt(JSON.stringify({ iat: 1 }))), null);
    assert.equal(L.currentSessionView(makeJwt(JSON.stringify({ iat: '1', exp: 2 }))), null);
    assert.equal(L.currentSessionView(makeJwt(JSON.stringify({ iat: 1, exp: '2' }))), null);
    assert.equal(L.currentSessionView(makeJwt(JSON.stringify({ sub: 'u' }))), null);
  });
  test('currentSessionView returns null for negative or non-finite epoch claims', () => {
    assert.equal(L.currentSessionView(makeJwt(JSON.stringify({ iat: -100, exp: 100 }))), null);
    assert.equal(L.currentSessionView(makeJwt(JSON.stringify({ iat: 100, exp: -100 }))), null);
    // JSON.parse turns 1e999 into Infinity, which must not become a view.
    assert.equal(L.currentSessionView(makeJwt('{"iat":1e999,"exp":100}')), null);
  });
  test('currentSessionView returns null for malformed tokens', () => {
    assert.equal(L.currentSessionView('not-a-jwt'), null);
    assert.equal(L.currentSessionView('a.b.c.d'), null);
    assert.equal(L.currentSessionView(''), null);
  });
  test('deviceSummary renders numeric and string platform versions', () => {
    assert.equal(L.deviceSummary({ OS: 'android', Version: 15 }), 'Android 15');
    assert.equal(L.deviceSummary({ OS: 'android', Version: 33 }), 'Android 33');
    assert.equal(L.deviceSummary({ OS: 'ios', Version: '18.2' }), 'iOS 18.2');
    assert.equal(L.deviceSummary({ OS: 'windows', Version: '10.0' }), 'Windows 10.0');
    assert.equal(L.deviceSummary({ OS: 'macos', Version: '14.5' }), 'macOS 14.5');
  });
  test('deviceSummary: bare OS when version is empty, trimmed inputs, unknown OS capitalized', () => {
    assert.equal(L.deviceSummary({ OS: 'web', Version: '' }), 'Web');
    assert.equal(L.deviceSummary({ OS: ' android ', Version: 15 }), 'Android 15');
    assert.equal(L.deviceSummary({ OS: 'tizen', Version: '5' }), 'Tizen 5');
  });
  test('formatSessionTimestamps renders device-local "Mon DD, YYYY, HH:MM" labels', () => {
    const startedAt = new Date(2025, 5, 12, 14, 30).getTime();
    const expiresAt = new Date(2025, 5, 12, 15, 0).getTime();
    assert.deepEqual(L.formatSessionTimestamps({ startedAt, expiresAt }), {
      started: 'Jun 12, 2025, 14:30',
      expires: 'Jun 12, 2025, 15:00',
    });
    assert.deepEqual(
      L.formatSessionTimestamps({
        startedAt: new Date(2025, 0, 3, 9, 5).getTime(),
        expiresAt: new Date(2025, 0, 3, 9, 6).getTime(),
      }),
      { started: 'Jan 3, 2025, 09:05', expires: 'Jan 3, 2025, 09:06' },
    );
  });
});

// ─── Suite: sanitized error mappers (account-security-errors.ts) ───────────

defineSuite('sanitized error mappers', (test) => {
  const ApiClientError = apiClient.ApiClientError;

  test('accountSecurityError maps statusCode 0 (network) to fixed offline copy', () => {
    assert.equal(
      E.accountSecurityError(new ApiClientError(0, 'Network error contacting API: fixture')),
      'Unable to reach the server. Check your connection and try again.',
    );
  });
  test('accountSecurityError maps 401 to fixed re-auth copy', () => {
    assert.equal(
      E.accountSecurityError(new ApiClientError(401, 'Current password verification failed')),
      'Your session or current password could not be verified.',
    );
  });
  test('accountSecurityError maps 400 and 422 to fixed validation copy', () => {
    assert.equal(
      E.accountSecurityError(new ApiClientError(400, 'bad request body')),
      'Check the information you entered and try again.',
    );
    assert.equal(
      E.accountSecurityError(new ApiClientError(422, 'validation failed')),
      'Check the information you entered and try again.',
    );
  });
  test('accountSecurityError maps 429 to fixed rate-limit copy', () => {
    assert.equal(
      E.accountSecurityError(new ApiClientError(429, 'too many requests')),
      'Too many attempts. Please try again later.',
    );
  });
  test('accountSecurityError maps 5xx to fixed availability copy', () => {
    assert.equal(
      E.accountSecurityError(new ApiClientError(500, 'internal')),
      'This security action is temporarily unavailable. Please try again later.',
    );
    assert.equal(
      E.accountSecurityError(new ApiClientError(503, 'unavailable')),
      'This security action is temporarily unavailable. Please try again later.',
    );
  });
  test('accountSecurityError maps every other status to the generic fallback', () => {
    assert.equal(
      E.accountSecurityError(new ApiClientError(403, 'forbidden')),
      'The security action could not be completed.',
    );
    assert.equal(
      E.accountSecurityError(new ApiClientError(404, 'not found')),
      'The security action could not be completed.',
    );
  });
  test('accountSecurityError NEVER reflects raw payload messages (marker probe)', () => {
    const marker = 'INTERNAL_SERVER_MARKER_TOP_SECRET';
    const copies = [
      E.accountSecurityError(new ApiClientError(400, marker, { message: marker })),
      E.accountSecurityError(new ApiClientError(401, marker)),
      E.accountSecurityError(new ApiClientError(500, marker, { nested: marker })),
    ];
    for (const copy of copies) {
      assert.equal(typeof copy, 'string');
      assert.ok(!copy.includes(marker), 'raw server message must never reach user-facing copy');
    }
  });
  test('accountSecurityError falls back safely for non-ApiClientError throwables', () => {
    const fallback = 'Something went wrong. Please try again.';
    assert.equal(E.accountSecurityError(new Error('TypeError: cannot read property')), fallback);
    assert.equal(E.accountSecurityError({ statusCode: 401, message: 'spoofed' }), fallback);
    assert.equal(E.accountSecurityError('string error'), fallback);
    assert.equal(E.accountSecurityError(null), fallback);
    assert.equal(E.accountSecurityError(undefined), fallback);
    assert.equal(E.accountSecurityError(42), fallback);
  });
  test('verificationCodeError maps 401 to the code-mismatch copy', () => {
    assert.equal(
      E.verificationCodeError(new ApiClientError(401, 'MFA verification failed')),
      "That code didn't match. Check the code and try again.",
    );
  });
  test('verificationCodeError falls back to the generic mapper for every other status', () => {
    assert.equal(
      E.verificationCodeError(new ApiClientError(400, 'expired code')),
      'Check the information you entered and try again.',
    );
    assert.equal(
      E.verificationCodeError(new ApiClientError(429, 'throttled')),
      'Too many attempts. Please try again later.',
    );
    assert.equal(
      E.verificationCodeError(new ApiClientError(0, 'network')),
      'Unable to reach the server. Check your connection and try again.',
    );
    assert.equal(E.verificationCodeError(new Error('boom')), 'Something went wrong. Please try again.');
  });
  test('verificationCodeError never reflects the raw server message', () => {
    const marker = 'RAW_CODE_MARKER';
    const copy = E.verificationCodeError(new ApiClientError(401, marker));
    assert.ok(!copy.includes(marker));
  });
  test('mapper errors discriminate via real instanceof ApiClientError semantics', () => {
    const realError = new ApiClientError(401, 'fixture');
    assert.ok(realError instanceof ApiClientError);
    assert.equal(realError.statusCode, 401);
    assert.equal(E.accountSecurityError(realError), 'Your session or current password could not be verified.');
  });
});

// ─── Suite: pre-auth appeal validation (Phase K) ────────────────────────────

defineSuite('pre-auth appeal validation', (test) => {
  test('validateAppealSubmission returns null for a valid submission', () => {
    assert.equal(
      L.validateAppealSubmission({
        identifier: 'locked.out@example.com',
        reason: 'I can no longer access my registered email address.',
      }),
      null,
    );
  });
  test('validateAppealSubmission rejects an empty or whitespace-only identifier', () => {
    assert.deepEqual(L.validateAppealSubmission({ identifier: '', reason: 'x'.repeat(20) }), {
      field: 'identifier',
      error: 'Enter your email or phone number.',
    });
    assert.deepEqual(L.validateAppealSubmission({ identifier: '   ', reason: 'x'.repeat(20) }), {
      field: 'identifier',
      error: 'Enter your email or phone number.',
    });
  });
  test('validateAppealSubmission accepts identifier at 1 and 255 characters, rejects 256', () => {
    assert.equal(L.validateAppealSubmission({ identifier: 'a', reason: 'x'.repeat(20) }), null);
    assert.equal(L.validateAppealSubmission({ identifier: 'a'.repeat(255), reason: 'x'.repeat(20) }), null);
    assert.deepEqual(L.validateAppealSubmission({ identifier: 'a'.repeat(256), reason: 'x'.repeat(20) }), {
      field: 'identifier',
      error: 'Identifier must be 255 characters or fewer.',
    });
  });
  test('validateAppealSubmission rejects a 19-character reason, accepts 20 and 2000, rejects 2001', () => {
    assert.deepEqual(L.validateAppealSubmission({ identifier: 'a@example.com', reason: 'x'.repeat(19) }), {
      field: 'reason',
      error: 'Describe the issue in at least 20 characters.',
    });
    assert.equal(L.validateAppealSubmission({ identifier: 'a@example.com', reason: 'x'.repeat(20) }), null);
    assert.equal(L.validateAppealSubmission({ identifier: 'a@example.com', reason: 'x'.repeat(2000) }), null);
    assert.deepEqual(L.validateAppealSubmission({ identifier: 'a@example.com', reason: 'x'.repeat(2001) }), {
      field: 'reason',
      error: 'Reason must be 2000 characters or fewer.',
    });
  });
  test('validateAppealSubmission is trim-aware on the reason', () => {
    assert.equal(
      L.validateAppealSubmission({ identifier: 'a@example.com', reason: `  ${'x'.repeat(20)}  ` }),
      null,
    );
    assert.deepEqual(L.validateAppealSubmission({ identifier: 'a@example.com', reason: ' '.repeat(20) }), {
      field: 'reason',
      error: 'Describe the issue in at least 20 characters.',
    });
  });
  test('validateAppealSubmission reports the identifier gate before the reason gate', () => {
    assert.deepEqual(
      L.validateAppealSubmission({ identifier: '', reason: 'short' }),
      { field: 'identifier', error: 'Enter your email or phone number.' },
    );
  });
  test('appeal length constants match the backend DTO policy', () => {
    assert.equal(L.APPEAL_IDENTIFIER_MAX_LENGTH, 255);
    assert.equal(L.APPEAL_REASON_MIN_LENGTH, 20);
    assert.equal(L.APPEAL_REASON_MAX_LENGTH, 2000);
  });
});

// ─── Suite: security activity timeline (Phase J) ───────────────────────────

defineSuite('security activity timeline', (test) => {
  const EXPECTED_LABELS = {
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

  test('securityEventLabel maps every allowlisted action to its friendly label', () => {
    for (const [action, label] of Object.entries(EXPECTED_LABELS)) {
      assert.equal(L.securityEventLabel(action), label, `label for ${action}`);
    }
  });
  test('securityEventLabel renders unknown actions with the generic fallback (never an error)', () => {
    assert.equal(L.securityEventLabel('SOMETHING_NEW'), 'Account security event');
    assert.equal(L.securityEventLabel(''), 'Account security event');
    assert.equal(L.securityEventLabel('user_login_success'), 'Account security event');
  });
  test('securityEventTone maps INFO/absent → neutral, WARNING → warning, CRITICAL → danger', () => {
    assert.equal(L.securityEventTone(undefined), 'neutral');
    assert.equal(L.securityEventTone('INFO'), 'neutral');
    assert.equal(L.securityEventTone('WARNING'), 'warning');
    assert.equal(L.securityEventTone('CRITICAL'), 'danger');
    assert.equal(L.securityEventTone('GARBAGE'), 'neutral');
  });
  test('formatRelativeTime: "just now" under a minute, tolerating small future clock skew', () => {
    const now = 1_700_000_000_000;
    assert.equal(L.formatRelativeTime(new Date(now).toISOString(), now), 'just now');
    assert.equal(L.formatRelativeTime(new Date(now - 30_000).toISOString(), now), 'just now');
    assert.equal(L.formatRelativeTime(new Date(now + 10_000).toISOString(), now), 'just now');
  });
  test('formatRelativeTime renders compact minute/hour/day deltas', () => {
    const now = 1_700_000_000_000;
    assert.equal(L.formatRelativeTime(new Date(now - 60_000).toISOString(), now), '1m ago');
    assert.equal(L.formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now), '5m ago');
    assert.equal(L.formatRelativeTime(new Date(now - 3_600_000).toISOString(), now), '1h ago');
    assert.equal(L.formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now), '3h ago');
    assert.equal(L.formatRelativeTime(new Date(now - 86_400_000).toISOString(), now), '1d ago');
    assert.equal(L.formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), now), '2d ago');
    assert.equal(L.formatRelativeTime(new Date(now - 6 * 86_400_000).toISOString(), now), '6d ago');
  });
  test('formatRelativeTime falls back to the ISO date at ≥ 7 days', () => {
    const now = Date.parse('2025-01-15T12:00:00.000Z');
    assert.equal(L.formatRelativeTime('2025-01-01T09:30:00.000Z', now), '2025-01-01');
    assert.equal(L.formatRelativeTime('2024-12-31T23:59:59.999Z', now), '2024-12-31');
  });
  test('formatRelativeTime returns unparseable timestamps as-is (honest raw string)', () => {
    assert.equal(L.formatRelativeTime('not-a-date', 1_700_000_000_000), 'not-a-date');
    assert.equal(L.formatRelativeTime('', 1_700_000_000_000), '');
  });
});

// ─── Suite: sensitive-memory/storage static regression guard ───────────────

defineSuite('sensitive-memory/storage static regression guard', (test) => {
  // Guards the TRANSPILED source text of both pure modules: the account layer
  // must never persist, load, or log secrets (enrollment material, codes,
  // passwords, tokens) — storage APIs, filesystem access, and console logging
  // are banned from the pure layer.
  const FS_REQUIRE_PATTERN = /require\(\s*["'](node:)?fs["']\s*\)/;

  const modules = [
    ['account-security-logic.ts', logic],
    ['account-security-errors.ts', errorsModule],
  ];

  for (const [label, record] of modules) {
    test(`${label}: transpiled source contains no SecureStore`, () => {
      assert.ok(!record.outputText.includes('SecureStore'), 'pure layer must not touch keychain storage');
    });
    test(`${label}: transpiled source contains no AsyncStorage`, () => {
      assert.ok(!record.outputText.includes('AsyncStorage'), 'pure layer must not touch AsyncStorage');
    });
    test(`${label}: transpiled source contains no console. logging`, () => {
      assert.ok(!record.outputText.includes('console.'), 'pure layer must never log secrets');
    });
    test(`${label}: transpiled source contains no fs require`, () => {
      assert.ok(!FS_REQUIRE_PATTERN.test(record.outputText), 'pure layer must never touch the filesystem');
      assert.ok(!record.outputText.includes('node:fs'), 'pure layer must never touch the filesystem');
    });
  }

  test('account-security-logic.ts has ZERO runtime imports (fully standalone RN-free module)', () => {
    assert.equal(extractRequireSpecifiers(logic.outputText).length, 0);
  });
  test('account-security-errors.ts runtime imports are exactly api-client + the pure logic module', () => {
    const specifiers = extractRequireSpecifiers(errorsModule.outputText);
    assert.deepEqual(
      [...specifiers].sort(),
      ['./account-security-logic', '@irexpro/api-client'],
      'the RN-free error module may only import the shared client error class and the pure logic module',
    );
  });
});

function extractRequireSpecifiers(outputText) {
  const specifiers = [];
  const pattern = /require\(\s*["']([^"']+)["']\s*\)/g;
  let match;
  while ((match = pattern.exec(outputText)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

// ─── Runner ────────────────────────────────────────────────────────────────

async function main() {
  console.log('account-security pure-logic harness (zero-dependency, node:assert)');
  console.log(
    `typescript ${ts.version} | modules: account-security-logic.ts, account-security-errors.ts, api-client (ApiClientError)`,
  );
  console.log('');

  let totalPassed = 0;
  let totalFailed = 0;
  const failures = [];

  for (const suite of suites) {
    let passed = 0;
    for (const entry of suite.tests) {
      try {
        await entry.fn();
        passed += 1;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        failures.push(`[${suite.name}] ${entry.name} — ${message.split('\n')[0]}`);
      }
    }
    const failed = suite.tests.length - passed;
    totalPassed += passed;
    totalFailed += failed;
    console.log(`${failed === 0 ? 'PASS' : 'FAIL'}  ${suite.name}: ${passed}/${suite.tests.length} tests`);
  }

  console.log('');
  if (failures.length > 0) {
    console.log('Failures:');
    for (const failure of failures) {
      console.log(`  ${failure}`);
    }
    console.log('');
  }

  console.log(
    `TOTAL: ${totalPassed + totalFailed} tests — ${totalPassed} passed, ${totalFailed} failed ` +
      `(${suites.length} suites)`,
  );
  if (totalFailed > 0) {
    console.log('RESULT: FAIL');
    process.exitCode = 1;
  } else {
    console.log('RESULT: PASS');
  }
}

main().catch((error) => {
  console.error(`account-security harness failed to run: ${error.message}`);
  process.exit(1);
});
