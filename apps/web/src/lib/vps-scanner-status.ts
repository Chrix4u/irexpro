type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableRecord(value: unknown): boolean {
  return value === null || isRecord(value);
}

/**
 * Minimal runtime shape required by the AI Trading cockpit.
 *
 * The scanner endpoint is secondary evidence: a rolling deployment or a
 * malformed response must degrade to "unavailable", never crash Start/Stop
 * or the rest of the Trade workspace. This intentionally validates the
 * nested containers the page dereferences while leaving scalar evolution to
 * the versioned API contract.
 */
export function hasVpsScannerUiShape(value: unknown): boolean {
  if (!isRecord(value)) return false;

  const marketSchedule = value.marketSchedule;
  const thresholds = value.ensembleThresholds;
  const lastDecision = value.lastEnsembleDecision;
  const campaign = value.ensembleCampaign;
  const challenger = value.highConvictionChallenger;
  const registry = value.expertRegistry;
  const marketCache = value.marketCache;

  if (
    !isRecord(marketSchedule) ||
    !isRecord(thresholds) ||
    typeof thresholds.candidateConfidenceFloor !== "number" ||
    typeof thresholds.metaProbabilityFloor !== "number" ||
    typeof thresholds.grossExpectedRFloor !== "number" ||
    typeof thresholds.paperNetExpectedRFloor !== "number" ||
    typeof thresholds.promotionNetExpectedRFloor !== "number" ||
    typeof thresholds.sleeveCoreMinClosedTrades !== "number" ||
    typeof marketSchedule.paused !== "boolean" ||
    typeof marketSchedule.nextEligibleScanAt !== "string" ||
    !isRecord(lastDecision) ||
    !Array.isArray(lastDecision.reasons) ||
    !isNullableRecord(lastDecision.governance) ||
    !isNullableRecord(lastDecision.macroEventAssessment) ||
    !isNullableRecord(lastDecision.highConvictionOverlay) ||
    (lastDecision.paperAdmitted !== undefined &&
      typeof lastDecision.paperAdmitted !== "boolean") ||
    !isRecord(campaign) ||
    !Array.isArray(campaign.sleeves) ||
    !isRecord(campaign.highConvictionOverlayCounts) ||
    !isRecord(campaign.highConvictionOverlayPerformance) ||
    !isRecord(campaign.highConvictionOverlayPerformance.CONFIRM) ||
    !isRecord(campaign.highConvictionOverlayPerformance.CONFLICT) ||
    !isRecord(campaign.highConvictionOverlayPerformance.ABSTAIN) ||
    !isRecord(campaign.profitProtection) ||
    !Array.isArray(campaign.profitProtection.counterfactuals) ||
    !isRecord(challenger) ||
    !isNullableRecord(challenger.frozenConsensus) ||
    !isNullableRecord(challenger.historicalValidation) ||
    !isRecord(registry) ||
    !Array.isArray(registry.entries) ||
    !isRecord(marketCache)
  ) {
    return false;
  }

  if (isRecord(lastDecision.governance)) {
    if (
      typeof lastDecision.governance.paperNetExpectedRPassed !== "boolean" ||
      (lastDecision.governance.paperDriftPassed !== undefined &&
        typeof lastDecision.governance.paperDriftPassed !== "boolean") ||
      typeof lastDecision.governance.paperExecutionEligible !== "boolean" ||
      !Array.isArray(lastDecision.governance.paperExecutionBlockers) ||
      typeof lastDecision.governance.paperPromotionEligible !== "boolean"
    ) {
      return false;
    }
  }

  if (value.postEntryShadow !== undefined) {
    if (
      !isRecord(value.postEntryShadow) ||
      !isRecord(value.postEntryShadow.evidenceMinimums)
    ) {
      return false;
    }
  }

  return (
    typeof value.enabled === "boolean" &&
    typeof value.activeEngineCode === "string" &&
    (value.executionAuthority === "SHADOW_ONLY" ||
      value.executionAuthority === "PAPER_ONLY")
  );
}
/** Fail closed on malformed legacy-provider evidence without taking down Trade. */
export function hasExternalProviderPerformanceUiShape(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !isRecord(value.observed) ||
    !isRecord(value.checks)
  ) {
    return false;
  }
  if (typeof value.observed.strategyRealisedPnl !== "number") return false;

  if (
    value.strategyIdentity !== undefined &&
    !isRecord(value.strategyIdentity)
  ) {
    return false;
  }
  if (value.profitProtectionShadow !== undefined) {
    if (
      !isRecord(value.profitProtectionShadow) ||
      !isRecord(value.profitProtectionShadow.losingTradesThatReached)
    )
      return false;
  }
  if (value.driftDiagnostics !== undefined) {
    if (
      !isRecord(value.driftDiagnostics) ||
      !isRecord(value.driftDiagnostics.recent) ||
      !isRecord(value.driftDiagnostics.reference) ||
      typeof value.driftDiagnostics.recent.realisedPnl !== "number"
    )
      return false;
  }
  if (value.shadowCalibration !== undefined) {
    if (
      !isRecord(value.shadowCalibration) ||
      !Array.isArray(value.shadowCalibration.confidenceBins) ||
      !Array.isArray(value.shadowCalibration.pairDirection)
    )
      return false;
  }
  if (value.v8ProspectiveShadow !== undefined) {
    if (
      !isRecord(value.v8ProspectiveShadow) ||
      !isRecord(value.v8ProspectiveShadow.screeningChecks) ||
      typeof value.v8ProspectiveShadow.realisedPnl !== "number" ||
      typeof value.v8ProspectiveShadow.rejectedRealisedPnl !== "number"
    )
      return false;
  }
  if (value.planBEnsembleShadow !== undefined) {
    if (
      !isRecord(value.planBEnsembleShadow) ||
      !isRecord(value.planBEnsembleShadow.pairSideRouteCounts) ||
      !isRecord(value.planBEnsembleShadow.regimeCounts) ||
      typeof value.planBEnsembleShadow.realisedPnl !== "number"
    )
      return false;
  }
  return true;
}
