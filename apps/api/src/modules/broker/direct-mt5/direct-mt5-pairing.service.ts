import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { DataSource } from 'typeorm';

const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const DIRECT_MT5_HEARTBEAT_STALE_MS = 15_000;

export type DirectMt5ConnectorState = 'UNPAIRED' | 'PAIRING' | 'ACTIVE' | 'SUSPENDED' | 'REVOKED';
export type DirectMt5ConnectorHealthReason =
  | 'READY'
  | 'NOT_PAIRED'
  | 'PAIRING_INCOMPLETE'
  | 'CONNECTOR_SUSPENDED'
  | 'CONNECTOR_REVOKED'
  | 'HEARTBEAT_MISSING'
  | 'HEARTBEAT_INVALID'
  | 'HEARTBEAT_STALE'
  | 'TRADING_DISABLED';

export interface DirectMt5ConnectionHealth {
  connectorId: string | null;
  brokerConnectionId: string;
  state: DirectMt5ConnectorState;
  connected: boolean;
  executionReady: boolean;
  tradeAllowed: boolean;
  lastHeartbeatAt: Date | null;
  heartbeatAgeMs: number | null;
  accountLogin: string | null;
  brokerServer: string | null;
  reason: DirectMt5ConnectorHealthReason;
}

export interface DirectMt5TerminalIdentity {
  accountLogin: string;
  brokerServer: string;
  currency: string | null;
  tradeAllowed: boolean;
}

export interface DirectMt5PairingResult {
  connectorId: string;
  brokerConnectionId: string;
  pairingCode: string;
  expiresAt: Date;
}

export interface DirectMt5RedeemResult {
  connectorId: string;
  brokerConnectionId: string;
  connectorToken: string;
}

export interface DirectMt5ConnectorBinding {
  connectorId: string;
  userId: string;
  brokerConnectionId: string;
  accountLogin: string;
  brokerServer: string;
  lastSequence: number;
}

export interface DirectMt5HeartbeatInput {
  accountLogin: string;
  brokerServer: string;
  sequence: number;
  tradeAllowed: boolean;
}

@Injectable()
export class DirectMt5PairingService {
  private readonly pepper: string;

  constructor(
    private readonly dataSource: DataSource,
    configService: ConfigService,
  ) {
    const pepper =
      configService.get<string>('broker.directMt5ConnectorPepper') ??
      configService.get<string>('DIRECT_MT5_CONNECTOR_PEPPER', '');
    // Phase-1 may be deployed before direct MT5 is enabled. Keep API bootstrap
    // healthy, but fail closed on the first pairing/token operation until the
    // operator provisions this secret.
    this.pepper = pepper;
  }

