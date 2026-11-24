import { ConfigService } from '@nestjs/config';
import { CredentialEncryptionService } from '../services/credential-encryption.service';
import {
  StoredCTraderCertTarget,
  StoredCTraderCredentialRow,
  assertStoredCTraderCertRow,
  assertStoredCTraderCertTarget,
  decodeStoredCTraderCredential,
  loadStoredCTraderCertCredential,
} from './ctrader-stored-cert-credentials';

describe('operator-only exact-bound cTrader stored credential source (NO broker calls)', () => {
  const key = 'test-stored-cert-credential-key-32-bytes!';
  const target: StoredCTraderCertTarget = {
    ownerUserId: '11111111-1111-4111-8111-111111111111',
    connectionId: '22222222-2222-4222-8222-222222222222',
    brokerId: 'pepperstone-ctrader',
    ctidTraderAccountId: '12345678',
  };
  const expiry = new Date('2030-01-01T00:00:00.000Z');
  const fakeSecret = 'test-oauth-access-token-sensitive-value';
  function row(): StoredCTraderCredentialRow {
    const svc = new CredentialEncryptionService(new ConfigService({ BROKER_ENCRYPTION_KEY: key }));
    const x = svc.encrypt({
      apiKey: fakeSecret,
      accountId: target.ctidTraderAccountId,
      additionalParams: {
        refreshToken: 'test-refresh-sensitive',
        accessTokenExpiresAt: expiry.toISOString(),
      },
    });
    return {
      id: target.connectionId,
      user_id: target.ownerUserId,
      broker_id: target.brokerId,
      account_id: target.ctidTraderAccountId,
      account_type: 'LIVE',
      provider_broker_identity: 'pepperstone',
      status: 'CONNECTED',
      authorization_status: 'CONNECTED',
      credential_status: 'ROTATED',
      encrypted_credentials: x.ciphertext,
      credential_iv: x.iv,
      credential_tag: x.tag,
      encryption_key_id: x.keyId,
    };
  }
  it('returns only an in-memory token for the exact owner, account and broker', () => {
    const r = row();
    const c = decodeStoredCTraderCredential(r, target, key, Date.parse('2029-12-01'));
    expect(c.apiKey).toBe(fakeSecret);
    expect(c.accountId).toBe(target.ctidTraderAccountId);
    expect(JSON.stringify(r)).not.toContain(fakeSecret);
    expect(Object.keys(c).sort()).toEqual(['accountId', 'apiKey', 'clear']);
    c.clear();
    expect(c.apiKey).toBe('');
  });
  it.each([
    ['wrong owner', { user_id: '33333333-3333-4333-8333-333333333333' }],
    ['wrong connection', { id: '44444444-4444-4444-8444-444444444444' }],
    ['wrong account', { account_id: '99999999' }],
    ['DEMO', { account_type: 'DEMO' }],
    ['wrong broker', { broker_id: 'icmarkets-ctrader' }],
    ['wrong provider', { provider_broker_identity: 'icmarkets' }],
    ['unknown provider', { provider_broker_identity: null }],
    ['disconnected', { status: 'DISCONNECTED' }],
    ['inactive authorization', { authorization_status: 'NOT_CONNECTED' }],
    ['revoked', { credential_status: 'REVOKED' }],
    ['invalid', { credential_status: 'INVALID' }],
    ['missing ciphertext', { encrypted_credentials: null }],
    ['missing IV', { credential_iv: null }],
    ['missing tag', { credential_tag: null }],
    ['missing key-id', { encryption_key_id: null }],
  ])('rejects %s before decrypt', (_name, patch) => {
    expect(() => assertStoredCTraderCertRow({ ...row(), ...patch }, target)).toThrow();
  });
  it('rejects invalid owner, connection, broker alias and malformed account ID', () => {
    expect(() => assertStoredCTraderCertTarget({ ...target, ownerUserId: 'invalid' })).toThrow();
    expect(() => assertStoredCTraderCertTarget({ ...target, connectionId: 'invalid' })).toThrow();
    expect(() => assertStoredCTraderCertTarget({ ...target, brokerId: 'oanda' })).toThrow();
    expect(() =>
      assertStoredCTraderCertTarget({ ...target, ctidTraderAccountId: '1408198 unsafe' }),
    ).toThrow();
  });
  it('rejects expired and near-expiry stored access token', () => {
    const r = row();
    expect(() => decodeStoredCTraderCredential(r, target, key, expiry.getTime() - 1000)).toThrow(
      /expiry/,
    );
    expect(() =>
      decodeStoredCTraderCredential(r, target, key, expiry.getTime() - 5 * 60_000),
    ).toThrow(/expiry/);
  });
  it('rejects wrong account embedded inside encrypted credential bundle', () => {
    const svc = new CredentialEncryptionService(new ConfigService({ BROKER_ENCRYPTION_KEY: key }));
    const r = row();
    const bundle = svc.encrypt({
      apiKey: fakeSecret,
      accountId: '99999999',
      additionalParams: { accessTokenExpiresAt: expiry.toISOString() },
    });
    r.encrypted_credentials = bundle.ciphertext;
    r.credential_iv = bundle.iv;
    r.credential_tag = bundle.tag;
    expect(() => decodeStoredCTraderCredential(r, target, key, Date.parse('2029-12-01'))).toThrow(
      /mismatched/,
    );
  });
  it('rejects tampering and never reports secrets in the exception', () => {
    const r = row();
    r.credential_tag = '0'.repeat(32);
    let error = '';
    try {
      decodeStoredCTraderCredential(r, target, key, Date.parse('2029-12-01'));
    } catch (e) {
      error = String(e);
    }
    expect(error).toContain('could not be authenticated');
    expect(error).not.toContain(fakeSecret);
  });
  it('fails before any DB lookup when explicit real-money gate is closed', async () => {
    await expect(
      loadStoredCTraderCertCredential(target, {
        IREXPRO_ALLOW_LIVE_CERTIFICATION: 'false',
        CTRADER_LIVE_CERT_CREDENTIAL_SOURCE: 'stored',
        IREXPRO_LIVE_CERT_OPERATOR_ID: 'test-operator',
      }),
    ).rejects.toThrow(/master gate/);
  });
  it('fails before DB lookup when operator identity is missing', async () => {
    await expect(
      loadStoredCTraderCertCredential(target, {
        IREXPRO_ALLOW_LIVE_CERTIFICATION: 'true',
        CTRADER_LIVE_CERT_CREDENTIAL_SOURCE: 'stored',
      }),
    ).rejects.toThrow(/operator identity/);
  });
});
