import type { RiskProfile } from './entities/risk-profile.entity';
import type { RiskViolation } from './entities/risk-violation.entity';
import type { RiskViolationSummaryResponseDto } from './dto/risk-intelligence-response.dto';

/**
 * Public risk-violation projection.
 *
 * Never expose userId, signalId, or riskContext. riskContext can contain
 * balances, equity, proposed order parameters, and other internal evidence.
 */
export function toRiskViolationSummary(violation: RiskViolation): RiskViolationSummaryResponseDto {
  return {
    id: violation.id,
    rejectionCode: violation.rejectionCode,
    rejectionReason: violation.rejectionReason,
    evaluatedAt: violation.evaluatedAt,
  };
}

/**
 * Public risk-profile projection.
 *
 * maxDailyTrades is retained only as a legacy database column. It is not an
 * active risk control and must not be exposed as though the user has a daily
 * execution quota.
 */
export function toRiskProfileResponse(profile: RiskProfile): Omit<RiskProfile, 'maxDailyTrades'> {
  const { maxDailyTrades: legacyDailyTradeCap, ...publicProfile } = profile;
  void legacyDailyTradeCap;
  return publicProfile;
}
