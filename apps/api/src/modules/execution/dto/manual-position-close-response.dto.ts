import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Trade } from '../entities/trade.entity';
import {
  toTradeExecutionResponse,
  TradeExecutionResponseDto,
} from './trade-execution-response.dto';

/**
 * Honest terminal classification of ONE user-requested manual position close
 * (October UAT hardening — WS1). Mirrors
 * `ManualPositionCloseOutcome` in @irexpro/types/execution.
 *
 * The server NEVER fabricates a success: CLOSED is returned only when the
 * provider confirmed the close; every other value states the truthful state
 * of the attempt.
 */
export type ManualPositionCloseOutcome =
  | 'CLOSED'
  | 'ALREADY_CLOSED'
  | 'CLOSE_IN_PROGRESS'
  | 'RECONCILIATION_REQUIRED'
  | 'PROVIDER_REFUSED';

/** POST /execution/positions/:tradeId/close → 200 typed response. */
export class ManualPositionCloseResponseDto {
  @ApiProperty({
    enum: [
      'CLOSED',
      'ALREADY_CLOSED',
      'CLOSE_IN_PROGRESS',
      'RECONCILIATION_REQUIRED',
      'PROVIDER_REFUSED',
    ] as const,
    description: 'The honest outcome of this single close attempt.',
  })
  outcome: ManualPositionCloseOutcome;

  @ApiProperty({ description: 'Server-derived human-readable copy (never invented).' })
  message: string;

  @ApiPropertyOptional({
    type: TradeExecutionResponseDto,
    nullable: true,
    description: 'The refreshed post-attempt trade view (null only on lookup failure).',
  })
  position: TradeExecutionResponseDto | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'MARKET_CLOSED',
    description:
      'Sanitized provider error classification when the provider refused — never credentials or raw provider payloads.',
  })
  providerErrorClass: string | null;
}

/** Map a Trade entity onto the frontend-safe manual-close position view. */
export function toManualClosePositionView(trade: Trade): TradeExecutionResponseDto {
  return toTradeExecutionResponse(trade);
}

/**
 * Sanitize a provider refusal into a coarse error class for audit/display.
 *
 * Extracts a KNOWN broker error-code token (UPPER_SNAKE) from the sanitized
 * ConflictException message; anything unrecognizable collapses to
 * 'PROVIDER_REFUSED' — the raw message never flows into the error class.
 */
export function sanitizeProviderErrorClass(message: string): string {
  const match = /\b([A-Z][A-Z0-9_]{3,40})\b/.exec(message);
  if (match) {
    const token = match[1];
    const known = new Set([
      'AUTHENTICATION_FAILED',
      'INSUFFICIENT_MARGIN',
      'INVALID_INSTRUMENT',
      'INVALID_LOT_SIZE',
      'INVALID_ORDER_TYPE',
      'INVALID_PRICE',
      'DUPLICATE_ORDER',
      'MARKET_CLOSED',
      'POSITION_NOT_FOUND',
      'CONNECTION_TIMEOUT',
      'CONNECTION_LOST',
      'RATE_LIMITED',
      'BROKER_SERVER_ERROR',
      'AUTHORIZATION_EXPIRED',
      'ACCOUNT_NOT_FOUND',
      'ACCOUNT_DISABLED',
      'INVALID_REQUEST',
      'ENVIRONMENT_MISMATCH',
      'PROVIDER_UNAVAILABLE',
    ]);
    return known.has(token) ? token : 'PROVIDER_REFUSED';
  }
  return 'PROVIDER_REFUSED';
}
