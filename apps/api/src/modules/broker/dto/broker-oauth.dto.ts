import { IsIn, IsNotEmpty, IsOptional, IsString, IsUrl, MaxLength, IsUUID } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CTRADER_FAMILY_BROKER_IDS } from '../registry/broker-catalog';

/**
 * Broker OAuth DTOs (Sprint 56 correction round 1 / audit point 6).
 *
 * SECURITY: NO DTO ever carries application credentials
 * (CTRADER_CLIENT_ID/SECRET are server-only) and NO response ever carries
 * access/refresh tokens — the authorization code arrives ONCE from the
 * frontend (delivered there by Spotware's redirect) and is exchanged
 * server-side immediately.
 */

/** POST /broker/connections/oauth/authorize body. */
export class StartBrokerOAuthDto {
  @ApiProperty({
    description: 'cTrader-family broker id',
    enum: CTRADER_FAMILY_BROKER_IDS,
    example: 'ctrader',
  })
  @IsIn(CTRADER_FAMILY_BROKER_IDS as unknown as string[])
  brokerId!: string;

  @ApiPropertyOptional({
    description:
      'Platform-registered redirect URI (mobile deep link etc.) — must be in the ' +
      'server-configured allowlist; defaults to the primary web callback.',
    example: 'irexpro://broker/oauth/callback',
  })
  @IsOptional()
  @IsUrl()
  @MaxLength(255)
  redirectUri?: string;
}

/** POST /broker/connections/oauth/complete body. */
export class CompleteBrokerOAuthDto {
  @ApiProperty({ description: 'Server-issued OAuth flow id (from authorize)', format: 'uuid' })
  @IsUUID()
  flowId!: string;

  @ApiProperty({
    description:
      'Single-use cTrader authorization code delivered by the Spotware redirect ' +
      '(expires in 60 seconds)',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  code!: string;
}

/** POST /broker/connections/oauth/link body. */
export class LinkBrokerOAuthDto {
  @ApiProperty({ description: 'Server-issued OAuth flow id (from authorize)', format: 'uuid' })
  @IsUUID()
  flowId!: string;

  @ApiProperty({ description: 'Discovered cTID trader account id to link', example: '1234567' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  ctidTraderAccountId!: string;

  @ApiPropertyOptional({ description: 'User-friendly connection label', maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;
}
