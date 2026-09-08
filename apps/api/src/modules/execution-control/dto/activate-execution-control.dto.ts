import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ExecutionControlScope } from '../entities/execution-control.entity';

/**
 * ActivateExecutionControlDto — input for activating an emergency control.
 * scopeKey is REQUIRED for non-GLOBAL scopes (validated in the service too).
 */
export class ActivateExecutionControlDto {
  @ApiProperty({ enum: ExecutionControlScope, description: 'Control scope' })
  @IsEnum(ExecutionControlScope)
  scope: ExecutionControlScope;

  @ApiPropertyOptional({
    description:
      'Scope key — brokerId for PROVIDER, userId for USER, brokerConnectionId for ' +
      'BROKER_CONNECTION. Must be null/omitted for GLOBAL.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  scopeKey?: string;

  @ApiProperty({ description: 'Human-readable reason (audited)' })
  @IsString()
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({ description: 'Optional auto-expiry (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
