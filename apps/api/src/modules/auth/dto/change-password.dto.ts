import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * ChangePasswordDto — Sprint 55 authenticated password change.
 *
 * currentPassword re-authenticates the caller (wrong value → 401, mirroring
 * the MFA setup re-auth style); newPassword follows EXACTLY the reset-password
 * policy: 12–128 characters with at least one letter and one number (weak
 * value → 400).
 *
 * SECURITY: both fields are secrets. Neither value is ever logged, audited, or
 * persisted beyond the one-way argon2 hash.
 */
export class ChangePasswordDto {
  @ApiProperty({ description: 'Current account password (1–128 characters)' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  currentPassword: string;

  @ApiProperty({
    description: 'New password (min 12 chars, must contain letters + numbers)',
    example: 'NewStrongPassword123!',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(12)
  @MaxLength(128)
  @Matches(/[a-zA-Z]/, { message: 'newPassword must contain at least one letter' })
  @Matches(/[0-9]/, { message: 'newPassword must contain at least one number' })
  newPassword: string;
}
