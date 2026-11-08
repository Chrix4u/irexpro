/**
 * One cost-forecast research contract for all secondary AI routes.
 *
 * This is NOT order authority. The old predicted after-cost return hurdle is
 * retained in decision-time evidence, but it must not veto new exposure until
 * independently validated and explicitly promoted through normal governance.
 * Actual quote availability, spread safety, stop-loss geometry, margin and
 * realised-performance brakes remain hard requirements.
 */
export const SECONDARY_PREDICTED_COST_SHADOW_ARTIFACT =
  'secondary-predicted-cost-floor-shadow-v1' as const;

export function observeSecondaryPredictedCostFloor(expectedNetR: number | null, oldFloorR: number) {
  const evidenceFinite = expectedNetR !== null && Number.isFinite(expectedNetR);
  return {
    artifact: SECONDARY_PREDICTED_COST_SHADOW_ARTIFACT,
    mode: 'SHADOW_ONLY' as const,
    modifiesExecution: false as const,
    evidenceFinite,
    predictedNetR: evidenceFinite ? expectedNetR : null,
    oldRequiredNetR: oldFloorR,
    wouldHaveBlocked: !evidenceFinite || expectedNetR! < oldFloorR,
  };
}
