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
      'Authorization channel. "web" (default) uses the registered HTTPS web ' +
      'callback page; "mobile" claims one of the server-configured mobile ' +
      'callback slot URIs (CTRADER_MOBILE_CALLBACK_URIS) so the provider code ' +
      'is exchanged by the SERVER and the app receives only a one-time ' +
      'handoff token.',
    enum: ['web', 'mobile'],
    default: 'web',
  })
  @IsOptional()
  @IsIn(['web', 'mobile'])
  channel?: 'web' | 'mobile';

  @ApiPropertyOptional({
    description:
      'Platform-registered HTTPS web callback URI — must be in the ' +
      'server-configured allowlist; defaults to the primary web callback. ' +
      'Custom app schemes are rejected (the provider code must be exchanged ' +
      'server-side). Ignored for the mobile channel.',
    example: 'https://app.irexpro.com/onboarding/broker/callback',
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

/**
 * POST /broker/connections/oauth/handoff body (Sprint 56 correction round 2 /
 * architect finding 4 — mobile callback boundary).
 *
 * The token is the opaque, high-entropy, ONE-TIME, 120-second handoff token
 * issued by the SERVER callback redirect (irexpro://broker/oauth/handoff?
 * token=...). It is user-bound and digest-verified; replay and cross-user use
 * fail closed as not-found. It is NOT the provider authorization code and
 * carries no provider token material.
 */
export class ExchangeBrokerOAuthHandoffDto {
  @ApiProperty({
    description: 'One-time OAuth handoff token delivered via the deep link',
    maxLength: 512,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  handoffToken!: string;
}
