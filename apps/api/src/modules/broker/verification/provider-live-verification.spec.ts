/**
 * Identity-scoped production-LIVE verification policy (Sprint 56 correction
 * round 4, architect finding 10) — adversarial unit coverage.
 *
 * THE MANDATED MATRIX (proving one broker's LIVE verification can NEVER
 * authorize another):
 * - Pepperstone identity VERIFIED; IC Markets UNVERIFIED:
 *   • a Pepperstone connection satisfies the verification identity lookup;
 *   • IC Markets cannot inherit Pepperstone's verification;
 *   • a GENERIC cTrader connection carrying the IC Markets identity cannot
 *     inherit Pepperstone's verification;
 *   • an unknown identity (null) cannot inherit ANY verified alias;
 *   • technology-level (generic 'ctrader' catalog) evidence authorizes NO
 *     connection by itself — a future ctrader=VERIFIED flip never
 *     blanket-authorizes the cTrader ecosystem.
 * - every cTrader-family catalog entry remains UNVERIFIED today.
 */
import {
  catalogEntryIdentity,
  catalogEntryToEvidence,
  connectionLiveVerificationStatus,
  LIVE_VERIFICATION_MODEL_VERSION,
  type ProviderLiveVerificationEvidence,
} from './provider-live-verification.policy';

