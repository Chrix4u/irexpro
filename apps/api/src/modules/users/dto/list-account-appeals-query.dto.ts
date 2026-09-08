import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AccountAppealStatus } from '../entities/account-appeal.entity';

/** Validated, bounded query contract for the PII-bearing admin appeal queue. */
export class ListAccountAppealsQueryDto {
  @ApiPropertyOptional({ enum: AccountAppealStatus })
  @IsOptional()
  @IsEnum(AccountAppealStatus)
  status?: AccountAppealStatus;

  @ApiPropertyOptional({ description: 'One-based page number', default: 1, minimum: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  page: number = 1;

  @ApiPropertyOptional({ description: 'Page size (1-100)', default: 20, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}
