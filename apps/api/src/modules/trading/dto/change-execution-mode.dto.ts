import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ExecutionMode } from '../../execution/interfaces/execution-authority';

/**
 * ChangeExecutionModeDto — Round 5, architect issue #298.
 *
 * The execution-mode change is explicit + audited: it bumps the session
 * authorityGeneration (CAS) and INVALIDATES outstanding authority (ACTIVE
 * RiskGrants → INVALIDATED with reason SESSION_AUTHORITY_GENERATION_CHANGED;
 * PENDING SEMI_AUTO confirmations → REVOKED). New risk evaluation is required
 * afterwards; grants are never revived.
 */
export class ChangeExecutionModeDto {
  @ApiProperty({
    description:
      'New durable execution mode for the ACTIVE session. Triggers an audited ' +
      'authorityGeneration bump and invalidates outstanding RiskGrants / confirmations.',
    enum: ExecutionMode,
    example: 'SEMI_AUTO',
  })
  @IsEnum(ExecutionMode)
  executionMode: ExecutionMode;
}
