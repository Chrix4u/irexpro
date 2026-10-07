import { Equals, IsBoolean, IsOptional, IsString, Length, MinLength } from 'class-validator';

export class AdvancedControlsStepUpDto {
  @IsBoolean()
  @Equals(true)
  riskAcknowledged: true;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  @Length(6, 6)
  mfaCode?: string;
}
