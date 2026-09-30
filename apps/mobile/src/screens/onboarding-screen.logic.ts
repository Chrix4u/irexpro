import type {
  AcceptEligibilityDisclosuresRequest,
  EligibilityDisclosureKey,
  EligibilityStatusView,
} from '@irexpro/types/eligibility';
import type { OnboardingNextStep, UpdateMyProfileRequest } from '@irexpro/types';

export interface ProfileDraft {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  countryCode: string;
  timezone: string;
  preferredCurrency: string;
}

export type ProfileBuildResult =
  | { body: UpdateMyProfileRequest; error?: never }
  | { body?: never; error: string };

export function buildProfileUpdate(draft: ProfileDraft): ProfileBuildResult {
  const dateOfBirth = draft.dateOfBirth.trim();
  const countryCode = draft.countryCode.trim().toUpperCase();
  const timezone = draft.timezone.trim();
  const preferredCurrency = draft.preferredCurrency.trim().toUpperCase();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
    return { error: 'Enter your date of birth in YYYY-MM-DD format.' };
  }
  if (!/^[A-Z]{2}$/.test(countryCode)) {
    return { error: 'Enter a valid two-letter country code, for example GH.' };
  }
  if (!/^[A-Z]{3}$/.test(preferredCurrency)) {
    return { error: 'Enter a valid three-letter currency code, for example USD.' };
  }
  if (!timezone) {
    return { error: 'Timezone is required.' };
  }

  return {
    body: {
      firstName: draft.firstName.trim() || undefined,
      lastName: draft.lastName.trim() || undefined,
      dateOfBirth,
      countryCode,
      timezone,
      preferredCurrency,
    },
  };
}

export type MobileOnboardingDestination =
  | 'profile-onboarding'
  | 'eligibility-onboarding'
  | 'brokers'
  | null;

export function destinationForOnboardingStep(
  step: OnboardingNextStep,
): MobileOnboardingDestination {
  switch (step) {
    case 'PROFILE':
      return 'profile-onboarding';
    case 'ELIGIBILITY':
      return 'eligibility-onboarding';
    case 'BROKER_CONNECTION':
      return 'brokers';
    case 'READY':
    default:
      return null;
  }
}

export type DisclosureBuildResult =
  | { body: AcceptEligibilityDisclosuresRequest | null; error?: never }
  | { body?: never; error: string };

export function buildDisclosureAcceptance(
  status: EligibilityStatusView,
  selected: ReadonlySet<EligibilityDisclosureKey>,
): DisclosureBuildResult {
  if (status.ageStatus !== 'ADULT') {
    return {
      error:
        'The adult-age requirement must be satisfied before disclosure evidence can be recorded.',
    };
  }

  const accepted = new Set(status.consents.map((item) => item.key));
  const missing = status.disclosures.filter((item) => !accepted.has(item.key));

  if (missing.some((item) => !selected.has(item.key))) {
    return {
      error: 'Review and accept every outstanding required disclosure before continuing.',
    };
  }

  if (missing.length === 0) {
    return { body: null };
  }

  return {
    body: {
      policyVersion: status.policyVersion,
      policyFingerprint: status.policyFingerprint,
      acceptances: missing.map((item) => ({
        key: item.key,
        version: item.version,
        contentSha256: item.contentSha256,
      })),
    },
  };
}

export function disclosuresAreSelectable(status: EligibilityStatusView): boolean {
  return status.ageStatus === 'ADULT' && status.jurisdictionStatus !== 'INELIGIBLE';
}
