import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerAuthorizationStatus } from '../../broker/authorization/broker-authorization-status';
import { BrokerCredentialStatus } from '../../broker/authorization/broker-credential-status';
import {
  BrokerConnectionStatus,
  BrokerMode,
} from '../../broker/interfaces/broker-adapter.interface';

/**
 * Admin connections page DTO (Sprint 50 PR-6 — Directive PHASE L §39).
 *
 * Mirrors AdminConnectionRowView / AdminConnectionsPage from
 * packages/types/src/admin-live-account.ts EXACTLY: names, enums,
 * nullability, ISO date strings.
 *
 * SECURITY: the raw `accountId` and all credential material
 * (encryptedCredentials / credentialIv / credentialTag / encryptionKeyId)
 * are NEVER mapped — only the masked last-4 identifier is exposed.
 * `lastErrorMessage` is sanitized + truncated by the mapper's callers.
 */
export class AdminConnectionRowViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Owner user id (admin scope: cross-user by design).',
  })
  userId: string;

  @ApiProperty({ example: 'metatrader5' })
  brokerId: string;

  @ApiProperty({ example: 'MetaTrader 5' })
  brokerName: string;

  @ApiPropertyOptional({ nullable: true, example: 'Primary account' })
  displayName: string | null;

  @ApiPropertyOptional({ nullable: true, example: '•••9012' })
  maskedAccountId: string | null;

  @ApiProperty({ enum: BrokerMode })
  accountType: 'DEMO' | 'LIVE';

  @ApiProperty({ enum: BrokerConnectionStatus })
  connectionStatus: BrokerConnectionStatus;

  @ApiProperty({ enum: BrokerAuthorizationStatus })
  authorizationStatus: BrokerAuthorizationStatus;

  @ApiProperty({ enum: BrokerCredentialStatus })
  credentialStatus: BrokerCredentialStatus;

  @ApiProperty({ description: 'Fail-closed execution gate (server-computed).' })
  executable: boolean;

  @ApiProperty()
  liveTradingEnabled: boolean;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  lastSyncAt: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  lastHealthCheckAt: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Sanitized, truncated provider error (never raw internals).',
  })
  lastErrorMessage: string | null;

  @ApiProperty({ minimum: 0, description: 'OPEN reconciliation discrepancies on this connection.' })
  openDiscrepancies: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: string;
}

export class AdminConnectionsPageDto {
  @ApiProperty({ type: [AdminConnectionRowViewDto] })
  connections: AdminConnectionRowViewDto[];

  @ApiProperty({ minimum: 0, description: 'Total rows matching the filter (before pagination).' })
  total: number;

  @ApiProperty({ minimum: 1, maximum: 100 })
  limit: number;

  @ApiProperty({ minimum: 0 })
  offset: number;
}

function toIsoString(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/**
 * Masked account identifier: ONLY the last 4 characters, prefixed "•••".
 * Returns null when the identifier is absent or too short to mask safely.
 */
export function maskAccountId(accountId: string | null | undefined): string | null {
  if (!accountId || accountId.length < 4) return null;
  return `•••${accountId.slice(-4)}`;
}

/**
 * Entity → admin view mapper. `executable` and `lastErrorMessage` are
 * computed by the service (fail-closed gate delegation + sanitization) and
 * passed in — this mapper never touches credential material.
 */
export function toAdminConnectionRowView(
  connection: BrokerConnection,
  executable: boolean,
  sanitizedLastErrorMessage: string | null,
  openDiscrepancies: number,
): AdminConnectionRowViewDto {
  return {
    id: connection.id,
    userId: connection.userId,
    brokerId: connection.brokerId,
    brokerName: connection.brokerName,
    displayName: connection.displayName ?? null,
    maskedAccountId: maskAccountId(connection.accountId),
    accountType: connection.accountType,
    connectionStatus: connection.status,
    authorizationStatus: connection.authorizationStatus,
    credentialStatus: connection.credentialStatus,
    executable,
    liveTradingEnabled: connection.liveTradingEnabled === true,
    lastSyncAt: toIsoString(connection.lastSyncAt),
    lastHealthCheckAt: toIsoString(connection.lastHealthCheckAt),
    lastErrorMessage: sanitizedLastErrorMessage,
    openDiscrepancies,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}
