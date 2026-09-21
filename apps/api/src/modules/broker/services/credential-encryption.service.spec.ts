import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialEncryptionService } from './credential-encryption.service';
import { DecryptedBrokerCredentials } from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';

const TEST_ENCRYPTION_KEY = 'test-encryption-key-32-chars-pad!!';

describe('CredentialEncryptionService', () => {
  let module: TestingModule;
  let service: CredentialEncryptionService;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      providers: [
        CredentialEncryptionService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, defaultVal?: string) => {
              if (key === 'BROKER_ENCRYPTION_KEY') return TEST_ENCRYPTION_KEY;
              return defaultVal;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<CredentialEncryptionService>(CredentialEncryptionService);
  });

  afterEach(async () => {
    await module.close();
  });

  describe('encrypt() / decrypt() round-trip', () => {
    it('successfully encrypts and decrypts credentials', () => {
      const credentials: DecryptedBrokerCredentials = {
        apiKey: 'test-api-key-abc123',
        apiSecret: 'test-secret-xyz987',
        accountId: '654321',
        serverUrl: 'https://mt-client-api.example.com',
      };

      const bundle = service.encrypt(credentials);
      const decrypted = service.decrypt(bundle);

      expect(decrypted.apiKey).toBe(credentials.apiKey);
      expect(decrypted.apiSecret).toBe(credentials.apiSecret);
      expect(decrypted.accountId).toBe(credentials.accountId);
      expect(decrypted.serverUrl).toBe(credentials.serverUrl);
    });

    it('produces different ciphertext for same plaintext (random IV)', () => {
      const credentials: DecryptedBrokerCredentials = { accountId: '123' };
      const bundle1 = service.encrypt(credentials);
      const bundle2 = service.encrypt(credentials);

      expect(bundle1.ciphertext).not.toBe(bundle2.ciphertext);
      expect(bundle1.iv).not.toBe(bundle2.iv);
    });

    it('never stores raw API key in the ciphertext output', () => {
      const credentials: DecryptedBrokerCredentials = {
        apiKey: 'SUPER_SECRET_API_KEY',
        accountId: '999',
      };
      const bundle = service.encrypt(credentials);

      // The raw API key must NEVER appear in ciphertext, IV, or tag
      expect(bundle.ciphertext).not.toContain('SUPER_SECRET_API_KEY');
      expect(bundle.iv).not.toContain('SUPER_SECRET_API_KEY');
      expect(bundle.tag).not.toContain('SUPER_SECRET_API_KEY');
    });
  });

  describe('decrypt() error handling', () => {
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('throws BrokerAdapterError with DECRYPTION_FAILED on tampered data', () => {
      const credentials: DecryptedBrokerCredentials = { accountId: '123' };
      const bundle = service.encrypt(credentials);

      // Tamper with the ciphertext
      const tamperedBundle = { ...bundle, ciphertext: bundle.ciphertext.slice(0, -4) + 'dead' };

      expect(() => service.decrypt(tamperedBundle)).toThrow(BrokerAdapterError);
      expect(() => service.decrypt(tamperedBundle)).toThrow(
        expect.objectContaining({ code: BrokerErrorCode.DECRYPTION_FAILED }),
      );
    });

    it('marks decryption errors as non-retryable', () => {
      const bundle = { ciphertext: 'bad', iv: 'badbad', tag: 'badtag', keyId: 'test' };
      try {
        service.decrypt(bundle);
      } catch (err) {
        expect((err as BrokerAdapterError).isRetryable).toBe(false);
      }
    });
  });

  // ── Production-LIVE completion round (Phase 14): key rotation support ────

  describe('key rotation (BROKER_ENCRYPTION_KEYS)', () => {
    const NEW_KEY = 'rotated-primary-key-32-chars-pad!';
    const OLD_KEY = 'legacy-key-32-chars-padding-xyz!';

    const buildRotationService = (rotationList: string | undefined, baseKey?: string) => {
      const config = {
        get: jest.fn().mockImplementation((key: string, defaultVal?: string) => {
          if (key === 'BROKER_ENCRYPTION_KEY') return baseKey ?? TEST_ENCRYPTION_KEY;
          if (key === 'BROKER_ENCRYPTION_KEYS') return rotationList;
          return defaultVal;
        }),
      };
      return new CredentialEncryptionService(config as unknown as ConfigService);
    };

    it('single-key mode is unchanged: keyId env-key-v1, round-trip works', () => {
      const svc = buildRotationService(undefined);
      const bundle = svc.encryptJson({ token: 'abc' });
      expect(bundle.keyId).toBe('env-key-v1');
      expect(svc.primaryKeyId).toBe('env-key-v1');
      expect(svc.decryptJson(bundle)).toEqual({ token: 'abc' });
      expect(svc.needsReEncryption(bundle)).toBe(false);
    });

    it('the FIRST rotation entry is the primary WRITE key', () => {
      const svc = buildRotationService(`env-key-v2:${NEW_KEY},env-key-v1:${OLD_KEY}`);
      expect(svc.primaryKeyId).toBe('env-key-v2');
      const bundle = svc.encryptJson({ token: 'abc' });
      expect(bundle.keyId).toBe('env-key-v2');
      expect(svc.needsReEncryption(bundle)).toBe(false);
    });

    it('bundles encrypted under a RETAINED predecessor key still decrypt', () => {
      const oldSvc = buildRotationService(undefined, OLD_KEY);
      const legacyBundle = oldSvc.encryptJson({ token: 'old-secret' });
      expect(legacyBundle.keyId).toBe('env-key-v1');

      const rotatedSvc = buildRotationService(
        `env-key-v2:${NEW_KEY},env-key-v1:${OLD_KEY}`,
        OLD_KEY,
      );
      expect(rotatedSvc.decryptJson(legacyBundle)).toEqual({ token: 'old-secret' });
      // The legacy bundle is honestly flagged for re-encryption.
      expect(rotatedSvc.needsReEncryption(legacyBundle)).toBe(true);
    });

    it('rotation + re-encrypt round-trip: legacy bundle decrypts, re-encrypts under the new primary, and the re-encrypted bundle no longer needs re-encryption', () => {
      const oldSvc = buildRotationService(undefined, OLD_KEY);
      const legacyBundle = oldSvc.encryptJson({ token: 'old-secret' });

      const rotatedSvc = buildRotationService(
        `env-key-v2:${NEW_KEY},env-key-v1:${OLD_KEY}`,
        OLD_KEY,
      );
      const plaintext = rotatedSvc.decryptJson(legacyBundle);
      const reEncrypted = rotatedSvc.encryptJson(plaintext);
      expect(reEncrypted.keyId).toBe('env-key-v2');
      expect(rotatedSvc.needsReEncryption(reEncrypted)).toBe(false);
      expect(rotatedSvc.decryptJson(reEncrypted)).toEqual({ token: 'old-secret' });
    });

    it('fails CLOSED with a truthful rotation-gap error for an unlisted keyId', () => {
      const otherSvc = buildRotationService(undefined, 'a-different-32-char-key-padd!!!!');
      const foreignBundle = otherSvc.encryptJson({ token: 'x' });

      const rotatedSvc = buildRotationService(
        `env-key-v2:${NEW_KEY},env-key-v1:${OLD_KEY}`,
        OLD_KEY,
      );
      // env-key-v1 IS listed, but this bundle is env-key-v1 with a DIFFERENT
      // secret — GCM fails the auth tag (fail-closed tamper detection).
      expect(() => rotatedSvc.decryptJson(foreignBundle)).toThrow(BrokerAdapterError);

      const unknownSvc = buildRotationService(`env-key-v2:${NEW_KEY}`, OLD_KEY);
      const legacyBundle = buildRotationService(undefined, OLD_KEY).encryptJson({
        token: 'x',
      });
      // env-key-v1 is NOT in unknownSvc's list at all — rotation-gap failure.
      expect(() => unknownSvc.decryptJson(legacyBundle)).toThrow(/unknown key id env-key-v1/);
    });

    it('malformed rotation lists fail boot LOUDLY (no silent stranding)', () => {
      expect(() => buildRotationService('noseparator-here-at-all', OLD_KEY)).toThrow(
        /keyId:secret/,
      );
      expect(() => buildRotationService('env-key-v2:short', OLD_KEY)).toThrow(
        /at least 32 characters/,
      );
      expect(() =>
        buildRotationService(`env-key-v2:${NEW_KEY},env-key-v2:${OLD_KEY}`, OLD_KEY),
      ).toThrow(/duplicate keyId 'env-key-v2'/);
      expect(() => buildRotationService(',,,', OLD_KEY)).toThrow(/at least one keyId:secret/);
    });

    it('rotation mode still requires the legacy BROKER_ENCRYPTION_KEY at boot', () => {
      expect(() => buildRotationService(`env-key-v2:${NEW_KEY}`, '')).toThrow(
        /still requires BROKER_ENCRYPTION_KEY/,
      );
    });
  });
});
