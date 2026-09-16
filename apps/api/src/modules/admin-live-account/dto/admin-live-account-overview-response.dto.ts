import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ExecutionControlScope,
  ExecutionControlStatus,
} from '../../execution-control/entities/execution-control.entity';

/**
 * Admin Live Operations overview DTO (Sprint 50 PR-6 — Directive PHASE L §39).
 *
 * Mirrors AdminConnectionStateCounts / AdminDiscrepancyCounts /
 * AdminExecutionControlView / AdminExpiredControlsView /
 * AdminProviderRegistryEntry / AdminLiveOpsOverviewView from
 * packages/types/src/admin-live-account.ts EXACTLY: names, enums,
 * nullability, ISO date strings. (Compat nuance: control `status` and
 * `expiredControls` are optional on the shared type — older payloads may omit
 * them — while this API always emits both.)
 *
 * SECURITY: no credential material, no provider secrets, no audit metadata
 * blobs. Control `reason` is sanitized to plain text before mapping.
 */
export class AdminConnectionStateCountsDto {
  @ApiProperty({ minimum: 0 })
  total: number;

  @ApiProperty({ minimum: 0, description: 'connectionStatus = CONNECTED' })
  connected: number;

  @ApiProperty({ minimum: 0, description: 'connectionStatus = CONNECTING' })
  connecting: number;

  @ApiProperty({ minimum: 0, description: 'connectionStatus = ERROR' })
  error: number;

  @ApiProperty({ minimum: 0, description: 'connectionStatus = DISCONNECTED' })
  disconnected: number;

  @ApiProperty({
    minimum: 0,
    description:
      'connectionStatus = SUSPENDED (distinct from the authorizationStatus suspended bucket).',
  })
  suspendedConnectionStatus: number;

  @ApiProperty({
    minimum: 0,
    description: 'authorizationStatus granted (AUTHORIZED/READY/ACTIVE).',
  })
  authorized: number;

  @ApiProperty({ minimum: 0, description: 'authorizationStatus = AUTHORIZATION_REQUIRED' })
  authorizationRequired: number;

  @ApiProperty({ minimum: 0, description: 'authorizationStatus = REVOKED' })
  revoked: number;

  @ApiProperty({
    minimum: 0,
    description: 'authorizationStatus = SUSPENDED (distinct from suspendedConnectionStatus).',
  })
  suspended: number;

  @ApiProperty({ minimum: 0, description: 'accountType = DEMO' })
  demo: number;

  @ApiProperty({ minimum: 0, description: 'accountType = LIVE' })
  live: number;
}

export class AdminDiscrepancyCountsDto {
  @ApiProperty({ minimum: 0 })
  open: number;

  @ApiProperty({ minimum: 0 })
  openCritical: number;

  @ApiProperty({ minimum: 0 })
  openWarning: number;

  @ApiProperty({ minimum: 0 })
  openInfo: number;

  @ApiProperty({ minimum: 0, description: 'status = RESOLVED and resolvedAt within the last 24h.' })
  resolvedLast24h: number;
}

export class AdminExecutionControlViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ExecutionControlScope })
  scope: 'GLOBAL' | 'PROVIDER' | 'USER' | 'BROKER_CONNECTION';

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Normalized display target (broker id / masked user or connection / null for GLOBAL).',
  })
  scopeTarget: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Sanitized plain-text reason.' })
  reason: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  activatedBy: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  activatedAt: string;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  expiresAt: string | null;

  @ApiProperty({
    enum: ExecutionControlStatus,
    description:
      'Lifecycle status: ACTIVE = currently blocking; EXPIRED = retained record (never blocking; reactivation replaces it).',
  })
  status: 'ACTIVE' | 'EXPIRED';
}

export class AdminExpiredControlsViewDto {
  @ApiProperty({ minimum: 0, description: 'Total retained expired records.' })
  count: number;

  @ApiProperty({
    type: [AdminExecutionControlViewDto],
    description: 'Most recent expired records by activatedAt desc (bounded to 50).',
  })
  controls: AdminExecutionControlViewDto[];
}

