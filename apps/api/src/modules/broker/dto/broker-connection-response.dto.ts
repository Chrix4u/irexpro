import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Expose } from 'class-transformer';
import { BrokerConnectionStatus, BrokerMode } from '../interfaces/broker-adapter.interface';
import { BrokerAuthorizationStatus } from '../authorization/broker-authorization-status';
import { BrokerCredentialStatus } from '../authorization/broker-credential-status';

/**
 * BrokerConnectionResponseDto — Safe response DTO for broker connections.
 *
 * All encrypted credential fields are explicitly excluded.
 * This DTO is the only shape ever returned to the frontend.
 */
@Exclude()
export class BrokerConnectionResponseDto {
  @Expose()
  @ApiProperty()
  id: string;

  @Expose()
  @ApiProperty()
  brokerId: string;

  @Expose()
  @ApiProperty()
  brokerName: string;

  @Expose()
  @ApiPropertyOptional()
  displayName: string | null;

  @Expose()
  @ApiPropertyOptional({ description: 'Broker-side account ID (not a secret)' })
  accountId: string | null;

  @Expose()
  @ApiProperty({ enum: BrokerMode })
  accountType: BrokerMode;

  @Expose()
  @ApiPropertyOptional()
  accountCurrency: string | null;

  @Expose()
  @ApiPropertyOptional()
  accountLeverage: number | null;

  @Expose()
  @ApiProperty({ enum: BrokerConnectionStatus })
  status: BrokerConnectionStatus;

  @Expose()
  @ApiProperty({
    enum: BrokerAuthorizationStatus,
    description:
      'Authorization state machine (Sprint 50). ACTIVE is the ONLY executable state. ' +
      'Backend-authoritative — frontend state can never enable execution.',
  })
  authorizationStatus: BrokerAuthorizationStatus;

  @Expose()
  @ApiProperty({
    enum: BrokerCredentialStatus,
    description: 'Credential lifecycle status (metadata only — never secrets).',
  })
  credentialStatus: BrokerCredentialStatus;

  @Expose()
  @ApiPropertyOptional({ description: 'When authorization was granted (ACTIVE).' })
  authorizedAt: Date | null;

  @Expose()
  @ApiPropertyOptional({ description: 'When authorization was revoked.' })
  authorizationRevokedAt: Date | null;

  @Expose()
  @ApiProperty()
  demoValidated: boolean;

  @Expose()
  @ApiProperty()
  liveTradingEnabled: boolean;

  @Expose()
  @ApiPropertyOptional()
  lastHealthCheckAt: Date | null;

  @Expose()
  @ApiPropertyOptional()
  lastSyncAt: Date | null;

  @Expose()
  @ApiPropertyOptional()
  lastErrorMessage: string | null;

  @Expose()
  @ApiProperty()
  createdAt: Date;

  @Expose()
  @ApiProperty()
  updatedAt: Date;

  // Credential fields are NEVER exposed — @Exclude() on the class handles it
}
