import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';
import type { DecryptedBrokerCredentials } from '../interfaces/broker-adapter.interface';
import { CredentialEncryptionService } from '../services/credential-encryption.service';
import { DirectMt5PairingService } from './direct-mt5-pairing.service';

const HOSTED_WORKER_LEASE_SECONDS = 60;
const HOSTED_RECLAIM_STALE_SECONDS = 30;

export interface HostedMt5ProvisioningResult {
  brokerConnectionId: string;
  connectorId: string;
  hostMode: 'IREXPRO_HOSTED';
  state: 'PAIRING';
}

export interface HostedMt5WorkerAssignment {
  connectorId: string;
  brokerConnectionId: string;
  accountLogin: string;
  brokerServer: string;
  accountType: 'DEMO';
  connectorToken: string;
  tradingPassword: string;
}

type HostedConnectionRow = {
  id: string;
  user_id: string;
  broker_id: string;
  account_id: string | null;
  account_type: string;
  encrypted_credentials: string | null;
  credential_iv: string | null;
  credential_tag: string | null;
  encryption_key_id: string | null;
};

type HostedLeaseRow = HostedConnectionRow & {
  connector_id: string;
  broker_server: string | null;
  connector_state: string;
};

@Injectable()
export class HostedMt5Service {
  private readonly workerToken: string;

  constructor(
    private readonly dataSource: DataSource,
    private readonly encryptionService: CredentialEncryptionService,
    private readonly pairingService: DirectMt5PairingService,
    configService: ConfigService,
  ) {
    this.workerToken =
      configService.get<string>('broker.hostedMt5WorkerToken') ??
      configService.get<string>('HOSTED_MT5_WORKER_TOKEN', '');
  }

