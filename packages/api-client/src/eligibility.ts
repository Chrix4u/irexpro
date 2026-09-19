import type {
  AcceptEligibilityDisclosuresRequest,
  EligibilityConsentEvidenceView,
  EligibilityDisclosureKey,
  EligibilityDisclosureView,
  EligibilityReviewQueueItem,
  EligibilityStatusView,
  KycReviewQueueItem,
  ReviewUserEligibilityRequest,
  ReviewUserKycRequest,
} from '@irexpro/types/eligibility';
import type { ApiClient } from './index';

const DISCLOSURE_KEYS = new Set<EligibilityDisclosureKey>([
  'AUTOMATED_TRADING_RISK',
  'NO_PROFIT_GUARANTEE',
  'BROKER_EXECUTION_AUTHORITY',
  'LEGAL_ELIGIBILITY_ATTESTATION',
]);
const JURISDICTION_STATUSES = new Set([
  'MISSING_PROFILE',
  'REVIEW_REQUIRED',
  'ELIGIBLE',
  'INELIGIBLE',
]);
const DECISION_SOURCES = new Set(['POLICY', 'ADMIN_REVIEW']);
const AGE_STATUSES = new Set(['MISSING_DOB', 'INVALID_DOB', 'UNDER_18', 'ADULT']);
const KYC_STATUSES = new Set(['NONE', 'PENDING', 'APPROVED', 'REJECTED']);
const SHA256 = /^[a-f0-9]{64}$/;
const COUNTRY = /^[A-Z]{2}$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

function isIso(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isDisclosureKey(value: unknown): value is EligibilityDisclosureKey {
  return typeof value === 'string' && DISCLOSURE_KEYS.has(value as EligibilityDisclosureKey);
}

function isDisclosure(value: unknown): value is EligibilityDisclosureView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['key', 'version', 'title', 'body', 'contentSha256', 'required'])
  ) {
    return false;
  }
  return (
    isDisclosureKey(value.key) &&
    typeof value.version === 'string' &&
    value.version.length > 0 &&
    typeof value.title === 'string' &&
    value.title.length > 0 &&
    typeof value.body === 'string' &&
    value.body.length > 0 &&
    typeof value.contentSha256 === 'string' &&
    SHA256.test(value.contentSha256) &&
    value.required === true
  );
}

function isConsent(value: unknown): value is EligibilityConsentEvidenceView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'policyVersion',
      'policyFingerprint',
      'key',
      'version',
      'contentSha256',
      'acceptedAt',
    ])
  ) {
    return false;
  }
  return (
    typeof value.policyVersion === 'string' &&
    value.policyVersion.length > 0 &&
    typeof value.policyFingerprint === 'string' &&
    SHA256.test(value.policyFingerprint) &&
    isDisclosureKey(value.key) &&
    typeof value.version === 'string' &&
    value.version.length > 0 &&
    typeof value.contentSha256 === 'string' &&
    SHA256.test(value.contentSha256) &&
    isIso(value.acceptedAt)
  );
}

export function isEligibilityStatusView(value: unknown): value is EligibilityStatusView {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'policyVersion',
      'policyFingerprint',
      'countryCode',
      'jurisdictionStatus',
      'decisionSource',
      'reasonCode',
      'reviewedAt',
      'ageStatus',
      'kycStatus',
      'identityReasonCode',
      'disclosures',
      'consents',
      'missingConsentKeys',
      'canProceed',
    ])
  ) {
    return false;
  }

  const countryValid =
    value.countryCode === null ||
    (typeof value.countryCode === 'string' && COUNTRY.test(value.countryCode));
  const reviewedAtValid = value.reviewedAt === null || isIso(value.reviewedAt);

  if (
    typeof value.policyVersion !== 'string' ||
    value.policyVersion.length === 0 ||
    typeof value.policyFingerprint !== 'string' ||
    !SHA256.test(value.policyFingerprint) ||
    !countryValid ||
    typeof value.jurisdictionStatus !== 'string' ||
    !JURISDICTION_STATUSES.has(value.jurisdictionStatus) ||
    typeof value.decisionSource !== 'string' ||
    !DECISION_SOURCES.has(value.decisionSource) ||
    typeof value.reasonCode !== 'string' ||
    value.reasonCode.length === 0 ||
    !reviewedAtValid ||
    typeof value.ageStatus !== 'string' ||
    !AGE_STATUSES.has(value.ageStatus) ||
    typeof value.kycStatus !== 'string' ||
    !KYC_STATUSES.has(value.kycStatus) ||
    typeof value.identityReasonCode !== 'string' ||
    value.identityReasonCode.length === 0 ||
    typeof value.canProceed !== 'boolean'
  ) {
    return false;
  }

  if (
    !Array.isArray(value.disclosures) ||
    value.disclosures.length !== DISCLOSURE_KEYS.size ||
    !value.disclosures.every(isDisclosure) ||
    new Set(value.disclosures.map((item) => item.key)).size !== DISCLOSURE_KEYS.size
  ) {
    return false;
  }
  const disclosures = value.disclosures as EligibilityDisclosureView[];
  const disclosureByKey = new Map(disclosures.map((item) => [item.key, item]));

  if (!Array.isArray(value.consents) || !value.consents.every(isConsent)) return false;
  const consents = value.consents as EligibilityConsentEvidenceView[];
  const consentKeys = new Set<EligibilityDisclosureKey>();
  for (const consent of consents) {
    if (consent.policyVersion !== value.policyVersion) return false;
    if (consent.policyFingerprint !== value.policyFingerprint) return false;
    if (consentKeys.has(consent.key)) return false;

    const disclosure = disclosureByKey.get(consent.key);
    if (
      !disclosure ||
      consent.version !== disclosure.version ||
      consent.contentSha256 !== disclosure.contentSha256
    ) {
      return false;
    }
    consentKeys.add(consent.key);
  }

  if (
    !Array.isArray(value.missingConsentKeys) ||
    !value.missingConsentKeys.every(isDisclosureKey) ||
    new Set(value.missingConsentKeys).size !== value.missingConsentKeys.length
  ) {
    return false;
  }
  const missingConsentKeys = value.missingConsentKeys as EligibilityDisclosureKey[];
  const expectedMissing = disclosures
    .filter((item) => !consentKeys.has(item.key))
    .map((item) => item.key)
    .sort();
  const reportedMissing = [...missingConsentKeys].sort();
  if (
    expectedMissing.length !== reportedMissing.length ||
    expectedMissing.some((key, index) => key !== reportedMissing[index])
  ) {
    return false;
  }

  return (
    value.canProceed ===
    (value.jurisdictionStatus === 'ELIGIBLE' &&
      value.ageStatus === 'ADULT' &&
      value.kycStatus === 'APPROVED' &&
      expectedMissing.length === 0)
  );
}

