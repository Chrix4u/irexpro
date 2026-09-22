import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * October UAT hardening (WS5) — the six SEPARATED trading-readiness states.
 *
 * Mirrors LiveReadinessView in @irexpro/types/live-account. The evidence
 * class always matters: DEMO validation is never a broker LIVE certification;
 * a certified broker never implies the active AI model is LIVE-approved; a
 * LIVE-approved model never implies the broker is certified. Every state
 * below carries its OWN truth and never inherits another's evidence.
 */
export class LiveReadinessBlockerDto {
  @ApiProperty({ example: 'MODEL_LIVE_APPROVAL_MISSING' })
  reasonCode: string;

  @ApiProperty({
    example:
      'Real-money AI trading is unavailable because the active AI model has not received LIVE approval.',
  })
  message: string;
}

export class PaperReadinessDto {
  @ApiProperty({ description: 'A paper-broker connection exists and is executable.' })
  ready: boolean;
}

export class DemoReadinessDto {
  @ApiProperty({
    description: 'At least one real-broker DEMO connection passed the DEMO validation checklist.',
  })
  verified: boolean;
}

export class BrokerLiveCertificationDto {
  @ApiProperty({ description: 'Any provider currently CERTIFIED for production-LIVE trading.' })
  certified: boolean;

  @ApiProperty({
    type: [String],
    description: 'Certified provider ids (display only; empty when none).',
  })
  certifiedProviders: string[];
}

export class ModelApprovalReadinessDto {
  @ApiPropertyOptional({ nullable: true })
  activeModelVersion: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Paper approval of the exact active model (null when the runtime is unreachable).',
  })
  paperApproved: boolean | null;

  @ApiProperty({
    description: 'True only when the EXACT active model has a valid LIVE promotion record.',
  })
  liveApproved: boolean;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Honest not-approved reason from the runtime (display only).',
  })
  liveActivationReason: string | null;
}

export class LiveEnablementDto {
  @ApiProperty({
    description: 'Any LIVE connection with liveTradingEnabled=true (explicitly enabled).',
  })
  enabled: boolean;
}

export class LiveReadinessResponseDto {
  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt: string;

  @ApiProperty({ type: PaperReadinessDto })
  paper: PaperReadinessDto;

  @ApiProperty({ type: DemoReadinessDto })
  demo: DemoReadinessDto;

  @ApiProperty({ type: BrokerLiveCertificationDto })
  brokerLiveCertified: BrokerLiveCertificationDto;

  @ApiProperty({ type: ModelApprovalReadinessDto })
  model: ModelApprovalReadinessDto;

  @ApiProperty({ type: LiveEnablementDto })
  liveTradingEnabled: LiveEnablementDto;

  @ApiProperty({
    type: [LiveReadinessBlockerDto],
    description:
      'Ordered plain-language blockers for real-money AI trading (empty only when every LIVE gate is genuinely satisfied).',
  })
  liveBlockers: LiveReadinessBlockerDto[];
}
