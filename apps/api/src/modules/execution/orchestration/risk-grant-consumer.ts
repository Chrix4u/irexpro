import { RiskGrant } from '../entities/risk-grant.entity';

/**
 * RISK-GRANT CONSUMER SEAM (Sprint 56 correction round 5, tasks 50-b + 50-c).
 *
 * Contract owner: `src/modules/risk/risk-grant.service.ts` (the parallel
 * round-5 agent 50-b). Its `consumeGrantAtomic` / `invalidateGrantsForSession`
 * satisfy the RiskGrantConsumerPort below, and the FINAL DISPATCH BOUNDARY
 * (orchestration/final-dispatch-boundary.ts) injects RiskGrantService
 * directly via forwardRef across the RiskModule ↔ ExecutionModule import
 * cycle. This module carries the SHARED TYPES of that contract (the
 * RiskGrantService return shape is declared against them) plus the
 * injection token available for a provider alias if the seam is ever
 * re-homed:
 *
 *   { provide: RISK_GRANT_CONSUMER, useExisting: RiskGrantService }
 */

/** Injection token for the risk-module-owned grant consumer (50-b seam). */
export const RISK_GRANT_CONSUMER = 'RISK_GRANT_CONSUMER';

/** Why a consume attempt did not win. */
export type RiskGrantConsumeFailureReason =
  | 'NOT_FOUND'
  | 'NOT_ACTIVE'
  | 'EXPIRED'
  | 'ALREADY_CONSUMED'
  | 'INVALIDATED'
  | 'CAS_RACE_LOST';

export interface RiskGrantConsumeResult {
  /** True when THIS call performed the ACTIVE → CONSUMED transition. */
  consumed: boolean;
  /** Present when consumed is false. */
  reason?: RiskGrantConsumeFailureReason;
  /** The authoritative grant row after the attempt. */
  grant: RiskGrant | null;
}

/** The 50-b contract surface consumed by the final dispatch boundary. */
export interface RiskGrantConsumerPort {
  /** CAS consume: ACTIVE + unexpired + un-invalidated → CONSUMED (single winner). */
  consumeGrantAtomic(grantId: string): Promise<RiskGrantConsumeResult>;
  /** CAS invalidate: every still-ACTIVE grant of the session → INVALIDATED. */
  invalidateGrantsForSession(sessionId: string, reason: string): Promise<number>;
}
