import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import {
  TradingSession,
  TradingSessionStatus,
} from '../../execution/entities/trading-session.entity';
import { ExecutionMode } from '../../execution/interfaces/execution-authority';

/**
 * Frontend-safe trading-session response.
 *
 * Intentionally excludes userId, openingBalance, peakEquity, and the internal
 * riskProfileSnapshot. Financial values will be exposed only through dedicated
 * authoritative portfolio/performance contracts in later terminal slices.
 *
 * Round 5 (issues #295/#298): executionMode + authorityGeneration are part of
 * the session authority contract and ARE exposed — clients must display the
 * authoritative execution mode and reload on generation conflicts.
 */
@Exclude()
export class TradingSessionResponseDto {
  @Expose()
  @ApiProperty()
  id: string;

  @Expose()
  @ApiProperty()
  brokerConnectionId: string;

  @Expose()
  @ApiProperty({ enum: ExecutionMode })
  executionMode: ExecutionMode;

  @Expose()
  @ApiProperty({
    description: 'Monotonic session authority generation — advanced on audited changes.',
    example: 1,
  })
  authorityGeneration: number;

  @Expose()
  @ApiProperty({ enum: TradingSessionStatus })
  status: TradingSessionStatus;

  @Expose()
  @ApiProperty()
  startedAt: Date;

  @Expose()
  @ApiPropertyOptional()
  endedAt: Date | null;

  @Expose()
  @ApiProperty()
  createdAt: Date;

  @Expose()
  @ApiProperty()
  updatedAt: Date;
}

/**
 * Explicit mapper rather than Object.assign so internal entity fields never
 * become own-properties on the response object, even before serialization.
 */
export function toTradingSessionResponse(session: TradingSession): TradingSessionResponseDto {
  const response = new TradingSessionResponseDto();
  response.id = session.id;
  response.brokerConnectionId = session.brokerConnectionId;
  response.executionMode = session.executionMode ?? ExecutionMode.PAPER_ONLY;
  response.authorityGeneration = session.authorityGeneration ?? 1;
  response.status = session.status;
  response.startedAt = session.startedAt;
  response.endedAt = session.endedAt;
  response.createdAt = session.createdAt;
  response.updatedAt = session.updatedAt;
  return response;
}
