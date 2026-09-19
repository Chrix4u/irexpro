import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class InternalOhlcvQueryDto {
  @IsUUID()
  userId: string;

  @IsUUID()
  brokerConnectionId: string;

  @IsString()
  instrument: string;

  @IsString()
  timeframe: string;

  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(500)
  limit: number = 100;

  @IsOptional()
  @IsISO8601({ strict: true })
  before?: string;
}
