import {
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TradingViewWebhookSignalDto {
  @ApiProperty({ description: 'Stable alert event id. Retries must reuse the same value.' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  eventId: string;

  @ApiProperty({ example: 'USDJPY' })
  @IsString()
  @Matches(/^(EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|USDCHF)$/)
  instrument: string;

  @ApiProperty({ enum: ['BUY', 'SELL'] })
  @IsIn(['BUY', 'SELL'])
  direction: 'BUY' | 'SELL';

  @ApiProperty({ minimum: 0.6, maximum: 1 })
  @IsNumber()
  @Min(0.6)
  @Max(1)
  confidence: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0.000001)
  entryPrice?: number;

  @ApiProperty()
  @IsNumber()
  @Min(0.000001)
  stopLoss: number;

  @ApiProperty()
  @IsNumber()
  @Min(0.000001)
  takeProfit: number;

  @ApiPropertyOptional({ default: 0.01 })
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  suggestedVolume?: number;

  @ApiProperty({ example: 'M5' })
  @IsString()
  @Matches(/^(M1|M5|M15|H1|H4)$/)
  timeframe: string;

  @ApiProperty({ example: 'tv-ema-rsi-v1' })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  @Matches(/^[a-zA-Z0-9._:-]+$/)
  strategy: string;

  @ApiProperty({ enum: ['TRENDING', 'RANGING', 'VOLATILE', 'HIGH_VOLATILITY', 'LOW_LIQUIDITY'] })
  @IsIn(['TRENDING', 'RANGING', 'VOLATILE', 'HIGH_VOLATILITY', 'LOW_LIQUIDITY'])
  marketRegime: 'TRENDING' | 'RANGING' | 'VOLATILE' | 'HIGH_VOLATILITY' | 'LOW_LIQUIDITY';

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  volatilityScore?: number;

  @ApiProperty({ description: 'TradingView alert/strategy timestamp' })
  @IsDateString()
  generatedAt: string;

  @ApiPropertyOptional({ description: 'Optional alert expiry timestamp' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