describe('provider-live-verification policy (finding 10)', () => {
  const PEPPERSTONE_VERIFIED: ProviderLiveVerificationEvidence = {
    providerTechnology: 'ctrader',
    providerIdentity: 'pepperstone',
    environment: 'LIVE',
    status: 'VERIFIED',
    verifiedAt: '2026-09-01T00:00:00Z',
    evidenceRef: 'ops/pepperstone-live-verification/2026-09',
  };
  const IC_MARKETS_UNVERIFIED: ProviderLiveVerificationEvidence = {
    providerTechnology: 'ctrader',
    providerIdentity: 'icmarkets',
    environment: 'LIVE',
    status: 'UNVERIFIED',
    verifiedAt: null,
    evidenceRef: null,
  };

  const evidence = [PEPPERSTONE_VERIFIED, IC_MARKETS_UNVERIFIED];

  it('is a versioned model', () => {
    expect(LIVE_VERIFICATION_MODEL_VERSION).toBe(1);
  });

  it('a Pepperstone connection SATISFIES the verification identity lookup', () => {
    expect(
      connectionLiveVerificationStatus({
        brokerId: 'pepperstone-ctrader',
        providerTechnology: 'ctrader',
        connectionProviderIdentity: 'pepperstone',
        environment: 'LIVE',
        evidence,
      }),
    ).toBe('VERIFIED');
  });

  it('IC Markets CANNOT inherit Pepperstone verification (exact identity match only)', () => {
    expect(
      connectionLiveVerificationStatus({
        brokerId: 'icmarkets-ctrader',
        providerTechnology: 'ctrader',
        connectionProviderIdentity: 'icmarkets',
        environment: 'LIVE',
        evidence,
      }),
    ).toBe('UNVERIFIED');
  });

  it('a GENERIC cTrader connection carrying the IC Markets identity CANNOT inherit Pepperstone verification', () => {
    // The generic entry is broker-agnostic — but its connections still need
    // identity-matching evidence. IC Markets is unverified → fail-closed.
    expect(
      connectionLiveVerificationStatus({
        brokerId: 'ctrader',
        providerTechnology: 'ctrader',
        connectionProviderIdentity: 'icmarkets',
        environment: 'LIVE',
        evidence,
      }),
    ).toBe('UNVERIFIED');
  });

  it('a generic cTrader connection carrying a VERIFIED identity CAN satisfy the lookup (identity-scoped, not alias-scoped)', () => {
    expect(
      connectionLiveVerificationStatus({
        brokerId: 'ctrader',
        providerTechnology: 'ctrader',
        connectionProviderIdentity: 'pepperstone',
        environment: 'LIVE',
        evidence,
      }),
    ).toBe('VERIFIED');
  });

  it('an UNKNOWN identity (null) cannot inherit ANY verified alias (fail-closed)', () => {
    expect(
      connectionLiveVerificationStatus({
        brokerId: 'pepperstone-ctrader',
        providerTechnology: 'ctrader',
        connectionProviderIdentity: null,
        environment: 'LIVE',
        evidence,
      }),
    ).toBe('UNVERIFIED');
    expect(
      connectionLiveVerificationStatus({
        brokerId: 'ctrader',
        providerTechnology: 'ctrader',
        connectionProviderIdentity: null,
        environment: 'LIVE',
        evidence,
      }),
    ).toBe('UNVERIFIED');
  });

  it('TECHNOLOGY-LEVEL evidence (identity: null — a future generic ctrader=VERIFIED flip) authorizes NO connection', () => {
    const technologyLevelOnly: ProviderLiveVerificationEvidence[] = [
      {
        providerTechnology: 'ctrader',
        providerIdentity: null, // technology-level — never blanket
        environment: 'LIVE',
        status: 'VERIFIED',
        verifiedAt: '2026-09-01T00:00:00Z',
        evidenceRef: 'ops/ctrader-technology-verification/2026-09',
      },
    ];
    for (const identity of ['pepperstone', 'icmarkets', 'spotware', null]) {
      expect(
        connectionLiveVerificationStatus({
          brokerId: 'ctrader',
          providerTechnology: 'ctrader',
          connectionProviderIdentity: identity,
          environment: 'LIVE',
          evidence: technologyLevelOnly,
        }),
      ).toBe('UNVERIFIED');
    }
  });

  it('environment scoping: DEMO evidence never authorizes LIVE', () => {
    const demoOnly: ProviderLiveVerificationEvidence[] = [
      { ...PEPPERSTONE_VERIFIED, environment: 'DEMO' },
    ];
    expect(
      connectionLiveVerificationStatus({
        brokerId: 'pepperstone-ctrader',
        providerTechnology: 'ctrader',
        connectionProviderIdentity: 'pepperstone',
        environment: 'LIVE',
        evidence: demoOnly,
      }),
    ).toBe('UNVERIFIED');
  });

  it("technology scoping: another technology's evidence never authorizes cTrader", () => {
    const otherTech: ProviderLiveVerificationEvidence[] = [
      { ...PEPPERSTONE_VERIFIED, providerTechnology: 'metatrader' },
    ];
    expect(
      connectionLiveVerificationStatus({
        brokerId: 'pepperstone-ctrader',
        providerTechnology: 'ctrader',
        connectionProviderIdentity: 'pepperstone',
        environment: 'LIVE',
        evidence: otherTech,
      }),
    ).toBe('UNVERIFIED');
  });

  it('an empty evidence set is UNVERIFIED (fail-closed)', () => {
    expect(
      connectionLiveVerificationStatus({
        brokerId: 'pepperstone-ctrader',
        providerTechnology: 'ctrader',
        connectionProviderIdentity: 'pepperstone',
        environment: 'LIVE',
        evidence: [],
      }),
    ).toBe('UNVERIFIED');
  });

  // ─── Catalog evidence derivation ──────────────────────────────────────────

  it('derives identity-scoped evidence for a branded catalog entry', () => {
    const units = catalogEntryToEvidence(
      {
        id: 'pepperstone-ctrader',
        productionLiveVerification: {
          status: 'VERIFIED',
          verifiedAt: '2026-09-01T00:00:00Z',
          evidenceRef: 'ops/pepperstone/2026-09',
        },
      },
      ['LIVE'],
    );
    expect(units).toEqual([
      {
        providerTechnology: 'pepperstone-ctrader',
        providerIdentity: 'pepperstone',
        environment: 'LIVE',
        status: 'VERIFIED',
        verifiedAt: '2026-09-01T00:00:00Z',
        evidenceRef: 'ops/pepperstone/2026-09',
      },
    ]);
  });

  it('derives TECHNOLOGY-LEVEL (identity: null) evidence for the generic ctrader entry', () => {
    const units = catalogEntryToEvidence(
      {
        id: 'ctrader',
        productionLiveVerification: {
          status: 'VERIFIED',
          verifiedAt: '2026-09-01T00:00:00Z',
          evidenceRef: 'ops/ctrader/2026-09',
        },
      },
      ['LIVE'],
    );
    expect(units[0].providerIdentity).toBeNull();
    // ...and that evidence authorizes no connection (proved above).
  });

  it('scopes catalog identity: branded aliases resolve to their family identity; generic/other ids to null', () => {
    expect(catalogEntryIdentity('pepperstone-ctrader')).toBe('pepperstone');
    expect(catalogEntryIdentity('icmarkets-ctrader')).toBe('icmarkets');
    expect(catalogEntryIdentity('ctrader')).toBeNull();
    expect(catalogEntryIdentity('oanda')).toBeNull();
  });
});
