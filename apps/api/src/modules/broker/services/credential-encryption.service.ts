import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { DecryptedBrokerCredentials } from '../interfaces/broker-adapter.interface';
import { BrokerAdapterError, BrokerErrorCode } from '../interfaces/broker-adapter.errors';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_LENGTH = 32;

/** A named encryption key: `keyId` travels with every bundle it encrypts. */
interface NamedEncryptionKey {
  keyId: string;
  key: Buffer;
}

export interface EncryptedCredentialBundle {
  ciphertext: string;
  iv: string;
  tag: string;
  keyId: string;
}

/** JSON payload encrypted by encryptJson — any shape, NEVER token material in logs. */
export type EncryptedJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | { [key: string]: EncryptedJsonValue }
  | EncryptedJsonValue[];

/**
 * CredentialEncryptionService — AES-256-GCM symmetric encryption for broker credentials.
 *
 * ARCHITECTURE RULES:
 * - Encryption key is sourced from environment variable BROKER_ENCRYPTION_KEY
 *   (single-key mode, keyId 'env-key-v1') OR the rotation list
 *   BROKER_ENCRYPTION_KEYS ('keyId:secret,keyId:secret,...' — the FIRST entry
 *   is the PRIMARY WRITE key; every listed key remains readable so existing
 *   ciphertexts decrypt during and after a rotation).
 * - KEY ROTATION (production-LIVE completion round, Phase 14): rotate by
 *   (1) prepending the NEW key to BROKER_ENCRYPTION_KEYS as primary,
 *   (2) keeping every previous key in the list until no bundle carries its
 *   keyId, (3) re-writing credentials (rotateCredentials / OAuth token
 *   refresh / any credential re-save re-encrypts with the primary key),
 *   (4) removing retired keys once no bundle references them. Bundles
 *   encrypted with an unlisted keyId fail closed with a truthful
 *   key-rotation-gap error.
 * - In production, this key must be managed by AWS KMS or HashiCorp Vault (envelope encryption)
 * - Decrypted credentials are NEVER logged, NEVER returned in API responses
 * - This service is only ever called from BrokerService — never from controllers
 *
 * For production KMS envelope encryption:
 *   - A Data Encryption Key (DEK) is generated per credential set
 *   - The DEK is encrypted by KMS (Key Encryption Key / KEK)
 *   - Only the encrypted DEK is stored (encryptionKeyId field)
 *   - Decryption requires a call to KMS to unwrap the DEK first
 *
 * See: docs/architecture/09-broker-integration-architecture.md §6
 */
@Injectable()
export class CredentialEncryptionService {
  private readonly logger = new Logger(CredentialEncryptionService.name);
  /** Primary WRITE key (encrypts every new bundle). */
  private readonly primary: NamedEncryptionKey;
  /** Every READABLE key (primary + retained rotation predecessors), by keyId. */
  private readonly readKeys: Map<string, Buffer>;

  constructor(private readonly configService: ConfigService) {
    const rawKey = this.configService.get<string>('BROKER_ENCRYPTION_KEY', '');
    const rotationList = this.configService.get<string>('BROKER_ENCRYPTION_KEYS', '');

    if (rotationList && rotationList.trim() !== '') {
      const keys = this.parseRotationList(rotationList);
      if (keys.length === 0) {
        throw new InternalServerErrorException(
          'BROKER_ENCRYPTION_KEYS must contain at least one keyId:secret entry when set',
        );
      }
      this.primary = keys[0];
      this.readKeys = new Map(keys.map((k) => [k.keyId, k.key]));
      if (!rawKey || rawKey.length < KEY_LENGTH) {
        // The legacy variable remains the boot-time minimum even in rotation
        // mode — it is the 'env-key-v1' fallback the operator lists explicitly
        // when rotating away from it. Keeping the requirement prevents an
        // accidental boot with rotation active but the original key missing.
        throw new InternalServerErrorException(
          'BROKER_ENCRYPTION_KEYS rotation mode still requires BROKER_ENCRYPTION_KEY to be set ' +
            '(list the original key explicitly in BROKER_ENCRYPTION_KEYS as env-key-v1:<secret> ' +
            'while any bundle still carries that keyId)',
        );
      }
    } else {
      if (!rawKey || rawKey.length < KEY_LENGTH) {
        throw new InternalServerErrorException(
          'BROKER_ENCRYPTION_KEY must be set and at least 32 characters long',
        );
      }
      this.primary = { keyId: 'env-key-v1', key: Buffer.from(rawKey.slice(0, KEY_LENGTH), 'utf8') };
      this.readKeys = new Map([[this.primary.keyId, this.primary.key]]);
    }
  }

