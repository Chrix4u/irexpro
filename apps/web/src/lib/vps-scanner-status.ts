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
const MAX_BLOCKED_GATE_SCORE = 95;
const MAX_BLOCKED_READINESS_SCORE = 69;

export type TradeReadinessBand = "WAITING" | "FORMING" | "READY";

export interface TradeReadinessUiState {
  score: number;
  band: TradeReadinessBand;
  headline: string;
  detail: string;
  tradeExpected: boolean;
  instrument: string | null;
  direction: "BUY" | "SELL" | null;
}

export interface TradeReadinessUiInput {
  automationOn: boolean;
  scannerStatus: unknown;
  fastMarkState?: FastMarkFeedUiState["state"] | null;
  fallbackConfidence?: number | null;
  fallbackThreshold?: number | null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedProgress(value: number | null, target: number | null): number {
  if (value == null || target == null || target <= 0) return 0;
  return Math.max(0, Math.min(1, value / target));
}

/**
 * Customer-facing summary of the current trading gates.
 *
 * This is presentation-only. It never grants execution authority and can only
 * enter the green zone when the backend has already declared the current PAPER
 * setup execution-eligible. Fast-mark health can reduce readiness, never raise it.
 */
export function deriveTradeReadinessUiState(
  input: TradeReadinessUiInput,
): TradeReadinessUiState {
  const waiting = (
    score: number,
    headline: string,
    detail: string,
    instrument: string | null = null,
    direction: "BUY" | "SELL" | null = null,
  ): TradeReadinessUiState => ({
    score: Math.max(0, Math.min(100, Math.round(score))),
    band: score >= 40 ? "FORMING" : "WAITING",
    headline,
    detail,
    tradeExpected: false,
    instrument,
    direction,
  });

  if (!input.automationOn) {
    return waiting(
      0,
      "AI Trading is stopped",
      "Start AI Trading when you want iRexPro to evaluate and execute qualified opportunities.",
    );
  }

  const status = isRecord(input.scannerStatus) ? input.scannerStatus : null;
  const schedule = status && isRecord(status.marketSchedule) ? status.marketSchedule : null;
  if (schedule?.paused === true) {
    return waiting(
      8,
      "Market paused",
      "The AI is ready to resume automatically when the authoritative market window reopens.",
    );
  }

  const decision = status && isRecord(status.lastEnsembleDecision)
    ? status.lastEnsembleDecision
    : null;
  const governance = decision && isRecord(decision.governance) ? decision.governance : null;
  const thresholds = status && isRecord(status.ensembleThresholds)
    ? status.ensembleThresholds
    : null;
  const instrument = decision && typeof decision.instrument === "string"
    ? decision.instrument
    : null;
  const direction = decision?.direction === "BUY" || decision?.direction === "SELL"
    ? decision.direction
    : null;

  if (!decision || !thresholds) {
    const confidence = finite(input.fallbackConfidence);
    const threshold = finite(input.fallbackThreshold);
    const progress = normalizedProgress(confidence, threshold);
    const score = Math.min(64, 24 + progress * 40);
    return waiting(
      score,
      confidence == null ? "Scanning the market" : "Setup forming",
      "The AI is evaluating market quality, risk and execution conditions before it can trade.",
      instrument,
      direction,
    );
  }

  const candidateConfidence = finite(decision.candidateConfidence);
  const candidateFloor = finite(thresholds.candidateConfidenceFloor);
  const metaProbability = finite(decision.metaProbability);
  const metaFloor = finite(thresholds.metaProbabilityFloor);
  const expectedR = finite(decision.expectedR);
  const grossFloor = finite(thresholds.grossExpectedRFloor);
  const consensusPassed = finite(decision.consensusPassed);
  const consensusRequired = finite(decision.consensusRequired);

  let score = 0;
  score += normalizedProgress(candidateConfidence, candidateFloor) * 20;
  score += normalizedProgress(metaProbability, metaFloor) * 15;
  score += normalizedProgress(expectedR, grossFloor) * 15;
  score += normalizedProgress(consensusPassed, consensusRequired) * 15;
  score += governance?.paperNetExpectedRPassed === true ? 10 : 0;
  score += governance?.paperDriftPassed === true ? 8 : 0;
  score += governance?.eventRisk === "CLEAR" ? 7 : 0;
  score += decision.paperAdmitted === true || decision.admitted === true ? 5 : 0;
  score += governance?.paperExecutionEligible === true ? 5 : 0;

  const executionEligible = governance?.paperExecutionEligible === true;
  if (executionEligible) {
    score = Math.max(score, 78);
  } else {
    // Preserve the full 0–69 forming range instead of pinning every strong-but-
    // blocked setup at 69. The blocked score is normalized against the maximum
    // points available before execution eligibility (95). Green remains reserved
    // exclusively for backend-declared execution-eligible setups.
    score = Math.min(
      MAX_BLOCKED_READINESS_SCORE,
      (score / MAX_BLOCKED_GATE_SCORE) * MAX_BLOCKED_READINESS_SCORE,
    );
  }

  if (governance?.eventRisk === "HIGH_IMPACT_BLOCK" || governance?.eventRisk === "UNVERIFIED") {
    score = Math.min(score, 49);
  }

  if (input.fastMarkState === "DEGRADED") score = Math.min(score, 64);
  if (input.fastMarkState === "M5_FALLBACK") score = Math.min(score, 54);
  if (input.fastMarkState === "UNAVAILABLE") score = Math.min(score, 49);

  const rounded = Math.max(0, Math.min(100, Math.round(score)));
  const tradeExpected = executionEligible && rounded >= 70 && input.fastMarkState !== "DEGRADED" &&
    input.fastMarkState !== "M5_FALLBACK" && input.fastMarkState !== "UNAVAILABLE";

  if (tradeExpected) {
    return {
      score: rounded,
      band: "READY",
      headline: "Trade conditions ready",
      detail: "The current setup has passed the active model, risk and execution checks. An order may open when final dispatch conditions remain valid.",
      tradeExpected: true,
      instrument,
      direction,
    };
  }

  if (rounded >= 40) {
    return {
      score: rounded,
      band: "FORMING",
      headline: decision.paperAdmitted === true ? "Final checks in progress" : "Setup forming",
      detail: "Several conditions are aligned, but at least one required trade check is still holding the setup back.",
      tradeExpected: false,
      instrument,
      direction,
    };
  }

  return {
    score: rounded,
    band: "WAITING",
    headline: "Waiting for a stronger setup",
    detail: "The AI is monitoring the market and will stay out until enough conditions align.",
    tradeExpected: false,
    instrument,
    direction,
  };
}


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

export type ValidationPipelineGateState = "PASS" | "BLOCKED" | "WAITING";
export type ValidationPipelineGateCode =
  | "MARKET_DATA"
  | "REGIME"
  | "MODEL_QUALITY"
  | "CONSENSUS"
  | "NET_EDGE"
  | "DRIFT"
  | "EVENT_RISK"
  | "PAPER_EXECUTION";

export interface ValidationPipelineUiGate {
  code: ValidationPipelineGateCode;
  label: string;
  state: ValidationPipelineGateState;
  detail: string;
}

export interface ValidationPipelineUiCandidate {
  instrument: string;
  direction: "BUY" | "SELL";
  evaluatedAt: string;
  marketBarTime: string;
  regime: string;
  strategyRoute: string | null;
  confidence: number;
  ensembleScore: number;
  metaProbability: number;
  expectedR: number;
  netExpectedR: number | null;
  status: "READY" | "BLOCKED" | "WAITING";
  passedGates: number;
  totalGates: number;
  primaryBlocker: string | null;
  blockers: string[];
  gates: ValidationPipelineUiGate[];
}

export interface ValidationPipelineUiState {
  generatedAt: string;
  marketBarTime: string | null;
  pairsExpected: number;
  pairsEvaluated: number;
  readyPairs: number;
  blockedPairs: number;
  waitingPairs: number;
  error: string | null;
  candidates: ValidationPipelineUiCandidate[];
}

const VALIDATION_GATE_CODES = new Set<ValidationPipelineGateCode>([
  "MARKET_DATA",
  "REGIME",
  "MODEL_QUALITY",
  "CONSENSUS",
  "NET_EDGE",
  "DRIFT",
  "EVENT_RISK",
  "PAPER_EXECUTION",
]);

function isValidationPipelineGate(value: unknown): value is ValidationPipelineUiGate {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === "string" &&
    VALIDATION_GATE_CODES.has(value.code as ValidationPipelineGateCode) &&
    typeof value.label === "string" &&
    (value.state === "PASS" || value.state === "BLOCKED" || value.state === "WAITING") &&
    typeof value.detail === "string"
  );
}

