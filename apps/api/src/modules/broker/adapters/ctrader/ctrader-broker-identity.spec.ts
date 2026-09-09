/**
 * cTrader broker-identity policy — adversarial unit coverage (Sprint 56
 * correction round 3, architect finding 6; Task 2-a).
 *
 * The policy module is PURE (no transport, no client) — every case below is
 * a direct contract assertion on the documented matching policy:
 * - normalizeBrokerTitleShort strips case/punctuation/whitespace.
 * - expectedBrokerIdentityToken derives the expected token from the REQUESTED
 *   alias id: generic 'ctrader' is agnostic (null); unknown ids fall back to
 *   the id itself (fail-closed, NEVER agnostic); the bare '-ctrader' edge
 *   falls back to the full id.
 * - brokerIdentityMatches is agnostic for 'ctrader' even with a missing
 *   title, but fail-closed (false) for a broker-specific alias with a
 *   missing/empty/blank title, and containment-matched on the NORMALIZED
 *   title otherwise.
 * - assertDiscoveredBrokerIdentity rejects mismatches with
 *   AUTHENTICATION_FAILED naming BOTH the discovered title and the requested
 *   id, and never throws for the generic 'ctrader' id.
 */
import {
  assertDiscoveredBrokerIdentity,
  brokerIdentityMatches,
  expectedBrokerIdentityToken,
  normalizeBrokerTitleShort,
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

    it("'pepperstone-ctrader' matches the Pepperstone brand (normalized containment)", () => {
      expect(brokerIdentityMatches('pepperstone-ctrader', 'Pepperstone')).toBe(true);
      expect(brokerIdentityMatches('pepperstone-ctrader', 'PEPPER STONE')).toBe(true);
      expect(brokerIdentityMatches('pepperstone-ctrader', 'Pepperstone (UK)')).toBe(true);
      expect(brokerIdentityMatches('pepperstone-ctrader', '  pepperstone  ')).toBe(true);
      expect(brokerIdentityMatches('pepperstone-ctrader', 'Pepperstone Group Ltd')).toBe(true);
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

    it("'icmarkets-ctrader' matches the IC Markets brand only", () => {
      expect(brokerIdentityMatches('icmarkets-ctrader', 'IC Markets')).toBe(true);
      expect(brokerIdentityMatches('icmarkets-ctrader', 'IC Markets (AU)')).toBe(true);
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
      // expected token is '-ctrader' itself; no normalized title can contain
      // the dash (non-alphanumerics are stripped) → always false.
      expect(brokerIdentityMatches('-ctrader', 'Pepperstone')).toBe(false);
      expect(brokerIdentityMatches('-ctrader', 'cTrader')).toBe(false);
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

    it('does NOT throw when the discovered brand matches the requested alias', () => {
      expect(() =>
        assertDiscoveredBrokerIdentity('pepperstone-ctrader', {
          ...ACCOUNT,
          brokerTitleShort: 'Pepperstone (UK)',
        }),
      ).not.toThrow();
      expect(() =>
        assertDiscoveredBrokerIdentity('icmarkets-ctrader', {
          ...ACCOUNT,
          brokerTitleShort: 'IC Markets',
        }),
      ).not.toThrow();
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
});
