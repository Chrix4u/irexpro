import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

/**
 * UpdateMyProfileDto — onboarding profile contract.
 *
 * Supports identity/profile fields plus the User-level regional fields required by
 * readiness checks. Date of birth is collected for the independent Sprint 45
 * adult-age gate. Changing an already-reviewed DOB resets KYC state server-side.
 *
 * Trading experience is intentionally not user-configurable: automation uses the
 * platform's professional model/risk policy for every account.
 *
 * Email and phone are NOT updateable here (they require separate verification
 * flows). Password is NOT updateable here (use /auth/reset-password).
 */
export class UpdateMyProfileDto {
  @ApiPropertyOptional({ example: 'John', description: 'First name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe', description: 'Last name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({
    example: '1990-01-31',
    description: 'Date of birth in ISO calendar format YYYY-MM-DD',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'GH', description: 'ISO 3166-1 alpha-2 country code' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  countryCode?: string;

  @ApiPropertyOptional({ example: 'Africa/Accra', description: 'IANA timezone' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  timezone?: string;

  @ApiPropertyOptional({ example: 'USD', description: 'Preferred ISO 4217 currency code' })
  @IsOptional()
  @IsString()
  @Length(3, 3)
  preferredCurrency?: string;
}
