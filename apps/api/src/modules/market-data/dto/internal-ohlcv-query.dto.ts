import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

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
  @IsDateString()
  endTime?: string;
}
