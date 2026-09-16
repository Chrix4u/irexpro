/**
 * cTrader broker-identity policy — adversarial unit coverage (Sprint 56
 * correction round 3, architect finding 6; correction round 4, architect
 * finding 8 — versioned CANONICAL provider-identity model).
 *
 * The policy module is PURE (no transport, no client) — every case below is
 * a direct contract assertion on the documented matching policy:
 * - normalizeBrokerTitleShort strips case/punctuation/whitespace.
 * - expectedBrokerIdentityToken derives the expected token from the REQUESTED
 *   alias id: generic 'ctrader' is agnostic (null); unknown ids fall back to
 *   the id itself (fail-closed, NEVER agnostic); the bare '-ctrader' edge
 *   falls back to the full id.
 * - brokerIdentityMatches (round 4, EXACT canonical matching): agnostic for
 *   'ctrader'; CATALOGED aliases ('pepperstone-ctrader', 'icmarkets-ctrader')
 *   match ONLY the reviewed acceptable normalized titles (exact membership —
 *   a title merely CONTAINING the expected token is NOT a verified identity);
 *   uncataloged aliases match the derived token by EXACT equality; the bare
 *   '-ctrader' edge never matches anything.
 * - assertDiscoveredBrokerIdentity rejects mismatches with
 *   AUTHENTICATION_FAILED naming BOTH the discovered title and the requested
 *   id, and never throws for the generic 'ctrader' id.
 * - normalizeProviderBrokerIdentity produces the sanitized server-derived
 *   persisted identity (or null — never fabricated).
 */
import {
  assertDiscoveredBrokerIdentity,
  brokerIdentityMatches,
  expectedBrokerIdentityToken,
  normalizeBrokerTitleShort,
  normalizeProviderBrokerIdentity,
  PROVIDER_IDENTITY_MODEL_VERSION,
  providerIdentityFamilyForAlias,
} from './ctrader-broker-identity';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';

