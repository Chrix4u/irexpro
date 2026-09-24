import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Trade, TradeCloseReason, TradeDirection, TradeStatus } from '../entities/trade.entity';
import { TradeIntent } from '../entities/trade-intent.entity';

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

export type TradeEntryDecisionKind = 'QUALIFIED_AI' | 'RESEARCH_UAT_PROBE' | 'UNKNOWN';

const KNOWN_EXECUTION_REASON_CODES = [
  'MARKET_SAFETY_MARKET_DATA_UNAVAILABLE',
  'MARKET_SAFETY_STALE_PRICE',
  'MARKET_SAFETY_ABNORMAL_SPREAD',
  'MARKET_SAFETY_PRICE_DEVIATION_EXCESSIVE',
] as const;

function finiteProbability(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function toEntryDecisionProvenance(intent: TradeIntent | null): {
  entryDecisionKind: TradeEntryDecisionKind;
  entryConfidenceScore: number | null;
  entryConfidenceThreshold: number | null;
  entryModelVersion: string | null;
} {
  if (!intent) {
    return {
      entryDecisionKind: 'UNKNOWN',
      entryConfidenceScore: null,
      entryConfidenceThreshold: null,
      entryModelVersion: null,
    };
  }

  const metadata = intent.metadata ?? {};
  const confidence = finiteProbability(metadata.confidenceScore);
  const threshold = finiteProbability(metadata.model_confidence_threshold);
  const isUatProbe =
    intent.strategyCode?.startsWith('uat-workflow-probe-') === true &&
    metadata.uat_workflow_probe === true &&
    metadata.production_eligible === false;

  const qualified =
    !isUatProbe &&
    metadata.production_eligible !== false &&
    confidence !== null &&
    threshold !== null &&
    confidence >= threshold;

  return {
    entryDecisionKind: isUatProbe ? 'RESEARCH_UAT_PROBE' : qualified ? 'QUALIFIED_AI' : 'UNKNOWN',
    entryConfidenceScore: confidence,
    entryConfidenceThreshold: threshold,
    entryModelVersion: intent.modelVersion ?? null,
  };
}

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

  @ApiProperty({
    enum: ['QUALIFIED_AI', 'RESEARCH_UAT_PROBE', 'UNKNOWN'],
    description: 'Safe classification of the AI decision that created this execution.',
  })
  entryDecisionKind: TradeEntryDecisionKind;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: 1,
    description: 'Model confidence attached to this exact entry decision.',
  })
  entryConfidenceScore: number | null;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: 1,
    description: 'Confidence threshold recorded with this exact entry decision.',
  })
  entryConfidenceThreshold: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Model version recorded with this exact entry decision.',
  })
  entryModelVersion: string | null;

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
  intent: TradeIntent | null = null,
): TradeExecutionResponseDto {
  const entryProvenance = toEntryDecisionProvenance(intent);
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
    accountCurrency: trade.accountCurrency,
    realisedPnl: trade.accountCurrency ? trade.realisedPnl : null,
    commission: trade.accountCurrency ? trade.commission : null,
    swap: trade.accountCurrency ? trade.swap : null,
    executionReasonCode: toExecutionReasonCode(trade),
    ...entryProvenance,
    closeReason: trade.closeReason,
    openedAt: trade.openedAt,
    closedAt: trade.closedAt,
    createdAt: trade.createdAt,
    updatedAt: trade.updatedAt,
  };
}
