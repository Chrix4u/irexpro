import {
  assessProviderVerification,
  type ProviderVerificationLabel,
} from './provider-verification';
import { describeExecutionConfirmationFailure } from './execution';

/**
 * Provider verification label taxonomy tests (Sprint 56 correction round 5).
 *
 * The renderer vocabulary is EXACTLY the six architect labels — no test may
 * assert a label outside the taxonomy, and every unknown/absent fact must
 * degrade fail-closed (never toward a "Live"-sounding claim).
 */

const ALL_LABELS: readonly ProviderVerificationLabel[] = [
  'LIVE-capable',
  'Production LIVE Verified',
  'Production LIVE Unverified',
  'Ineligible',
  'DEMO only',
  'execution disabled',
];

describe('assessProviderVerification label taxonomy', () => {
  it('an UNVERIFIED BETA LIVE-capable provider is never labeled Live — it is Production LIVE Unverified', () => {
    const assessment = assessProviderVerification({
      environments: ['DEMO', 'LIVE'],
      implementationStatus: 'BETA',
      adapterAvailable: true,
      productionLiveVerification: { status: 'UNVERIFIED', verifiedAt: null, evidenceRef: null },
      accountType: 'LIVE',
    });

    expect(assessment.label).toBe('Production LIVE Unverified');
    expect(ALL_LABELS).toContain(assessment.label);
    expect(assessment.environmentCapability).toBe('LIVE-capable');
    expect(assessment.implementationAvailability).toBe('LIVE-capable');
    expect(assessment.adapterAvailability).toBe('LIVE-capable');
    expect(assessment.verificationStatus).toBe('Production LIVE Unverified');
    // LIVE identity + unverified provider → identity is NOT production-LIVE eligible.
    expect(assessment.identityProductionLiveEligibility).toBe('Ineligible');
  });

  it('a CURRENTLY CERTIFIED provider with a LIVE identity is Production LIVE Verified and identity-eligible', () => {
    const assessment = assessProviderVerification({
      environments: ['DEMO', 'LIVE'],
      implementationStatus: 'SUPPORTED',
      adapterAvailable: true,
      productionLiveVerification: {
        status: 'VERIFIED',
        verifiedAt: '2026-09-01T00:00:00.000Z',
        evidenceRef: 'OPS-123',
        certifiedVia: 'HARNESS_CERTIFIED',
        certificationRunRef:
          'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d@sha256:' +
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      accountType: 'LIVE',
      logicalAccountKey: 'ctrader:1234567',
      authorizationStatus: 'ACTIVE',
      executable: true,
    });

    expect(assessment.label).toBe('Production LIVE Verified');
    expect(assessment.verificationStatus).toBe('Production LIVE Verified');
    expect(assessment.identityProductionLiveEligibility).toBe('LIVE-capable');
    expect(assessment.connectionExecutability).toBe('LIVE-capable');
    expect(assessment.hasConnectionIdentity).toBe(true);
    expect(assessment.certificationState).toBe('CERTIFIED');
  });

  it('LEGACY attestation evidence is NEVER presented as a current certification (Phase 2 truth fix)', () => {
    // metatrader5's catalog shape: raw status VERIFIED with provenance
    // LEGACY_ATTESTATION and no harness run — real history, but the runtime
    // LIVE gate rejects it, so the label must not claim verified/LIVE-capable.
    const legacy = assessProviderVerification({
      environments: ['DEMO', 'LIVE'],
      implementationStatus: 'SUPPORTED',
      adapterAvailable: true,
      productionLiveVerification: {
        status: 'VERIFIED',
        verifiedAt: null,
        evidenceRef: 'production operation — MetaApi bridge, live in production',
        certifiedVia: 'LEGACY_ATTESTATION',
        certificationRunRef: null,
      },
      accountType: 'LIVE',
      authorizationStatus: 'ACTIVE',
      executable: true,
    });

    expect(legacy.certificationState).toBe('LEGACY_VERIFIED');
    expect(legacy.label).toBe('Production LIVE Unverified');
    expect(legacy.verificationStatus).toBe('Production LIVE Unverified');
    expect(legacy.identityProductionLiveEligibility).toBe('Ineligible');
    // Executability is a separate fact: an ACTIVE LIVE connection still
    // reports its granted authority — the label never claims certification.
    expect(legacy.connectionExecutability).toBe('LIVE-capable');
  });

  it('raw VERIFIED evidence without provenance derives LEGACY_VERIFIED (never CERTIFIED) — fail-closed derivation', () => {
    const assessment = assessProviderVerification({
      environments: ['DEMO', 'LIVE'],
      implementationStatus: 'SUPPORTED',
      adapterAvailable: true,
      // Older payload shape: no certifiedVia / certificationRunRef fields.
      productionLiveVerification: {
        status: 'VERIFIED',
        verifiedAt: '2026-09-01T00:00:00.000Z',
        evidenceRef: 'OPS-123',
      },
      accountType: 'LIVE',
    });

    expect(assessment.certificationState).toBe('LEGACY_VERIFIED');
    expect(assessment.label).toBe('Production LIVE Unverified');
    expect(assessment.identityProductionLiveEligibility).toBe('Ineligible');
  });

  it('an explicit server-provided certificationState is authoritative (CERTIFIED)', () => {
    const assessment = assessProviderVerification({
      environments: ['DEMO', 'LIVE'],
      implementationStatus: 'SUPPORTED',
      adapterAvailable: true,
      certificationState: 'CERTIFIED',
      accountType: 'LIVE',
    });

    expect(assessment.certificationState).toBe('CERTIFIED');
    expect(assessment.label).toBe('Production LIVE Verified');
    expect(assessment.identityProductionLiveEligibility).toBe('LIVE-capable');
  });

  it('an explicit server-provided certificationState is authoritative (NOT_CERTIFIED overrides raw VERIFIED)', () => {
    const assessment = assessProviderVerification({
      environments: ['DEMO', 'LIVE'],
      implementationStatus: 'SUPPORTED',
      adapterAvailable: true,
      productionLiveVerification: { status: 'VERIFIED', verifiedAt: null, evidenceRef: 'x' },
      certificationState: 'NOT_CERTIFIED',
      accountType: 'LIVE',
    });

    expect(assessment.certificationState).toBe('NOT_CERTIFIED');
    expect(assessment.label).toBe('Production LIVE Unverified');
  });

  it('a DEMO-typed connection identity is DEMO only regardless of provider capability', () => {
    const assessment = assessProviderVerification({
      environments: ['DEMO', 'LIVE'],
      implementationStatus: 'SUPPORTED',
      adapterAvailable: true,
      productionLiveVerification: {
        status: 'VERIFIED',
        verifiedAt: '2026-09-01T00:00:00.000Z',
        evidenceRef: 'OPS-123',
      },
      accountType: 'DEMO',
      executable: true,
      authorizationStatus: 'ACTIVE',
    });

    expect(assessment.label).toBe('DEMO only');
    expect(assessment.environmentCapability).toBe('LIVE-capable');
    expect(assessment.identityProductionLiveEligibility).toBe('DEMO only');
    // Executable demo connection executes — demo only.
    expect(assessment.connectionExecutability).toBe('DEMO only');
  });

  it('a provider without any LIVE environment is DEMO only and verification is Ineligible', () => {
    const assessment = assessProviderVerification({
      environments: ['DEMO'],
      implementationStatus: 'SUPPORTED',
      adapterAvailable: true,
      productionLiveVerification: { status: 'UNVERIFIED', verifiedAt: null, evidenceRef: null },
    });

    expect(assessment.label).toBe('DEMO only');
    expect(assessment.environmentCapability).toBe('DEMO only');
    expect(assessment.verificationStatus).toBe('Ineligible');
    expect(assessment.hasConnectionIdentity).toBe(false);
    expect(assessment.identityProductionLiveEligibility).toBe('Ineligible');
  });

  it('an unimplemented or adapter-less provider is Ineligible', () => {
    const notImplemented = assessProviderVerification({
      environments: ['DEMO', 'LIVE'],
      implementationStatus: 'NOT_STARTED',
      adapterAvailable: false,
    });
    expect(notImplemented.label).toBe('Ineligible');
    expect(notImplemented.implementationAvailability).toBe('Ineligible');
    expect(notImplemented.adapterAvailability).toBe('Ineligible');

    const noAdapter = assessProviderVerification({
      environments: ['DEMO', 'LIVE'],
      implementationStatus: 'BETA',
      adapterAvailable: false,
    });
    expect(noAdapter.label).toBe('Ineligible');
    expect(noAdapter.adapterAvailability).toBe('Ineligible');
  });

  it('degrades fail-closed when the registry is unavailable (absent facts are never guessed)', () => {
    // Only connection facts are known: a LIVE account with no verification evidence.
    const degraded = assessProviderVerification({
      accountType: 'LIVE',
      authorizationStatus: 'AUTHORIZED',
      executable: false,
    });

    // Cannot prove verification → unverified (fail-closed), never "Live".
    expect(degraded.label).toBe('Production LIVE Unverified');
    expect(degraded.environmentCapability).toBe('LIVE-capable');
    // Absent implementation/adapter facts are not assumed available.
    expect(degraded.implementationAvailability).toBe('Ineligible');
    expect(degraded.adapterAvailability).toBe('Ineligible');
    expect(degraded.verificationStatus).toBe('Production LIVE Unverified');
    expect(degraded.identityProductionLiveEligibility).toBe('Ineligible');
    // Not executable / not ACTIVE authorization → execution disabled.
    expect(degraded.connectionExecutability).toBe('execution disabled');
  });

  it('a connection that cannot execute reports execution disabled even when certified', () => {
    const assessment = assessProviderVerification({
      environments: ['DEMO', 'LIVE'],
      implementationStatus: 'SUPPORTED',
      adapterAvailable: true,
      certificationState: 'CERTIFIED',
      accountType: 'LIVE',
      executable: false,
      authorizationStatus: 'SUSPENDED',
    });

    expect(assessment.label).toBe('Production LIVE Verified');
    expect(assessment.connectionExecutability).toBe('execution disabled');
  });
});

describe('describeExecutionConfirmationFailure', () => {
  it('classifies the server 409-style reasons without inventing approval state', () => {
    expect(
      describeExecutionConfirmationFailure({
        statusCode: 409,
        message: 'Confirmation expired',
      }).kind,
    ).toBe('expired');

    expect(
      describeExecutionConfirmationFailure({
        statusCode: 409,
        message: 'Confirmation was already consumed',
      }).kind,
    ).toBe('consumed');

    expect(
      describeExecutionConfirmationFailure({
        statusCode: 409,
        message: 'Confirmation revoked',
      }).kind,
    ).toBe('revoked');

    expect(
      describeExecutionConfirmationFailure({
        statusCode: 409,
        code: 'AUTHORITY_GENERATION_MISMATCH',
        message: 'Session authority generation mismatch',
      }).kind,
    ).toBe('mismatched-generation');
  });

  it('preserves the server message and fails closed to unknown for unrecognized shapes', () => {
    const failure = describeExecutionConfirmationFailure({
      statusCode: 500,
      message: 'Internal error',
    });
    expect(failure.kind).toBe('unknown');
    expect(failure.message).toBe('Internal error');

    const noMessage = describeExecutionConfirmationFailure({ statusCode: 409 });
    expect(noMessage.kind).toBe('unknown');
    expect(noMessage.message.length).toBeGreaterThan(0);
  });
});
