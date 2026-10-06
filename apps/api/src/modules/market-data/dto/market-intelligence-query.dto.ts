import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';

export const MARKET_INTELLIGENCE_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'] as const;

export class MarketIntelligenceQueryDto {
  @IsString()
  @Matches(/^[A-Za-z0-9._-]{3,24}$/)
  instrument: string;

  @IsIn(MARKET_INTELLIGENCE_TIMEFRAMES)
  timeframe: (typeof MARKET_INTELLIGENCE_TIMEFRAMES)[number] = 'H1';

  @Type(() => Number)
  @IsInt()
  @Min(20)
  @Max(300)
  limit: number = 120;

  @IsOptional()
  @IsUUID()
  brokerConnectionId?: string;
}
