import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BrokerConnectionStatus,
  BrokerMode,
} from '../../broker/interfaces/broker-adapter.interface';
import { BrokerAuthorizationStatus } from '../../broker/authorization/broker-authorization-status';
import { BrokerCredentialStatus } from '../../broker/authorization/broker-credential-status';
import { ReconciliationRunStatus } from '../../execution/reconciliation/reconciliation.enums';
import {
  LiveAccountAlertKind,
  LiveAccountAlertSeverity,
  LiveAccountEnvironment,
  LiveAutomationStatus,
  LiveConnectionHealth,
} from './live-account.enums';

/**
 * Live Account overview response DTOs (Sprint 50 PR-5 — Directive PHASE J).
 *
 * Field names, enum values, and nullability mirror the FROZEN shared contract
 * at packages/types/src/live-account.ts EXACTLY — these classes serialize to
 * that shape (all dates as ISO strings, monetary values as decimal strings).
 *
 * SECURITY (read-only projection by construction):
 * - no credential material ever enters these objects (the mapper only copies
 *   explicitly allow-listed fields from the entity);
 * - `lastErrorMessage` is sanitized + truncated before exposure;
 * - `maskedAccountId` is the only account identifier intended for display.
 */
export class LiveAccountFinancialSummaryDto {
  @ApiPropertyOptional({ nullable: true, example: 'USD' })
  currency: string | null;

  @ApiProperty({ description: 'Balance as a decimal string (never a float).' })
  balance: string;

  @ApiProperty({ description: 'Equity as a decimal string.' })
  equity: string;

  @ApiProperty({ description: 'Used margin as a decimal string.' })
  margin: string;

  @ApiProperty({ description: 'Free margin as a decimal string.' })
  freeMargin: string;

  @ApiPropertyOptional({ nullable: true, description: 'Margin level % as a decimal string.' })
  marginLevel: string | null;

  @ApiProperty({ minimum: 0 })
  openPositionsCount: number;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'Server timestamp of the last broker account sync (ISO string).',
  })
  syncedAt: string | null;
}

export class LiveReconciliationSummaryDto {
  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'null when no reconciliation run has ever executed.',
  })
  lastRunAt: string | null;

  @ApiPropertyOptional({
    nullable: true,
    enum: ReconciliationRunStatus,
    description: 'Status of the most recent run; null when no run exists.',
  })
  lastRunStatus: ReconciliationRunStatus | null;

  @ApiProperty({ minimum: 0, description: 'OPEN discrepancies right now (all severities).' })
  openDiscrepancies: number;

  @ApiProperty({ minimum: 0 })
  openCritical: number;

  @ApiProperty({ minimum: 0 })
  openWarning: number;

  @ApiProperty({ description: 'true when openCritical + openWarning === 0.' })
  inSync: boolean;
}

export class LiveAccountAlertViewDto {
  @ApiProperty({ enum: LiveAccountAlertKind })
  kind: LiveAccountAlertKind;

  @ApiProperty({ enum: LiveAccountAlertSeverity })
  severity: LiveAccountAlertSeverity;

  @ApiProperty({
    description: 'Stable key for list rendering (kind + scope).',
    example: 'CONNECTION_ERROR:conn-uuid',
  })
  key: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid', description: 'null when account-wide.' })
  connectionId: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'MetaTrader 5' })
  brokerName: string | null;

  @ApiProperty({ description: 'Human-readable summary — never raw backend internals.' })
  message: string;

  @ApiPropertyOptional({ nullable: true, description: 'Remediation hint.' })
  action: string | null;
}