  async createPairing(userId: string, brokerConnectionId: string): Promise<DirectMt5PairingResult> {
    const rows = (await this.dataSource.query(
      `
        SELECT id, broker_id, account_type
        FROM broker.broker_connections
        WHERE id = $1
          AND user_id = $2
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [brokerConnectionId, userId],
    )) as Array<{ id: string; broker_id: string; account_type: string }>;
    const connection = rows[0];
    if (!connection) {
      throw new NotFoundException('Broker connection not found');
    }
    if (connection.broker_id !== 'metatrader5') {
      throw new BadRequestException('Direct connector pairing is available only for MetaTrader 5');
    }
    if (connection.account_type !== 'DEMO') {
      throw new BadRequestException(
        'Direct MT5 onboarding is DEMO-only until LIVE is explicitly certified',
      );
    }

    const connectorId = randomUUID();
    const pairingCode = this.generatePairingCode();
    const pairingHash = this.digest('pairing', pairingCode);
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);

    await this.dataSource.query(
      `
        WITH cancelled AS (
          UPDATE broker.direct_mt5_commands
          SET state = 'CANCELLED',
              lease_owner = NULL,
              lease_expires_at = NULL,
              error = COALESCE(error, 'connector re-paired before command dispatch'),
              updated_at = now(),
              completed_at = COALESCE(completed_at, now())
          WHERE broker_connection_id = $3
            AND state = 'PENDING'
          RETURNING id
        ), uncertain AS (
          UPDATE broker.direct_mt5_commands
          SET state = 'UNCERTAIN',
              lease_expires_at = NULL,
              error = COALESCE(error, 'connector re-paired after command lease; reconcile provider state'),
              updated_at = now()
          WHERE broker_connection_id = $3
            AND state = 'LEASED'
          RETURNING id
        ), paired AS (
          INSERT INTO broker.direct_mt5_connectors (
            id, user_id, broker_connection_id, pairing_code_hash, pairing_expires_at,
            state, token_hash, account_login, broker_server, currency, trade_allowed,
            paired_at, last_heartbeat_at, last_sequence, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, 'PAIRING', NULL, NULL, NULL, NULL, false,
                    NULL, NULL, 0, now(), now())
          ON CONFLICT (broker_connection_id) DO UPDATE SET
            id = EXCLUDED.id,
            user_id = EXCLUDED.user_id,
            pairing_code_hash = EXCLUDED.pairing_code_hash,
            pairing_expires_at = EXCLUDED.pairing_expires_at,
            state = 'PAIRING',
            token_hash = NULL,
            account_login = NULL,
            broker_server = NULL,
            currency = NULL,
            trade_allowed = false,
            paired_at = NULL,
            last_heartbeat_at = NULL,
            last_sequence = 0,
            updated_at = now()
          RETURNING id
        )
        SELECT id FROM paired
      `,
      [connectorId, userId, brokerConnectionId, pairingHash, expiresAt],
    );

    return { connectorId, brokerConnectionId, pairingCode, expiresAt };
  }

  async redeemPairing(
    pairingCode: string,
    identity: DirectMt5TerminalIdentity,
  ): Promise<DirectMt5RedeemResult> {
    this.assertIdentity(identity);
    const pairingHash = this.digest('pairing', this.normalizePairingCode(pairingCode));
    const connectorToken = randomBytes(32).toString('base64url');
    const tokenHash = this.digest('token', connectorToken);

    const rows = (await this.dataSource.query(
      `
        UPDATE broker.direct_mt5_connectors AS c
        SET state = 'ACTIVE',
            token_hash = $2,
            pairing_code_hash = NULL,
            pairing_expires_at = NULL,
            account_login = $3,
            broker_server = $4,
            currency = $5,
            trade_allowed = $6,
            paired_at = now(),
            last_heartbeat_at = now(),
            last_sequence = 0,
            updated_at = now()
        FROM broker.broker_connections AS bc
        WHERE c.pairing_code_hash = $1
          AND c.state = 'PAIRING'
          AND c.pairing_expires_at > now()
          AND bc.id = c.broker_connection_id
          AND bc.deleted_at IS NULL
          AND bc.broker_id = 'metatrader5'
          AND bc.account_id = $3
        RETURNING c.id, c.broker_connection_id, c.user_id
      `,
      [
        pairingHash,
        tokenHash,
        identity.accountLogin,
        identity.brokerServer,
        identity.currency,
        identity.tradeAllowed,
      ],
    )) as Array<{ id: string; broker_connection_id: string; user_id: string }>;

    const connector = rows[0];
    if (!connector) {
      throw new BadRequestException(
        'Pairing code is invalid or expired, or the MT5 account does not match this broker connection',
      );
    }

    return {
      connectorId: connector.id,
      brokerConnectionId: connector.broker_connection_id,
      connectorToken,
    };
  }

  async authenticateConnector(
    connectorId: string,
    rawToken: string,
  ): Promise<DirectMt5ConnectorBinding> {
    if (!connectorId || !rawToken) {
      throw new UnauthorizedException('Connector authentication failed');
    }
    const rows = (await this.dataSource.query(
      `
        SELECT id, user_id, broker_connection_id, token_hash,
               account_login, broker_server, last_sequence
        FROM broker.direct_mt5_connectors
        WHERE id = $1
          AND state = 'ACTIVE'
          AND token_hash IS NOT NULL
        LIMIT 1
      `,
      [connectorId],
    )) as Array<{
      id: string;
      user_id: string;
      broker_connection_id: string;
      token_hash: string;
      account_login: string;
      broker_server: string;
      last_sequence: string | number;
    }>;
    const row = rows[0];
    if (!row || !this.safeDigestEquals(row.token_hash, this.digestToken(rawToken))) {
      throw new UnauthorizedException('Connector authentication failed');
    }
    return {
      connectorId: row.id,
      userId: row.user_id,
      brokerConnectionId: row.broker_connection_id,
      accountLogin: row.account_login,
      brokerServer: row.broker_server,
      lastSequence: Number(row.last_sequence),
    };
  }

  async recordHeartbeat(
    binding: DirectMt5ConnectorBinding,
    heartbeat: DirectMt5HeartbeatInput,
  ): Promise<{ lastSequence: number }> {
    if (
      heartbeat.accountLogin !== binding.accountLogin ||
      heartbeat.brokerServer !== binding.brokerServer
    ) {
      await this.dataSource.query(
        `
          UPDATE broker.direct_mt5_connectors
          SET state = 'SUSPENDED', updated_at = now()
          WHERE id = $1 AND state = 'ACTIVE'
        `,
        [binding.connectorId],
      );
      throw new ConflictException('MT5 terminal identity changed; connector suspended');
    }
    if (!Number.isSafeInteger(heartbeat.sequence) || heartbeat.sequence <= binding.lastSequence) {
      throw new BadRequestException('Heartbeat sequence is stale or invalid');
    }

    const rows = (await this.dataSource.query(
      `
        UPDATE broker.direct_mt5_connectors
        SET last_sequence = $2,
            last_heartbeat_at = now(),
            trade_allowed = $3,
            updated_at = now()
        WHERE id = $1
          AND state = 'ACTIVE'
          AND account_login = $4
          AND broker_server = $5
          AND last_sequence < $2
        RETURNING id, last_sequence
      `,
      [
        binding.connectorId,
        heartbeat.sequence,
        heartbeat.tradeAllowed,
        binding.accountLogin,
        binding.brokerServer,
      ],
    )) as Array<{ id: string; last_sequence: string | number }>;
    const row = rows[0];
    if (!row) {
      throw new ConflictException('Heartbeat replay or concurrent connector activity detected');
    }
    return { lastSequence: Number(row.last_sequence) };
  }

  async getConnectionHealth(
    userId: string,
    brokerConnectionId: string,
    now = new Date(),
  ): Promise<DirectMt5ConnectionHealth> {
    const rows = (await this.dataSource.query(
      `
        SELECT id, state, account_login, broker_server, trade_allowed, last_heartbeat_at
        FROM broker.direct_mt5_connectors
        WHERE user_id = $1
          AND broker_connection_id = $2
        LIMIT 1
      `,
      [userId, brokerConnectionId],
    )) as Array<{
      id: string;
      state: Exclude<DirectMt5ConnectorState, 'UNPAIRED'>;
      account_login: string | null;
      broker_server: string | null;
      trade_allowed: boolean;
      last_heartbeat_at: Date | string | null;
    }>;
    const row = rows[0];
    if (!row) {
      return {
        connectorId: null,
        brokerConnectionId,
        state: 'UNPAIRED',
        connected: false,
        executionReady: false,
        tradeAllowed: false,
        lastHeartbeatAt: null,
        heartbeatAgeMs: null,
        accountLogin: null,
        brokerServer: null,
        reason: 'NOT_PAIRED',
      };
    }

    const lastHeartbeatAt = row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null;
    const heartbeatAtMs = lastHeartbeatAt?.getTime() ?? Number.NaN;
    const nowMs = now.getTime();
    const heartbeatAgeMs =
      Number.isFinite(heartbeatAtMs) && Number.isFinite(nowMs) ? nowMs - heartbeatAtMs : null;
    const base = {
      connectorId: row.id,
      brokerConnectionId,
      state: row.state,
      tradeAllowed: Boolean(row.trade_allowed),
      lastHeartbeatAt,
      heartbeatAgeMs,
      accountLogin: row.account_login,
      brokerServer: row.broker_server,
    };

    if (row.state === 'PAIRING') {
      return { ...base, connected: false, executionReady: false, reason: 'PAIRING_INCOMPLETE' };
    }
    if (row.state === 'SUSPENDED') {
      return { ...base, connected: false, executionReady: false, reason: 'CONNECTOR_SUSPENDED' };
    }
    if (row.state === 'REVOKED') {
      return { ...base, connected: false, executionReady: false, reason: 'CONNECTOR_REVOKED' };
    }
    if (!lastHeartbeatAt) {
      return { ...base, connected: false, executionReady: false, reason: 'HEARTBEAT_MISSING' };
    }
    if (heartbeatAgeMs === null || heartbeatAgeMs < 0) {
      return { ...base, connected: false, executionReady: false, reason: 'HEARTBEAT_INVALID' };
    }
    if (heartbeatAgeMs > DIRECT_MT5_HEARTBEAT_STALE_MS) {
      return { ...base, connected: false, executionReady: false, reason: 'HEARTBEAT_STALE' };
    }
    if (!row.trade_allowed) {
      return { ...base, connected: true, executionReady: false, reason: 'TRADING_DISABLED' };
    }
    return { ...base, connected: true, executionReady: true, reason: 'READY' };
  }

  async revokeConnector(
    userId: string,
    brokerConnectionId: string,
  ): Promise<{ connectorId: string; revoked: true }> {
    const rows = (await this.dataSource.query(
      `
        WITH revoked AS (
          UPDATE broker.direct_mt5_connectors
          SET state = 'REVOKED',
              token_hash = NULL,
              pairing_code_hash = NULL,
              pairing_expires_at = NULL,
              trade_allowed = false,
              updated_at = now()
          WHERE user_id = $1
            AND broker_connection_id = $2
          RETURNING id
        ), cancelled AS (
          UPDATE broker.direct_mt5_commands
          SET state = 'CANCELLED',
              lease_owner = NULL,
              lease_expires_at = NULL,
              error = COALESCE(error, 'connector revoked before command dispatch'),
              updated_at = now(),
              completed_at = COALESCE(completed_at, now())
          WHERE connector_id IN (SELECT id FROM revoked)
            AND state = 'PENDING'
          RETURNING id
        ), uncertain AS (
          UPDATE broker.direct_mt5_commands
          SET state = 'UNCERTAIN',
              lease_expires_at = NULL,
              error = COALESCE(error, 'connector revoked after command lease; reconcile provider state'),
              updated_at = now()
          WHERE connector_id IN (SELECT id FROM revoked)
            AND state = 'LEASED'
          RETURNING id
        )
        SELECT id FROM revoked
      `,
      [userId, brokerConnectionId],
    )) as Array<{ id: string }>;
    const row = rows[0];
    if (!row) {
      throw new NotFoundException('Direct MT5 connector not found');
    }
    return { connectorId: row.id, revoked: true };
  }

  digestToken(token: string): string {
    return this.digest('token', token);
  }

  private safeDigestEquals(expectedHex: string, actualHex: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(expectedHex) || !/^[0-9a-f]{64}$/i.test(actualHex)) {
      return false;
    }
    return timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'));
  }

  private digest(domain: 'pairing' | 'token', value: string): string {
    if (this.pepper.length < 32) {
      throw new Error('DIRECT_MT5_CONNECTOR_PEPPER must be configured with at least 32 characters');
    }
    return createHmac('sha256', this.pepper).update(`${domain}:${value}`, 'utf8').digest('hex');
  }

  private normalizePairingCode(value: string): string {
    const normalized = value
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '');
    if (!/^[A-Z2-9]{10}$/.test(normalized)) {
      throw new BadRequestException('Pairing code is invalid or expired');
    }
    return normalized;
  }

  private generatePairingCode(): string {
    const bytes = randomBytes(10);
    let code = '';
    for (const byte of bytes) {
      code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length];
    }
    return code;
  }

  private assertIdentity(identity: DirectMt5TerminalIdentity): void {
    if (!/^\d+$/.test(identity.accountLogin)) {
      throw new BadRequestException('MT5 account login is invalid');
    }
    if (!identity.brokerServer?.trim() || identity.brokerServer.length > 255) {
      throw new BadRequestException('MT5 broker server is invalid');
    }
    if (identity.currency !== null && !/^[A-Za-z]{3,8}$/.test(identity.currency)) {
      throw new BadRequestException('MT5 account currency is invalid');
    }
  }
}
