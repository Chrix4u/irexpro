import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Trade, TradeCloseReason, TradeDirection, TradeStatus } from '../entities/trade.entity';

/**
 * Frontend-safe execution read model.
 *
 * Deliberately excludes internal ownership, signal lineage, idempotency keys,
 * broker connection identifiers, raw external order identifiers, and raw
 * broker rejection diagnostics. A bounded executionReasonCode may be exposed
 * for user-facing explanation without serializing provider/internal messages.
 * Monetary execution economics are exposed only with the trade's immutable
 * account currency provenance.
 */

export interface TradeExecutionLiveTelemetry {
  currentPrice: string | null;
  markObservedAt: Date | null;
  unrealisedPnl: string | null;
  maxFavorablePnl: string | null;
  maxAdversePnl: string | null;
  profitGiveback: string | null;
  observationCount: number | null;
  peakObservedAt: Date | null;
  lastObservedAt: Date | null;
}

const KNOWN_EXECUTION_REASON_CODES = [
  'MARKET_SAFETY_MARKET_DATA_UNAVAILABLE',
  'MARKET_SAFETY_STALE_PRICE',
  'MARKET_SAFETY_ABNORMAL_SPREAD',
  'MARKET_SAFETY_PRICE_DEVIATION_EXCESSIVE',
] as const;

function toExecutionReasonCode(trade: Trade): string | null {
  if (trade.status === TradeStatus.RECONCILIATION_PENDING) {
    return 'EXECUTION_UNRESOLVED';
  }
  if (trade.status === TradeStatus.CANCELLED) {
    return 'EXECUTION_CANCELLED';
  }
  if (trade.status !== TradeStatus.REJECTED) {
    return null;
  }

  const raw = trade.brokerRejectionReason ?? '';
  for (const code of KNOWN_EXECUTION_REASON_CODES) {
    if (raw.includes(code)) return code;
  }
  if (raw.includes('DISPATCH_BOUNDARY_')) {
    return 'DISPATCH_BOUNDARY_BLOCKED';
  }
  return 'EXECUTION_REJECTED';
}
export class TradeExecutionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  instrument: string;

  @ApiProperty({ enum: TradeDirection })
  direction: TradeDirection;

  @ApiProperty({ description: 'Risk-engine validated lot size as a decimal string.' })
  lotSize: string;

  @ApiProperty({ description: 'Requested entry price as a decimal string.' })
  requestedEntryPrice: string;

  @ApiPropertyOptional({ nullable: true, description: 'Authoritative broker fill price.' })
  fillPrice: string | null;

  @ApiProperty({ description: 'Validated stop-loss price as a decimal string.' })
  stopLoss: string;

  @ApiProperty({ description: 'Validated take-profit price as a decimal string.' })
  takeProfit: string;

  @ApiPropertyOptional({ nullable: true })
  trailingStopPips: string | null;

  @ApiProperty({ enum: TradeStatus })
  status: TradeStatus;

  @ApiPropertyOptional({ nullable: true })
  exitPrice: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Latest executable PAPER mark for an open position.' })
  currentPrice: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  markObservedAt: Date | null;

  @ApiPropertyOptional({ nullable: true, description: 'Latest unrealized P&L in account currency.' })
  unrealisedPnl: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Best observed open-position P&L in account currency.' })
  maxFavorablePnl: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Worst observed open-position P&L in account currency.' })
  maxAdversePnl: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Observed give-back from peak P&L in account currency.' })
  profitGiveback: string | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  pathObservationCount: number | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  pathPeakObservedAt: Date | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  pathLastObservedAt: Date | null;

  @ApiPropertyOptional({ nullable: true, example: 'USD' })
  accountCurrency: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Realized P&L in account currency.' })
  realisedPnl: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Broker commission in account currency.' })
  commission: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Swap/financing in account currency.' })
  swap: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Bounded user-safe execution outcome classification; never raw provider diagnostics.',
  })
  executionReasonCode: string | null;

  @ApiPropertyOptional({ enum: TradeCloseReason, nullable: true })
  closeReason: TradeCloseReason | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  openedAt: Date | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  closedAt: Date | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export function toTradeExecutionResponse(
  trade: Trade,
  liveTelemetry: TradeExecutionLiveTelemetry | null = null,
): TradeExecutionResponseDto {
  const exposeMoney = trade.accountCurrency !== null;
  return {
    id: trade.id,
    instrument: trade.instrument,
    direction: trade.direction,
    lotSize: trade.lotSize,
    requestedEntryPrice: trade.requestedEntryPrice,
    fillPrice: trade.fillPrice,
    stopLoss: trade.stopLoss,
    takeProfit: trade.takeProfit,
    trailingStopPips: trade.trailingStopPips,
    status: trade.status,
    exitPrice: trade.exitPrice,
    currentPrice: liveTelemetry?.currentPrice ?? null,
    markObservedAt: liveTelemetry?.markObservedAt ?? null,
    unrealisedPnl: exposeMoney ? (liveTelemetry?.unrealisedPnl ?? null) : null,
    maxFavorablePnl: exposeMoney
      ? (liveTelemetry?.maxFavorablePnl ?? trade.maxFavorablePnl ?? null)
      : null,
    maxAdversePnl: exposeMoney
      ? (liveTelemetry?.maxAdversePnl ?? trade.maxAdversePnl ?? null)
      : null,
    profitGiveback: exposeMoney
      ? (liveTelemetry?.profitGiveback ?? trade.profitGiveback ?? null)
      : null,
    pathObservationCount: liveTelemetry?.observationCount ?? trade.pathObservationCount ?? null,
    pathPeakObservedAt: liveTelemetry?.peakObservedAt ?? trade.pathPeakObservedAt ?? null,
    pathLastObservedAt: liveTelemetry?.lastObservedAt ?? trade.pathLastObservedAt ?? null,
    accountCurrency: trade.accountCurrency,
    realisedPnl: trade.accountCurrency ? trade.realisedPnl : null,
    commission: trade.accountCurrency ? trade.commission : null,
    swap: trade.accountCurrency ? trade.swap : null,
    executionReasonCode: toExecutionReasonCode(trade),
    closeReason: trade.closeReason,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    createdAt: trade.createdAt,
    updatedAt: trade.updatedAt,
  };
}