describe('ctrader-broker-identity policy (finding 6)', () => {
  // ─── normalizeBrokerTitleShort ─────────────────────────────────────────────

  describe('normalizeBrokerTitleShort', () => {
    it.each([
      ['IC Markets', 'icmarkets'],
      ['Pepperstone (UK)', 'pepperstoneuk'],
      ['pepperstone', 'pepperstone'],
      ['PEPPERSTONE', 'pepperstone'],
      ['  Pepperstone  ', 'pepperstone'],
      ['PEPPER STONE', 'pepperstone'],
      ['pepper-stone.', 'pepperstone'],
      ['IC Markets Pty Ltd', 'icmarketsptyltd'],
      ['IC-Markets_2024!!', 'icmarkets2024'],
      ['Not@#$%^&*()Ok', 'notok'],
    ])('normalizes "%s" → "%s"', (input, expected) => {
      expect(normalizeBrokerTitleShort(input)).toBe(expected);
    });

    it('keeps digits (broker names legitimately carry years/markers)', () => {
      expect(normalizeBrokerTitleShort('Broker 24/7')).toBe('broker247');
    });

    it('returns the empty string for punctuation/whitespace-only input', () => {
      expect(normalizeBrokerTitleShort('')).toBe('');
      expect(normalizeBrokerTitleShort('   ')).toBe('');
      expect(normalizeBrokerTitleShort('()')).toBe('');
      expect(normalizeBrokerTitleShort(' - _ . ')).toBe('');
    });
  });

  // ─── expectedBrokerIdentityToken ───────────────────────────────────────────

  describe('expectedBrokerIdentityToken', () => {
    it('returns null for the generic engine id (broker-agnostic)', () => {
      expect(expectedBrokerIdentityToken('ctrader')).toBeNull();
    });

    it('derives the alias token from the requested id', () => {
      expect(expectedBrokerIdentityToken('pepperstone-ctrader')).toBe('pepperstone');
      expect(expectedBrokerIdentityToken('icmarkets-ctrader')).toBe('icmarkets');
    });

    it('is case-sensitive: "CTrader" is NOT the agnostic id (fail-closed)', () => {
      // Anything that is not EXACTLY 'ctrader' must resolve to a concrete
      // token — never an accidental agnostic match.
      expect(expectedBrokerIdentityToken('CTrader')).toBe('CTrader');
      expect(expectedBrokerIdentityToken('Ctrader')).toBe('Ctrader');
    });

    it('returns an unknown id unchanged (fail-closed: never null)', () => {
      expect(expectedBrokerIdentityToken('oanda')).toBe('oanda');
      expect(expectedBrokerIdentityToken('some-brand')).toBe('some-brand');
      expect(expectedBrokerIdentityToken('another-ctrader-like')).toBe('another-ctrader-like');
    });

    it('falls back to the full id for the bare "-ctrader" edge (empty token)', () => {
      // The distinguishing segment is empty — the full id is the expected
      // token so the request can never become accidentally agnostic.
      expect(expectedBrokerIdentityToken('-ctrader')).toBe('-ctrader');
    });

    it('extracts the token, not the suffix, for multi-segment aliases', () => {
      expect(expectedBrokerIdentityToken('pepperstoneuk-ctrader')).toBe('pepperstoneuk');
    });
  });

  // ─── brokerIdentityMatches ─────────────────────────────────────────────────

  describe('brokerIdentityMatches', () => {
    it("is agnostic for the generic 'ctrader' id even with a missing title", () => {
      expect(brokerIdentityMatches('ctrader', undefined)).toBe(true);
      expect(brokerIdentityMatches('ctrader', null)).toBe(true);
      expect(brokerIdentityMatches('ctrader', '')).toBe(true);
      expect(brokerIdentityMatches('ctrader', '   ')).toBe(true);
      expect(brokerIdentityMatches('ctrader', 'IC Markets')).toBe(true);
      expect(brokerIdentityMatches('ctrader', 'Pepperstone')).toBe(true);
    });

    it("'pepperstone-ctrader' matches ONLY the reviewed canonical Pepperstone title (EXACT)", () => {
      // Round 4 (finding 8): exact membership in the versioned catalog.
      expect(brokerIdentityMatches('pepperstone-ctrader', 'Pepperstone')).toBe(true);
      expect(brokerIdentityMatches('pepperstone-ctrader', 'PEPPER STONE')).toBe(true);
      expect(brokerIdentityMatches('pepperstone-ctrader', '  pepperstone  ')).toBe(true);
    });

    it('unreviewed variants CONTAINING the token are NOT verified identities (round 4, exact model)', () => {
      // The old substring rule matched these; the canonical catalog does NOT
      // — variants are only acceptable after an evidence-backed model bump.
      expect(brokerIdentityMatches('pepperstone-ctrader', 'Pepperstone (UK)')).toBe(false);
      expect(brokerIdentityMatches('pepperstone-ctrader', 'Pepperstone Group Ltd')).toBe(false);
      // A DIFFERENT title that merely contains the expected token.
      expect(brokerIdentityMatches('pepperstone-ctrader', 'NotPepperstone')).toBe(false);
      expect(brokerIdentityMatches('pepperstone-ctrader', 'xpepperstonex')).toBe(false);
    });

    it("'pepperstone-ctrader' does NOT match other brands", () => {
      expect(brokerIdentityMatches('pepperstone-ctrader', 'IC Markets')).toBe(false);
      expect(brokerIdentityMatches('pepperstone-ctrader', 'IC-Markets')).toBe(false);
    });

    it("'pepperstone-ctrader' is fail-closed on missing/empty/blank titles", () => {
      expect(brokerIdentityMatches('pepperstone-ctrader', undefined)).toBe(false);
      expect(brokerIdentityMatches('pepperstone-ctrader', null)).toBe(false);
      expect(brokerIdentityMatches('pepperstone-ctrader', '')).toBe(false);
      expect(brokerIdentityMatches('pepperstone-ctrader', '   ')).toBe(false);
      // Punctuation-only titles normalize to the empty string — no match.
      expect(brokerIdentityMatches('pepperstone-ctrader', '()')).toBe(false);
      expect(brokerIdentityMatches('pepperstone-ctrader', ' - . ')).toBe(false);
    });

    it("'icmarkets-ctrader' matches ONLY the reviewed canonical IC Markets title (EXACT)", () => {
      expect(brokerIdentityMatches('icmarkets-ctrader', 'IC Markets')).toBe(true);
      // Unreviewed variant — NOT a verified identity under the exact model.
      expect(brokerIdentityMatches('icmarkets-ctrader', 'IC Markets (AU)')).toBe(false);
      expect(brokerIdentityMatches('icmarkets-ctrader', 'Pepperstone')).toBe(false);
    });

    it('unknown requested ids fail closed against every title (never agnostic)', () => {
      // The expected token is the id itself — only a title whose normalized
      // form contains it can match; anything else (including a missing
      // title) is a mismatch.
      expect(brokerIdentityMatches('somebrand', 'Some Brand')).toBe(true);
      expect(brokerIdentityMatches('somebrand', 'Pepperstone')).toBe(false);
      expect(brokerIdentityMatches('somebrand', undefined)).toBe(false);
    });

    it("the bare '-ctrader' edge never matches a real brand (empty token fallback)", () => {
      // Round 4: the degenerate bare-suffix id fails closed against EVERY
      // title (including 'cTrader', whose normalized form equals the id's).
      expect(brokerIdentityMatches('-ctrader', 'Pepperstone')).toBe(false);
      expect(brokerIdentityMatches('-ctrader', 'cTrader')).toBe(false);
    });

    it('unknown requested ids match ONLY the exact normalized id form (containment removed)', () => {
      expect(brokerIdentityMatches('somebrand', 'Some Brand')).toBe(true);
      // Containment is gone: a title that merely CONTAINS the token fails.
      expect(brokerIdentityMatches('somebrand', 'Some Brand Extra')).toBe(false);
      expect(brokerIdentityMatches('somebrand', 'Pepperstone')).toBe(false);
      expect(brokerIdentityMatches('somebrand', undefined)).toBe(false);
    });
  });

  // ─── assertDiscoveredBrokerIdentity ────────────────────────────────────────

  describe('assertDiscoveredBrokerIdentity', () => {
    const ACCOUNT = { ctidTraderAccountId: 1234567 };

    it('throws AUTHENTICATION_FAILED naming BOTH the discovered title and the requested id', () => {
      try {
        assertDiscoveredBrokerIdentity('pepperstone-ctrader', {
          ...ACCOUNT,
          brokerTitleShort: 'IC Markets',
        });
        fail('expected assertDiscoveredBrokerIdentity to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerAdapterError);
        const adapterError = err as BrokerAdapterError;
        expect(adapterError.code).toBe(BrokerErrorCode.AUTHENTICATION_FAILED);
        // The operator must see the DISCOVERED brand AND the requested alias.
        expect(adapterError.message).toContain('IC Markets');
        expect(adapterError.message).toContain('pepperstone-ctrader');
        expect(adapterError.message).toContain('1234567');
      }
    });

    it('throws AUTHENTICATION_FAILED for the reverse mismatch (Pepperstone title under icmarkets alias)', () => {
      try {
        assertDiscoveredBrokerIdentity('icmarkets-ctrader', {
          ...ACCOUNT,
          brokerTitleShort: 'Pepperstone',
        });
        fail('expected assertDiscoveredBrokerIdentity to throw');
      } catch (err) {
        const adapterError = err as BrokerAdapterError;
        expect(adapterError.code).toBe(BrokerErrorCode.AUTHENTICATION_FAILED);
        expect(adapterError.message).toContain('Pepperstone');
        expect(adapterError.message).toContain('icmarkets-ctrader');
      }
    });

    it('is fail-closed for a broker-specific alias with a missing title', () => {
      expect(() =>
        assertDiscoveredBrokerIdentity('pepperstone-ctrader', {
          ...ACCOUNT,
          brokerTitleShort: undefined,
        }),
      ).toThrow(BrokerAdapterError);
      expect(() =>
        assertDiscoveredBrokerIdentity('pepperstone-ctrader', { ...ACCOUNT, brokerTitleShort: '' }),
      ).toThrow(BrokerAdapterError);
      // The message names the account + "unknown" brand — never an
      // unspecified blank.
      try {
        assertDiscoveredBrokerIdentity('pepperstone-ctrader', {
          ...ACCOUNT,
          brokerTitleShort: undefined,
        });
        fail('expected assertDiscoveredBrokerIdentity to throw');
      } catch (err) {
        const adapterError = err as BrokerAdapterError;
        expect(adapterError.code).toBe(BrokerErrorCode.AUTHENTICATION_FAILED);
        expect(adapterError.message).toContain('unknown');
        expect(adapterError.message).toContain('pepperstone-ctrader');
      }
    });

    it('does NOT throw when the discovered brand matches the requested alias (exact)', () => {
      expect(() =>
        assertDiscoveredBrokerIdentity('pepperstone-ctrader', {
          ...ACCOUNT,
          brokerTitleShort: 'Pepperstone',
        }),
      ).not.toThrow();
      expect(() =>
        assertDiscoveredBrokerIdentity('icmarkets-ctrader', {
          ...ACCOUNT,
          brokerTitleShort: 'IC Markets',
        }),
      ).not.toThrow();
      // Unreviewed variants now FAIL CLOSED (round 4, exact model).
      expect(() =>
        assertDiscoveredBrokerIdentity('pepperstone-ctrader', {
          ...ACCOUNT,
          brokerTitleShort: 'Pepperstone (UK)',
        }),
      ).toThrow(BrokerAdapterError);
    });

    it("does NOT throw for the generic 'ctrader' id regardless of the discovered title", () => {
      expect(() =>
        assertDiscoveredBrokerIdentity('ctrader', { ...ACCOUNT, brokerTitleShort: 'IC Markets' }),
      ).not.toThrow();
      expect(() =>
        assertDiscoveredBrokerIdentity('ctrader', { ...ACCOUNT, brokerTitleShort: 'Pepperstone' }),
      ).not.toThrow();
      expect(() =>
        assertDiscoveredBrokerIdentity('ctrader', { ...ACCOUNT, brokerTitleShort: undefined }),
      ).not.toThrow();
      expect(() =>
        assertDiscoveredBrokerIdentity('ctrader', { ...ACCOUNT, brokerTitleShort: '' }),
      ).not.toThrow();
    });
  });

  // ─── Versioned canonical catalog (round 4, finding 8) ─────────────────────

  describe('canonical provider-identity catalog', () => {
    it('is versioned (every catalog change bumps the model version)', () => {
      expect(PROVIDER_IDENTITY_MODEL_VERSION).toBe(1);
    });

    it('resolves the cataloged identity families for the branded aliases', () => {
      expect(providerIdentityFamilyForAlias('pepperstone-ctrader')).toEqual({
        family: 'PEPPERSTONE',
        acceptableNormalizedTitles: ['pepperstone'],
      });
      expect(providerIdentityFamilyForAlias('icmarkets-ctrader')).toEqual({
        family: 'IC_MARKETS',
        acceptableNormalizedTitles: ['icmarkets'],
      });
    });

    it('returns null for the generic id and uncataloged ids', () => {
      expect(providerIdentityFamilyForAlias('ctrader')).toBeNull();
      expect(providerIdentityFamilyForAlias('somebrand-ctrader')).toBeNull();
      expect(providerIdentityFamilyForAlias('oanda')).toBeNull();
    });

    it('catalog matching is EXACT — cross-brand token containment never matches', () => {
      // A fabricated title containing BOTH tokens still fails both aliases.
      expect(brokerIdentityMatches('pepperstone-ctrader', 'Pepperstone IC Markets')).toBe(false);
      expect(brokerIdentityMatches('icmarkets-ctrader', 'IC Markets Pepperstone')).toBe(false);
    });
  });

  // ─── Server-derived persisted identity (round 4, finding 9) ───────────────

  describe('normalizeProviderBrokerIdentity', () => {
    it('normalizes a discovered title into the sanitized persisted identity', () => {
      expect(normalizeProviderBrokerIdentity('Pepperstone')).toBe('pepperstone');
      expect(normalizeProviderBrokerIdentity('IC Markets')).toBe('icmarkets');
      expect(normalizeProviderBrokerIdentity('  Spotware  ')).toBe('spotware');
    });

    it('returns null for missing/blank/punctuation-only titles — never fabricated', () => {
      expect(normalizeProviderBrokerIdentity(undefined)).toBeNull();
      expect(normalizeProviderBrokerIdentity(null)).toBeNull();
      expect(normalizeProviderBrokerIdentity('')).toBeNull();
      expect(normalizeProviderBrokerIdentity('   ')).toBeNull();
      expect(normalizeProviderBrokerIdentity('()')).toBeNull();
    });
  });
});
