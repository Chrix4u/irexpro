type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableRecord(value: unknown): boolean {
  return value === null || isRecord(value);
}

function isNullableFiniteNumber(value: unknown): boolean {
  return (
    value === null || (typeof value === "number" && Number.isFinite(value))
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isNullableTimestamp(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isFastMarkProviderRow(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  return (
    isStringArray(value.freshInstruments) &&
    typeof value.freshInstrumentCount === "number" &&
    Number.isInteger(value.freshInstrumentCount) &&
    value.freshInstrumentCount >= 0 &&
    isStringArray(value.staleInstruments) &&
    isNullableTimestamp(value.latestObservedAt) &&
    isNullableTimestamp(value.latestReceivedAt) &&
    isNullableFiniteNumber(value.latestSourceLagMs) &&
    isNullableFiniteNumber(value.maxFreshSourceLagMs)
  );
}

function isFastMarkComparison(value: unknown): value is UnknownRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.instrument === "string" &&
    typeof value.streamProvider === "string" &&
    typeof value.timestampSkewMs === "number" &&
    Number.isFinite(value.timestampSkewMs) &&
    typeof value.divergencePips === "number" &&
    Number.isFinite(value.divergencePips) &&
    typeof value.divergenceBps === "number" &&
    Number.isFinite(value.divergenceBps) &&
    typeof value.streamObservedAt === "string" &&
    typeof value.referenceObservedAt === "string"
  );
}

function isFastMarkProviderHealth(value: unknown): value is UnknownRecord {
  if (
    !isRecord(value) ||
    !isRecord(value.providers) ||
    !isRecord(value.executionReference)
  ) {
    return false;
  }

  const providerRows = Object.values(value.providers);
  const reference = value.executionReference;
  return (
    typeof value.freshnessMaxAgeMs === "number" &&
    Number.isFinite(value.freshnessMaxAgeMs) &&
    value.freshnessMaxAgeMs > 0 &&
    providerRows.length > 0 &&
    providerRows.every(isFastMarkProviderRow) &&
    typeof reference.comparisonMaxSkewMs === "number" &&
    Number.isFinite(reference.comparisonMaxSkewMs) &&
    typeof reference.comparisonCount === "number" &&
    Number.isInteger(reference.comparisonCount) &&
    reference.comparisonCount >= 0 &&
    Array.isArray(reference.comparisons) &&
    reference.comparisons.every(isFastMarkComparison) &&
    isNullableFiniteNumber(reference.maxDivergencePips) &&
    isNullableFiniteNumber(reference.averageDivergencePips)
  );
}

export interface FastMarkFeedUiState {
  state: "LIVE" | "DEGRADED" | "M5_FALLBACK" | "UNAVAILABLE";
  provider: string | null;
  freshCount: number;
  expectedCount: number;
  streamingCount: number;
  fallbackCount: number;
  selectedInstrumentFallback: boolean;
  latestObservedAt: string | null;
  latestSourceLagMs: number | null;
  maxFreshSourceLagMs: number | null;
  divergencePips: number | null;
  divergenceBps: number | null;
  badgeLabel: string;
  badgeVariant: "success" | "warning" | "info";
}

const EXPECTED_FAST_MARK_INSTRUMENTS = 6;

/**
 * Converts optional scanner market-cache telemetry into one fail-closed UI state.
 * This describes the read-only fast-mark feed only; it never implies execution authority.
 */
export function deriveFastMarkFeedUiState(
  marketCache: unknown,
  selectedInstrument: string,
): FastMarkFeedUiState {
  const unavailable: FastMarkFeedUiState = {
    state: "UNAVAILABLE",
    provider: null,
    freshCount: 0,
    expectedCount: EXPECTED_FAST_MARK_INSTRUMENTS,
    streamingCount: 0,
    fallbackCount: 0,
    selectedInstrumentFallback: false,
    latestObservedAt: null,
    latestSourceLagMs: null,
    maxFreshSourceLagMs: null,
    divergencePips: null,
    divergenceBps: null,
    badgeLabel: "MARKET FEED · VERIFYING",
    badgeVariant: "info",
  };

  if (
    !isRecord(marketCache) ||
    !isFastMarkProviderHealth(marketCache.providerHealth)
  ) {
    return unavailable;
  }

  const health = marketCache.providerHealth;
  const providers = health.providers as UnknownRecord;
  const reference = health.executionReference as UnknownRecord;
  const comparisons = reference.comparisons as UnknownRecord[];
  const instrument = selectedInstrument.trim().toUpperCase();
  const selectedComparison = comparisons.find(
    (row) => String(row.instrument).toUpperCase() === instrument,
  );

  const candidates = Object.entries(providers)
    .filter(
      ([, row]) =>
        isFastMarkProviderRow(row) && Number(row.freshInstrumentCount) > 0,
    )
    .sort((left, right) => {
      const freshDelta =
        Number((right[1] as UnknownRecord).freshInstrumentCount) -
        Number((left[1] as UnknownRecord).freshInstrumentCount);
      return freshDelta !== 0 ? freshDelta : left[0].localeCompare(right[0]);
    });

  let active = candidates[0] ?? null;
  if (selectedComparison) {
    const comparisonProvider = String(selectedComparison.streamProvider);
    const comparisonRow = providers[comparisonProvider];
    if (
      isFastMarkProviderRow(comparisonRow) &&
      Number(comparisonRow.freshInstrumentCount) > 0
    ) {
      active = [comparisonProvider, comparisonRow];
    }
  }
  if (!active) return unavailable;

  const [provider, providerRowValue] = active;
  const providerRow = providerRowValue as UnknownRecord;
  const streamingInstruments = isStringArray(marketCache.streamingInstruments)
    ? marketCache.streamingInstruments.map((symbol) => symbol.toUpperCase())
    : [];
  const fallbackInstruments = isStringArray(
    marketCache.fastMarkFallbackInstruments,
  )
    ? marketCache.fastMarkFallbackInstruments.map((symbol) =>
        symbol.toUpperCase(),
      )
    : [];
  const freshCount = Number(providerRow.freshInstrumentCount);
  const streamingCount =
    typeof marketCache.streamingInstrumentCount === "number" &&
    Number.isFinite(marketCache.streamingInstrumentCount)
      ? marketCache.streamingInstrumentCount
      : streamingInstruments.length;
  const selectedInstrumentFallback = fallbackInstruments.includes(instrument);

  let state: FastMarkFeedUiState["state"];
  if (selectedInstrumentFallback) {
    state = "M5_FALLBACK";
  } else if (
    freshCount >= EXPECTED_FAST_MARK_INSTRUMENTS &&
    streamingCount >= EXPECTED_FAST_MARK_INSTRUMENTS &&
    streamingInstruments.includes(instrument)
  ) {
    state = "LIVE";
  } else {
    state = "DEGRADED";
  }

  const badgeLabel =
    state === "M5_FALLBACK"
      ? `M5 FALLBACK · ${instrument}`
      : `${provider} · ${state} · ${freshCount}/${EXPECTED_FAST_MARK_INSTRUMENTS}`;

  return {
    state,
    provider,
    freshCount,
    expectedCount: EXPECTED_FAST_MARK_INSTRUMENTS,
    streamingCount,
    fallbackCount: fallbackInstruments.length,
    selectedInstrumentFallback,
    latestObservedAt:
      typeof providerRow.latestObservedAt === "string"
        ? providerRow.latestObservedAt
        : null,
    latestSourceLagMs:
      typeof providerRow.latestSourceLagMs === "number"
        ? providerRow.latestSourceLagMs
        : null,
    maxFreshSourceLagMs:
      typeof providerRow.maxFreshSourceLagMs === "number"
        ? providerRow.maxFreshSourceLagMs
        : null,
    divergencePips:
      selectedComparison &&
      typeof selectedComparison.divergencePips === "number"
        ? selectedComparison.divergencePips
        : null,
    divergenceBps:
      selectedComparison && typeof selectedComparison.divergenceBps === "number"
        ? selectedComparison.divergenceBps
        : null,
    badgeLabel,
    badgeVariant: state === "LIVE" ? "success" : "warning",
  };
}

function isPairSideReliabilityRow(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.instrument === "string" &&
    (value.direction === "BUY" || value.direction === "SELL") &&
    (value.state === "NOT_APPLICABLE" ||
      value.state === "COLLECTING" ||
      value.state === "HEALTHY" ||
      value.state === "RESEARCH_ONLY") &&
    typeof value.episodes === "number" &&
    Number.isInteger(value.episodes) &&
    value.episodes >= 0 &&
    isNullableFiniteNumber(value.profitFactor) &&
    isNullableFiniteNumber(value.sharpe) &&
    isNullableFiniteNumber(value.maxDrawdown) &&
    isNullableFiniteNumber(value.positiveWindowFraction) &&
    typeof value.fullSizeEligible === "boolean" &&
    typeof value.researchFallbackRequested === "boolean" &&
    typeof value.reason === "string"
  );
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
  const pairSideReliability = value.pairSideReliability;
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
    !Array.isArray(pairSideReliability) ||
    !pairSideReliability.every(isPairSideReliabilityRow) ||
    !isNullableRecord(challenger.frozenConsensus) ||
    !isNullableRecord(challenger.historicalValidation) ||
    !isRecord(registry) ||
    !Array.isArray(registry.entries) ||
    !isRecord(marketCache)
  ) {
    return false;
  }

  if (
    (marketCache.fastMarkFallbackInstruments !== undefined &&
      !isStringArray(marketCache.fastMarkFallbackInstruments)) ||
    (marketCache.providerHealth !== undefined &&
      !isFastMarkProviderHealth(marketCache.providerHealth))
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
