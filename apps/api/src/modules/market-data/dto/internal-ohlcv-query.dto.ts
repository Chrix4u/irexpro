import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

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
  @IsISO8601()
  before?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  advanceSimulation?: boolean;
}
