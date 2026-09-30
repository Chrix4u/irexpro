import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const FOREX_MAJOR_PATTERN = /^(EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|USDCHF)$/;

/**
 * Generic trusted-provider signal envelope.
 *
 * The external provider cannot choose execution authority. The server forces
 * every signal onto a PAPER_ONLY internal paper-broker session until a future
 * provider-certification feature explicitly promotes that provider.
 */
export class ExternalProviderSignalDto {
  @ApiProperty({ description: 'Stable provider event id used for idempotent retries' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  externalSignalId: string;

  @ApiProperty({ description: 'Provider/strategy integration code', example: 'tradingview-relay' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9._-]+$/)
  providerCode: string;

  @ApiProperty({ description: 'Provider strategy identifier', example: 'trend-breakout-v3' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/^[a-zA-Z0-9._:-]+$/)
  strategyCode: string;

  @IsUUID()
  userId: string;

  @IsUUID()
  tradingSessionId: string;

  @IsUUID()
  brokerConnectionId: string;

  @ApiProperty({ description: 'Initial six-pair production universe' })
  @IsString()
  @Matches(FOREX_MAJOR_PATTERN)
  instrument: string;

  @IsEnum(['BUY', 'SELL'])
  direction: 'BUY' | 'SELL';

  @ApiProperty({ description: 'Provider confidence. Production floor remains 0.60.' })
  @IsNumber()
  @Min(0.6)
  @Max(1)
  confidenceScore: number;

  @ApiPropertyOptional({ description: 'Optional market entry; omit for market execution' })
  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  suggestedEntryPrice?: number;

  @IsNumber()
  @Min(0.000001)
  suggestedStopLoss: number;

  @IsNumber()
  @Min(0.000001)
  suggestedTakeProfit: number;

  @IsNumber()
  @Min(0.001)
  suggestedVolume: number;

  @ApiProperty({ example: 'M5' })
  @IsString()
  @Matches(/^(M1|M5|M15|H1|H4)$/)
  timeframe: string;

  @IsDateString()
  generatedAt: string;

  @ApiPropertyOptional({ description: 'Optional signal expiry; expired signals are rejected' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ description: 'Non-secret provider reference for audit' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  sourceReference?: string;
}
