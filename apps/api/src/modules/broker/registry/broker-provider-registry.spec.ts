import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BrokerProviderRegistryService } from './broker-provider-registry.service';
import { BrokerAdapterRegistry } from '../adapters/broker-adapter.registry';
import { BrokerConnection } from '../entities/broker-connection.entity';
import { BrokerAccount } from '../entities/broker-account.entity';
import { BrokerCapability } from './broker-capability.enum';
import {
  BrokerAvailabilityStatus,
  BrokerConnectionRoute,
  deriveProviderCertificationState,
} from './broker-definition';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Sprint 50 — BrokerProviderRegistryService tests.
 *
 * Directive §AB: a broker must NEVER appear as fully SUPPORTED when its
 * adapter does not exist. Directive §AU: this catalog is the single
 * server-authoritative source rendered by web/admin/mobile.
 */

const adapterWith = (brokerId: string, supported: string[]) => ({
  isSupported: jest.fn((id: string) => supported.includes(id)),
  getAdapter: jest.fn(),
  getSupportedBrokers: jest.fn().mockReturnValue([]),
  getSupportedBrokerIds: jest.fn().mockReturnValue(supported),
});

describe('BrokerProviderRegistryService', () => {
  const buildService = async (supportedAdapters: string[]) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BrokerProviderRegistryService,
        {
          provide: BrokerAdapterRegistry,
          useValue: adapterWith('any', supportedAdapters),
        },
        { provide: getRepositoryToken(BrokerConnection), useValue: {} },
        { provide: getRepositoryToken(BrokerAccount), useValue: {} },
      ],
    }).compile();
    return module.get(BrokerProviderRegistryService);
  };

  describe('status honesty (Directive §AB)', () => {
    it('reports SUPPORTED only when the adapter is actually registered', async () => {
      const service = await buildService(['metatrader5', 'paper-broker']);
      const catalog = service.getCatalog();

      const mt5 = catalog.find((e) => e.id === 'metatrader5');
      expect(mt5?.status).toBe(BrokerAvailabilityStatus.SUPPORTED);
      expect(mt5?.adapterAvailable).toBe(true);
    });

    it('DOWNGRADES a SUPPORTED catalog entry to NOT_STARTED when no adapter is registered', async () => {
      const service = await buildService([]);
      const catalog = service.getCatalog();

      const mt5 = catalog.find((e) => e.id === 'metatrader5');
      expect(mt5?.status).toBe(BrokerAvailabilityStatus.NOT_STARTED);
      expect(mt5?.adapterAvailable).toBe(false);
    });

    it('DOWNGRADES a BETA catalog entry to NOT_STARTED when no adapter is registered (Sprint 51 PR-7)', async () => {
      const service = await buildService(['metatrader5', 'paper-broker']);
      const oanda = service.getCatalog().find((e) => e.id === 'oanda');
      expect(oanda?.status).toBe(BrokerAvailabilityStatus.NOT_STARTED);
      expect(oanda?.adapterAvailable).toBe(false);
      expect(service.isConnectable('oanda')).toBe(false);
    });

    it('reports OANDA as BETA and connectable when its adapter IS registered (Sprint 51 PR-7)', async () => {
      const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
      const oanda = service.getCatalog().find((e) => e.id === 'oanda');
      expect(oanda?.status).toBe(BrokerAvailabilityStatus.BETA);
      expect(oanda?.adapterAvailable).toBe(true);
      expect(service.isConnectable('oanda')).toBe(true);
      expect(oanda?.status).not.toBe(BrokerAvailabilityStatus.SUPPORTED);
    });

    it('DOWNGRADES the BETA cTrader catalog entry to NOT_STARTED when no adapter is registered (Task 48-B)', async () => {
      const service = await buildService(['metatrader5', 'paper-broker']);
      const ctrader = service.getCatalog().find((e) => e.id === 'ctrader');
      expect(ctrader?.status).toBe(BrokerAvailabilityStatus.NOT_STARTED);
      expect(ctrader?.adapterAvailable).toBe(false);
      const pepperstone = service.getCatalog().find((e) => e.id === 'pepperstone-ctrader');
      expect(pepperstone?.status).toBe(BrokerAvailabilityStatus.NOT_STARTED);
      expect(pepperstone?.adapterAvailable).toBe(false);
      expect(service.isConnectable('pepperstone-ctrader')).toBe(false);
    });

    it('reports cTrader (and its broker aliases) as BETA + connectable when the shared engine is registered (Task 48-B)', async () => {
      const service = await buildService([
        'metatrader5',
        'paper-broker',
        'ctrader',
        'pepperstone-ctrader',
        'icmarkets-ctrader',
      ]);
      for (const id of ['ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader']) {
        const entry = service.getCatalog().find((e) => e.id === id);
        expect(entry?.status).toBe(BrokerAvailabilityStatus.BETA);
        expect(entry?.adapterAvailable).toBe(true);
        expect(service.isConnectable(id)).toBe(true);
        expect(entry?.productionLiveVerification.status).toBe('UNVERIFIED');
        expect(service.isProductionLiveEligible(id)).toBe(false);
      }
    });
  });

  describe('production-LIVE verification (architect Phase H)', () => {
    it('OANDA: BETA + adapter available + productionLiveVerification UNVERIFIED — DEMO connectable, LIVE ineligible', async () => {
      const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
      const oanda = service.getCatalog().find((e) => e.id === 'oanda');

      expect(oanda?.status).toBe(BrokerAvailabilityStatus.BETA);
      expect(oanda?.adapterAvailable).toBe(true);
      expect(oanda?.productionLiveVerification.status).toBe('UNVERIFIED');
      expect(oanda?.productionLiveVerification.verifiedAt).toBeNull();
      expect(oanda?.productionLiveVerification.evidenceRef).toBeNull();
      expect(service.isConnectable('oanda')).toBe(true);
      expect(service.isProductionLiveEligible('oanda')).toBe(false);
    });

    it('metatrader5: legacy VERIFIED evidence is informational only and does not authorize production LIVE', async () => {
      const service = await buildService(['metatrader5', 'paper-broker']);
      const mt5 = service.getCatalog().find((e) => e.id === 'metatrader5');

      expect(mt5?.status).toBe(BrokerAvailabilityStatus.SUPPORTED);
      expect(mt5?.productionLiveVerification.status).toBe('VERIFIED');
      expect(mt5?.productionLiveVerification.verifiedAt).toBeNull();
      expect(mt5?.productionLiveVerification.evidenceRef).toContain('production');
      expect(mt5?.certificationState).toBe('LEGACY_VERIFIED');
      expect(service.isProductionLiveEligible('metatrader5')).toBe(false);
    });

    it('metatrader5 is NOT LIVE-eligible when its adapter is not registered (fail closed)', async () => {
      const service = await buildService(['paper-broker']);
      const mt5 = service.getCatalog().find((e) => e.id === 'metatrader5');
      expect(mt5?.status).toBe(BrokerAvailabilityStatus.NOT_STARTED);
      expect(service.isProductionLiveEligible('metatrader5')).toBe(false);
    });

    it('entries without catalog evidence materialize UNVERIFIED and are ineligible (paper-broker, ctrader)', async () => {
      const service = await buildService(['metatrader5', 'paper-broker']);

      const paper = service.getCatalog().find((e) => e.id === 'paper-broker');
      expect(paper?.productionLiveVerification).toEqual({
        status: 'UNVERIFIED',
        verifiedAt: null,
        evidenceRef: null,
        certifiedVia: null,
        certificationRunRef: null,
        certificationState: 'NOT_CERTIFIED',
      });
      expect(service.isProductionLiveEligible('paper-broker')).toBe(false);

      const ctrader = service.getCatalog().find((e) => e.id === 'ctrader');
      expect(ctrader?.productionLiveVerification.status).toBe('UNVERIFIED');
      expect(service.isProductionLiveEligible('ctrader')).toBe(false);
    });

    it('unknown brokers are never production-LIVE eligible (fail closed)', async () => {
      const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
      expect(service.isProductionLiveEligible('unknown-broker')).toBe(false);
      expect(service.isProductionLiveEligible('')).toBe(false);
    });

    // ── Production-LIVE completion round (Phase 15): liveReadiness truth ──

    describe('liveReadiness — always-materialized, never a bare false (Phase 15)', () => {
      it('metatrader5: LEGACY_VERIFIED → CERTIFICATION_REQUIRED blocker, no partner gate', async () => {
        const service = await buildService(['metatrader5', 'paper-broker']);
        const mt5 = service.getCatalog().find((e) => e.id === 'metatrader5');

        expect(mt5?.liveReadiness).toEqual({
          eligible: false,
          blockedReasons: ['CERTIFICATION_REQUIRED'],
          partnerApprovalRequired: false,
          liveUnavailableRegions: [],
        });
      });

      it('paper-broker: DEMO-only environments → LIVE_UNSUPPORTED', async () => {
        const service = await buildService(['metatrader5', 'paper-broker']);
        const paper = service.getCatalog().find((e) => e.id === 'paper-broker');

        expect(paper?.liveReadiness).toEqual({
          eligible: false,
          blockedReasons: ['LIVE_UNSUPPORTED'],
          partnerApprovalRequired: false,
          liveUnavailableRegions: [],
        });
      });

      it('oanda: certification blocker + GH region unavailability surfaced', async () => {
        const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
        const oanda = service.getCatalog().find((e) => e.id === 'oanda');

        expect(oanda?.liveReadiness).toEqual({
          eligible: false,
          blockedReasons: ['CERTIFICATION_REQUIRED'],
          partnerApprovalRequired: false,
          liveUnavailableRegions: ['GH'],
        });
      });

      it('cTrader family: partner approval is the FIRST blocker, certification still required after it', async () => {
        const service = await buildService(['ctrader']);
        for (const id of ['ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader']) {
          const entry = service.getCatalog().find((e) => e.id === id);
          expect(entry?.liveReadiness).toEqual({
            eligible: false,
            blockedReasons: ['PARTNER_APPROVAL_REQUIRED', 'CERTIFICATION_REQUIRED'],
            partnerApprovalRequired: true,
            liveUnavailableRegions: [],
          });
        }
      });

      it('an entry without a registered adapter carries ADAPTER_UNAVAILABLE before certification', async () => {
        const service = await buildService(['metatrader5']);
        const oanda = service.getCatalog().find((e) => e.id === 'oanda');

        expect(oanda?.liveReadiness.blockedReasons).toEqual([
          'ADAPTER_UNAVAILABLE',
          'CERTIFICATION_REQUIRED',
        ]);
        expect(oanda?.liveReadiness.eligible).toBe(false);
      });

      it('eligible mirrors isProductionLiveEligible for every catalog entry (invariant)', async () => {
        const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
        for (const entry of service.getCatalog()) {
          expect(entry.liveReadiness.eligible).toBe(service.isProductionLiveEligible(entry.id));
        }
      });

      it('every catalog entry materializes the liveReadiness shape', async () => {
        const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
        for (const entry of service.getCatalog()) {
          expect(entry.liveReadiness).toEqual(
            expect.objectContaining({
              eligible: expect.any(Boolean),
              blockedReasons: expect.any(Array),
              partnerApprovalRequired: expect.any(Boolean),
              liveUnavailableRegions: expect.any(Array),
            }),
          );
        }
      });
    });

    describe('isLiveRegionAvailable — provider LIVE region truth (Phase 5)', () => {
      it('OANDA LIVE is unavailable for GH users (documented division restriction)', async () => {
        const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
        expect(service.isLiveRegionAvailable('oanda', 'GH')).toBe(false);
        expect(service.isLiveRegionAvailable('oanda', 'gh')).toBe(false);
      });

      it('OANDA LIVE is available for users outside the restricted regions', async () => {
        const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
        expect(service.isLiveRegionAvailable('oanda', 'US')).toBe(true);
        expect(service.isLiveRegionAvailable('oanda', 'GB')).toBe(true);
      });

      it('providers without a known restriction are available everywhere (metatrader5)', async () => {
        const service = await buildService(['metatrader5', 'paper-broker']);
        expect(service.isLiveRegionAvailable('metatrader5', 'GH')).toBe(true);
        expect(service.isLiveRegionAvailable('metatrader5', 'US')).toBe(true);
      });

      it('a null/empty country cannot be evaluated here (profile gates precede LIVE)', async () => {
        const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
        expect(service.isLiveRegionAvailable('oanda', null)).toBe(true);
        expect(service.isLiveRegionAvailable('oanda', '  ')).toBe(true);
      });

      it('unknown brokers fail closed', async () => {
        const service = await buildService(['metatrader5', 'paper-broker']);
        expect(service.isLiveRegionAvailable('unknown-broker', 'US')).toBe(false);
      });
    });

    it('every catalog entry serializes the materialized productionLiveVerification shape', async () => {
      const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
      const catalog = service.getCatalog();

      expect(catalog.length).toBeGreaterThan(0);
      for (const entry of catalog) {
        expect(entry.productionLiveVerification).toBeDefined();
        expect(Object.keys(entry.productionLiveVerification).sort()).toEqual([
          'certificationRunRef',
          'certificationState',
          'certifiedVia',
          'evidenceRef',
          'status',
          'verifiedAt',
        ]);
        expect(['UNVERIFIED', 'VERIFIED']).toContain(entry.productionLiveVerification.status);
        if (entry.productionLiveVerification.status === 'VERIFIED') {
          expect(typeof entry.productionLiveVerification.evidenceRef).toBe('string');
          expect(entry.productionLiveVerification.evidenceRef!.length).toBeGreaterThan(0);
        } else {
          expect(entry.productionLiveVerification.verifiedAt).toBeNull();
          expect(entry.productionLiveVerification.evidenceRef).toBeNull();
        }
      }
    });

    it('metatrader5 is the ONLY legacy VERIFIED entry — no test or catalog fixture fabricates OANDA LIVE evidence', async () => {
      const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
      const verified = service
        .getCatalog()
        .filter((e) => e.productionLiveVerification.status === 'VERIFIED')
        .map((e) => e.id);

      expect(verified).toEqual(['metatrader5']);
      expect(service.isProductionLiveEligible('metatrader5')).toBe(false);
      expect(service.isProductionLiveEligible('oanda')).toBe(false);
    });

    describe('Round 7.1 (P0-3): truthful certification-state model', () => {
      it('metatrader5 records its verification as LEGACY_ATTESTATION — legacy attestation, never a protocol certification', async () => {
        const service = await buildService(['metatrader5', 'paper-broker']);
        const mt5 = service.getEntry('metatrader5')!;

        expect(mt5.productionLiveVerification.certifiedVia).toBe('LEGACY_ATTESTATION');
        expect(mt5.productionLiveVerification.certificationRunRef).toBeNull();
        expect(mt5.productionLiveVerification.certificationState).toBe('LEGACY_VERIFIED');
        expect(mt5.certificationState).toBe('LEGACY_VERIFIED');
      });

      it('UNVERIFIED entries carry NOT_CERTIFIED with null provenance (never a guessed certification)', async () => {
        const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
        for (const id of [
          'oanda',
          'paper-broker',
          'ctrader',
          'pepperstone-ctrader',
          'icmarkets-ctrader',
        ]) {
          const entry = service.getEntry(id)!;
          expect(entry.productionLiveVerification.status).toBe('UNVERIFIED');
          expect(entry.productionLiveVerification.certifiedVia).toBeNull();
          expect(entry.productionLiveVerification.certificationRunRef).toBeNull();
          expect(entry.certificationState).toBe('NOT_CERTIFIED');
          expect(entry.productionLiveVerification.certificationState).toBe('NOT_CERTIFIED');
        }
      });

      it('LEGACY_VERIFIED remains production-LIVE ineligible until current protocol certification evidence exists', async () => {
        const service = await buildService(['metatrader5', 'paper-broker', 'oanda']);
        expect(service.isProductionLiveEligible('metatrader5')).toBe(false);
        expect(service.isProductionLiveEligible('oanda')).toBe(false);
        expect(service.isProductionLiveEligible('ctrader')).toBe(false);
        expect(service.isProductionLiveEligible('pepperstone-ctrader')).toBe(false);
        expect(service.isProductionLiveEligible('icmarkets-ctrader')).toBe(false);
      });

      it('current CERTIFIED state authorizes production LIVE only when the adapter is also available', async () => {
        const service = await buildService(['metatrader5', 'paper-broker']);
        const legacy = service.getEntry('metatrader5')!;
        jest.spyOn(service, 'getEntry').mockReturnValue({
          ...legacy,
          certificationState: 'CERTIFIED',
          productionLiveVerification: {
            ...legacy.productionLiveVerification,
            verifiedAt: '2026-09-16T15:00:00Z',
            evidenceRef: 'live-certification-operator-evidence',
            certifiedVia: 'HARNESS_CERTIFIED',
            certificationRunRef:
              '550e8400-e29b-41d4-a716-446655440000@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            certificationState: 'CERTIFIED',
          },
        });

        expect(service.isProductionLiveEligible('metatrader5')).toBe(true);
      });

      it('deriveProviderCertificationState: the full fail-closed truth table', () => {
        expect(deriveProviderCertificationState(undefined)).toBe('NOT_CERTIFIED');
        expect(
          deriveProviderCertificationState({
            status: 'UNVERIFIED',
            verifiedAt: null,
            evidenceRef: null,
          }),
        ).toBe('NOT_CERTIFIED');

        expect(
          deriveProviderCertificationState({
            status: 'VERIFIED',
            verifiedAt: null,
            evidenceRef: 'production operation',
            certifiedVia: 'LEGACY_ATTESTATION',
            certificationRunRef: null,
          }),
        ).toBe('LEGACY_VERIFIED');
        expect(
          deriveProviderCertificationState({
            status: 'VERIFIED',
            verifiedAt: '2026-01-01T00:00:00Z',
            evidenceRef: 'old attestation',
          }),
        ).toBe('LEGACY_VERIFIED');

        const validRunRef =
          '550e8400-e29b-41d4-a716-446655440000@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        expect(
          deriveProviderCertificationState({
            status: 'VERIFIED',
            verifiedAt: '2026-09-16T00:00:00Z',
            evidenceRef: 'live-certification artifact',
            certifiedVia: 'HARNESS_CERTIFIED',
            certificationRunRef: validRunRef,
          }),
        ).toBe('CERTIFIED');

        expect(
          deriveProviderCertificationState({
            status: 'VERIFIED',
            verifiedAt: null,
            evidenceRef: 'live-certification artifact',
            certifiedVia: 'HARNESS_CERTIFIED',
            certificationRunRef: validRunRef,
          }),
        ).toBe('NOT_CERTIFIED');
        expect(
          deriveProviderCertificationState({
            status: 'VERIFIED',
            verifiedAt: 'not-a-date',
            evidenceRef: 'live-certification artifact',
            certifiedVia: 'HARNESS_CERTIFIED',
            certificationRunRef: validRunRef,
          }),
        ).toBe('NOT_CERTIFIED');
        expect(
          deriveProviderCertificationState({
            status: 'VERIFIED',
            verifiedAt: '2026-09-16T00:00:00Z',
            evidenceRef: '',
            certifiedVia: 'HARNESS_CERTIFIED',
            certificationRunRef: validRunRef,
          }),
        ).toBe('NOT_CERTIFIED');
        expect(
          deriveProviderCertificationState({
            status: 'VERIFIED',
            verifiedAt: '2026-09-16T00:00:00Z',
            evidenceRef: 'live-certification artifact',
            certifiedVia: 'HARNESS_CERTIFIED',
            certificationRunRef: 'invalid-run-ref',
          }),
        ).toBe('NOT_CERTIFIED');
      });

      it('PIN: no runtime writer flips productionLiveVerification — the harness never imports the catalog and the registry never writes it', () => {
        const harnessSource = readFileSync(
          join(__dirname, '../verification/provider-live-certification-harness.ts'),
          'utf8',
        );
        expect(harnessSource).not.toMatch(/from\s+['"][^'"]*broker-catalog['"]/);
        expect(harnessSource).not.toMatch(/from\s+['"][^'"]*broker-provider-registry['"]/);
        expect(harnessSource).not.toMatch(/from\s+['"][^'"]*broker-definition['"]/);
        expect(harnessSource).not.toMatch(/productionLiveVerification\s*=/);

        const registrySource = readFileSync(
          join(__dirname, './broker-provider-registry.service.ts'),
          'utf8',
        );
        expect(registrySource).not.toMatch(/productionLiveVerification\.status\s*=\s*['"]/);
      });
    });
  });

  describe('fail-closed connectability', () => {
    it('isConnectable true only for entries with a registered adapter', async () => {
      const service = await buildService(['metatrader5']);
      expect(service.isConnectable('metatrader5')).toBe(true);
      expect(service.isConnectable('paper-broker')).toBe(false);
      expect(service.isConnectable('oanda')).toBe(false);
      expect(service.isConnectable('unknown-broker')).toBe(false);
      expect(service.isConnectable('')).toBe(false);
    });
  });

  describe('capability queries (Directive §M)', () => {
    it('resolves capabilities per broker — never guessed from name', async () => {
      const service = await buildService(['metatrader5', 'paper-broker']);

      expect(service.hasCapability('metatrader5', BrokerCapability.MARGIN_CALCULATION)).toBe(true);
      expect(service.hasCapability('metatrader5', BrokerCapability.METATRADER)).toBe(true);
      expect(service.hasCapability('paper-broker', BrokerCapability.LIVE)).toBe(false);
      expect(service.hasCapability('paper-broker', BrokerCapability.MARGIN_CALCULATION)).toBe(true);
      expect(service.hasCapability('oanda', BrokerCapability.REST)).toBe(true);
      expect(service.hasCapability('nope', BrokerCapability.REST)).toBe(false);
    });
  });

  describe('environment support (Directive §11 — explicit, never inferred)', () => {
    it('metatrader5 supports DEMO and LIVE', async () => {
      const service = await buildService(['metatrader5']);
      expect(service.supportsEnvironment('metatrader5', 'DEMO')).toBe(true);
      expect(service.supportsEnvironment('metatrader5', 'LIVE')).toBe(true);
    });

    it('paper-broker supports DEMO ONLY — LIVE isolation by design', async () => {
      const service = await buildService(['paper-broker']);
      expect(service.supportsEnvironment('paper-broker', 'DEMO')).toBe(true);
      expect(service.supportsEnvironment('paper-broker', 'LIVE')).toBe(false);
    });

    it('returns false for unknown brokers (fail closed)', async () => {
      const service = await buildService([]);
      expect(service.supportsEnvironment('unknown', 'DEMO')).toBe(false);
      expect(service.supportsEnvironment('unknown', 'LIVE')).toBe(false);
    });
  });

  describe('catalog shape', () => {
    it('returns connection routes per entry (Directive §AF — routes, not fake broker entries)', async () => {
      const service = await buildService(['metatrader5']);
      const catalog = service.getCatalog();

      const mtEntries = catalog.filter((e) =>
        e.connectionRoutes.includes(BrokerConnectionRoute.METATRADER),
      );
      expect(mtEntries).toHaveLength(1);

      const ctrader = catalog.find((e) => e.id === 'ctrader');
      expect(ctrader?.connectionRoutes).toEqual([BrokerConnectionRoute.CTRADER]);
    });

    it('exposes a catalog version for cache-busting and drift detection', async () => {
      const service = await buildService([]);
      expect(typeof service.catalogVersion).toBe('string');
      expect(service.catalogVersion.length).toBeGreaterThan(0);
    });

    it('getEntry returns null for unknown ids', async () => {
      const service = await buildService([]);
      expect(service.getEntry('unknown')).toBeNull();
      expect(service.getEntry('metatrader5')).not.toBeNull();
    });
  });
});
