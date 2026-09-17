import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

/**
 * Explicit user authority for the amount of broker equity the AI engine may
 * allocate. Decimal strings are used end-to-end so no floating-point money
 * conversion occurs at the API boundary.
 */
export class UpdateCapitalBudgetDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  brokerConnectionId: string;

  @ApiProperty({
    description: 'Explicit AI capital allocation in the broker account currency.',
    example: '2500.00',
  })
  @IsString()
  @Matches(/^\d+(?:\.\d{1,8})?$/, {
    message: 'totalCapital must be a positive decimal string with up to 8 decimal places',
  })
  totalCapital: string;
}
