import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuditLog, AuditSeverity } from '../../audit/entities/audit-log.entity';

/**
 * Admin audit investigation page DTO (Sprint 50 PR-6 — Directive PHASE L §39).
 *
 * Mirrors AdminAuditRowView / AdminAuditPage from
 * packages/types/src/admin-live-account.ts EXACTLY: names, enums,
 * nullability, ISO date strings.
 *
 * SECURITY: audit `metadata` (jsonb), `ipAddress`, and `userAgent` are NEVER
 * mapped into this view — the mapper copies only the explicitly
 * allow-listed fields.
 */
export class AdminAuditRowViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'EXECUTION_CONTROL_ACTIVATED' })
  action: string;

  @ApiProperty({ example: 'USER' })
  actorType: string;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  actorUserId: string | null;

  @ApiPropertyOptional({ nullable: true, example: 'ExecutionControl' })
  resourceType: string | null;

  @ApiPropertyOptional({ nullable: true })
  resourceId: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uuid' })
  correlationId: string | null;

  @ApiProperty({ enum: AuditSeverity })
  severity: 'INFO' | 'WARNING' | 'CRITICAL';

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class AdminAuditPageDto {
  @ApiProperty({ type: [AdminAuditRowViewDto] })
  logs: AdminAuditRowViewDto[];

  @ApiProperty({ minimum: 0, description: 'Total rows matching the filters (before pagination).' })
  total: number;

  @ApiProperty({ minimum: 1, maximum: 100 })
  limit: number;

  @ApiProperty({ minimum: 0 })
  offset: number;
}

/**
 * Defensive severity fallback for legacy audit rows without a severity value:
 * derive from the action name. Prefer the persisted column whenever present.
 * (Same approach as PR-5's deriveActivitySeverity.)
 */
export function deriveAdminAuditSeverity(
  log: Pick<AuditLog, 'severity' | 'action'>,
): 'INFO' | 'WARNING' | 'CRITICAL' {
  if (log.severity === AuditSeverity.CRITICAL) return 'CRITICAL';
  if (log.severity === AuditSeverity.WARNING) return 'WARNING';
  if (log.severity === AuditSeverity.INFO) return 'INFO';

  const action = (log.action ?? '').toUpperCase();
  if (
    action.includes('KILL_SWITCH') ||
    action.includes('EXECUTION_CONTROL') ||
    action.endsWith('_CRITICAL')
  ) {
    return 'CRITICAL';
  }
  if (
    action.includes('FAILED') ||
    action.includes('REJECTED') ||
    action.includes('REVOKED') ||
    action.includes('SUSPENDED')
  ) {
    return 'WARNING';
  }
  return 'INFO';
}

export function toAdminAuditRowView(log: AuditLog): AdminAuditRowViewDto {
  return {
    id: log.id,
    action: log.action,
    actorType: log.actorType,
    actorUserId: log.actorUserId ?? null,
    resourceType: log.resourceType ?? null,
    resourceId: log.resourceId ?? null,
    correlationId: log.correlationId ?? null,
    severity: deriveAdminAuditSeverity(log),
    createdAt: log.createdAt.toISOString(),
  };
}
