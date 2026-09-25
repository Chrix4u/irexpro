import { IsEnum, IsNotEmpty, IsString, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { BillingFrequency } from '../entities/performance-fee-policy.entity';

export class ReplacePolicyDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @Transform(({ value }: { value: unknown }) => parseFloat(String(value)))
  @Min(0)
  @Max(100)
  feePercent: number;

  @IsEnum(BillingFrequency)
  billingFrequency: BillingFrequency;
}
