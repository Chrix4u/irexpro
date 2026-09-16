/**
 * ctrader-oauth — unit specs for the pure OAuth2 helpers (Task 48-B port).
 *
 * These functions build/validate the official cTrader Open API OAuth2 flow
 * URLs and parse the token-endpoint response:
 * 1. consent URL (id.ctrader.com — user grants the platform app access),
 * 2. token URL (openapi.ctrader.com/apps/token — GET, query params),
 * 3. response parsing that fails CLOSED on every rejected/incomplete body.
 *
 * Security invariants asserted here:
 * - client secrets ride ONLY in the built token-request URL (never thrown,
 *   never embedded in error messages),
 * - provider error descriptions are REDACTED (secret-shaped key=value
 *   fragments collapse to '[REDACTED]') before they reach a thrown message.
 */
import {
  buildCtraderAuthorizationUrl,
  buildCtraderTokenRequestUrl,
  CTRADER_AUTHORIZATION_BASE_URL,
  CTRADER_TOKEN_ENDPOINT,
  parseCtraderTokenResponse,
} from './ctrader-oauth';
import { BrokerAdapterError, BrokerErrorCode } from '../../interfaces/broker-adapter.errors';

describe('ctrader-oauth', () => {
  // ─── Official endpoint constants ───────────────────────────────────────────

  it('targets the official cTrader consent and token endpoints', () => {
    expect(CTRADER_AUTHORIZATION_BASE_URL).toBe(
      'https://id.ctrader.com/my/settings/openapi/grantingaccess/',
    );
    expect(CTRADER_TOKEN_ENDPOINT).toBe('https://openapi.ctrader.com/apps/token');
  });

  // ─── Consent (authorization) URL ───────────────────────────────────────────

  describe('buildCtraderAuthorizationUrl', () => {
    it('builds the full consent URL with client_id/redirect_uri/scope/product', () => {
      const url = buildCtraderAuthorizationUrl('client-123', 'https://app.example.com/callback');
      expect(url.startsWith(`${CTRADER_AUTHORIZATION_BASE_URL}?`)).toBe(true);
      const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      expect(params.get('client_id')).toBe('client-123');
      expect(params.get('redirect_uri')).toBe('https://app.example.com/callback');
      expect(params.get('scope')).toBe('trading'); // full trading scope by default
      expect(params.get('product')).toBe('web');
    });

    it('supports the view-only accounts scope', () => {
      const url = buildCtraderAuthorizationUrl('client-123', 'https://a.b/cb', 'accounts');
      const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      expect(params.get('scope')).toBe('accounts');
    });

    it('URL-encodes redirect URIs with query strings', () => {
      const url = buildCtraderAuthorizationUrl('id', 'https://app.example.com/cb?state=xyz');
      const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      expect(params.get('redirect_uri')).toBe('https://app.example.com/cb?state=xyz');
    });
  });

  // ─── Token-request URL ─────────────────────────────────────────────────────

  describe('buildCtraderTokenRequestUrl', () => {
    it('builds an authorization_code exchange URL with every parameter', () => {
      const url = buildCtraderTokenRequestUrl({
        grantType: 'authorization_code',
        code: 'the-auth-code',
        redirectUri: 'https://app.example.com/cb',
        clientId: 'client-123',
        clientSecret: 'super-secret-value',
      });
      expect(url.startsWith(`${CTRADER_TOKEN_ENDPOINT}?`)).toBe(true);
      const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      expect(params.get('grant_type')).toBe('authorization_code');
      expect(params.get('code')).toBe('the-auth-code');
      expect(params.get('redirect_uri')).toBe('https://app.example.com/cb');
      expect(params.get('client_id')).toBe('client-123');
      expect(params.get('client_secret')).toBe('super-secret-value');
    });

    it('builds a refresh_token exchange URL (no code/redirect_uri)', () => {
      const url = buildCtraderTokenRequestUrl({
        grantType: 'refresh_token',
        refreshToken: 'the-refresh-token',
        clientId: 'client-123',
        clientSecret: 'super-secret-value',
      });
      const params = new URLSearchParams(url.slice(url.indexOf('?') + 1));
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('the-refresh-token');
      expect(params.get('client_id')).toBe('client-123');
      expect(params.get('client_secret')).toBe('super-secret-value');
      expect(params.has('code')).toBe(false);
      expect(params.has('redirect_uri')).toBe(false);
    });

    it('fails closed (typed AUTHENTICATION_FAILED) when the code is missing', () => {
      expect(() =>
        buildCtraderTokenRequestUrl({
          grantType: 'authorization_code',
          redirectUri: 'https://app.example.com/cb',
          clientId: 'client-123',
          clientSecret: 'secret',
        }),
      ).toThrow(
        expect.objectContaining({
          code: BrokerErrorCode.AUTHENTICATION_FAILED,
        }),
      );
    });

    it('fails closed when the redirectUri is missing for a code exchange', () => {
      expect(() =>
        buildCtraderTokenRequestUrl({
          grantType: 'authorization_code',
          code: 'the-code',
          clientId: 'client-123',
          clientSecret: 'secret',
        }),
      ).toThrow(BrokerAdapterError);
    });

    it('fails closed when the refreshToken is missing for a refresh exchange', () => {
      expect(() =>
        buildCtraderTokenRequestUrl({
          grantType: 'refresh_token',
          clientId: 'client-123',
          clientSecret: 'secret',
        }),
      ).toThrow(
        expect.objectContaining({
          code: BrokerErrorCode.AUTHENTICATION_FAILED,
        }),
      );
    });
  });

  // ─── Token-response parsing (fail closed) ──────────────────────────────────

  describe('parseCtraderTokenResponse', () => {
    it('parses a successful grant into tokens', () => {
      const tokens = parseCtraderTokenResponse({
        accessToken: 'access-abc',
        refreshToken: 'refresh-xyz',
        tokenType: 'bearer',
        expiresIn: 2_628_000,
      });
      expect(tokens).toEqual({
        accessToken: 'access-abc',
        refreshToken: 'refresh-xyz',
        expiresIn: 2_628_000,
      });
    });

    it('fails closed with AUTHENTICATION_FAILED on a rejected exchange', () => {
      expect(() =>
        parseCtraderTokenResponse({
          errorCode: 'BAD_REQUEST',
          description: 'The authorization code is invalid.',
        }),
      ).toThrow(
        expect.objectContaining({
          code: BrokerErrorCode.AUTHENTICATION_FAILED,
        }),
      );
    });

    it('surfaces the (redacted) provider description on rejection', () => {
      try {
        parseCtraderTokenResponse({
          errorCode: 'CH_CLIENT_AUTH_FAILURE',
          description: 'client_secret=super-secret-value was rejected',
        });
        fail('expected parseCtraderTokenResponse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerAdapterError);
        const typed = err as BrokerAdapterError;
        expect(typed.message).toContain('[REDACTED]');
        expect(typed.message).not.toContain('super-secret-value');
        expect(typed.message).not.toContain('client_secret=super');
      }
    });

    it('falls back to the errorCode when no description is present', () => {
      try {
        parseCtraderTokenResponse({ errorCode: 'TOKEN_EXPIRED' });
        fail('expected parseCtraderTokenResponse to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(BrokerAdapterError);
        expect((err as BrokerAdapterError).message).toContain('TOKEN_EXPIRED');
      }
    });

    it('fails closed when tokens are missing (no fabricated half-grants)', () => {
      expect(() => parseCtraderTokenResponse({ accessToken: 'only-access' })).toThrow(
        BrokerAdapterError,
      );
      expect(() => parseCtraderTokenResponse({ refreshToken: 'only-refresh' })).toThrow(
        BrokerAdapterError,
      );
      expect(() => parseCtraderTokenResponse({})).toThrow(BrokerAdapterError);
    });

    it('fails closed on a non-numeric or non-positive expiresIn', () => {
      expect(() =>
        parseCtraderTokenResponse({
          accessToken: 'a',
          refreshToken: 'r',
          expiresIn: 'soon' as unknown as number,
        }),
      ).toThrow(BrokerAdapterError);
      expect(() =>
        parseCtraderTokenResponse({ accessToken: 'a', refreshToken: 'r', expiresIn: 0 }),
      ).toThrow(BrokerAdapterError);
      expect(() =>
        parseCtraderTokenResponse({ accessToken: 'a', refreshToken: 'r', expiresIn: -5 }),
      ).toThrow(BrokerAdapterError);
    });

    it('fails closed on non-object bodies', () => {
      for (const bad of [null, undefined, 'token', 42]) {
        expect(() => parseCtraderTokenResponse(bad)).toThrow(
          expect.objectContaining({ code: BrokerErrorCode.AUTHENTICATION_FAILED }),
        );
      }
    });

    it('accepts expiresIn 1 (minimal positive lifetime) without folding to error', () => {
      expect(
        parseCtraderTokenResponse({ accessToken: 'a', refreshToken: 'r', expiresIn: 1 }),
      ).toEqual({ accessToken: 'a', refreshToken: 'r', expiresIn: 1 });
    });
  });
});