export class LiveAccountConnectionViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  brokerName: string;

  @ApiPropertyOptional({ nullable: true })
  displayName: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '•••4123',
    description:
      'Masked account identifier safe for display (last 4 characters only) — ' +
      'the ONLY account identifier in this user-facing contract (Phase F ' +
      'accountId minimization: the full id never ships here).',
  })
  maskedAccountId: string | null;

  @ApiProperty({ enum: BrokerMode })
  accountType: BrokerMode;

  @ApiPropertyOptional({ nullable: true, example: 'USD' })
  accountCurrency: string | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1 })
  accountLeverage: number | null;

  @ApiProperty({ enum: BrokerConnectionStatus })
  connectionStatus: BrokerConnectionStatus;

  @ApiProperty({
    enum: BrokerAuthorizationStatus,
    description: 'Authorization state machine. ACTIVE is the only executable state.',
  })
  authorizationStatus: BrokerAuthorizationStatus;

  @ApiProperty({
    enum: BrokerCredentialStatus,
    description: 'Credential lifecycle metadata (no secrets).',
  })
  credentialStatus: BrokerCredentialStatus;

  @ApiProperty({
    description:
      'Fail-closed execution gate (Directive §14) — delegated to BrokerService.isConnectionExecutable.',
  })
  executable: boolean;

  @ApiProperty()
  liveTradingEnabled: boolean;

  @ApiProperty({
    enum: LiveConnectionHealth,
    description: 'Server-derived roll-up, fail-closed default UNKNOWN.',
  })
  health: LiveConnectionHealth;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  lastSyncAt: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  lastHealthCheckAt: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Sanitized, truncated (≤200 chars) connection error text; never provider internals.',
  })
  lastErrorMessage: string | null;

  @ApiPropertyOptional({
    type: LiveAccountFinancialSummaryDto,
    nullable: true,
    description:
      'null when no synchronized broker account row exists (never fabricated client-side).',
  })
  financial: LiveAccountFinancialSummaryDto | null;

  @ApiProperty({ type: LiveReconciliationSummaryDto })
  reconciliation: LiveReconciliationSummaryDto;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: string;
}

export class LiveAutomationSummaryDto {
  @ApiProperty({ enum: LiveAutomationStatus })
  status: LiveAutomationStatus;

  @ApiPropertyOptional({
    nullable: true,
    format: 'uuid',
    description: 'null when no trading session exists.',
  })
  sessionId: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  sessionConnectionId: string | null;

  @ApiProperty({ description: 'True when the user-level kill switch is engaged.' })
  killSwitchActive: boolean;

  @ApiPropertyOptional({ nullable: true })
  killSwitchReason: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  startedAt: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  endedAt: string | null;
}

export class LiveExecutionHealthSummaryDto {
  @ApiProperty({
    minimum: 0,
    description: 'Trades currently holding market exposure (status OPEN).',
  })
  openPositions: number;

  @ApiProperty({ minimum: 0, description: 'Orders in a working (non-terminal) state.' })
  workingOrders: number;

  @ApiProperty({
    minimum: 0,
    description: 'Orders + trades held in RECONCILIATION_PENDING right now.',
  })
  reconciliationPending: number;

  @ApiProperty({ minimum: 0, description: 'Terminal order rejections over the last 24h.' })
  rejectedLast24h: number;

  @ApiProperty({ minimum: 0, description: 'Terminal order fills over the last 24h.' })
  filledLast24h: number;
}

export class LiveAccountOverviewResponseDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Server generation time (ISO string).',
  })
  generatedAt: string;

  @ApiProperty({ type: [LiveAccountConnectionViewDto] })
  connections: LiveAccountConnectionViewDto[];

  @ApiProperty({ type: LiveAutomationSummaryDto })
  automation: LiveAutomationSummaryDto;

  @ApiProperty({ type: LiveExecutionHealthSummaryDto })
  executionHealth: LiveExecutionHealthSummaryDto;

  @ApiProperty({
    type: [LiveAccountAlertViewDto],
    description:
      'Server-derived from authoritative state — no separate alert store (Directive §38).',
  })
  alerts: LiveAccountAlertViewDto[];

  @ApiProperty({
    enum: LiveAccountEnvironment,
    description:
      'Worst-case environment banner (Directive §36): LIVE > DEMO > PAPER > UNKNOWN. ' +
      'UNKNOWN = environment provenance could not be established (no connections / ' +
      'no explicit mode) — never presented as PAPER.',
  })
  environment: LiveAccountEnvironment;

  @ApiProperty({ description: 'True when at least one broker connection exists.' })
  hasConnections: boolean;

  @ApiProperty({
    description:
      'Phase F partial-failure tri-state: true when the reconciliation state ' +
      '(latest runs + open discrepancy counts) was actually read from the store; ' +
      'false when the lookup itself failed — the zero-valued counts must never ' +
      'be rendered as "zero discrepancies".',
  })
  reconciliationLoaded: boolean;
}
