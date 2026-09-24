import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AllowedTradingMode } from '../entities/risk-profile.entity';

export class UpdateRiskProfileDto {
  @ApiPropertyOptional({
    description: 'Max daily loss as % of opening balance (1–20%)',
    example: 5,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(20)
  maxDailyLossPercent?: number;

  @ApiPropertyOptional({
    description: 'Max drawdown as % of peak equity (1–30%)',
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(30)
  maxDrawdownPercent?: number;

  @ApiPropertyOptional({ description: 'Max simultaneously open trades (1–20)', example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxOpenTrades?: number;

  @ApiPropertyOptional({ description: 'Max position size in lots (0.01–10)', example: 0.1 })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  @Max(10)
  maxPositionSizeLot?: number;

  @ApiPropertyOptional({ description: 'Min stop-loss distance in pips (1–50)', example: 5 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(50)
  minStopLossPips?: number;

  @ApiPropertyOptional({
    description: 'Allowed instrument symbols (null = all allowed)',
    example: ['EURUSD', 'GBPUSD'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedInstruments?: string[] | null;

  @ApiPropertyOptional({
    description: 'Max volatility score threshold 0.0–1.0',
    example: 0.85,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(1.0)
  maxVolatilityScore?: number;

  @ApiPropertyOptional({
    description: 'Reject trades during LOW_LIQUIDITY market regime',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  rejectLowLiquidity?: boolean;

  // ── Sprint 29: onboarding fields ──────────────────────────────────────────

  @ApiPropertyOptional({
    description:
      'Sprint 29: Max risk per trade as % of equity. ' +
      'Default: 2%. Maximum for automated modes: 5% (conservative). ' +
      'Values above 5% are rejected to prevent excessive automated risk.',
    example: 2,
  })
  @IsOptional()
  @IsNumber()
  @Min(0.5)
  @Max(5)
  maxTradeRiskPercent?: number;

  @ApiPropertyOptional({
    description:
      'Sprint 29: Max leverage allowed. ' +
      'Default: 30 (conservative). Maximum: 100 for any automated mode. ' +
      'Higher values may be allowed for PAPER_ONLY simulation but are capped ' +
      'to prevent excessive automated risk.',
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxLeverageAllowed?: number;

  @ApiPropertyOptional({
    description: 'Sprint 29: Allowed trading mode (PAPER_ONLY / SEMI_AUTO / FULL_AUTO)',
    enum: AllowedTradingMode,
    example: 'PAPER_ONLY',
  })
  @IsOptional()
  @IsEnum(AllowedTradingMode)
  allowedTradingModes?: AllowedTradingMode;

  @ApiPropertyOptional({
    description:
      'Sprint 29: Explicit risk acknowledgement acceptance. Must be true to start trading. ' +
      'When set to true, records the acceptance timestamp + audits RISK_ACKNOWLEDGEMENT_ACCEPTED.',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  riskAcknowledgementAccepted?: boolean;
}
