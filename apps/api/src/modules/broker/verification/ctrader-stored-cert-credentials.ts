/**
 * Operator-only credential source for an explicitly authorized cTrader LIVE
 * certification. This module never initiates certification or broker orders.
 * Do NOT call this from any HTTP controller, UI route, or background job.
 *
 * The operator must opt into the existing REAL-money certification harness,
 * supply an exact owner UUID, logical broker alias, connection UUID, and cTID
 * account ID. Read-only PostgreSQL lookup is restricted to this exact tuple.
 * No ciphertext or plaintext is logged, returned to browsers, or persisted.
 */
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { CredentialEncryptionService } from '../services/credential-encryption.service';
import {
  BrokerCredentialLifecycle,
  BrokerCredentialStatus,
} from '../authorization/broker-credential-status';
import { LiveCertificationConfigurationError } from './provider-live-certification-harness';

export interface StoredCTraderCertTarget {
  ownerUserId: string;
  connectionId: string;
  brokerId: string;
  ctidTraderAccountId: string;
}

export interface StoredCTraderCredentialRow {
  id: string;
  user_id: string;
  broker_id: string;
  account_id: string | null;
  account_type: string;
  provider_broker_identity: string | null;
  status: string;
  authorization_status: string;
  credential_status: string;
  encrypted_credentials: string | null;
  credential_iv: string | null;
  credential_tag: string | null;
  encryption_key_id: string | null;
}