  async provision(userId: string, brokerConnectionId: string): Promise<HostedMt5ProvisioningResult> {
    const rows = (await this.dataSource.query(
      `
        SELECT id, user_id, broker_id, account_id, account_type,
               encrypted_credentials, credential_iv, credential_tag, encryption_key_id
        FROM broker.broker_connections
        WHERE id = $1
          AND user_id = $2
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [brokerConnectionId, userId],
    )) as HostedConnectionRow[];
    const connection = rows[0];
    if (!connection) throw new NotFoundException('Broker connection not found');
    if (connection.broker_id !== 'direct-mt5') {
      throw new BadRequestException('Hosted execution is available only for Direct MT5 connections');
    }
    if (connection.account_type !== 'DEMO') {
      throw new ForbiddenException(
        'iRexPro Hosted MT5 is DEMO-only until hosted execution certification is complete',
      );
    }
    if (!connection.account_id || !/^\d+$/.test(connection.account_id)) {
      throw new BadRequestException('MT5 account login is invalid');
    }

    const credentials = this.decryptCredentials(connection);
    try {
      const { brokerServer } = this.requireHostedCredentials(credentials);
      const requestedConnectorId = randomUUID();
      const connectorRows = (await this.dataSource.query(
        `
          WITH cancelled AS (
            UPDATE broker.direct_mt5_commands
            SET state = 'CANCELLED', lease_owner = NULL, lease_expires_at = NULL,
                error = COALESCE(error, 'hosted MT5 reprovisioned before command dispatch'),
                updated_at = now(), completed_at = COALESCE(completed_at, now())
            WHERE broker_connection_id = $3 AND state = 'PENDING'
            RETURNING id
          ), uncertain AS (
            UPDATE broker.direct_mt5_commands
            SET state = 'UNCERTAIN', lease_expires_at = NULL,
                error = COALESCE(error, 'hosted MT5 reprovisioned after command lease; reconcile provider state'),
                updated_at = now()
            WHERE broker_connection_id = $3 AND state = 'LEASED'
            RETURNING id
          ), hosted AS (
            INSERT INTO broker.direct_mt5_connectors (
              id, user_id, broker_connection_id, account_type, host_mode,
              pairing_code_hash, pairing_expires_at, state, token_hash,
              account_login, broker_server, currency, trade_allowed,
              paired_at, last_heartbeat_at, last_sequence,
              host_worker_id, host_lease_expires_at, host_last_seen_at, host_last_error,
              created_at, updated_at
            ) VALUES (
              $1, $2, $3, 'DEMO', 'IREXPRO_HOSTED',
              NULL, NULL, 'PAIRING', NULL,
              $4, $5, NULL, false,
              NULL, NULL, 0,
              NULL, NULL, NULL, NULL,
              now(), now()
            )
            ON CONFLICT (broker_connection_id) DO UPDATE SET
              user_id = EXCLUDED.user_id,
              account_type = 'DEMO',
              host_mode = 'IREXPRO_HOSTED',
              pairing_code_hash = NULL,
              pairing_expires_at = NULL,
              state = 'PAIRING',
              token_hash = NULL,
              account_login = EXCLUDED.account_login,
              broker_server = EXCLUDED.broker_server,
              currency = NULL,
              trade_allowed = false,
              paired_at = NULL,
              last_heartbeat_at = NULL,
              last_sequence = 0,
              host_worker_id = NULL,
              host_lease_expires_at = NULL,
              host_last_seen_at = NULL,
              host_last_error = NULL,
              updated_at = now()
            RETURNING id
          )
          SELECT id FROM hosted
        `,
        [requestedConnectorId, userId, brokerConnectionId, connection.account_id, brokerServer],
      )) as Array<{ id: string }>;
      const connectorId = connectorRows[0]?.id;
      if (!connectorId) throw new ConflictException('Hosted MT5 provisioning could not be created');

      await this.dataSource.query(
        `UPDATE broker.broker_connections
         SET status='CONNECTING', authorization_status='NOT_CONNECTED',
             demo_validated=false, live_trading_enabled=false, updated_at=now()
         WHERE id=$1 AND user_id=$2 AND broker_id='direct-mt5' AND account_type='DEMO'`,
        [brokerConnectionId, userId],
      );

      return { brokerConnectionId, connectorId, hostMode: 'IREXPRO_HOSTED', state: 'PAIRING' };
    } finally {
      this.clearCredentials(credentials);
    }
  }

  async leaseAssignment(
    workerId: string,
    rawWorkerToken: string,
  ): Promise<HostedMt5WorkerAssignment | null> {
    this.assertWorkerToken(rawWorkerToken);
    this.assertWorkerId(workerId);

    return this.dataSource.transaction(async (manager) => {
      const rows = (await manager.query(
        `
          SELECT c.id AS connector_id, c.state AS connector_state, c.broker_server,
                 bc.id, bc.user_id, bc.broker_id, bc.account_id, bc.account_type,
                 bc.encrypted_credentials, bc.credential_iv, bc.credential_tag, bc.encryption_key_id
          FROM broker.direct_mt5_connectors c
          JOIN broker.broker_connections bc ON bc.id = c.broker_connection_id
          WHERE c.host_mode = 'IREXPRO_HOSTED'
            AND bc.broker_id = 'direct-mt5'
            AND bc.account_type = 'DEMO'
            AND bc.deleted_at IS NULL
            AND (
              c.state = 'PAIRING'
              OR (
                c.state = 'ACTIVE'
                AND (c.last_heartbeat_at IS NULL OR c.last_heartbeat_at < now() - interval '${HOSTED_RECLAIM_STALE_SECONDS} seconds')
                AND (c.host_lease_expires_at IS NULL OR c.host_lease_expires_at < now())
              )
            )
          ORDER BY c.created_at ASC
          FOR UPDATE OF c SKIP LOCKED
          LIMIT 1
        `,
      )) as HostedLeaseRow[];
      const row = rows[0];
      if (!row) return null;
      if (!row.account_id || !/^\d+$/.test(row.account_id)) {
        throw new BadRequestException('Hosted MT5 account login is invalid');
      }

      const credentials = this.decryptCredentials(row);
      try {
        const { tradingPassword, brokerServer } = this.requireHostedCredentials(credentials);
        if (!row.broker_server || row.broker_server !== brokerServer) {
          throw new ConflictException('Hosted MT5 broker server binding does not match stored credentials');
        }
        const connectorToken = randomBytes(32).toString('base64url');
        const tokenHash = this.pairingService.digestToken(connectorToken);

        await manager.query(
          `
            WITH cancelled AS (
              UPDATE broker.direct_mt5_commands
              SET state='CANCELLED', lease_owner=NULL, lease_expires_at=NULL,
                  error=COALESCE(error, 'hosted worker ownership rotated before dispatch'),
                  updated_at=now(), completed_at=COALESCE(completed_at, now())
              WHERE connector_id=$1 AND state='PENDING'
              RETURNING id
            ), uncertain AS (
              UPDATE broker.direct_mt5_commands
              SET state='UNCERTAIN', lease_expires_at=NULL,
                  error=COALESCE(error, 'hosted worker ownership rotated after lease; reconcile provider state'),
                  updated_at=now()
              WHERE connector_id=$1 AND state='LEASED'
              RETURNING id
            )
            UPDATE broker.direct_mt5_connectors
            SET state='ACTIVE', token_hash=$3,
                trade_allowed=false, last_heartbeat_at=NULL, last_sequence=0,
                host_worker_id=$2,
                host_lease_expires_at=now() + interval '${HOSTED_WORKER_LEASE_SECONDS} seconds',
                host_last_seen_at=now(), host_last_error=NULL,
                paired_at=COALESCE(paired_at, now()), updated_at=now()
            WHERE id=$1 AND host_mode='IREXPRO_HOSTED'
          `,
          [row.connector_id, workerId, tokenHash],
        );

        return {
          connectorId: row.connector_id,
          brokerConnectionId: row.id,
          accountLogin: row.account_id,
          brokerServer,
          accountType: 'DEMO' as const,
          connectorToken,
          tradingPassword,
        };
      } finally {
        // Do not clear until the returned assignment has copied the password string.
        this.clearCredentials(credentials);
      }
    });
  }

  async heartbeatAssignment(
    connectorId: string,
    workerId: string,
    rawWorkerToken: string,
    errorCode?: string | null,
  ): Promise<{ connectorId: string; renewed: true }> {
    this.assertWorkerToken(rawWorkerToken);
    this.assertWorkerId(workerId);
    const normalizedError = errorCode?.trim() || null;
    if (normalizedError && !/^[A-Z0-9][A-Z0-9_:-]{0,63}$/.test(normalizedError)) {
      throw new BadRequestException('Hosted MT5 worker error code is invalid');
    }
    const rows = (await this.dataSource.query(
      `
        UPDATE broker.direct_mt5_connectors
        SET host_last_seen_at=now(),
            host_lease_expires_at=now() + interval '${HOSTED_WORKER_LEASE_SECONDS} seconds',
            host_last_error=$3,
            updated_at=now()
        WHERE id=$1
          AND host_mode = 'IREXPRO_HOSTED'
          AND state='ACTIVE'
          AND host_worker_id = $2
          AND host_lease_expires_at > now()
        RETURNING id
      `,
      [connectorId, workerId, normalizedError],
    )) as Array<{ id: string }>;
    if (!rows[0]) throw new ConflictException('Hosted MT5 worker lease is not owned or has expired');
    return { connectorId: rows[0].id, renewed: true };
  }

  private decryptCredentials(connection: HostedConnectionRow): DecryptedBrokerCredentials {
    if (
      !connection.encrypted_credentials ||
      !connection.credential_iv ||
      !connection.credential_tag
    ) {
      throw new BadRequestException('Hosted MT5 connection has no stored encrypted credentials');
    }
    return this.encryptionService.decrypt({
      ciphertext: connection.encrypted_credentials,
      iv: connection.credential_iv,
      tag: connection.credential_tag,
      keyId: connection.encryption_key_id ?? 'env-key-v1',
    });
  }

  private requireHostedCredentials(credentials: DecryptedBrokerCredentials): {
    tradingPassword: string;
    brokerServer: string;
  } {
    const tradingPassword = credentials.apiSecret?.trim() ?? '';
    const brokerServer = credentials.additionalParams?.brokerServer?.trim() ?? '';
    if (!tradingPassword || !brokerServer || brokerServer.length > 255) {
      throw new BadRequestException(
        'Hosted MT5 requires an encrypted trading password and exact broker server name',
      );
    }
    return { tradingPassword, brokerServer };
  }

  private assertWorkerToken(rawToken: string): void {
    if (this.workerToken.length < 32 || !rawToken) {
      throw new UnauthorizedException('Hosted MT5 worker authentication failed');
    }
    const expected = Buffer.from(this.workerToken, 'utf8');
    const actual = Buffer.from(rawToken, 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new UnauthorizedException('Hosted MT5 worker authentication failed');
    }
  }

  private assertWorkerId(workerId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(workerId)) {
      throw new BadRequestException('Hosted MT5 worker id is invalid');
    }
  }

  private clearCredentials(credentials: DecryptedBrokerCredentials): void {
    for (const key of Object.keys(credentials)) {
      (credentials as unknown as Record<string, unknown>)[key] = null;
    }
  }
}
