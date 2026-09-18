import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

export class SetCapitalAllocationDto {
  @ApiProperty({ format: 'uuid', description: 'Exact broker connection to allocate capital against.' })
  @IsUUID()
  brokerConnectionId: string;

  @ApiProperty({
    example: '500.00',
    description: 'Positive decimal amount in the broker account currency.',
  })
  @IsString()
  @Matches(/^\d+(?:\.\d+)?$/, { message: 'amount must be a positive decimal string' })
  amount: string;
}
