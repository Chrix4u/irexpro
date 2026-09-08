import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Trade, TradeDirection, TradeStatus } from '../../execution/entities/trade.entity';
import { BrokerMode } from '../../broker/interfaces/broker-adapter.interface';
import { LiveAccountEnvironment, LivePositionStatus } from './live-account.enums';

/**
 * Live Account positions DTO (Sprint 50 PR-5 — Directive PHASE J).
 *
 * Mirrors LivePositionRowView / LiveAccountPositionsView from
 * packages/types/src/live-account.ts EXACTLY. A "position" is a trade holding
 * market exposure (status OPEN) or held by reconciliation
 * (RECONCILIATION_PENDING). Environment is enriched from the owning
 * connection's accountType.
 */
export class LivePositionRowViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  brokerConnectionId: string;

  @ApiPropertyOptional({ nullable: true, example: 'MetaTrader 5' })
  brokerName: string | null;

  @ApiProperty({
    enum: LiveAccountEnvironment,
    description: 'Derived from the connection accountType.',
  })
  environment: LiveAccountEnvironment;

  @ApiProperty({ example: 'EURUSD' })
  instrument: string;

  @ApiProperty({ enum: TradeDirection })
  direction: TradeDirection;

  @ApiProperty({ description: 'Lot size as a decimal string.' })
  lotSize: string;

  @ApiProperty({ description: 'Requested entry price as a decimal string.' })
  requestedEntryPrice: string;

  @ApiPropertyOptional({ nullable: true, description: 'Actual fill price as a decimal string.' })
  fillPrice: string | null;

  @ApiProperty({ description: 'Stop-loss price as a decimal string.' })
  stopLoss: string;

  @ApiProperty({ description: 'Take-profit price as a decimal string.' })
  takeProfit: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Trailing stop distance in pips as a decimal string.',
  })
  trailingStopPips: string | null;

  @ApiProperty({ enum: LivePositionStatus })
  status: LivePositionStatus;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  openedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class LiveAccountPositionsViewDto {
  @ApiProperty({ type: [LivePositionRowViewDto] })
  positions: LivePositionRowViewDto[];

  @ApiProperty({ minimum: 0 })
  total: number;
}

function toIsoString(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function toLivePositionStatus(status: TradeStatus): LivePositionStatus {
  if (status === TradeStatus.RECONCILIATION_PENDING) {
    return LivePositionStatus.RECONCILIATION_PENDING;
  }
  // The position query only yields OPEN / RECONCILIATION_PENDING rows;
  // any legacy value collapses to OPEN (the row still holds market exposure
  // in every state the service requests).
  return LivePositionStatus.OPEN;
}

export function toLivePositionRowView(
  trade: Trade,
  brokerName: string | null,
  environment: LiveAccountEnvironment,
): LivePositionRowViewDto {
  return {
    id: trade.id,
    brokerConnectionId: trade.brokerConnectionId,
    brokerName,
    environment,
    instrument: trade.instrument,
    direction: trade.direction,
    lotSize: trade.lotSize,
    requestedEntryPrice: trade.requestedEntryPrice,
    fillPrice: trade.fillPrice ?? null,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    trailingStopPips: trade.trailingStopPips ?? null,
    status: toLivePositionStatus(trade.status),
    openedAt: toIsoString(trade.openedAt),
    createdAt: trade.createdAt.toISOString(),
  };
}

/**
 * Map a connection account type to the position environment (Directive §36).
 *
 * Fail-closed provenance: ONLY an explicit LIVE/DEMO/PAPER mode maps to that
 * environment. Unknown or absent accountType maps to UNKNOWN — it is never
 * downgraded to PAPER (an unprovenanced environment must not be presented as
 * the safe simulated mode). `BrokerMode` currently defines DEMO/LIVE; the
 * explicit 'PAPER' comparison is defensive so a future paper mode value maps
 * honestly instead of collapsing to UNKNOWN.
 */
export function accountTypeToEnvironment(
  accountType: BrokerMode | string | null | undefined,
): LiveAccountEnvironment {
  switch (accountType) {
    case BrokerMode.LIVE:
      return LiveAccountEnvironment.LIVE;
    case BrokerMode.DEMO:
      return LiveAccountEnvironment.DEMO;
    case 'PAPER':
      return LiveAccountEnvironment.PAPER;
    default:
      return LiveAccountEnvironment.UNKNOWN;
  }
}
