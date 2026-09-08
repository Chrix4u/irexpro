import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

/**
 * SecurityEventsQueryDto — Sprint 55 GET /auth/security-events pagination.
 *
 * Mirrors the repo's query-DTO validation pattern (see
 * MarketIntelligenceQueryDto): validated by the global ValidationPipe
 * (whitelist + forbidNonWhitelisted + transform), so limit/offset violations
 * fail with 400 instead of reaching the service.
 */
export class SecurityEventsQueryDto {
  @ApiPropertyOptional({ description: 'Page size (1–100, default 20)', default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @ApiPropertyOptional({ description: 'Zero-based row offset (default 0)', default: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset: number = 0;
}
