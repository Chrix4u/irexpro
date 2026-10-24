import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

const PAIRING_TTL_MS = 10 * 60_000;
const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

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

@Injectable()
export class DirectMt5PairingService {
  private readonly pepper: string;

  constructor(
    private readonly dataSource: DataSource,
    configService: ConfigService,
  ) {
    const pepper = configService.get<string>('DIRECT_MT5_CONNECTOR_PEPPER', '');
    if (pepper.length < 32) {
      throw new Error('DIRECT_MT5_CONNECTOR_PEPPER must be configured with at least 32 characters');
    }
    this.pepper = pepper;
  }

  async createPairing(userId: string, brokerConnectionId: string): Promise<DirectMt5PairingResult> {
    const rows = (await this.dataSource.query(
      `
        SELECT id, broker_id
        FROM broker.broker_connections
        WHERE id = $1
          AND user_id = $2
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [brokerConnectionId, userId],
    )) as Array<{ id: string; broker_id: string }>;
    const connection = rows[0];
    if (!connection) {
      throw new NotFoundException('Broker connection not found');
    }
    if (connection.broker_id !== 'metatrader5') {
      throw new BadRequestException('Direct connector pairing is available only for MetaTrader 5');
    }

    const connectorId = randomUUID();
    const pairingCode = this.generatePairingCode();
    const pairingHash = this.digest('pairing', pairingCode);
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);

    await this.dataSource.query(
      `
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
        UPDATE broker.direct_mt5_connectors
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
        WHERE pairing_code_hash = $1
          AND state = 'PAIRING'
          AND pairing_expires_at > now()
        RETURNING id, broker_connection_id, user_id
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
      throw new BadRequestException('Pairing code is invalid or expired');
    }

    return {
      connectorId: connector.id,
      brokerConnectionId: connector.broker_connection_id,
      connectorToken,
    };
  }

  digestToken(token: string): string {
    return this.digest('token', token);
  }

  private digest(domain: 'pairing' | 'token', value: string): string {
    return createHmac('sha256', this.pepper).update(`${domain}:${value}`, 'utf8').digest('hex');
  }

  private normalizePairingCode(value: string): string {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '');
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