export function isEligibilityReviewQueueItem(value: unknown): value is EligibilityReviewQueueItem {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'userId',
      'email',
      'countryCode',
      'policyVersion',
      'policyFingerprint',
      'jurisdictionStatus',
      'reasonCode',
    ]) &&
    typeof value.userId === 'string' &&
    value.userId.length > 0 &&
    (value.email === null || typeof value.email === 'string') &&
    typeof value.countryCode === 'string' &&
    COUNTRY.test(value.countryCode) &&
    typeof value.policyVersion === 'string' &&
    value.policyVersion.length > 0 &&
    typeof value.policyFingerprint === 'string' &&
    SHA256.test(value.policyFingerprint) &&
    value.jurisdictionStatus === 'REVIEW_REQUIRED' &&
    typeof value.reasonCode === 'string' &&
    value.reasonCode.length > 0
  );
}

export function isKycReviewQueueItem(value: unknown): value is KycReviewQueueItem {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'userId',
      'email',
      'countryCode',
      'dateOfBirth',
      'ageStatus',
      'kycStatus',
      'reasonCode',
    ]) &&
    typeof value.userId === 'string' &&
    value.userId.length > 0 &&
    (value.email === null || typeof value.email === 'string') &&
    (value.countryCode === null ||
      (typeof value.countryCode === 'string' && COUNTRY.test(value.countryCode))) &&
    typeof value.dateOfBirth === 'string' &&
    DATE_ONLY.test(value.dateOfBirth) &&
    value.ageStatus === 'ADULT' &&
    (value.kycStatus === 'NONE' || value.kycStatus === 'PENDING') &&
    (value.reasonCode === 'KYC_REQUIRED' || value.reasonCode === 'KYC_PENDING')
  );
}

function assertStatus(value: unknown): EligibilityStatusView {
  if (!isEligibilityStatusView(value)) {
    throw new Error('Eligibility response failed frontend-safe contract verification.');
  }
  return value;
}

function assertQueue(value: unknown): EligibilityReviewQueueItem[] {
  if (!Array.isArray(value) || !value.every(isEligibilityReviewQueueItem)) {
    throw new Error('Eligibility review queue failed frontend-safe contract verification.');
  }
  return value;
}

function assertKycQueue(value: unknown): KycReviewQueueItem[] {
  if (!Array.isArray(value) || !value.every(isKycReviewQueueItem)) {
    throw new Error('KYC review queue failed frontend-safe contract verification.');
  }
  return value;
}

export interface EligibilityApi {
  getMyStatus(): Promise<EligibilityStatusView>;
  submitKyc(): Promise<EligibilityStatusView>;
  acceptDisclosures(body: AcceptEligibilityDisclosuresRequest): Promise<EligibilityStatusView>;
  listReviewQueue(): Promise<EligibilityReviewQueueItem[]>;
  reviewUser(userId: string, body: ReviewUserEligibilityRequest): Promise<EligibilityStatusView>;
  listKycReviewQueue(): Promise<KycReviewQueueItem[]>;
  reviewKyc(userId: string, body: ReviewUserKycRequest): Promise<EligibilityStatusView>;
}

/**
 * Eligibility/readiness client. All responses are exact-key verified before
 * they reach a browser. It exposes evidence/readiness methods only and no
 * broker, risk-override, order, strategy, or execution method.
 */
export function createEligibilityApi(client: Pick<ApiClient, 'request'>): EligibilityApi {
  return {
    getMyStatus: async () => assertStatus(await client.request<unknown>('/users/me/eligibility')),
    submitKyc: async () =>
      assertStatus(
        await client.request<unknown>('/users/me/eligibility/kyc-submission', {
          method: 'POST',
        }),
      ),
    acceptDisclosures: async (body) =>
      assertStatus(
        await client.request<unknown>('/users/me/eligibility/disclosures', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      ),
    listReviewQueue: async () =>
      assertQueue(await client.request<unknown>('/admin/eligibility/reviews')),
    reviewUser: async (userId, body) =>
      assertStatus(
        await client.request<unknown>(
          `/admin/eligibility/users/${encodeURIComponent(userId)}/review`,
          { method: 'POST', body: JSON.stringify(body) },
        ),
      ),
    listKycReviewQueue: async () =>
      assertKycQueue(await client.request<unknown>('/admin/identity/kyc/reviews')),
    reviewKyc: async (userId, body) =>
      assertStatus(
        await client.request<unknown>(
          `/admin/identity/users/${encodeURIComponent(userId)}/kyc-review`,
          { method: 'POST', body: JSON.stringify(body) },
        ),
      ),
  };
}