export interface ValidatedStoredCTraderCredential {
  apiKey: string;
  accountId: string;
  /** Must be called after the operator's certification invocation. */
  clear: () => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BROKERS = ['ctrader', 'pepperstone-ctrader', 'icmarkets-ctrader'] as const;
const MINIMUM_REMAINING_TOKEN_MS = 5 * 60_000;

function refuse(reason: string): never {
  // Static, secret-free failure messages only.
  throw new LiveCertificationConfigurationError(reason);
}

export function assertStoredCTraderCertTarget(target: StoredCTraderCertTarget): void {
  if (!UUID.test(target.ownerUserId) || !UUID.test(target.connectionId)) {
    refuse('Stored LIVE certification requires explicit valid owner and connection UUIDs.');
  }
  if (!BROKERS.includes(target.brokerId as (typeof BROKERS)[number])) {
    refuse('Stored LIVE certification requires a supported cTrader family broker alias.');
  }
  if (!/^[1-9]\d{4,18}$/.test(target.ctidTraderAccountId)) {
    refuse('Stored LIVE certification requires an exact numeric cTID account ID.');
  }
}

export function assertStoredCTraderCertRow(
  row: StoredCTraderCredentialRow | undefined,
  target: StoredCTraderCertTarget,
): asserts row is StoredCTraderCredentialRow {
  assertStoredCTraderCertTarget(target);
  if (
    !row ||
    row.id !== target.connectionId ||
    row.user_id !== target.ownerUserId ||
    row.broker_id !== target.brokerId ||
    row.account_id !== target.ctidTraderAccountId ||
    row.account_type !== 'LIVE'
  ) {
    refuse(
      'Stored LIVE certification did not find the exact authorized owner/broker/account binding.',
    );
  }
  if (
    row.status !== 'CONNECTED' ||
    !['CONNECTED', 'ACTIVE'].includes(row.authorization_status) ||
    !BrokerCredentialLifecycle.isUsable(row.credential_status as BrokerCredentialStatus)
  ) {
    refuse('Stored LIVE certification connection is not connected or credentials are not usable.');
  }
  const provider = row.provider_broker_identity;
  if (
    !provider ||
    (target.brokerId === 'pepperstone-ctrader' && provider !== 'pepperstone') ||
    (target.brokerId === 'icmarkets-ctrader' && provider !== 'icmarkets')
  ) {
    refuse('Stored LIVE certification provider identity does not match its broker alias.');
  }
  if (
    !row.encrypted_credentials ||
    !row.credential_iv ||
    !row.credential_tag ||
    !row.encryption_key_id
  ) {
    refuse('Stored LIVE certification credential bundle is missing or incomplete.');
  }
}

/**
 * Validate the encrypted bundle locally. Does not refresh, expose, export, or
 * log a token. Never silently fall back to another account or environment.
 */
export function decodeStoredCTraderCredential(
  row: StoredCTraderCredentialRow,
  target: StoredCTraderCertTarget,
  encryptionKey: string | undefined,
  nowMs = Date.now(),
): ValidatedStoredCTraderCredential {
  assertStoredCTraderCertRow(row, target);
  if (!encryptionKey || encryptionKey.length < 32) {
    refuse('Stored LIVE certification requires a configured encryption key.');
  }
  let credentials:
    | {
        apiKey?: string;
        accountId?: string;
        additionalParams?: { refreshToken?: string; accessTokenExpiresAt?: string };
      }
    | undefined;
  try {
    const svc = new CredentialEncryptionService(
      new ConfigService({ BROKER_ENCRYPTION_KEY: encryptionKey }),
    );
    credentials = svc.decrypt({
      ciphertext: row.encrypted_credentials!,
      iv: row.credential_iv!,
      tag: row.credential_tag!,
      keyId: row.encryption_key_id!,
    });
  } catch {
    refuse('Stored LIVE certification credential bundle could not be authenticated.');
  }
  const expiry = credentials.additionalParams?.accessTokenExpiresAt;
  const expiryTime = typeof expiry === 'string' ? Date.parse(expiry) : Number.NaN;
  if (
    credentials.accountId !== target.ctidTraderAccountId ||
    typeof credentials.apiKey !== 'string' ||
    credentials.apiKey.length < 8 ||
    !Number.isFinite(expiryTime) ||
    expiryTime - nowMs <= MINIMUM_REMAINING_TOKEN_MS
  ) {
    if (credentials)
      for (const key of Object.keys(credentials)) {
        (credentials as Record<string, unknown>)[key] = undefined;
      }
    refuse(
      'Stored LIVE certification OAuth token is mismatched, missing or too close to expiry; reauthorize.',
    );
  }
  // Local-only short-lived reference; caller clears after the certification.
  const result: ValidatedStoredCTraderCredential = {
    apiKey: credentials.apiKey,
    accountId: target.ctidTraderAccountId,
    clear: () => {
      result.apiKey = '';
      if (credentials) {
        for (const key of Object.keys(credentials)) {
          (credentials as Record<string, unknown>)[key] = undefined;
        }
      }
    },
  };
  return result;
}

/**
 * Real DB access only when an explicitly gated human operator invokes the
 * LIVE spec with credential source 'stored'. No module-initialization queries.
 * A single parameterized SELECT, transaction set READ ONLY, closed in finally.
 */
export async function loadStoredCTraderCertCredential(
  target: StoredCTraderCertTarget,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ValidatedStoredCTraderCredential> {
  assertStoredCTraderCertTarget(target);
  if (
    env.IREXPRO_ALLOW_LIVE_CERTIFICATION !== 'true' ||
    env.CTRADER_LIVE_CERT_CREDENTIAL_SOURCE !== 'stored' ||
    env.IREXPRO_LIVE_CERT_OPERATOR_ID?.trim() === ''
  ) {
    refuse('Stored LIVE certification requires explicit operator and master gate.');
  }
  if (!env.IREXPRO_LIVE_CERT_OPERATOR_ID) {
    refuse('Stored LIVE certification operator identity is missing.');
  }
  const database = new Client({
    host: env.DB_HOST,
    port: Number(env.DB_PORT || '5432'),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    ssl: env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 7000,
    application_name: 'irexpro_operator_ctrader_cert_stored_source',
  });
  let connected = false;
  try {
    await database.connect();
    connected = true;
    await database.query('BEGIN READ ONLY');
    const records = await database.query<StoredCTraderCredentialRow>(
      `SELECT id::text,user_id::text,broker_id,account_id,account_type,
              provider_broker_identity,status,authorization_status,credential_status,
              encrypted_credentials,credential_iv,credential_tag,encryption_key_id
         FROM broker.broker_connections
        WHERE id=$1::uuid AND user_id=$2::uuid AND broker_id=$3
          AND account_id=$4 AND account_type='LIVE' AND deleted_at IS NULL
        LIMIT 2`,
      [target.connectionId, target.ownerUserId, target.brokerId, target.ctidTraderAccountId],
    );
    if (records.rows.length !== 1) {
      refuse('Stored LIVE certification did not identify exactly one authorized connection.');
    }
    return decodeStoredCTraderCredential(records.rows[0]!, target, env.BROKER_ENCRYPTION_KEY);
  } catch (error) {
    if (error instanceof LiveCertificationConfigurationError) throw error;
    return refuse('Stored LIVE certification credential lookup failed (no credentials exposed).');
  } finally {
    if (connected) {
      try {
        await database.query('ROLLBACK');
      } catch {
        /* closed connection is inert */
      }
    }
    try {
      await database.end();
    } catch {
      /* best effort cleanup */
    }
  }
}
