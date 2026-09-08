import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Order } from '../../execution/orders/order.entity';
import { OrderKind, OrderStatus, OrderTimeInForce } from '../../execution/orders/order.enums';
import { TradeDirection } from '../../execution/entities/trade.entity';

/**
 * Live Account orders page DTO (Sprint 50 PR-5 — Directive PHASE J).
 *
 * Mirrors LiveOrderRowView / LiveAccountOrdersPage from
 * packages/types/src/live-account.ts EXACTLY: names, enums, nullability.
 * Dates serialize as ISO strings; quantities and prices stay decimal strings.
 *
 * The mapper deliberately drops `userId`, `idempotencyKey`, `signalId` —
 * those are internal lineage, not part of the user-facing contract.
 */
export class LiveOrderRowViewDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  brokerConnectionId: string;

  @ApiPropertyOptional({ nullable: true, example: 'MetaTrader 5' })
  brokerName: string | null;

  @ApiProperty({ description: 'Caller-supplied stable identifier (deduplication surface).' })
  clientOrderId: string;

  @ApiPropertyOptional({ nullable: true, description: 'Broker-side order identifier.' })
  providerOrderId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    format: 'uuid',
    description: 'Position produced by this order.',
  })
  tradeId: string | null;

  @ApiProperty({ enum: OrderKind })
  orderKind: OrderKind;

  @ApiProperty({ enum: OrderTimeInForce })
  timeInForce: OrderTimeInForce;

  @ApiProperty({ example: 'EURUSD' })
  instrument: string;

  @ApiProperty({ enum: TradeDirection })
  direction: TradeDirection;

  @ApiProperty({ description: 'Requested quantity in lots as a decimal string.' })
  requestedQuantity: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Limit price as a decimal string (LIMIT/STOP_LIMIT).',
  })
  requestedPrice: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Stop/trigger price as a decimal string (STOP/STOP_LIMIT).',
  })
  stopPrice: string | null;

  @ApiProperty({ description: 'Cumulative filled quantity as a decimal string.' })
  filledQuantity: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Volume-weighted average fill price as a decimal string.',
  })
  avgFillPrice: string | null;

  @ApiProperty({ enum: OrderStatus })
  status: OrderStatus;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Terminal rejection reason (risk engine or provider).',
  })
  rejectReason: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  submittedAt: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  finalizedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: string;
}

export class LiveAccountOrdersPageDto {
  @ApiProperty({ type: [LiveOrderRowViewDto] })
  orders: LiveOrderRowViewDto[];

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

export function toLiveOrderRowView(order: Order, brokerName: string | null): LiveOrderRowViewDto {
  return {
    id: order.id,
    brokerConnectionId: order.brokerConnectionId,
    brokerName,
    clientOrderId: order.clientOrderId,
    providerOrderId: order.providerOrderId ?? null,
    tradeId: order.tradeId ?? null,
    orderKind: order.orderKind,
    timeInForce: order.timeInForce,
    instrument: order.instrument,
    direction: order.direction,
    requestedQuantity: order.requestedQuantity,
    requestedPrice: order.requestedPrice ?? null,
    stopPrice: order.stopPrice ?? null,
    filledQuantity: order.filledQuantity,
    avgFillPrice: order.avgFillPrice ?? null,
    status: order.status,
    rejectReason: order.rejectReason ?? null,
    submittedAt: toIsoString(order.submittedAt),
    finalizedAt: toIsoString(order.finalizedAt),
    createdAt: order.createdAt.toISOString(),
  };
}
