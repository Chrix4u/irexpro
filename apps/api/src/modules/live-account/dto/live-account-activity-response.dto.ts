import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AuditLog, AuditSeverity } from '../../audit/entities/audit-log.entity';
import { LiveActivitySeverity } from './live-account.enums';

/**
 * Live Account activity timeline DTO (Sprint 50 PR-5 — Directive PHASE J).
 *
 * Mirrors LiveActivityRowView / LiveAccountActivityPage from
 * packages/types/src/live-account.ts EXACTLY.
 *
 * SECURITY: audit `metadata` (jsonb), ip_address, user_agent, and correlation
 * ids are NEVER mapped into the user-facing view — the mapper copies only the
 * explicitly allow-listed fields.
 */
export class LiveActivityRowViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'ORDER_SUBMITTED' })
  action: string;

  @ApiPropertyOptional({ nullable: true, example: 'Order' })
  resourceType: string | null;

  @ApiPropertyOptional({ nullable: true })
  resourceId: string | null;

  @ApiProperty({ enum: LiveActivitySeverity })
  severity: LiveActivitySeverity;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class LiveAccountActivityPageDto {
  @ApiProperty({ type: [LiveActivityRowViewDto] })
  activity: LiveActivityRowViewDto[];

  @ApiProperty({ minimum: 0, description: 'Total rows for the user (before pagination).' })
  total: number;

  @ApiProperty({ minimum: 1, maximum: 100 })
  limit: number;

  @ApiProperty({ minimum: 0 })
  offset: number;
}

/**
 * Defensive severity fallback for legacy audit rows without a severity value:
 * derive from the action name. Prefer the persisted column whenever present.
 */
export function deriveActivitySeverity(
  log: Pick<AuditLog, 'severity' | 'action'>,
): LiveActivitySeverity {
  if (log.severity === AuditSeverity.CRITICAL) return LiveActivitySeverity.CRITICAL;
  if (log.severity === AuditSeverity.WARNING) return LiveActivitySeverity.WARNING;
  if (log.severity === AuditSeverity.INFO) return LiveActivitySeverity.INFO;

  const action = (log.action ?? '').toUpperCase();
  if (
    action.includes('KILL_SWITCH') ||
    action.includes('EXECUTION_CONTROL') ||
    action.endsWith('_CRITICAL')
  ) {
    return LiveActivitySeverity.CRITICAL;
  }
  if (
    action.includes('FAILED') ||
    action.includes('REJECTED') ||
    action.includes('REVOKED') ||
    action.includes('SUSPENDED')
  ) {
    return LiveActivitySeverity.WARNING;
  }
  return LiveActivitySeverity.INFO;
}

export function toLiveActivityRowView(log: AuditLog): LiveActivityRowViewDto {
  return {
    id: log.id,
    action: log.action,
    resourceType: log.resourceType ?? null,
    resourceId: log.resourceId ?? null,
    severity: deriveActivitySeverity(log),
    createdAt: log.createdAt.toISOString(),
  };
}