function isValidationPipelineCandidate(value: unknown): value is ValidationPipelineUiCandidate {
  if (!isRecord(value) || !Array.isArray(value.gates)) return false;
  return (
    typeof value.instrument === "string" &&
    (value.direction === "BUY" || value.direction === "SELL") &&
    typeof value.evaluatedAt === "string" &&
    typeof value.marketBarTime === "string" &&
    typeof value.regime === "string" &&
    (value.strategyRoute === null || typeof value.strategyRoute === "string") &&
    typeof value.confidence === "number" &&
    Number.isFinite(value.confidence) &&
    typeof value.ensembleScore === "number" &&
    Number.isFinite(value.ensembleScore) &&
    typeof value.metaProbability === "number" &&
    Number.isFinite(value.metaProbability) &&
    typeof value.expectedR === "number" &&
    Number.isFinite(value.expectedR) &&
    isNullableFiniteNumber(value.netExpectedR) &&
    (value.status === "READY" || value.status === "BLOCKED" || value.status === "WAITING") &&
    typeof value.passedGates === "number" &&
    Number.isInteger(value.passedGates) &&
    value.passedGates >= 0 &&
    typeof value.totalGates === "number" &&
    Number.isInteger(value.totalGates) &&
    value.totalGates >= value.passedGates &&
    (value.primaryBlocker === null || typeof value.primaryBlocker === "string") &&
    isStringArray(value.blockers) &&
    value.gates.length === value.totalGates &&
    value.gates.every(isValidationPipelineGate)
  );
}