  /**
   * Parse 'keyId:secret,keyId:secret,...'. Secrets must be ≥32 chars (only
   * the first 32 are used — same discipline as the legacy variable).
   * Malformed entries, duplicates, or empty ids fail boot LOUDLY — a
   * silently-ignored rotation entry would strand ciphertexts.
   */
  private parseRotationList(raw: string): NamedEncryptionKey[] {
    const keys: NamedEncryptionKey[] = [];
    const seen = new Set<string>();
    for (const entry of raw.split(',')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const separator = trimmed.indexOf(':');
      if (separator <= 0 || separator === trimmed.length - 1) {
        throw new InternalServerErrorException(
          'BROKER_ENCRYPTION_KEYS entries must be keyId:secret pairs (comma-separated)',
        );
      }
      const keyId = trimmed.slice(0, separator).trim();
      const secret = trimmed.slice(separator + 1).trim();
      if (!keyId || secret.length < KEY_LENGTH) {
        throw new InternalServerErrorException(
          `BROKER_ENCRYPTION_KEYS entry '${keyId || '(empty)'}' is invalid — ` +
            'keyId must be non-empty and the secret at least 32 characters',
        );
      }
      if (seen.has(keyId)) {
        throw new InternalServerErrorException(
          `BROKER_ENCRYPTION_KEYS contains duplicate keyId '${keyId}'`,
        );
      }
      seen.add(keyId);
      keys.push({ keyId, key: Buffer.from(secret.slice(0, KEY_LENGTH), 'utf8') });
    }
    return keys;
  }

  /**
   * Encrypt broker credentials.
   * Returns ciphertext, IV, auth tag, and key identifier — all safe to persist.
   */
  encrypt(credentials: DecryptedBrokerCredentials): EncryptedCredentialBundle {
    return this.encryptJson(credentials as unknown as EncryptedJsonValue);
  }

  /**
   * Decrypt broker credentials.
   * The result is in-memory only — NEVER log or serialize the return value.
   */
  decrypt(bundle: EncryptedCredentialBundle): DecryptedBrokerCredentials {
    return this.decryptJson(bundle) as unknown as DecryptedBrokerCredentials;
  }

  // ─── Generic JSON encryption (Sprint 56 correction round 2, finding 2) ─────

  /**
   * Encrypt an arbitrary JSON-serialisable value (AES-256-GCM) — used by
   * BrokerOAuthService to persist OAuth token bundles in the shared flow
   * store WITHOUT plaintext tokens at rest. The decrypted result must NEVER
   * be logged or returned in a response.
   */
  encryptJson(value: EncryptedJsonValue): EncryptedCredentialBundle {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.primary.key, iv);

    const plaintext = JSON.stringify(value);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      keyId: this.primary.keyId,
    };
  }

  /**
   * True when the bundle is NOT encrypted with the current primary key — a
n   * caller that re-persists credentials should re-encrypt (encryptJson) so
   * retired keys can eventually be dropped from the rotation list.
   */
  needsReEncryption(bundle: EncryptedCredentialBundle): boolean {
    return bundle.keyId !== this.primary.keyId;
  }

  /** The keyId every newly-encrypted bundle carries (the primary write key). */
  get primaryKeyId(): string {
    return this.primary.keyId;
  }

  /**
   * Decrypt a bundle produced by encryptJson. Fails closed (BrokerAdapterError
   * DECRYPTION_FAILED) on any tampering — GCM auth-tag mismatch, wrong key,
   * or malformed input. The result is in-memory only.
   */
  decryptJson(bundle: EncryptedCredentialBundle): EncryptedJsonValue {
    try {
      const iv = Buffer.from(bundle.iv, 'hex');
      const tag = Buffer.from(bundle.tag, 'hex');
      const ciphertext = Buffer.from(bundle.ciphertext, 'hex');

      const key = this.readKeys.get(bundle.keyId);
      if (!key) {
        // Truthful key-rotation-gap failure: the bundle names a key this
        // process cannot read. Fail closed with a message that names the
        // keyId (a non-secret identifier) — never the key material.
        this.logger.error(
          `Credential decryption failed: bundle keyId '${bundle.keyId}' is not in the active ` +
            'rotation list (key rotation gap)',
        );
        throw new BrokerAdapterError(
          BrokerErrorCode.DECRYPTION_FAILED,
          `Failed to decrypt broker credentials (unknown key id ${bundle.keyId})`,
          undefined,
          false,
        );
      }

      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(tag);

      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8')) as EncryptedJsonValue;
    } catch (err) {
      if (err instanceof BrokerAdapterError) throw err;
      // Log the error type only — never log the key, IV, or any credential data
      this.logger.error('Credential decryption failed', (err as Error).message);
      throw new BrokerAdapterError(
        BrokerErrorCode.DECRYPTION_FAILED,
        'Failed to decrypt broker credentials',
        undefined,
        false,
      );
    }
  }
}
