import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AllowedTradingMode } from '../../risk/entities/risk-profile.entity';
import { ExecutionMode } from '../../execution/interfaces/execution-authority';

/**
 * StartSessionDto — Sprint 29 amendment + Round 5 session authority (#295/#298).
 *
 * `executionMode` is the durable session execution mode (PAPER_ONLY /
 * SEMI_AUTO / FULL_AUTO) persisted on the TradingSession and bound to all
 * future NEW-exposure decisions. The TradingService validates it against the
 * user's `riskProfile.allowedTradingModes`.
 *
 * `requestedMode` is the legacy alias of the same values — kept for backward
 * compatibility with existing clients; `executionMode` wins when both are
 * supplied. If both are supplied and disagree, the request is rejected.
 *
 * `brokerConnectionId` names the EXACT connection the session binds (Round 5:
 * the session is the authoritative execution target — no implicit discovery).
 * The service requires it.
 *
 * If no mode is provided, defaults to PAPER_ONLY (safest).
 */
export class StartSessionDto {
  @ApiPropertyOptional({
    description:
      'Specific broker connection ID to bind to the session (required by the service — ' +
      'the session is the authoritative execution target and no connection is discovered implicitly).',
    example: 'uuid-v4',
  })
  @IsOptional()
  @IsUUID()
  brokerConnectionId?: string;

  @ApiPropertyOptional({
    description:
      'Durable execution mode for the session. Must be permitted by ' +
      'riskProfile.allowedTradingModes. Defaults to PAPER_ONLY (safest). FULL_AUTO does NOT ' +
      'automatically enable live broker execution — live trading requires a separate explicit ' +
      'enablement on the broker connection.',
    enum: ExecutionMode,
    example: 'PAPER_ONLY',
  })
  @IsOptional()
  @IsEnum(ExecutionMode)
  executionMode?: ExecutionMode;

  @ApiPropertyOptional({
    description:
      'DEPRECATED legacy alias for executionMode (same values). Superseded by executionMode; ' +
      'rejected when both are present and disagree.',
    enum: AllowedTradingMode,
    example: 'PAPER_ONLY',
    deprecated: true,
  })
  @IsOptional()
  @IsEnum(AllowedTradingMode)
  requestedMode?: AllowedTradingMode;
}
