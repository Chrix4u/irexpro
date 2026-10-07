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
 * maxDailyTrades and maxOpenTrades are retained only as legacy database
 * columns. Neither is an active risk control and neither is exposed as though
 * the user has a trade-count or position-slot quota.
 */
export function toRiskProfileResponse(
  profile: RiskProfile,
): Omit<RiskProfile, 'maxDailyTrades' | 'maxOpenTrades'> {
  const {
    maxDailyTrades: legacyDailyTradeCap,
    maxOpenTrades: legacyOpenPositionCap,
    ...publicProfile
  } = profile;
  void legacyDailyTradeCap;
  void legacyOpenPositionCap;
  return publicProfile;
}