export function deriveValidationPipelineUiState(value: unknown): ValidationPipelineUiState | null {
  if (!isRecord(value) || !Array.isArray(value.candidates)) return null;
  if (
    typeof value.generatedAt !== "string" ||
    !isNullableTimestamp(value.marketBarTime) ||
    typeof value.pairsExpected !== "number" ||
    !Number.isInteger(value.pairsExpected) ||
    value.pairsExpected < 0 ||
    typeof value.pairsEvaluated !== "number" ||
    !Number.isInteger(value.pairsEvaluated) ||
    value.pairsEvaluated < 0 ||
    typeof value.readyPairs !== "number" ||
    !Number.isInteger(value.readyPairs) ||
    value.readyPairs < 0 ||
    typeof value.blockedPairs !== "number" ||
    !Number.isInteger(value.blockedPairs) ||
    value.blockedPairs < 0 ||
    typeof value.waitingPairs !== "number" ||
    !Number.isInteger(value.waitingPairs) ||
    value.waitingPairs < 0 ||
    (value.error !== null && value.error !== undefined && typeof value.error !== "string") ||
    !value.candidates.every(isValidationPipelineCandidate)
  ) {
    return null;
  }

  const candidates = value.candidates as ValidationPipelineUiCandidate[];
  if (
    value.pairsEvaluated !== candidates.length ||
    value.readyPairs + value.blockedPairs + value.waitingPairs !== candidates.length
  ) {
    return null;
  }

  return {
    generatedAt: value.generatedAt,
    marketBarTime: value.marketBarTime as string | null,
    pairsExpected: value.pairsExpected,
    pairsEvaluated: value.pairsEvaluated,
    readyPairs: value.readyPairs,
    blockedPairs: value.blockedPairs,
    waitingPairs: value.waitingPairs,
    error: typeof value.error === "string" ? value.error : null,
    candidates,
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