/**
 * Production-LIVE verification evidence (R7-audit-D #12) — mirrors
 * BrokerProductionLiveVerification from packages/types/src/broker-registry.ts
 * (the exact type GET /broker/registry carries) so Admin Live Ops can render
 * verification state from the overview without a second registry call.
 */
export class AdminProductionLiveVerificationDto {
  @ApiProperty({ enum: ['UNVERIFIED', 'VERIFIED'] })
  status: 'UNVERIFIED' | 'VERIFIED';

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'Operator-attested verification timestamp (null when unverified or legacy-attested without a dated artifact).',
  })
  verifiedAt: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Doc/ticket evidence reference (never secrets; null when unverified).',
  })
  evidenceRef: string | null;

  @ApiPropertyOptional({
    enum: ['LEGACY_ATTESTATION', 'HARNESS_CERTIFIED'],
    nullable: true,
    description:
      'Round 7.1 (P0-3): provenance — LEGACY_ATTESTATION (historical operator ' +
      'attestation, predates the certification protocol) vs HARNESS_CERTIFIED ' +
      '(documented protocol run with a durable evidence artifact).',
  })
  certifiedVia: 'LEGACY_ATTESTATION' | 'HARNESS_CERTIFIED' | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Harness run reference (runId@sha256:<hash>) for HARNESS_CERTIFIED entries; null otherwise.',
  })
  certificationRunRef: string | null;

  @ApiProperty({
    enum: ['NOT_CERTIFIED', 'LEGACY_VERIFIED', 'CERTIFIED'],
    description:
      'Round 7.1 (P0-3): truthful derived certification state — legacy ' +
      'verification is NEVER presented as a current protocol certification.',
  })
  certificationState: 'NOT_CERTIFIED' | 'LEGACY_VERIFIED' | 'CERTIFIED';
}

export class AdminProviderRegistryEntryDto {
  @ApiProperty({ example: 'metatrader5' })
  brokerId: string;

  @ApiProperty({ example: 'MetaTrader 5' })
  brokerName: string;

  @ApiProperty({ type: [String], example: ['ACCOUNT_READ', 'ORDER_READ'] })
  capabilities: string[];

  @ApiProperty()
  supportsDemo: boolean;

  @ApiProperty()
  supportsLive: boolean;

  @ApiProperty({
    type: AdminProductionLiveVerificationDto,
    description:
      'Production-LIVE verification evidence — BETA ≠ production-LIVE (always emitted; mirrors the broker registry response).',
  })
  productionLiveVerification: AdminProductionLiveVerificationDto;

  @ApiProperty({
    enum: ['NOT_CERTIFIED', 'LEGACY_VERIFIED', 'CERTIFIED'],
    description:
      'Round 7.1 (P0-3): truthful derived certification state — legacy ' +
      'verification is NEVER presented as a current protocol certification.',
  })
  certificationState: 'NOT_CERTIFIED' | 'LEGACY_VERIFIED' | 'CERTIFIED';
}

export class AdminLiveOpsOverviewViewDto {
  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt: string;

  @ApiProperty({ type: AdminConnectionStateCountsDto })
  connections: AdminConnectionStateCountsDto;

  @ApiProperty({ type: AdminDiscrepancyCountsDto })
  discrepancies: AdminDiscrepancyCountsDto;

  @ApiProperty({
    type: [AdminExecutionControlViewDto],
    description: 'Active emergency execution controls.',
  })
  activeControls: AdminExecutionControlViewDto[];

  @ApiProperty({
    type: AdminExpiredControlsViewDto,
    description:
      'Retained expired execution-control records — never blocking; reactivation replaces them.',
  })
  expiredControls: AdminExpiredControlsViewDto;

  @ApiProperty({ type: [AdminProviderRegistryEntryDto] })
  providers: AdminProviderRegistryEntryDto[];

  @ApiProperty({
    type: 'object',
    properties: {
      activeSessions: { type: 'number' },
      suspendedSessions: { type: 'number' },
    },
  })
  automation: {
    activeSessions: number;
    suspendedSessions: number;
  };
}
