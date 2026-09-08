import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ReconciliationDiscrepancy } from '../../execution/reconciliation/entities/reconciliation-discrepancy.entity';
import {
  ReconciliationDiscrepancySeverity,
  ReconciliationDiscrepancyStatus,
  ReconciliationDiscrepancyType,
} from '../../execution/reconciliation/reconciliation.enums';

/**
 * Admin discrepancies page DTO (Sprint 50 PR-6 — Directive PHASE L §39).
 *
 * Mirrors AdminDiscrepancyRowView / AdminDiscrepanciesPage from
 * packages/types/src/admin-live-account.ts EXACTLY: names, enums,
 * nullability, ISO date strings.
 *
 * ENTITY → CONTRACT MAPPING (the discrepancy entity has no literal
 * `description` / `resolutionNote` / `brokerId` columns):
 * - `description`  ← derived from the SAFE `details` jsonb (note-first, then
 *   key=value pairs, then the discrepancy type as fallback), sanitized +
 *   truncated to 300 chars by the caller.
 * - `detectedAt`   ← `firstDetectedAt` (detection time; `lastSeenAt` is the
 *   re-detection refresh).
 * - `resolutionNote` ← the entity's `resolution` column.
 * - `brokerId`     ← enriched via a BrokerConnection lookup (the entity only
 *   stores brokerConnectionId).
 */
export class AdminDiscrepancyRowViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  userId: string;

  @ApiProperty({ format: 'uuid' })
  brokerConnectionId: string;

  @ApiProperty({
    example: 'metatrader5',
    description: "Enriched from the connection row ('unknown' for orphans).",
  })
  brokerId: string;

  @ApiProperty({ enum: ReconciliationDiscrepancyType })
  type: string;

  @ApiProperty({ enum: ReconciliationDiscrepancySeverity })
  severity: 'INFO' | 'WARNING' | 'CRITICAL';

  @ApiProperty({ enum: ReconciliationDiscrepancyStatus })
  status: 'OPEN' | 'RESOLVED';

  @ApiPropertyOptional({ nullable: true, description: 'Internal record id (order/trade).' })
  internalRefId: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Provider-side identifier.' })
  providerRef: string | null;

  @ApiProperty({ description: 'Sanitized, truncated (≤300 chars) safe comparison facts.' })
  description: string;

  @ApiProperty({ type: String, format: 'date-time' })
  detectedAt: string;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  resolvedAt: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'How the discrepancy was resolved.' })
  resolutionNote: string | null;
}

export class AdminDiscrepanciesPageDto {
  @ApiProperty({ type: [AdminDiscrepancyRowViewDto] })
  discrepancies: AdminDiscrepancyRowViewDto[];

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
 * Build the raw (unsanitized) description from the entity's SAFE details
 * blob: prefer a human `note`, else compact `key=value` pairs, else the
 * discrepancy type. The caller sanitizes + truncates the result.
 */
export function deriveDiscrepancyDescription(
  discrepancy: Pick<ReconciliationDiscrepancy, 'type' | 'details'>,
): string {
  const details = discrepancy.details;
  if (details && typeof details === 'object') {
    const note = (details as Record<string, unknown>).note;
    if (typeof note === 'string' && note.trim().length > 0) return note;

    const pairs = Object.entries(details)
      .filter(([, value]) => value === null || typeof value !== 'object')
      .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`);
    if (pairs.length > 0) return pairs.join('; ');
  }
  return discrepancy.type;
}

export function toAdminDiscrepancyRowView(
  discrepancy: ReconciliationDiscrepancy,
  brokerId: string,
  sanitizedDescription: string,
): AdminDiscrepancyRowViewDto {
  const detectedAt =
    toIsoString(discrepancy.firstDetectedAt) ?? discrepancy.createdAt.toISOString();
  return {
    id: discrepancy.id,
    userId: discrepancy.userId,
    brokerConnectionId: discrepancy.brokerConnectionId,
    brokerId,
    type: discrepancy.type,
    severity: discrepancy.severity,
    status: discrepancy.status,
    internalRefId: discrepancy.internalRefId ?? null,
    providerRef: discrepancy.providerRef ?? null,
    description: sanitizedDescription,
    detectedAt,
    resolvedAt: toIsoString(discrepancy.resolvedAt),
    resolutionNote: discrepancy.resolution ?? null,
  };
}
