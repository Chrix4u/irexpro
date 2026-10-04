"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  startExecutionModeForBroker,
  type UserCapitalAllocationView,
  type TradeExecutionView,
} from "@irexpro/types/execution";
import type { LivePositionRowView } from "@irexpro/types/live-account";
import type {
  MarketCandleView,
  MarketIntelligenceView,
} from "@irexpro/types/market-intelligence";
import {
  Alert,
  Badge,
  Button,
  Card,
  DashboardShell,
  Input,
  LoadingSpinner,
} from "@/components/ui";
import { useAuth } from "@/context/auth-context";
import { useNotification } from "@/hooks/useNotification";
import { MotionStatusOrb } from "@/components/ui/motion-status-orb";
import { api } from "@/lib/api";
import { formatAgeSeconds } from "@/lib/duration";
import { mapApiError } from "@/lib/error-mapping";
import { loadLiveAccountPositions } from "@/lib/live-account";
import { loadMarketIntelligence } from "@/lib/market-intelligence";
import {
  loadTraderExecutionSnapshot,
  type TraderExecutionSnapshot,
} from "@/lib/trader-execution";
import {
  loadTraderTerminalStatus,
  type TraderTerminalStatus,
  type TerminalBrokerView,
} from "@/lib/trader-terminal-status";
import "./ai-trader.css";

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return "Not available";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatFixedDecimal(
  value: string | null | undefined,
  fractionDigits = 2,
): string {
  if (!value) return "—";

  const normalized = value.trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) return normalized;

  const negative = match[1] === "-";
  const integerPart = match[2];
  const fractionalPart = match[3] ?? "";
  const scale = 10n ** BigInt(fractionDigits);
  const paddedFraction = fractionalPart.padEnd(fractionDigits + 1, "0");
  const keptFraction = paddedFraction.slice(0, fractionDigits) || "0";

  let scaled =
    BigInt(integerPart) * scale +
    (fractionDigits > 0 ? BigInt(keptFraction) : 0n);

  const roundDigit = paddedFraction[fractionDigits] ?? "0";
  if (roundDigit >= "5") {
    scaled += 1n;
  }

  const whole = scaled / scale;
  const fraction =
    fractionDigits > 0
      ? (scaled % scale).toString().padStart(fractionDigits, "0")
      : "";
  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = negative && scaled !== 0n ? "-" : "";

  return fractionDigits > 0
    ? `${sign}${groupedWhole}.${fraction}`
    : `${sign}${groupedWhole}`;
}

function money(
  value: string | null | undefined,
  currency: string | null | undefined,
): string {
  const formatted = formatFixedDecimal(value, 2);
  if (formatted === "—") return formatted;
  return currency ? `${formatted} ${currency}` : formatted;
}

function pnlBadge(value: string | null): "success" | "error" | "info" {
  if (!value) return "info";
  if (value.startsWith("-")) return "error";
  if (value === "0" || /^0(?:\.0+)?$/.test(value)) return "info";
  return "success";
}

function connectionLabel(broker: TerminalBrokerView | null): string {
  if (!broker) return "No broker connected";
  return broker.displayName || broker.brokerName;
}

function compactBrokerLabel(value: string | null | undefined): string {
  if (!value) return "Broker";
  return value
    .replace(/\s*\(Simulated\s*[—-]\s*PAPER_ONLY\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

type BrokerParityPresentation = {
  state: "READY" | "CONNECTING" | "BLOCKED" | "NOT_CONFIGURED";
  label: string;
  detail: string;
  badgeVariant: "success" | "warning" | "info";
};

function brokerParityPresentation(
  broker: TerminalBrokerView | null,
): BrokerParityPresentation {
  if (!broker) {
    return {
      state: "NOT_CONFIGURED",
      label: "NOT CONFIGURED",
      detail:
        "Connect an MT4/MT5 DEMO account through MetaApi to compare v7 against broker-native prices without sending broker orders.",
      badgeVariant: "info",
    };
  }

  const authorization = String(broker.authorizationStatus ?? "");
  if (
    broker.status === "CONNECTED" &&
    ["CONNECTED", "AUTHORIZED", "READY", "ACTIVE"].includes(authorization)
  ) {
    return {
      state: "READY",
      label: "BROKER FEED CONNECTED",
      detail:
        "Broker-native MetaTrader market data is available for read-only Broker-Parity PAPER. Order execution remains separately gated.",
      badgeVariant: "success",
    };
  }

  if (
    broker.status === "CONNECTING" ||
    ["CONNECTING", "VERIFYING"].includes(authorization)
  ) {
    return {
      state: "CONNECTING",
      label: "CONNECTING",
      detail:
        "MetaApi is establishing or verifying the broker connection. Parity comparison will remain read-only when available.",
      badgeVariant: "info",
    };
  }

  const providerError = String(broker.lastErrorMessage ?? "").toLowerCase();
  if (
    providerError.includes("top up") ||
    providerError.includes("topped up") ||
    providerError.includes("balance must be")
  ) {
    return {
      state: "BLOCKED",
      label: "METAAPI FUNDING REQUIRED",
      detail:
        "MetaApi cannot deploy the connected MetaTrader account until its MetaApi balance is topped up. The multi-model research engine remains independent; legacy v7 evidence stays preserved.",
      badgeVariant: "warning",
    };
  }

  return {
    state: "BLOCKED",
    label: "BROKER FEED BLOCKED",
    detail:
      "The MetaTrader connection is not currently healthy enough for broker-parity validation. This does not alter the multi-model shadow engine or the preserved legacy v7 evidence.",
    badgeVariant: "warning",
  };
}

interface VpsForexScannerStatusView {
  providerCode: string;
  activeEngineCode: string;
  activeEngineDisplayName: string;
  engineArchitecture: "MULTI_MODEL_ENSEMBLE";
  legacyBaselineProviderCode: string;
  legacyBaselineFrozen: boolean;
  multiModelPaperExecutionEnabled: boolean;
  executionAuthority: "SHADOW_ONLY" | "PAPER_ONLY";
  enabled: boolean;
  configured: boolean;
  activePaperSession: boolean;
  cadenceMinutes: number;
  timeframe: string;
  skippedUtcHours: number[];
  confidenceFloor: number;
  lastEvaluatedConfidence: number | null;
  lastEvaluatedInstrument: string | null;
  lastEvaluatedDirection: "BUY" | "SELL" | null;
  lastEvaluatedAt: string | null;
  lastEvaluationQualified: boolean;
  lastEvaluationReason: "QUALIFYING_SETUP" | "NO_QUALIFYING_SETUP";
  paperOnly: boolean;
  automaticDemoPromotion: boolean;
  automaticLivePromotion: boolean;
  marketSchedule: {
    paused: boolean;
    reason: "WEEKEND" | "ROLLOVER_LOW_LIQUIDITY" | null;
    nextEligibleScanAt: string;
  };
  highConvictionChallenger: {
    state:
      | "UNAVAILABLE"
      | "NOT_CONFIGURED"
      | "ERROR"
      | "ARTIFACT_READY_BROKER_MTF_REQUIRED"
      | "BROKER_MTF_OVERLAY_READY";
    artifact: string | null;
    loaded: boolean;
    featureCount: number | null;
    qualificationCutoff: string | null;
    sealedFutureHoldoutTouched: boolean | null;
    frozenConsensus: {
      opp_floor: number;
      margin_floor: number;
      votes_required: number;
    } | null;
    historicalValidation: {
      n: number | null;
      profit_factor: number | null;
      sharpe: number | null;
      balanced_accuracy: number | null;
      max_drawdown: number | null;
      positive_fold_fraction: number | null;
      positive_instrument_fraction: number | null;
      median_gap_minutes: number | null;
    } | null;
    executionAuthority: "NONE";
    paperPromotionEligible: boolean;
    brokerNativeRequired: boolean;
    brokerSourceConfigured: boolean;
    prospectiveScoringState:
      | "BROKER_SOURCE_NOT_CONFIGURED"
      | "READY_WAITING_FRESH_MARKET"
      | "READY_WAITING_FRESH_SCORE"
      | "READY"
      | "STALE";
    lastOverlay: {
      state: "CONFIRM" | "CONFLICT" | "ABSTAIN" | "STALE" | "UNAVAILABLE";
      reason: string | null;
      decisionTime: string | null;
      freshnessSeconds: number | null;
      allBrokerNative: boolean;
      direction: "BUY" | "SELL" | null;
      admitted: boolean | null;
      ensembleConfidence: number | null;
      meanOpportunityProbability: number | null;
      longVotes: number | null;
      shortVotes: number | null;
      regime: string | null;
      modifiesExecution: false;
    } | null;
    error: string | null;
  };
  ensembleCampaign: {
    decisions: number;
    admitted: number;
    rejected: number;
    resolved: number;
    evaluableResolved: number;
    wins: number;
    losses: number;
    expired: number;
    ambiguous: number;
    netR: number;
    profitFactor: number | null;
    sharpe: number | null;
    maxDrawdown: number | null;
    positiveWindowFraction: number | null;
    firstEvaluatedAt: string | null;
    lastEvaluatedAt: string | null;
    blockerCounts: Record<string, number>;
    highConvictionOverlayCounts: {
      CONFIRM: number;
      CONFLICT: number;
      ABSTAIN: number;
      STALE: number;
      UNAVAILABLE: number;
    };
    highConvictionOverlayPerformance: Record<
      "CONFIRM" | "CONFLICT" | "ABSTAIN" | "STALE" | "UNAVAILABLE",
      {
        state: "CONFIRM" | "CONFLICT" | "ABSTAIN" | "STALE" | "UNAVAILABLE";
        observations: number;
        resolved: number;
        evaluableResolved: number;
        wins: number;
        losses: number;
        expired: number;
        ambiguous: number;
        netR: number;
        profitFactor: number | null;
        sharpe: number | null;
        maxDrawdown: number | null;
        positiveWindowFraction: number | null;
      }
    >;
    profitProtection: {
      pathResolved: number;
      lossesWithPath: number;
      positiveMfeThenLosses: number;
      lossesAfterHalfR: number;
      lossesAfterOneR: number;
      averageMaxFavorableR: number | null;
      averageMaxCloseGivebackR: number | null;
      counterfactuals: Array<{
        code: string;
        observations: number;
        activated: number;
        exitedEarly: number;
        baselineNetR: number;
        policyNetR: number;
        deltaNetR: number;
        improved: number;
        worsened: number;
        unchanged: number;
      }>;
    };
    sleeves: Array<{
      instrument: string;
      direction: "BUY" | "SELL";
      decisions: number;
      admitted: number;
      resolved: number;
      state: "COLLECTING" | "CORE" | "PROBATION" | "BLOCKED";
      evidence: {
        closedTrades: number;
        profitFactor: number | null;
        sharpe: number | null;
        maxDrawdown: number | null;
        positiveWindowFraction: number | null;
      };
    }>;
  };
  expertRegistry: {
    policy: "EXPLICIT_PROVENANCE_V1";
    trainedModelCount: number;
    heuristicPolicyCount: number;
    riskGuardCount: number;
    frozenBaselineCount: number;
    entries: Array<{
      code: string;
      label: string;
      kind: "TRAINED_MODEL" | "HEURISTIC_POLICY" | "RISK_GUARD" | "FROZEN_BASELINE";
      lifecycle:
        | "SHADOW"
        | "READY_ARTIFACT"
        | "WAITING_FOR_DATA"
        | "COLLECTING"
        | "ACTIVE_GUARD"
        | "FROZEN"
        | "REJECTED";
      trained: boolean;
      artifact: string | null;
      dataAuthority: string;
      executionAuthority: "NONE";
      modifiesExecution: false;
      prospectiveEvidenceRequired: boolean;
      description: string;
    }>;
  };
  lastEnsembleDecision: {
    evaluatedAt: string | null;
    instrument: string | null;
    direction: "BUY" | "SELL" | null;
    admitted: boolean;
    ensembleScore: number | null;
    consensusPassed: number | null;
    consensusRequired: number | null;
    regime: string | null;
    reasons: string[];
    governance: {
      version: string;
      costModelVersion: string;
      driftModelVersion: string;
      grossExpectedR: number;
      estimatedExecutionCostR: number;
      netExpectedR: number;
      netExpectedRPassed: boolean;
      driftState: "NORMAL" | "STRESSED" | "OUT_OF_DISTRIBUTION";
      driftQuality: number;
      driftPassed: boolean;
      sleeveState: "COLLECTING" | "CORE" | "PROBATION" | "BLOCKED";
      sleeveEvidence: {
        closedTrades: number;
        profitFactor: number | null;
        sharpe: number | null;
        maxDrawdown: number | null;
        positiveWindowFraction: number | null;
      } | null;
      eventRisk: "CLEAR" | "HIGH_IMPACT_BLOCK" | "UNVERIFIED";
      paperPromotionEligible: boolean;
      blockers: string[];
    } | null;
    highConvictionOverlay: {
      state: "CONFIRM" | "CONFLICT" | "ABSTAIN" | "STALE" | "UNAVAILABLE";
      reason: string | null;
      decisionTime: string | null;
      freshnessSeconds: number | null;
      allBrokerNative: boolean;
      direction: "BUY" | "SELL" | null;
      admitted: boolean | null;
      ensembleConfidence: number | null;
      meanOpportunityProbability: number | null;
      longVotes: number | null;
      shortVotes: number | null;
      regime: string | null;
      modifiesExecution: false;
    } | null;
  };
  components: Record<string, string>;
  marketCache: {
    cachedInstruments: string[];
    cachedInstrumentCount: number;
    streamingInstruments: string[];
    streamingInstrumentCount: number;
    latestObservedAt: string | null;
    latestQuoteObservedAt: string | null;
  };
  state:
    | "WAITING_FOR_CONFIGURATION"
    | "DISABLED"
    | "WAITING_FOR_PAPER_SESSION"
    | "WAITING_FOR_PROVIDER_QUOTA"
    | "WAITING_FOR_MARKET_DATA"
    | "MARKET_PAUSED"
    | "MULTI_MODEL_SHADOW"
    | "ACTIVE";
}

interface BrokerParityRuntimeStatusView {
  providerCode: string;
  modelVersion: string;
  enabled: boolean;
  configured: boolean;
  brokerNativeOnly: boolean;
  twelveDataFallback: false;
  frozenArtifactRequired: boolean;
  frozenArtifactConfigured: boolean;
  signalExecutionEnabled: boolean;
  activeTargetSession: boolean;
  state:
    | "DISABLED"
    | "WAITING_FOR_CONFIGURATION"
    | "WAITING_FOR_FROZEN_ARTIFACT"
    | "WAITING_FOR_BROKER_DATA"
    | "READ_ONLY_READY"
    | "WAITING_FOR_PAPER_SESSION"
    | "ACTIVE_PAPER";
  marketCache: VpsForexScannerStatusView["marketCache"];
  lastCollectedAt: string | null;
  lastError: string | null;
}

interface V8DedicatedPaperStatusView {
  providerCode: string;
  modelVersion: string;
  enabled: boolean;
  configured: boolean;
  isolatedTarget: boolean;
  targetPaperConnection: boolean;
  requiredFreshBaselineUsd: number;
  v7EvidencePreserved: boolean;
  shadowEvidencePreservedButNotQualification: boolean;
  formalQualificationStartsAtZero: boolean;
  frozenArtifactRequired: boolean;
  frozenArtifactConfigured: boolean;
  activeTargetSession: boolean;
  state:
    | "DISABLED"
    | "WAITING_FOR_CONFIGURATION"
    | "TARGET_NOT_ISOLATED"
    | "COLLECTING_PROSPECTIVE_SHADOW"
    | "WAITING_FOR_FROZEN_ARTIFACT"
    | "READY_FOR_FRESH_PAPER"
    | "ACTIVE_PAPER";
  prospectiveShadow: {
    artifact: string;
    taggedSignals: number;
    admittedSignals: number;
    closedTrades: number;
    screeningReadyForDedicatedPaper: boolean;
  } | null;
  activationPolicy: string;
}

interface ExternalProviderPerformanceView {
  providerCode: string;
  strategyIdentity: {
    displayName: string;
    modelVersion: string;
    marketDataAuthority: string;
    evidenceCohortKey: string;
    evidenceIsolationApplied: boolean;
    evidenceCohortIntegrity: boolean;
    authorityTaggedSignals: number;
    authorityTagCoverage: number;
    observedMarketDataAuthorities: string[];
    strategyFrozen: boolean;
    currentEnvironment: "PAPER";
    currentExecution: "SIMULATED_PAPER_BROKER";
    productionPromotionPolicy: string;
  };
  executionAuthority: "PAPER_ONLY";
  certificationStatus: "PAPER_EVIDENCE_ONLY" | "ELIGIBLE_FOR_DEMO_REVIEW";
  demoReviewEligible: boolean;
  automaticDemoPromotion: boolean;
  automaticLivePromotion: boolean;
  observed: {
    receivedSignals: number;
    buySignals: number;
    sellSignals: number;
    executedTrades: number;
    buyExecutedTrades: number;
    sellExecutedTrades: number;
    rejectedSignals: number;
    closedTrades: number;
    interruptedClosedTrades: number;
    ambiguousClosedTrades: number;
    sameBarProtectionAmbiguityCount: number;
    strategyRealisedPnl: number;
    balancedAccuracy: number | null;
    profitFactor: number | null;
    evidenceWindowSharpeRatio: number | null;
    maxDrawdown: number | null;
    positiveWeeklyWindowFraction: number;
    positiveInstrumentFraction: number;
    minSubmittedConfidence: number | null;
    latestSubmittedConfidence: number | null;
    latestSignalAt: string | null;
    latestSignalInstrument: string | null;
    latestSignalDirection: "BUY" | "SELL" | null;
    medianMinutesBetweenSignals: number | null;
    totalNormalizedReturn: number;
    evaluatedWeeklyWindows: number;
  };
  checks: {
    balancedAccuracy: boolean;
    sharpeRatio: boolean;
    profitFactor: boolean;
    maxDrawdown: boolean;
    positiveWindowFraction: boolean;
    positiveInstrumentFraction: boolean;
    confidence: boolean;
    evidence: boolean;
    frequency: boolean;
    evidenceCohortIntegrity: boolean;
  };
  shadowCalibration: {
    mode: "DIAGNOSTIC_ONLY";
    modifiesExecution: false;
    resetsProviderEvidence: false;
    closedTradesEvaluated: number;
    brierScore: number | null;
    expectedCalibrationError: number | null;
    confidencePnlCorrelation: number | null;
    minimumEvidenceBeforeAdaptiveUse: {
      globalClosedTrades: number;
      pairDirectionClosedTrades: number;
      minimumWins: number;
      minimumLosses: number;
    };
    confidenceBins: Array<{
      lower: number;
      upper: number;
      count: number;
      wins: number;
      losses: number;
      avgConfidence: number | null;
      observedWinRate: number | null;
      calibrationGap: number | null;
      averagePnl: number | null;
      profitFactor: number | null;
    }>;
    pairDirection: Array<{
      instrument: string;
      direction: "BUY" | "SELL";
      closedTrades: number;
      wins: number;
      losses: number;
      winRate: number | null;
      smoothedWinRate: number;
      realisedPnl: number;
      averagePnl: number | null;
      averageWin: number | null;
      averageLoss: number | null;
      profitFactor: number | null;
      averageConfidence: number | null;
      evidenceStatus: "OBSERVE" | "EARLY_ACTIONABLE";
    }>;
  };
  profitProtectionShadow: {
    mode: "DIAGNOSTIC_ONLY";
    modifiesExecution: false;
    observedClosedTrades: number;
    losingTradesObserved: number;
    losersWithPositiveMfe: number;
    loserPositiveMfeFraction: number | null;
    averageMaxFavorablePnl: number | null;
    averageMaxAdversePnl: number | null;
    averageProfitGiveback: number | null;
    losingTradesThatReached: {
      usd3: number;
      usd5: number;
      usd10: number;
    };
    methodology: string;
  };
  driftDiagnostics: {
    mode: "DIAGNOSTIC_ONLY";
    modifiesExecution: false;
    recentWindowSize: number;
    minimumClosedTrades: number;
    status: "INSUFFICIENT_EVIDENCE" | "STABLE" | "WATCH" | "DEGRADED";
    recent: {
      closedTrades: number;
      realisedPnl: number;
      averagePnl: number | null;
      winRate: number | null;
      profitFactor: number | null;
    };
    reference: {
      closedTrades: number;
      realisedPnl: number;
      averagePnl: number | null;
      winRate: number | null;
      profitFactor: number | null;
    };
    recentToReferenceProfitFactorRatio: number | null;
    methodology: string;
  };
  v8ProspectiveShadow: {
    artifact: string;
    mode: "PROSPECTIVE_SHADOW_ONLY";
    modifiesExecution: false;
    admissionThreshold: number;
    trainingEvidence: string;
    qualificationEvidence: false;
    maxDrawdownIsolated: false;
    taggedSignals: number;
    admittedSignals: number;
    rejectedSignals: number;
    admittedFraction: number;
    executedTrades: number;
    closedTrades: number;
    rejectedClosedTrades: number;
    rejectedWins: number;
    rejectedLosses: number;
    rejectedRealisedPnl: number;
    rejectedProfitFactor: number | null;
    wins: number;
    losses: number;
    realisedPnl: number;
    profitFactor: number | null;
    balancedAccuracy: number | null;
    evidenceWindowSharpeRatio: number | null;
    positiveWeeklyWindowFraction: number;
    positiveInstrumentFraction: number;
    medianMinutesBetweenSignals: number | null;
    minUnderlyingConfidence: number | null;
    latestProbability: number | null;
    minProbability: number | null;
    screeningChecks: {
      balancedAccuracy: boolean;
      sharpeRatio: boolean;
      profitFactor: boolean;
      positiveWindowFraction: boolean;
      positiveInstrumentFraction: boolean;
      confidence: boolean;
      evidence: boolean;
      frequency: boolean;
    };
    screeningReadyForDedicatedPaper: boolean;
    nextStage: "DEDICATED_V8_PAPER_REQUIRED" | "COLLECTING_PROSPECTIVE_SHADOW";
    methodology: string;
  };
  planBEnsembleShadow?: {
    artifact: string;
    mode: "PROSPECTIVE_SHADOW_ONLY";
    modifiesExecution: false;
    taggedSignals: number;
    admittedSignals: number;
    rejectedSignals: number;
    admittedFraction: number;
    closedTrades: number;
    wins: number;
    losses: number;
    realisedPnl: number;
    profitFactor: number | null;
    regimeCounts: Record<string, number>;
    pairSideRouteCounts: Record<string, number>;
    averageDirectionQuality: number | null;
    averageTradeQuality: number | null;
    averageExitQuality: number | null;
    averagePairSideQuality: number | null;
    averageSessionQuality: number | null;
    averageConsensusPassed: number | null;
    averageConsensusRequired: number | null;
    averagePortfolioQuality: number | null;
    averagePortfolioRiskScore: number | null;
    averageOpenPositionCount: number | null;
    averageSameInstrumentCount: number | null;
    averageMetaProbability: number | null;
    averageEnsembleScore: number | null;
    methodology: string;
  };
}

function providerMetric(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function providerPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

interface AiAutomationRuntimeStatus {
  enabled: boolean;
  registered: boolean;
  trading_session_id: string;
  active: boolean;
  instruments: string[];
  timeframe: string | null;
  interval_seconds: number | null;
  source: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  last_decision: string | null;
  last_reason: string | null;
  last_confidence_score: number | null;
  last_confidence_at: string | null;
  confidence_threshold: number | null;
  model_version: string | null;
  model_mode: string | null;
  model_loaded: boolean | null;
  last_market_data_at: string | null;
  last_market_data_close: string | null;
  market_data_age_seconds: number | null;
  market_data_cache_bypassed: boolean;
  last_publish_failed: boolean;
  research_uat?: boolean;
  replay_steps_per_cycle?: number;
  replay_steps_last_cycle?: number;
  replay_steps_total?: number;
  signals_published_total?: number;
  last_strategy_outcome?: string | null;
  last_strategy_reason?: string | null;
  last_trade_id?: string | null;
  executions_succeeded_total?: number;
  downstream_rejected_total?: number;
}

function runtimeReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "Waiting for first market scan";
  const labels: Record<string, string> = {
    confidence_below_threshold:
      "Market setup did not meet the confidence threshold",
    confidence_threshold_passed:
      "Signal passed the confidence threshold and was published",
    market_data_unchanged:
      "No new market-data revision was available, so no duplicate signal was published",
    scheduler_integration_disabled: "AI scheduler integration is disabled",
    model_not_approved_for_live:
      "Current AI model is not yet approved for live-money automation",
    MarketDataError:
      "Market data is unavailable or invalid; this scan was skipped and no confidence was evaluated",
    research_uat_replay_budget_exhausted:
      "Research PAPER replay completed its bounded market steps without an eligible signal",
    uat_workflow_probe_published:
      "Synthetic Research PAPER workflow probe published. The model did not pass the normal confidence gate.",
  };
  return labels[reason] ?? reason.replaceAll("_", " ");
}

function formatConfidence(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

function modelModeLabel(mode: string | null | undefined): string {
  if (!mode) return "Unknown";
  if (mode === "heuristic_placeholder") return "Heuristic scaffold";
  if (mode === "trained_xgboost_mtf") return "Trained MTF XGBoost";
  if (mode === "trained_xgboost" || mode === "real") return "Trained XGBoost";
  return mode.replaceAll("_", " ");
}

function executionReasonLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const labels: Record<string, string> = {
    MARKET_SAFETY_MARKET_DATA_UNAVAILABLE:
      "Execution blocked because a current paper-market quote could not be proven.",
    MARKET_SAFETY_STALE_PRICE:
      "Execution blocked because the provider quote was outside the allowed freshness window.",
    MARKET_SAFETY_ABNORMAL_SPREAD:
      "Execution blocked because the current spread exceeded the market-safety limit.",
    MARKET_SAFETY_PRICE_DEVIATION_EXCESSIVE:
      "Execution blocked because the execution quote was too far from the risk-validated reference price.",
    DISPATCH_BOUNDARY_BLOCKED:
      "Execution authority changed before provider dispatch, so the order was blocked safely.",
    EXECUTION_UNRESOLVED:
      "Provider outcome is not yet proven; reconciliation is still required.",
    EXECUTION_CANCELLED:
      "The order was cancelled before an active position was established.",
    EXECUTION_REJECTED:
      "The order was rejected before an active position was established.",
  };
  return labels[code] ?? "Execution did not establish an active position.";
}

function sumDecimalStrings(
  values: Array<string | null | undefined>,
): string | null {
  if (values.length === 0) return "0";
  if (values.some((value) => !value?.trim())) return null;

  const parsed = values.map((value) => {
    const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(value!.trim());
    if (!match) return null;
    return {
      negative: match[1] === "-",
      whole: match[2],
      fraction: match[3] ?? "",
    };
  });
  if (parsed.some((value) => value === null)) return null;

  const decimals = parsed as Array<{
    negative: boolean;
    whole: string;
    fraction: string;
  }>;
  const scale = Math.max(...decimals.map((value) => value.fraction.length), 0);
  const factor = 10n ** BigInt(scale);
  const total = decimals.reduce((acc, value) => {
    const fraction = value.fraction.padEnd(scale, "0") || "0";
    const scaled =
      BigInt(value.whole) * factor + (scale ? BigInt(fraction) : 0n);
    return acc + (value.negative ? -scaled : scaled);
  }, 0n);

  const negative = total < 0n;
  const absolute = negative ? -total : total;
  const whole = absolute / factor;
  const fraction = scale
    ? (absolute % factor).toString().padStart(scale, "0").replace(/0+$/, "")
    : "";
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function PositionCard({
  position,
  closing,
  onClose,
}: {
  position: LivePositionRowView;
  closing: boolean;
  onClose: (tradeId: string) => void;
}) {
  return (
    <article className="ai-position-card">
      <div className="ai-position-card__head">
        <div>
          <strong>{position.instrument}</strong>
          <span>
            {position.direction} · {position.lotSize} lot ·{" "}
            {position.status.replaceAll("_", " ")}
          </span>
        </div>
        <Badge variant={pnlBadge(position.unrealisedPnl)}>
          {position.unrealisedPnl === null
            ? "P&L awaiting broker"
            : `${position.markIsStale ? "Last known · " : ""}${position.unrealisedPnl.startsWith("-") ? "" : "+"}${money(position.unrealisedPnl, position.accountCurrency)}`}
        </Badge>
      </div>
      <dl className="ai-trade-metrics">
        <div>
          <dt>Entry</dt>
          <dd>{position.fillPrice ?? position.requestedEntryPrice}</dd>
        </div>
        <div>
          <dt>Current</dt>
          <dd>
            {position.currentPrice ?? "Awaiting broker mark"}
            {position.markSource ? (
              <small>
                {position.markSource === "STREAM"
                  ? "Live stream"
                  : position.markSource === "REST_M5"
                    ? "M5 fallback"
                    : "Broker mark"}
                {position.markIsStale ? " · STALE" : ""}
                {position.markObservedAt
                  ? ` · ${formatTimestamp(position.markObservedAt)}`
                  : ""}
              </small>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Peak P&amp;L</dt>
          <dd>
            {position.pathDiagnostics
              ? `${position.pathDiagnostics.maxFavorablePnl.startsWith("-") ? "" : "+"}${money(
                  position.pathDiagnostics.maxFavorablePnl,
                  position.accountCurrency,
                )}`
              : "—"}
            {position.pathDiagnostics?.peakObservedAt ? (
              <small>
                Peak · {formatTimestamp(position.pathDiagnostics.peakObservedAt)}
              </small>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Profit give-back</dt>
          <dd>
            {position.pathDiagnostics
              ? money(
                  position.pathDiagnostics.profitGiveback,
                  position.accountCurrency,
                )
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Worst excursion</dt>
          <dd>
            {position.pathDiagnostics
              ? money(
                  position.pathDiagnostics.maxAdversePnl,
                  position.accountCurrency,
                )
              : "—"}
          </dd>
        </div>
        <div>
          <dt>Stop loss</dt>
          <dd>{position.stopLoss}</dd>
        </div>
        <div>
          <dt>Take profit</dt>
          <dd>{position.takeProfit}</dd>
        </div>
        <div>
          <dt>Commission</dt>
          <dd>{money(position.commission, position.accountCurrency)}</dd>
        </div>
        <div>
          <dt>Swap</dt>
          <dd>{money(position.swap, position.accountCurrency)}</dd>
        </div>
      </dl>
      <div className="ai-position-card__foot">
        <span>
          {compactBrokerLabel(position.brokerName)} · {position.environment}
        </span>
        <span>{formatTimestamp(position.openedAt ?? position.createdAt)}</span>
      </div>
      <Button
        type="button"
        variant="danger"
        size="sm"
        loading={closing}
        disabled={closing}
        onClick={() => onClose(position.id)}
      >
        {closing ? "Closing…" : "Close position"}
      </Button>
    </article>
  );
}

function PositionTable({
  positions,
  closingTradeId,
  onClose,
}: {
  positions: LivePositionRowView[];
  closingTradeId: string | null;
  onClose: (tradeId: string) => void;
}) {
  return (
    <div className="ai-data-table-wrap">
      <table
        className="ai-data-table"
        aria-label="Open positions live performance"
      >
        <thead>
          <tr>
            <th>Instrument</th>
            <th>Side</th>
            <th>Lots</th>
            <th>Entry</th>
            <th>Current</th>
            <th>Unrealized P&amp;L</th>
            <th>Peak P&amp;L</th>
            <th>Give-back</th>
            <th>SL</th>
            <th>TP</th>
            <th>Commission</th>
            <th>Swap</th>
            <th>Status</th>
            <th>Opened</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.id}>
              <td>
                <strong>{position.instrument}</strong>
                <small>
                  {compactBrokerLabel(position.brokerName)} ·{" "}
                  {position.environment}
                </small>
              </td>
              <td>
                <Badge
                  variant={position.direction === "BUY" ? "success" : "warning"}
                >
                  {position.direction}
                </Badge>
              </td>
              <td>{position.lotSize}</td>
              <td>{position.fillPrice ?? position.requestedEntryPrice}</td>
              <td>
                <strong>{position.currentPrice ?? "—"}</strong>
                {position.markSource ? (
                  <small>
                    {position.markSource === "STREAM"
                      ? "Live stream"
                      : position.markSource === "REST_M5"
                        ? "M5 fallback"
                        : "Broker mark"}
                    {position.markIsStale ? " · STALE" : ""}
                    {position.markObservedAt
                      ? ` · ${formatTimestamp(position.markObservedAt)}`
                      : ""}
                  </small>
                ) : null}
              </td>
              <td>
                <Badge variant={pnlBadge(position.unrealisedPnl)}>
                  {position.unrealisedPnl === null
                    ? "Awaiting mark"
                    : `${position.markIsStale ? "Last known · " : ""}${position.unrealisedPnl.startsWith("-") ? "" : "+"}${money(position.unrealisedPnl, position.accountCurrency)}`}
                </Badge>
              </td>
              <td>
                {position.pathDiagnostics
                  ? `${position.pathDiagnostics.maxFavorablePnl.startsWith("-") ? "" : "+"}${money(
                      position.pathDiagnostics.maxFavorablePnl,
                      position.accountCurrency,
                    )}`
                  : "—"}
              </td>
              <td>
                {position.pathDiagnostics
                  ? money(
                      position.pathDiagnostics.profitGiveback,
                      position.accountCurrency,
                    )
                  : "—"}
              </td>
              <td>{position.stopLoss}</td>
              <td>{position.takeProfit}</td>
              <td>{money(position.commission, position.accountCurrency)}</td>
              <td>{money(position.swap, position.accountCurrency)}</td>
              <td>{position.status.replaceAll("_", " ")}</td>
              <td>
                {formatTimestamp(position.openedAt ?? position.createdAt)}
              </td>
              <td>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  loading={closingTradeId === position.id}
                  disabled={closingTradeId !== null}
                  onClick={() => onClose(position.id)}
                >
                  {closingTradeId === position.id ? "Closing…" : "Close"}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExecutionRow({ trade }: { trade: TradeExecutionView }) {
  const realized = trade.status === "CLOSED" ? trade.realisedPnl : null;
  const executionReason = executionReasonLabel(trade.executionReasonCode);
  return (
    <article className="ai-activity-row">
      <div className="ai-activity-row__symbol">
        <strong>{trade.instrument}</strong>
        <span>
          {trade.direction} · {trade.lotSize} lot
        </span>
      </div>
      <div className="ai-activity-row__state">
        <Badge
          variant={
            trade.status === "CLOSED" || trade.status === "OPEN"
              ? "success"
              : trade.status === "REJECTED" || trade.status === "CANCELLED"
                ? "error"
                : "warning"
          }
        >
          {trade.status.replaceAll("_", " ")}
        </Badge>
        {realized !== null && (
          <Badge variant={pnlBadge(realized)}>
            {realized.startsWith("-") ? "" : "+"}
            {money(realized, trade.accountCurrency)}
          </Badge>
        )}
      </div>
      <div className="ai-order-detail-grid">
        <div>
          <span>Entry</span>
          <strong>{trade.fillPrice ?? trade.requestedEntryPrice}</strong>
        </div>
        <div>
          <span>Exit</span>
          <strong>{trade.exitPrice ?? "—"}</strong>
        </div>
        <div>
          <span>Realized P&amp;L</span>
          <strong>
            {trade.realisedPnl === null
              ? "—"
              : money(trade.realisedPnl, trade.accountCurrency)}
          </strong>
        </div>
        <div>
          <span>Commission</span>
          <strong>{money(trade.commission, trade.accountCurrency)}</strong>
        </div>
        <div>
          <span>Swap</span>
          <strong>{money(trade.swap, trade.accountCurrency)}</strong>
        </div>
        <div>
          <span>Stop loss</span>
          <strong>{trade.stopLoss}</strong>
        </div>
        <div>
          <span>Take profit</span>
          <strong>{trade.takeProfit}</strong>
        </div>
        <div>
          <span>Closed by</span>
          <strong>
            {trade.closeReason ? trade.closeReason.replaceAll("_", " ") : "—"}
          </strong>
        </div>
      </div>
      {executionReason && (
        <div className="ai-activity-row__reason">{executionReason}</div>
      )}
      <div className="ai-activity-row__time">
        Opened {formatTimestamp(trade.openedAt ?? trade.createdAt)}
        {trade.closedAt ? ` · Closed ${formatTimestamp(trade.closedAt)}` : ""}
      </div>
    </article>
  );
}

function MarketPriceChart({ candles }: { candles: MarketCandleView[] }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  if (!candles.length) {
    return (
      <div className="ai-market-chart__empty">Waiting for market candles…</div>
    );
  }

  const parsed = candles
    .map((candle) => ({
      ...candle,
      openN: Number(candle.open),
      highN: Number(candle.high),
      lowN: Number(candle.low),
      closeN: Number(candle.close),
      volumeN: Number(candle.volume),
    }))
    .filter((candle) =>
      [candle.openN, candle.highN, candle.lowN, candle.closeN].every(
        Number.isFinite,
      ),
    );
  if (!parsed.length)
    return <div className="ai-market-chart__empty">Chart unavailable</div>;

  const width = 820;
  const height = 320;
  const priceBottom = 245;
  const volumeTop = 262;
  const padX = 26;
  const min = Math.min(...parsed.map((candle) => candle.lowN));
  const max = Math.max(...parsed.map((candle) => candle.highN));
  const range = Math.max(max - min, Math.abs(max) * 0.0001, 0.00001);
  const maxVolume = Math.max(...parsed.map((candle) => candle.volumeN), 1);
  const slot = (width - padX * 2) / Math.max(parsed.length, 1);
  const bodyWidth = Math.max(2.2, Math.min(8, slot * 0.58));
  const y = (value: number) =>
    14 + ((max - value) / range) * (priceBottom - 28);
  const activeIndex = hoveredIndex == null ? parsed.length - 1 : hoveredIndex;
  const active = parsed[Math.max(0, Math.min(activeIndex, parsed.length - 1))];

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const index = Math.round((x - padX - slot / 2) / slot);
    setHoveredIndex(Math.max(0, Math.min(parsed.length - 1, index)));
  };

  return (
    <div className="ai-market-chart">
      <div className="ai-market-chart__ohlc">
        <span>{new Date(active.timestamp).toLocaleString()}</span>
        <span>
          O <strong>{active.open}</strong>
        </span>
        <span>
          H <strong>{active.high}</strong>
        </span>
        <span>
          L <strong>{active.low}</strong>
        </span>
        <span>
          C <strong>{active.close}</strong>
        </span>
        <span>
          Vol <strong>{active.volume}</strong>
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Interactive candlestick chart"
        onMouseMove={onMove}
        onMouseLeave={() => setHoveredIndex(null)}
      >
        {[0.2, 0.4, 0.6, 0.8].map((fraction) => (
          <line
            key={fraction}
            className="ai-market-chart__gridline"
            x1={padX}
            x2={width - padX}
            y1={14 + (priceBottom - 28) * fraction}
            y2={14 + (priceBottom - 28) * fraction}
          />
        ))}
        {parsed.map((candle, index) => {
          const x = padX + slot * index + slot / 2;
          const isUp = candle.closeN >= candle.openN;
          const top = y(Math.max(candle.openN, candle.closeN));
          const bottom = y(Math.min(candle.openN, candle.closeN));
          const volumeHeight = Math.max(2, (candle.volumeN / maxVolume) * 42);
          return (
            <g
              key={`${candle.timestamp}-${index}`}
              className={isUp ? "is-up" : "is-down"}
            >
              <line
                className="ai-market-chart__wick"
                x1={x}
                x2={x}
                y1={y(candle.highN)}
                y2={y(candle.lowN)}
              />
              <rect
                className="ai-market-chart__candle"
                x={x - bodyWidth / 2}
                y={Math.min(top, bottom)}
                width={bodyWidth}
                height={Math.max(1.8, Math.abs(bottom - top))}
                rx="1.2"
              />
              <rect
                className="ai-market-chart__volume"
                x={x - bodyWidth / 2}
                y={volumeTop + 42 - volumeHeight}
                width={bodyWidth}
                height={volumeHeight}
                rx="1"
              />
            </g>
          );
        })}
        {hoveredIndex != null &&
          (() => {
            const x = padX + slot * activeIndex + slot / 2;
            return (
              <line
                className="ai-market-chart__crosshair"
                x1={x}
                x2={x}
                y1="8"
                y2={height - 10}
              />
            );
          })()}
      </svg>
      <div className="ai-market-chart__range">
        <span>{min.toFixed(3)}</span>
        <span>{max.toFixed(3)}</span>
      </div>
    </div>
  );
}

export default function AiTradingPage() {
  const { user, logout, restoring } = useAuth();
  const notify = useNotification();

  const [terminal, setTerminal] = useState<TraderTerminalStatus | null>(null);
  const [execution, setExecution] = useState<TraderExecutionSnapshot | null>(
    null,
  );
  const [livePositions, setLivePositions] = useState<LivePositionRowView[]>([]);
  const [market, setMarket] = useState<MarketIntelligenceView | null>(null);
  const [chartInstrument, setChartInstrument] = useState("USDJPY");
  const [chartTimeframe, setChartTimeframe] = useState<
    "M1" | "M5" | "M15" | "H1" | "H4"
  >("M5");
  const [chartLoading, setChartLoading] = useState(false);
  const [allocation, setAllocation] =
    useState<UserCapitalAllocationView | null>(null);
  const [selectedBrokerId, setSelectedBrokerId] = useState<string>("");
  const [allocationAmount, setAllocationAmount] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingAllocation, setSavingAllocation] = useState(false);
  const [togglingAutomation, setTogglingAutomation] = useState(false);
  const [pendingAutomationAction, setPendingAutomationAction] = useState<
    "START" | "STOP" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [allocationWarning, setAllocationWarning] = useState<string | null>(
    null,
  );
  const [activityWarning, setActivityWarning] = useState<string | null>(null);
  const [automationRuntime, setAutomationRuntime] =
    useState<AiAutomationRuntimeStatus | null>(null);
  const [providerEvidence, setProviderEvidence] =
    useState<ExternalProviderPerformanceView | null>(null);
  const [vpsScannerStatus, setVpsScannerStatus] =
    useState<VpsForexScannerStatusView | null>(null);
  const [brokerParityRuntime, setBrokerParityRuntime] =
    useState<BrokerParityRuntimeStatusView | null>(null);
  const [v8DedicatedPaperStatus, setV8DedicatedPaperStatus] =
    useState<V8DedicatedPaperStatusView | null>(null);
  const [automationRuntimeWarning, setAutomationRuntimeWarning] = useState<
    string | null
  >(null);
  const [positionView, setPositionView] = useState<"table" | "grid">("table");
  const [closingTradeId, setClosingTradeId] = useState<string | null>(null);
  const [closingAllPositions, setClosingAllPositions] = useState(false);

  const initializedActivity = useRef(false);
  const seenPositionIds = useRef<Set<string>>(new Set());
  const seenExecutionStates = useRef<Map<string, string>>(new Map());
  const tradingRefreshInFlight = useRef(false);
  const positionsRefreshInFlight = useRef(false);

  const controlStateReady = Boolean(
    terminal?.risk && terminal?.sessionStateKnown,
  );
  const automationOn =
    terminal?.sessionStateKnown === true &&
    (terminal.session?.status === "ACTIVE" ||
      terminal.session?.status === "PAUSED");
  const aiVisualState = !automationOn
    ? "stopped"
    : automationRuntime?.last_decision === "ERROR"
      ? "error"
      : automationRuntime?.last_decision === "BLOCKED"
        ? "blocked"
        : automationRuntime?.last_decision === "SIGNAL_PUBLISHED" ||
            automationRuntime?.last_strategy_outcome === "EXECUTION_SUCCEEDED"
          ? "signal"
          : automationRuntime?.last_decision === "NO_TRADE" ||
              automationRuntime?.last_decision === "NO_NEW_MARKET_DATA"
            ? "scanning"
            : "running";

  const vpsConfidenceActive = vpsScannerStatus?.enabled === true;
  const submittedVpsConfidence =
    providerEvidence?.observed.latestSubmittedConfidence ?? null;
  const displayedConfidence = vpsConfidenceActive
    ? (vpsScannerStatus?.lastEnsembleDecision.ensembleScore ??
      vpsScannerStatus?.lastEvaluatedConfidence ??
      null)
    : (automationRuntime?.last_confidence_score ?? null);
  const displayedConfidenceThreshold = vpsConfidenceActive
    ? null
    : (automationRuntime?.confidence_threshold ?? null);
  const confidencePercent = Math.max(
    0,
    Math.min(100, (displayedConfidence ?? 0) * 100),
  );
  const confidenceTone =
    confidencePercent >= 70
      ? "strong"
      : confidencePercent >= 60
        ? "ready"
        : confidencePercent >= 45
          ? "building"
          : "weak";
  const watchedInstruments = automationRuntime?.instruments?.length
    ? automationRuntime.instruments
    : [chartInstrument];
  const latestChartCandle = market?.candles?.at(-1) ?? null;
  const previousChartCandle =
    market?.candles && market.candles.length > 1
      ? (market.candles.at(-2) ?? null)
      : null;
  const chartMove =
    latestChartCandle && previousChartCandle
      ? Number(latestChartCandle.close) - Number(previousChartCandle.close)
      : null;
  const chartMovePercent =
    chartMove != null &&
    previousChartCandle &&
    Number(previousChartCandle.close) !== 0
      ? (chartMove / Number(previousChartCandle.close)) * 100
      : null;

  // The ACTIVE session is the execution authority. While it exists, the
  // workspace must stay visibly pinned to that exact broker account instead
  // of letting another selection inherit the global "AI ON" state.
  const selectedBroker = useMemo(
    () =>
      terminal?.sessionBroker ??
      terminal?.brokers.find((broker) => broker.id === selectedBrokerId) ??
      terminal?.primaryBroker ??
      null,
    [terminal, selectedBrokerId],
  );

  const metaTraderBroker = useMemo(
    () => terminal?.brokers.find((broker) => broker.brokerId === "metatrader5") ?? null,
    [terminal],
  );
  const brokerParity = useMemo(
    () => brokerParityPresentation(metaTraderBroker),
    [metaTraderBroker],
  );

  const emitActivityToasts = useCallback(
    (positions: LivePositionRowView[], snapshot: TraderExecutionSnapshot) => {
      if (!initializedActivity.current) {
        seenPositionIds.current = new Set(
          positions.map((position) => position.id),
        );
        seenExecutionStates.current = new Map(
          snapshot.recentExecutions.map((trade) => [trade.id, trade.status]),
        );
        initializedActivity.current = true;
        return;
      }

      for (const position of positions) {
        if (!seenPositionIds.current.has(position.id)) {
          notify.success(
            `AI opened ${position.direction} ${position.instrument} · ${position.lotSize} lot`,
          );
        }
      }

      for (const trade of snapshot.recentExecutions) {
        const previous = seenExecutionStates.current.get(trade.id);
        if (previous && previous !== trade.status) {
          if (trade.status === "CLOSED") {
            const pnl = trade.realisedPnl
              ? ` · ${trade.realisedPnl.startsWith("-") ? "" : "+"}${money(trade.realisedPnl, trade.accountCurrency)}`
              : "";
            notify.success(`${trade.instrument} position closed${pnl}`);
          } else if (trade.status === "OPEN") {
            notify.info(
              `${trade.instrument} order filled — position is now open`,
            );
          } else if (
            trade.status === "REJECTED" ||
            trade.status === "CANCELLED"
          ) {
            notify.warning(
              `${trade.instrument} order ${trade.status.toLowerCase()}`,
            );
          }
        }
      }

      seenPositionIds.current = new Set(
        positions.map((position) => position.id),
      );
      seenExecutionStates.current = new Map(
        snapshot.recentExecutions.map((trade) => [trade.id, trade.status]),
      );
    },
    [notify],
  );

  const refreshTradingData = useCallback(
    async (showSpinner = false) => {
      if (!user || tradingRefreshInFlight.current) return;
      tradingRefreshInFlight.current = true;
      if (showSpinner) setLoading(true);
      setError(null);
      try {
        // Core trading controls depend only on the authoritative terminal state.
        // Activity/position read models are useful context but must never make
        // the Start/Stop workspace unavailable when one of those secondary
        // endpoints has a transient server-side failure.
        const status = await loadTraderTerminalStatus();
        setTerminal(status);

        // External strategy evidence is deliberately secondary: scorecard/status
        // reads can never disable Start/Stop or broker controls. The VPS feed
        // has its own versioned evidence stream.
        try {
          const evidence = await api.request<ExternalProviderPerformanceView>(
            "/ai/external/providers/performance?providerCode=vps-twelvedata-six-pair-v7",
          );
          setProviderEvidence(evidence);
        } catch {
          setProviderEvidence(null);
        }
        try {
          const scannerStatus = await api.request<VpsForexScannerStatusView>(
            "/ai/external/vps-forex/status",
          );
          setVpsScannerStatus(scannerStatus);
        } catch {
          setVpsScannerStatus(null);
        }
        try {
          const [parityStatus, v8Status] = await Promise.all([
            api.request<BrokerParityRuntimeStatusView>(
              "/ai/external/vps-forex/broker-parity/status",
            ),
            api.request<V8DedicatedPaperStatusView>(
              "/ai/external/vps-forex/v8-dedicated-paper/status",
            ),
          ]);
          setBrokerParityRuntime(parityStatus);
          setV8DedicatedPaperStatus(v8Status);
        } catch {
          setBrokerParityRuntime(null);
          setV8DedicatedPaperStatus(null);
        }

        // Keep secondary market-intelligence context aligned with the actual
        // scheduler universe. Falling back to EURUSD preserves the ordinary
        // non-research workspace before a runtime is registered.
        let marketInstrument = "EURUSD";

        if (status.session) {
          try {
            const runtime = await api.request<AiAutomationRuntimeStatus>(
              `/trading/sessions/${encodeURIComponent(status.session.id)}/automation-status`,
            );
            setAutomationRuntime(runtime);
            setAutomationRuntimeWarning(null);
            const runtimeInstrument = runtime.instruments.find((value) =>
              /^[A-Z0-9._-]{3,24}$/.test(value),
            );
            if (runtimeInstrument) marketInstrument = runtimeInstrument;
          } catch {
            setAutomationRuntime(null);
            setAutomationRuntimeWarning(
              "AI Trading is running, but the AI engine runtime status could not be verified yet.",
            );
          }
        } else {
          setAutomationRuntime(null);
          setAutomationRuntimeWarning(null);
        }

        const [executionResult, positionsResult] = await Promise.allSettled([
          loadTraderExecutionSnapshot(),
          loadLiveAccountPositions(),
        ]);

        const snapshot =
          executionResult.status === "fulfilled" ? executionResult.value : null;
        const positions =
          positionsResult.status === "fulfilled"
            ? positionsResult.value.positions
            : [];

        setExecution(snapshot);
        setLivePositions(positions);

        if (snapshot) {
          emitActivityToasts(positions, snapshot);
        }

        if (
          executionResult.status === "rejected" ||
          positionsResult.status === "rejected"
        ) {
          setActivityWarning(
            "AI Trading controls are available, but recent activity or position details could not be loaded. You can continue using Start/Stop; refresh this page to retry the activity feed.",
          );
        } else {
          setActivityWarning(null);
        }

        const brokerId =
          status.sessionBroker?.id ||
          selectedBrokerId ||
          status.primaryBroker?.id ||
          "";
        if (brokerId) {
          setSelectedBrokerId(
            (current) => status.sessionBroker?.id || current || brokerId,
          );
          try {
            const nextAllocation = await api.getCapitalAllocation(brokerId);
            setAllocation(nextAllocation);
            setAllocationWarning(null);
            if (nextAllocation.allocatedCapital) {
              setAllocationAmount(nextAllocation.allocatedCapital);
            }
          } catch {
            setAllocation(null);
            setAllocationWarning(
              "Your broker account is connected, but its AI capital allocation could not be loaded. Trading controls remain disabled until this data is available.",
            );
          }
        } else {
          setAllocation(null);
        }
      } catch (requestError) {
        setError(mapApiError(requestError).message);
      } finally {
        tradingRefreshInFlight.current = false;
        if (showSpinner) setLoading(false);
      }
    },
    [user, selectedBrokerId, emitActivityToasts],
  );

  useEffect(() => {
    if (!user) return;
    void refreshTradingData(true);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) return;
    const timer = window.setInterval(() => {
      void refreshTradingData(false);
    }, 4000);
    return () => window.clearInterval(timer);
  }, [user, refreshTradingData]);

  useEffect(() => {
    if (!user) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refreshTradingData(false);
      }
    };
    const refreshOnFocus = () => void refreshTradingData(false);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [user, refreshTradingData]);

  useEffect(() => {
    if (vpsScannerStatus?.enabled && chartTimeframe === "M1") {
      setChartTimeframe("M5");
    }
  }, [vpsScannerStatus?.enabled, chartTimeframe]);

  useEffect(() => {
    const watched = automationRuntime?.instruments ?? [];
    if (watched.length && !watched.includes(chartInstrument)) {
      setChartInstrument(watched[0]);
    }
  }, [automationRuntime?.instruments, chartInstrument]);

  useEffect(() => {
    if (!user || !selectedBrokerId) return;

    // The PAPER scanner owns the authoritative market schedule. Do not hammer
    // market intelligence every five seconds while the FX market is
    // deliberately paused (weekend/rollover), or before that schedule status
    // has loaded. Position polling remains independent for exposure safety.
    if (
      selectedBroker?.brokerId === "paper-broker" &&
      (!vpsScannerStatus || vpsScannerStatus.marketSchedule.paused)
    ) {
      setChartLoading(false);
      return;
    }

    let cancelled = false;
    let firstLoad = true;
    const refreshChart = async () => {
      if (firstLoad) setChartLoading(true);
      try {
        const snapshot = await loadMarketIntelligence({
          instrument: chartInstrument,
          timeframe: chartTimeframe,
          limit: 90,
        });
        if (!cancelled) setMarket(snapshot);
      } catch {
        if (!cancelled) setMarket(null);
      } finally {
        if (!cancelled && firstLoad) {
          setChartLoading(false);
          firstLoad = false;
        }
      }
    };
    void refreshChart();
    const timer = window.setInterval(() => void refreshChart(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    user,
    selectedBrokerId,
    selectedBroker?.brokerId,
    chartInstrument,
    chartTimeframe,
    vpsScannerStatus,
  ]);

  useEffect(() => {
    if (!user) return;
    let disposed = false;
    const refreshPositions = async () => {
      if (positionsRefreshInFlight.current) return;
      positionsRefreshInFlight.current = true;
      try {
        const next = await loadLiveAccountPositions();
        if (!disposed) setLivePositions(next.positions);
      } catch {
        // The broader workspace refresh owns the user-facing warning. Keep the
        // last authoritative snapshot instead of flashing empty/zero state.
      } finally {
        positionsRefreshInFlight.current = false;
      }
    };
    void refreshPositions();
    const timer = window.setInterval(() => {
      void refreshPositions();
    }, 2000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshPositions();
    };
    const refreshOnFocus = () => void refreshPositions();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [user]);

  useEffect(() => {
    if (!pendingAutomationAction) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !togglingAutomation) {
        setPendingAutomationAction(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [pendingAutomationAction, togglingAutomation]);

  async function handleBrokerChange(nextId: string) {
    setSelectedBrokerId(nextId);
    setAllocation(null);
    setAllocationAmount("");
    try {
      const nextAllocation = await api.getCapitalAllocation(nextId);
      setAllocation(nextAllocation);
      setAllocationWarning(null);
      setAllocationAmount(nextAllocation.allocatedCapital ?? "");
    } catch {
      setAllocation(null);
      setAllocationWarning(
        "This broker is connected, but its AI capital allocation could not be loaded yet.",
      );
    }
  }

  async function saveAllocation() {
    if (!selectedBroker) {
      notify.warning("Connect a broker account first.");
      return;
    }
    if (!allocationAmount.trim()) {
      notify.warning("Enter the capital amount the AI may use.");
      return;
    }
    setSavingAllocation(true);
    setError(null);
    try {
      const next = await api.setCapitalAllocation({
        brokerConnectionId: selectedBroker.id,
        amount: allocationAmount.trim(),
      });
      setAllocation(next);
      setAllocationAmount(next.allocatedCapital ?? allocationAmount.trim());
      notify.success(
        `AI capital allocated: ${money(next.allocatedCapital, next.accountCurrency)}`,
      );
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setSavingAllocation(false);
    }
  }

  function requestAutomationAction() {
    if (!selectedBroker) {
      notify.warning("Connect a broker account first.");
      return;
    }
    if (!controlStateReady) {
      notify.warning(
        "AI Trading controls are temporarily unavailable while risk protection and session status are being verified.",
      );
      return;
    }
    if (
      !automationOn &&
      (!allocation?.hasAllocation || !allocation.allocatedCapital)
    ) {
      notify.warning("Allocate capital before starting AI Trading.");
      return;
    }
    setPendingAutomationAction(automationOn ? "STOP" : "START");
  }

  async function confirmAutomationAction() {
    if (!pendingAutomationAction || !selectedBroker) return;
    const action = pendingAutomationAction;

    setTogglingAutomation(true);
    setError(null);
    try {
      if (action === "STOP") {
        if (!terminal?.session) {
          notify.warning("AI Trading is already stopped.");
          setPendingAutomationAction(null);
          return;
        }

        const result = await api.stopTradingSession(terminal.session.id);
        const summary = result.positionCloseSummary;

        // Keep the Stop UX in sync with the server-confirmed flatten immediately.
        // Only remove rows optimistically when the COMPLETE response proves that
        // every displayed position for this broker was part of the confirmed close.
        // Otherwise unresolved/manual-looking rows stay visible until the
        // authoritative positions endpoint says they are gone.
        if (summary.state === "COMPLETE" && summary.targetCount !== null) {
          setLivePositions((current) => {
            const brokerPositions = current.filter(
              (position) => position.brokerConnectionId === selectedBroker.id,
            );
            if (brokerPositions.length !== summary.targetCount) return current;
            return current.filter(
              (position) => position.brokerConnectionId !== selectedBroker.id,
            );
          });
        }

        // Refresh the positions resource directly after Stop instead of relying
        // solely on the broader workspace refresh, which can briefly retain its
        // pre-stop snapshot. A short second read absorbs provider persistence lag.
        try {
          const immediate = await loadLiveAccountPositions();
          const remainingForBroker = immediate.positions.filter(
            (position) => position.brokerConnectionId === selectedBroker.id,
          );
          const closureShouldBeComplete =
            summary.state === "COMPLETE" && summary.unresolvedCount === 0;

          if (!closureShouldBeComplete || remainingForBroker.length === 0) {
            setLivePositions(immediate.positions);
          } else {
            window.setTimeout(() => {
              void loadLiveAccountPositions()
                .then((latest) => setLivePositions(latest.positions))
                .catch(() => undefined);
            }, 500);
          }
        } catch {
          // The optimistic COMPLETE update above remains visible. The normal
          // polling loop will reconcile against the server on its next pass.
        }

        if (summary.state === "COMPLETE") {
          if (summary.closedCount > 0) {
            notify.success(
              "AI Trading stopped. " +
                summary.closedCount +
                " AI position" +
                (summary.closedCount === 1 ? "" : "s") +
                " confirmed closed.",
            );
          } else {
            notify.info(
              "AI Trading stopped. No AI-opened positions were open.",
            );
          }
        } else if (summary.state === "PARTIAL") {
          notify.warning(
            "AI Trading stopped. " +
              summary.closedCount +
              " of " +
              (summary.targetCount ?? "the") +
              " AI positions were confirmed closed; " +
              (summary.unresolvedCount ?? "some") +
              " require follow-up.",
          );
        } else {
          notify.warning(
            "AI Trading stopped, but position closure could not be verified. Check Positions & Activity now.",
          );
        }
      } else {
        if (!allocation?.hasAllocation || !allocation.allocatedCapital) {
          notify.warning("Allocate capital before starting AI Trading.");
          setPendingAutomationAction(null);
          return;
        }
        const executionMode = startExecutionModeForBroker(selectedBroker);
        if (
          selectedBroker.accountType === "DEMO" &&
          selectedBroker.brokerId !== "paper-broker" &&
          selectedBroker.authorizationStatus !== "ACTIVE"
        ) {
          await api.request<void>(
            `/broker/connections/${encodeURIComponent(selectedBroker.id)}/enable-demo-trading`,
            { method: "POST" },
          );
        }
        await api.startTradingSession({
          brokerConnectionId: selectedBroker.id,
          executionMode,
        });
        notify.success(
          selectedBroker.brokerId === "paper-broker"
            ? "Research PAPER UAT started in the internal simulator. No live broker funds are reachable."
            : selectedBroker.accountType === "DEMO"
              ? "AI Trading started against this broker's DEMO environment. No live funds are used."
              : "AI Trading started for the verified live account.",
        );
      }

      await refreshTradingData(false);
      setPendingAutomationAction(null);
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setTogglingAutomation(false);
    }
  }

  async function closePositionNow(tradeId: string) {
    if (closingTradeId || closingAllPositions) return;
    setClosingTradeId(tradeId);
    setError(null);
    try {
      await api.request(
        `/execution/positions/${encodeURIComponent(tradeId)}/close`,
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      notify.success(
        "Position close submitted and confirmed by the execution service.",
      );
      await refreshTradingData(false);
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setClosingTradeId(null);
    }
  }

  async function closeAllPositionsNow() {
    if (livePositions.length === 0 || closingTradeId || closingAllPositions)
      return;
    setClosingAllPositions(true);
    setError(null);
    try {
      const results = await api.request<
        Array<{ tradeId: string; closed: boolean; status: string }>
      >("/execution/positions/close-all", {
        method: "POST",
        body: JSON.stringify({}),
      });
      const closedCount = results.filter((result) => result.closed).length;
      const unresolvedCount = results.length - closedCount;
      if (unresolvedCount === 0) {
        notify.success(
          `Closed ${closedCount} AI position${closedCount === 1 ? "" : "s"} successfully.`,
        );
      } else {
        notify.warning(
          `${closedCount} position${closedCount === 1 ? "" : "s"} closed; ${unresolvedCount} require reconciliation.`,
        );
      }
      await refreshTradingData(false);
    } catch (requestError) {
      const message = mapApiError(requestError).message;
      setError(message);
      notify.error(message);
    } finally {
      setClosingAllPositions(false);
    }
  }

  const recentClosedTrades = execution?.closedExecutions.slice(0, 10) ?? [];
  const positionCurrencies = Array.from(
    new Set(
      livePositions
        .map((position) => position.accountCurrency ?? "")
        .filter(Boolean),
    ),
  );
  const positionCurrency =
    positionCurrencies.length === 1 ? positionCurrencies[0] : null;
  const totalUnrealisedPnl =
    livePositions.length > 0 && positionCurrencies.length === 1
      ? sumDecimalStrings(
          livePositions.map((position) => position.unrealisedPnl),
        )
      : null;
  const totalUnrealisedPnlUnavailable =
    livePositions.length > 0 &&
    (positionCurrencies.length !== 1 || totalUnrealisedPnl === null);

  if (restoring) {
    return (
      <div style={{ padding: "3rem" }}>
        <LoadingSpinner text="Restoring trading workspace…" />
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ padding: "3rem", maxWidth: "680px", margin: "0 auto" }}>
        <Card title="Not signed in">
          <p className="muted">Sign in to access AI Trading.</p>
          <Link href="/login" className="btn btn--primary mt-4">
            Go to login
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <DashboardShell
      user={user}
      onLogout={logout}
      activeRoute="/trade"
      title="AI Trading"
    >
      <main className="ai-trader" data-testid="ai-trader-workspace">
        <section className="ai-trader__hero">
          <div>
            <p className="workspace-hero__eyebrow">AI trading made simple</p>
            <h1>AI Trader</h1>
            <p>
              Connect your broker, choose how much capital the AI may use, then
              start AI Trading. Strategy selection, position sizing and risk
              checks run automatically on the server.
            </p>
          </div>
          <div className="ai-trader__hero-state" data-ai-state={aiVisualState}>
            <span>AI Trading</span>
            <MotionStatusOrb
              tone={
                aiVisualState === "error"
                  ? "error"
                  : aiVisualState === "blocked"
                    ? "warning"
                    : aiVisualState === "signal"
                      ? "info"
                      : automationOn
                        ? "success"
                        : "neutral"
              }
              active={automationOn}
              label={`AI Trading ${automationOn ? "running" : "stopped"}`}
            />
            <Badge variant={automationOn ? "success" : "info"}>
              {automationOn ? "RUNNING" : "STOPPED"}
            </Badge>
            {selectedBroker?.brokerId === "paper-broker" && (
              <Badge variant="warning">RESEARCH PAPER</Badge>
            )}
          </div>
        </section>

        {error && <Alert variant="error">{error}</Alert>}
        {terminal?.controlWarnings.map((warning) => (
          <Alert key={warning} variant="warning">
            {warning}
          </Alert>
        ))}
        {allocationWarning && (
          <Alert variant="warning">{allocationWarning}</Alert>
        )}
        {activityWarning && <Alert variant="warning">{activityWarning}</Alert>}
        {automationRuntimeWarning && (
          <Alert variant="warning">{automationRuntimeWarning}</Alert>
        )}
        {selectedBroker?.brokerId === "paper-broker" && (
          <Alert variant="info">
            <div className="ai-research-uat-copy">
              <strong>Research PAPER UAT · simulated execution only.</strong>
              <span>
                Accelerated replay may advance multiple simulated market steps
                per cycle so the end-to-end AI, risk, execution, position and
                P&amp;L workflow can be tested faster. No live broker funds are
                reachable, and model promotion gates remain unchanged.
              </span>
            </div>
          </Alert>
        )}

        {loading && !terminal ? (
          <Card title="Loading AI Trader">
            <LoadingSpinner text="Loading broker, allocation and trading activity…" />
          </Card>
        ) : (
          <>
            <section
              className="ai-control-deck"
              aria-label="AI trading controls"
            >
              <Card className="ai-control-card ai-control-card--broker">
                <span className="ai-control-card__label">Broker account</span>
                {terminal?.brokers.length ? (
                  <>
                    <select
                      className="input"
                      value={selectedBroker?.id ?? ""}
                      onChange={(event) =>
                        void handleBrokerChange(event.target.value)
                      }
                      aria-label="Broker account"
                      disabled={automationOn}
                    >
                      {terminal.brokers.map((broker) => (
                        <option key={broker.id} value={broker.id}>
                          {broker.displayName || broker.brokerName} ·{" "}
                          {broker.accountType}
                        </option>
                      ))}
                    </select>
                    <div className="ai-control-card__meta">
                      <Badge
                        variant={
                          selectedBroker?.status === "CONNECTED"
                            ? "success"
                            : "warning"
                        }
                      >
                        {selectedBroker?.status ?? "Not connected"}
                      </Badge>
                      <span>{selectedBroker?.accountType ?? "—"}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <strong>No broker connected</strong>
                    <Link
                      href="/onboarding/broker"
                      className="btn btn--primary btn--sm mt-4"
                    >
                      Connect broker
                    </Link>
                  </>
                )}
              </Card>

              <Card className="ai-control-card">
                <span className="ai-control-card__label">Broker equity</span>
                <strong className="ai-control-card__value">
                  {money(allocation?.brokerEquity, allocation?.accountCurrency)}
                </strong>
                <span className="ai-control-card__hint">
                  Authoritative broker account snapshot
                </span>
              </Card>

              <Card className="ai-control-card ai-control-card--allocation">
                <span className="ai-control-card__label">
                  AI capital allocation
                </span>
                <div className="ai-allocation-row">
                  <Input
                    aria-label="AI capital allocation amount"
                    inputMode="decimal"
                    value={allocationAmount}
                    onChange={(event) =>
                      setAllocationAmount(event.target.value)
                    }
                    placeholder={formatFixedDecimal(
                      allocation?.brokerEquity,
                      2,
                    )}
                    disabled={
                      !selectedBroker || savingAllocation || automationOn
                    }
                  />
                  <Button
                    type="button"
                    size="sm"
                    loading={savingAllocation}
                    disabled={!selectedBroker || automationOn}
                    onClick={() => void saveAllocation()}
                  >
                    Allocate
                  </Button>
                </div>
                <span className="ai-control-card__hint">
                  Shared across multiple AI trades. Available now:{" "}
                  {money(
                    allocation?.availableCapital,
                    allocation?.accountCurrency,
                  )}
                </span>
              </Card>

              <Card className="ai-control-card ai-control-card--automation">
                <div className="ai-control-card__status-row">
                  <span className="ai-control-card__label">AI Trading</span>
                  <Badge variant={automationOn ? "success" : "info"}>
                    {automationOn ? "Running" : "Stopped"}
                  </Badge>
                </div>
                <Button
                  type="button"
                  variant={automationOn ? "danger" : "primary"}
                  size="lg"
                  block
                  className="ai-automation-action"
                  aria-label={
                    automationOn ? "Stop AI Trading" : "Start AI Trading"
                  }
                  disabled={
                    !selectedBroker || !controlStateReady || togglingAutomation
                  }
                  onClick={requestAutomationAction}
                >
                  {togglingAutomation
                    ? automationOn
                      ? "Stopping…"
                      : "Starting…"
                    : automationOn
                      ? "Stop AI Trading"
                      : "Start AI Trading"}
                </Button>
                <span className="ai-control-card__hint">
                  {automationOn
                    ? "AI Trading may open and manage positions within your allocation. Stop requires confirmation and closes AI-opened positions."
                    : "AI Trading cannot create new positions while stopped."}
                </span>
              </Card>
            </section>

            <section className="ai-overview-grid">
              <Card className="ai-overview-card ai-overview-card--allocation-pool">
                <span className="ai-control-card__label">AI capital pool</span>
                <strong className="ai-overview-card__value">
                  {money(
                    allocation?.allocatedCapital,
                    allocation?.accountCurrency,
                  )}
                </strong>
                <span className="muted text-sm">
                  Shared across multiple trades — each trade commits only its
                  broker-required margin.
                </span>
                <dl
                  className="ai-allocation-breakdown"
                  aria-label="AI capital pool breakdown"
                >
                  <div>
                    <dt>Available</dt>
                    <dd>
                      {money(
                        allocation?.availableCapital,
                        allocation?.accountCurrency,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Committed now</dt>
                    <dd>
                      {money(
                        allocation?.committedCapital,
                        allocation?.accountCurrency,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Open positions</dt>
                    <dd>
                      {money(
                        allocation?.openPositionCommitments,
                        allocation?.accountCurrency,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Pending orders</dt>
                    <dd>
                      {money(
                        allocation?.pendingOrderCommitments,
                        allocation?.accountCurrency,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Broker equity</dt>
                    <dd>
                      {money(
                        allocation?.brokerEquity,
                        allocation?.accountCurrency,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>In-flight decisions</dt>
                    <dd>
                      {money(
                        allocation?.inFlightCommitments,
                        allocation?.accountCurrency,
                      )}
                    </dd>
                  </div>
                </dl>
              </Card>

              <div
                className="ai-overview-summary-stack"
                aria-label="Trading snapshot"
              >
                <Card className="ai-overview-card ai-overview-card--compact">
                  <span className="ai-control-card__label">Open positions</span>
                  <strong className="ai-overview-card__value">
                    {livePositions.length}
                  </strong>
                  <span className="muted text-sm">
                    Provider-enriched position state
                  </span>
                </Card>
                <Card className="ai-overview-card ai-overview-card--compact">
                  <span className="ai-control-card__label">AI session</span>
                  <strong className="ai-overview-card__value">
                    {!terminal?.sessionStateKnown
                      ? "UNAVAILABLE"
                      : (terminal.session?.status ?? "STOPPED")}
                  </strong>
                  <span className="muted text-sm">
                    {!terminal?.sessionStateKnown
                      ? "Session status is being verified"
                      : terminal.session
                        ? `Started ${formatTimestamp(terminal.session.startedAt)}`
                        : "Start AI Trading to begin"}
                  </span>
                </Card>
                <Card className="ai-overview-card ai-overview-card--compact">
                  <span className="ai-control-card__label">
                    {automationRuntime?.instruments?.length
                      ? `${automationRuntime.instruments.join(" · ")} · ${automationRuntime.timeframe ?? "MTF"}`
                      : "Market snapshot"}
                  </span>
                  <strong className="ai-overview-card__value">
                    {automationRuntime?.research_uat
                      ? (automationRuntime.last_market_data_close ?? "—")
                      : (market?.quote.bid ?? "—")}
                  </strong>
                  <span className="muted text-sm">
                    {automationRuntime?.research_uat
                      ? automationRuntime.last_market_data_close
                        ? `Replay close · ${formatTimestamp(automationRuntime.last_market_data_at)}`
                        : "Awaiting first replay market evaluation"
                      : market
                        ? `Spread ${market.quote.spread} · ${market.status}`
                        : "Market snapshot unavailable"}
                  </span>
                </Card>
              </div>
            </section>

            {selectedBroker?.brokerId === "paper-broker" && (
              <section
                className="ai-strategy-path"
                aria-labelledby="strategy-promotion-title"
              >
                <Card className="ai-strategy-path__card">
                  <div className="ai-provider-evidence__head">
                    <div>
                      <p className="workspace-hero__eyebrow">
                        Strategy identity &amp; promotion path
                      </p>
                      <h2 id="strategy-promotion-title">
                        {vpsScannerStatus?.activeEngineDisplayName ?? "iRexPro Multi-Model Ensemble"}
                      </h2>
                      <p>
                        The multi-model engine is now the active strategy architecture. Legacy v7 is frozen as a
                        benchmark only. Shadow observation runs automatically from market data and does not require an
                        active PAPER execution session. Specialists progress independently through research, shadow and
                        qualification; only a frozen ensemble artifact may advance to dedicated PAPER, DEMO and LIVE.
                      </p>
                    </div>
                    <div className="ai-provider-evidence__badges">
                      <Badge variant="info">MULTI-MODEL · SHADOW</Badge>
                      <Badge variant="warning">V7 · FROZEN BASELINE</Badge>
                      <Badge
                        variant={
                          providerEvidence?.strategyIdentity
                            .evidenceCohortIntegrity === false
                            ? "warning"
                            : "success"
                        }
                      >
                        {providerEvidence?.strategyIdentity
                          .evidenceCohortIntegrity === false
                          ? "EVIDENCE COHORT BLOCKED"
                          : "EVIDENCE ISOLATED"}
                      </Badge>
                    </div>
                  </div>

                  <div className="ai-strategy-details">
                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail ai-strategy-detail--artifact">
                        <span>Strategy artifact</span>
                        <strong>
                          {vpsScannerStatus?.activeEngineCode
                            ? `${vpsScannerStatus.activeEngineCode}/research-shadow-v1`
                            : "irexpro-multimodel-ensemble-v1/research-shadow-v1"}
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>Current market authority</span>
                        <strong>
                          {vpsScannerStatus?.highConvictionChallenger.brokerSourceConfigured
                            ? "Twelve Data M5 base · MetaApi broker M1/M5/M15/H1/H4 overlay"
                            : "Twelve Data M5 base · broker-MTF challenger source not configured"}
                        </strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>Current execution</span>
                        <strong>Shadow only · no new ensemble orders</strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>Strategy lifecycle</span>
                        <strong>Ensemble challengers evolving · v7 frozen</strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>High-conviction expert</span>
                        <strong>
                          {vpsScannerStatus?.highConvictionChallenger.state === "BROKER_MTF_OVERLAY_READY"
                            ? `BROKER MTF OVERLAY READY · ${vpsScannerStatus.highConvictionChallenger.prospectiveScoringState.replaceAll("_", " ")}`
                            : vpsScannerStatus?.highConvictionChallenger.state === "ARTIFACT_READY_BROKER_MTF_REQUIRED"
                              ? "ARTIFACT READY · BROKER MTF REQUIRED"
                              : vpsScannerStatus?.highConvictionChallenger.state ?? "UNAVAILABLE"}
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>Frozen challenger rule</span>
                        <strong>
                          {vpsScannerStatus?.highConvictionChallenger.frozenConsensus
                            ? `${vpsScannerStatus.highConvictionChallenger.frozenConsensus.votes_required}/3 votes · opp ≥ ${(vpsScannerStatus.highConvictionChallenger.frozenConsensus.opp_floor * 100).toFixed(0)}%`
                            : "Awaiting artifact status"}
                        </strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>Challenger historical validation</span>
                        <strong>
                          {vpsScannerStatus?.highConvictionChallenger.historicalValidation
                            ? `n ${vpsScannerStatus.highConvictionChallenger.historicalValidation.n ?? 0} · PF ${providerMetric(vpsScannerStatus.highConvictionChallenger.historicalValidation.profit_factor, 2)} · Sharpe ${providerMetric(vpsScannerStatus.highConvictionChallenger.historicalValidation.sharpe, 2)}`
                            : "Research evidence unavailable"}
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>Challenger cadence</span>
                        <strong>
                          {vpsScannerStatus?.highConvictionChallenger.historicalValidation?.median_gap_minutes != null
                            ? `Median ${providerMetric(vpsScannerStatus.highConvictionChallenger.historicalValidation.median_gap_minutes, 0)} min · sparse specialist only`
                            : "Prospective broker-MTF evidence pending"}
                        </strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>Latest trained-model overlay</span>
                        <strong>
                          {vpsScannerStatus?.lastEnsembleDecision.highConvictionOverlay
                            ? `${vpsScannerStatus.lastEnsembleDecision.highConvictionOverlay.state} · ${vpsScannerStatus.lastEnsembleDecision.highConvictionOverlay.direction ?? "no direction"} · shadow only`
                            : vpsScannerStatus?.marketSchedule.paused
                              ? "Waiting for fresh market reopen"
                              : "Waiting for first fresh broker-MTF score"}
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>Overlay cohort</span>
                        <strong>
                          {vpsScannerStatus
                            ? `${vpsScannerStatus.ensembleCampaign.highConvictionOverlayCounts.CONFIRM} confirm · ${vpsScannerStatus.ensembleCampaign.highConvictionOverlayCounts.CONFLICT} conflict · ${vpsScannerStatus.ensembleCampaign.highConvictionOverlayCounts.ABSTAIN} abstain`
                            : "0 confirm · 0 conflict · 0 abstain"}
                        </strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>CONFIRM cohort PF / net R</span>
                        <strong>
                          {vpsScannerStatus
                            ? `${providerMetric(vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.CONFIRM.profitFactor, 2)} / ${providerMetric(vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.CONFIRM.netR, 2)} R · n ${vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.CONFIRM.evaluableResolved}`
                            : "— / 0.00 R · n 0"}
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>CONFLICT cohort PF / net R</span>
                        <strong>
                          {vpsScannerStatus
                            ? `${providerMetric(vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.CONFLICT.profitFactor, 2)} / ${providerMetric(vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.CONFLICT.netR, 2)} R · n ${vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.CONFLICT.evaluableResolved}`
                            : "— / 0.00 R · n 0"}
                        </strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>CONFIRM Sharpe / +weeks</span>
                        <strong>
                          {vpsScannerStatus
                            ? `${providerMetric(vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.CONFIRM.sharpe, 2)} / ${providerPercent(vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.CONFIRM.positiveWindowFraction)}`
                            : "— / —"}
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>ABSTAIN cohort PF / net R</span>
                        <strong>
                          {vpsScannerStatus
                            ? `${providerMetric(vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.ABSTAIN.profitFactor, 2)} / ${providerMetric(vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.ABSTAIN.netR, 2)} R · n ${vpsScannerStatus.ensembleCampaign.highConvictionOverlayPerformance.ABSTAIN.evaluableResolved}`
                            : "— / 0.00 R · n 0"}
                        </strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>Decision policy checks</span>
                        <strong>
                          {vpsScannerStatus?.lastEnsembleDecision.consensusPassed ?? 0}/
                          {vpsScannerStatus?.lastEnsembleDecision.consensusRequired ?? 0} checks
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>Expert provenance</span>
                        <strong>
                          {vpsScannerStatus?.expertRegistry
                            ? `${vpsScannerStatus.expertRegistry.trainedModelCount} trained · ${vpsScannerStatus.expertRegistry.heuristicPolicyCount} policies · ${vpsScannerStatus.expertRegistry.riskGuardCount} guards · ${vpsScannerStatus.expertRegistry.frozenBaselineCount} frozen`
                            : "Loading provenance"}
                        </strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>Trained-model authority</span>
                        <strong>
                          {vpsScannerStatus?.expertRegistry.entries
                            .filter((entry) => entry.kind === "TRAINED_MODEL")
                            .map((entry) => `${entry.label} · ${entry.lifecycle}`)
                            .join(" · ") || "No trained model registered"}
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>Net expected R</span>
                        <strong>
                          {vpsScannerStatus?.lastEnsembleDecision.governance
                            ? `${providerMetric(vpsScannerStatus.lastEnsembleDecision.governance.netExpectedR, 3)} R`
                            : "Awaiting fresh decision"}
                        </strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>Drift / sleeve</span>
                        <strong>
                          {vpsScannerStatus?.lastEnsembleDecision.governance
                            ? `${vpsScannerStatus.lastEnsembleDecision.governance.driftState} · ${vpsScannerStatus.lastEnsembleDecision.governance.sleeveState} · ${vpsScannerStatus.lastEnsembleDecision.governance.sleeveEvidence?.closedTrades ?? 0}/100`
                            : "COLLECTING · 0/100"}
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>Macro-event guard</span>
                        <strong>
                          {vpsScannerStatus?.lastEnsembleDecision.governance?.eventRisk === "CLEAR"
                            ? "CLEAR"
                            : vpsScannerStatus?.lastEnsembleDecision.governance?.eventRisk === "HIGH_IMPACT_BLOCK"
                              ? "BLOCKED · HIGH IMPACT"
                              : "PROVIDER REQUIRED · FAIL CLOSED"}
                        </strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>Sleeve PF / Sharpe</span>
                        <strong>
                          {vpsScannerStatus?.lastEnsembleDecision.governance?.sleeveEvidence
                            ? `${providerMetric(vpsScannerStatus.lastEnsembleDecision.governance.sleeveEvidence.profitFactor, 2)} / ${providerMetric(vpsScannerStatus.lastEnsembleDecision.governance.sleeveEvidence.sharpe, 2)}`
                            : "Awaiting resolved outcomes"}
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>Sleeve stability</span>
                        <strong>
                          {vpsScannerStatus?.lastEnsembleDecision.governance?.sleeveEvidence
                            ? `DD ${providerPercent(vpsScannerStatus.lastEnsembleDecision.governance.sleeveEvidence.maxDrawdown)} · +weeks ${providerPercent(vpsScannerStatus.lastEnsembleDecision.governance.sleeveEvidence.positiveWindowFraction)}`
                            : "COLLECTING"}
                        </strong>
                      </div>
                    </div>

                    <div className="ai-strategy-detail-group">
                      <div className="ai-strategy-detail">
                        <span>PAPER promotion</span>
                        <strong>
                          {vpsScannerStatus?.lastEnsembleDecision.governance?.paperPromotionEligible
                            ? "ELIGIBLE"
                            : "LOCKED BY GOVERNANCE"}
                        </strong>
                      </div>
                      <div className="ai-strategy-detail">
                        <span>Legacy evidence</span>
                        <strong>{providerEvidence ? `${providerEvidence.observed.closedTrades} closed v7 trades preserved` : "Loading"}</strong>
                      </div>
                    </div>
                  </div>

                  <div className="ai-promotion-path" aria-label="Strategy promotion path">
                    <div className="ai-promotion-path__step is-current">
                      <span>1</span>
                      <div>
                        <strong>Research Shadow</strong>
                        <small>Regime + specialists + net-EV + portfolio consensus · no orders</small>
                      </div>
                    </div>
                    <div
                      className={
                        "ai-promotion-path__step " +
                        (vpsScannerStatus?.multiModelPaperExecutionEnabled ? "is-ready" : "is-locked")
                      }
                    >
                      <span>2</span>
                      <div>
                        <strong>Dedicated Ensemble PAPER</strong>
                        <small>Fresh isolated $10,000 cohort only after all promotion gates pass</small>
                      </div>
                    </div>
                    <div className="ai-promotion-path__step is-locked">
                      <span>3</span>
                      <div>
                        <strong>DEMO</strong>
                        <small>Same frozen ensemble artifact · broker-native market data and execution</small>
                      </div>
                    </div>
                    <div className="ai-promotion-path__step is-locked">
                      <span>4</span>
                      <div>
                        <strong>LIVE</strong>
                        <small>Only after DEMO validation · no automatic promotion</small>
                      </div>
                    </div>
                  </div>

                  <div className="ai-broker-parity-status">
                    <Badge variant={brokerParity.badgeVariant}>
                      {brokerParity.label}
                    </Badge>
                    <p>{brokerParity.detail}</p>
                  </div>
                </Card>
              </section>
            )}

            {selectedBroker?.brokerId === "paper-broker" && (
              <section
                className="ai-provider-evidence"
                aria-labelledby="provider-evidence-title"
              >
                <Card className="ai-provider-evidence__card">
                  <div className="ai-provider-evidence__head">
                    <div>
                      <p className="workspace-hero__eyebrow">
                        External signal evidence
                      </p>
                      <h2 id="provider-evidence-title">
                        {vpsScannerStatus?.activeEngineDisplayName ?? "iRexPro Multi-Model Ensemble"}
                      </h2>
                      <p>
                        The legacy v7 single-model execution path is frozen and retained only as
                        historical evidence. New market opportunities are evaluated by the multi-model
                        ensemble; PAPER execution remains disabled until the ensemble specialists earn
                        qualification. Closed M5 context and quote/microstructure research remain causal inputs.
                      </p>
                    </div>
                    <div className="ai-provider-evidence__badges">
                      <Badge variant="info">
                        {vpsScannerStatus?.executionAuthority === "PAPER_ONLY" ? "PAPER AUTHORITY" : "SHADOW ONLY"}
                      </Badge>
                      <Badge
                        variant={
                          vpsScannerStatus?.state === "ACTIVE"
                            ? "success"
                            : vpsScannerStatus?.state === "MARKET_PAUSED" ||
                                vpsScannerStatus?.state === "WAITING_FOR_CONFIGURATION"
                              ? "warning"
                              : "info"
                        }
                      >
                        {vpsScannerStatus?.state === "ACTIVE"
                          ? "MULTI-MODEL PAPER ACTIVE"
                          : vpsScannerStatus?.state === "MULTI_MODEL_SHADOW"
                            ? "MULTI-MODEL SHADOW"
                            : vpsScannerStatus?.state === "MARKET_PAUSED"
                              ? vpsScannerStatus.marketSchedule.reason === "WEEKEND"
                                ? "MARKET PAUSED · WEEKEND"
                                : "MARKET PAUSED · ROLLOVER"
                              : vpsScannerStatus?.state === "WAITING_FOR_CONFIGURATION"
                                ? "DATA KEY REQUIRED"
                                : vpsScannerStatus?.state === "WAITING_FOR_PAPER_SESSION"
                                  ? "WAITING FOR PAPER SESSION"
                                  : vpsScannerStatus?.state === "WAITING_FOR_PROVIDER_QUOTA"
                                    ? "PROVIDER QUOTA PAUSED"
                                    : vpsScannerStatus?.state === "WAITING_FOR_MARKET_DATA"
                                      ? "WAITING FOR MARKET DATA"
                                      : "ENGINE DISABLED"}
                      </Badge>
                      <Badge variant="warning">LEGACY V7 FROZEN</Badge>
                      <Badge
                        variant={
                          providerEvidence?.demoReviewEligible
                            ? "success"
                            : "info"
                        }
                      >
                        LEGACY EVIDENCE PRESERVED
                      </Badge>
                    </div>
                  </div>

                  <div className="ai-provider-evidence__metrics">
                    <div>
                      <span>Engine state</span>
                      <strong>{vpsScannerStatus?.state ?? "Unavailable"}</strong>
                    </div>
                    <div>
                      <span>Active engine</span>
                      <strong>{vpsScannerStatus?.activeEngineCode ?? "irexpro-multimodel-ensemble-v1"}</strong>
                    </div>
                    <div>
                      <span>Execution authority</span>
                      <strong>{vpsScannerStatus?.executionAuthority ?? "SHADOW_ONLY"}</strong>
                    </div>
                    <div>
                      <span>Shadow observer</span>
                      <strong>AUTO · PAPER SESSION NOT REQUIRED</strong>
                    </div>
                    <div>
                      <span>PAPER execution session</span>
                      <strong>
                        {vpsScannerStatus?.activePaperSession
                          ? "ACTIVE"
                          : "INACTIVE · EXPECTED IN SHADOW"}
                      </strong>
                    </div>
                    <div>
                      <span>Market schedule</span>
                      <strong>
                        {vpsScannerStatus?.marketSchedule.paused
                          ? vpsScannerStatus.marketSchedule.reason === "WEEKEND"
                            ? "PAUSED · WEEKEND"
                            : "PAUSED · ROLLOVER"
                          : "OPEN"}
                      </strong>
                    </div>
                    <div>
                      <span>Next eligible scan</span>
                      <strong>{formatTimestamp(vpsScannerStatus?.marketSchedule.nextEligibleScanAt)}</strong>
                    </div>
                    <div>
                      <span>Legacy v7</span>
                      <strong>{vpsScannerStatus?.legacyBaselineFrozen ? "FROZEN · EVIDENCE ONLY" : "ACTIVE"}</strong>
                    </div>
                    <div>
                      <span>Live pairs cached</span>
                      <strong>{vpsScannerStatus?.marketCache.cachedInstrumentCount ?? 0} / 6</strong>
                    </div>
                    <div>
                      <span>Scan cadence</span>
                      <strong>{vpsScannerStatus?.cadenceMinutes ?? 10} min</strong>
                    </div>
                    <div>
                      <span>Ensemble decisions</span>
                      <strong>{vpsScannerStatus?.ensembleCampaign.decisions ?? 0}</strong>
                    </div>
                    <div>
                      <span>Would admit</span>
                      <strong>
                        {vpsScannerStatus?.ensembleCampaign.admitted ?? 0} / {vpsScannerStatus?.ensembleCampaign.decisions ?? 0}
                      </strong>
                    </div>
                    <div>
                      <span>Resolved outcomes</span>
                      <strong>
                        {vpsScannerStatus?.ensembleCampaign.evaluableResolved ?? 0} / 100
                      </strong>
                    </div>
                    <div>
                      <span>Outcome mix</span>
                      <strong>
                        {vpsScannerStatus?.ensembleCampaign.wins ?? 0} W · {vpsScannerStatus?.ensembleCampaign.losses ?? 0} L · {vpsScannerStatus?.ensembleCampaign.expired ?? 0} EXP
                      </strong>
                    </div>
                    <div>
                      <span>Shadow net R</span>
                      <strong>
                        {providerMetric(vpsScannerStatus?.ensembleCampaign.netR ?? null, 2)} R
                      </strong>
                    </div>
                    <div>
                      <span>Shadow PF / Sharpe</span>
                      <strong>
                        {providerMetric(vpsScannerStatus?.ensembleCampaign.profitFactor ?? null, 2)} / {providerMetric(vpsScannerStatus?.ensembleCampaign.sharpe ?? null, 2)}
                      </strong>
                    </div>
                    <div>
                      <span>Campaign stability</span>
                      <strong>
                        DD {providerPercent(vpsScannerStatus?.ensembleCampaign.maxDrawdown ?? null)} · +weeks {providerPercent(vpsScannerStatus?.ensembleCampaign.positiveWindowFraction ?? null)}
                      </strong>
                    </div>
                    <div>
                      <span>CORE sleeves</span>
                      <strong>
                        {vpsScannerStatus?.ensembleCampaign.sleeves.filter((sleeve) => sleeve.state === "CORE").length ?? 0} / {vpsScannerStatus?.ensembleCampaign.sleeves.length ?? 0}
                      </strong>
                    </div>
                    <div>
                      <span>Profit-path evidence</span>
                      <strong>{vpsScannerStatus?.ensembleCampaign.profitProtection.pathResolved ?? 0} resolved</strong>
                    </div>
                    <div>
                      <span>Positive MFE → loss</span>
                      <strong>
                        {vpsScannerStatus?.ensembleCampaign.profitProtection.positiveMfeThenLosses ?? 0} / {vpsScannerStatus?.ensembleCampaign.profitProtection.lossesWithPath ?? 0} losses
                      </strong>
                    </div>
                    <div>
                      <span>Reached +0.5R → loss</span>
                      <strong>{vpsScannerStatus?.ensembleCampaign.profitProtection.lossesAfterHalfR ?? 0}</strong>
                    </div>
                    <div>
                      <span>Reached +1R → loss</span>
                      <strong>{vpsScannerStatus?.ensembleCampaign.profitProtection.lossesAfterOneR ?? 0}</strong>
                    </div>
                    <div>
                      <span>Avg MFE / give-back</span>
                      <strong>
                        {providerMetric(vpsScannerStatus?.ensembleCampaign.profitProtection.averageMaxFavorableR ?? null, 2)} R / {providerMetric(vpsScannerStatus?.ensembleCampaign.profitProtection.averageMaxCloseGivebackR ?? null, 2)} R
                      </strong>
                    </div>
                    <div>
                      <span>Best protection shadow</span>
                      <strong>
                        {vpsScannerStatus?.ensembleCampaign.profitProtection.counterfactuals[0]
                          ? `${vpsScannerStatus.ensembleCampaign.profitProtection.counterfactuals[0].code.replaceAll("_", " ")} · Δ ${vpsScannerStatus.ensembleCampaign.profitProtection.counterfactuals[0].deltaNetR >= 0 ? "+" : ""}${providerMetric(vpsScannerStatus.ensembleCampaign.profitProtection.counterfactuals[0].deltaNetR, 2)} R`
                          : "Awaiting resolved outcomes"}
                      </strong>
                    </div>
                    <div>
                      <span>Protection shadow impact</span>
                      <strong>
                        {vpsScannerStatus?.ensembleCampaign.profitProtection.counterfactuals[0]
                          ? `${vpsScannerStatus.ensembleCampaign.profitProtection.counterfactuals[0].exitedEarly}/${vpsScannerStatus.ensembleCampaign.profitProtection.counterfactuals[0].observations} exits · ${vpsScannerStatus.ensembleCampaign.profitProtection.counterfactuals[0].improved} helped · ${vpsScannerStatus.ensembleCampaign.profitProtection.counterfactuals[0].worsened} hurt`
                          : "COLLECTING"}
                      </strong>
                    </div>
                    <div>
                      <span>Legacy v7 signals</span>
                      <strong>
                        {providerEvidence?.observed.receivedSignals ?? 0}
                      </strong>
                    </div>
                    <div>
                      <span>Legacy v7 signal mix</span>
                      <strong>
                        {providerEvidence?.observed.buySignals ?? 0} BUY ·{" "}
                        {providerEvidence?.observed.sellSignals ?? 0} SELL
                      </strong>
                    </div>
                    <div>
                      <span>Legacy v7 executed</span>
                      <strong>
                        {providerEvidence?.observed.executedTrades ?? 0}
                      </strong>
                    </div>
                    <div>
                      <span>Legacy v7 executed mix</span>
                      <strong>
                        {providerEvidence?.observed.buyExecutedTrades ?? 0} BUY
                        · {providerEvidence?.observed.sellExecutedTrades ?? 0}{" "}
                        SELL
                      </strong>
                    </div>
                    <div>
                      <span>Legacy v7 risk rejected</span>
                      <strong>
                        {providerEvidence?.observed.rejectedSignals ?? 0}
                      </strong>
                    </div>
                    <div>
                      <span>Legacy v7 realised P&amp;L</span>
                      <strong>
                        {providerEvidence == null
                          ? "—"
                          : `${providerEvidence.observed.strategyRealisedPnl >= 0 ? "+" : ""}${providerEvidence.observed.strategyRealisedPnl.toFixed(2)} USD`}
                      </strong>
                    </div>
                    <div>
                      <span>Legacy v7 closed evidence</span>
                      <strong>
                        {providerEvidence?.observed.closedTrades ?? 0} / 100
                      </strong>
                    </div>
                    <div>
                      <span>Ambiguous M5 closes</span>
                      <strong>
                        {providerEvidence?.observed.ambiguousClosedTrades ?? 0}
                      </strong>
                    </div>
                    <div>
                      <span>SL/TP same-bar events</span>
                      <strong>
                        {providerEvidence?.observed.sameBarProtectionAmbiguityCount ?? 0}
                      </strong>
                    </div>
                    <div>
                      <span>Balanced accuracy</span>
                      <strong>
                        {providerPercent(
                          providerEvidence?.observed.balancedAccuracy,
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>Profit factor</span>
                      <strong>
                        {providerMetric(
                          providerEvidence?.observed.profitFactor,
                          3,
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>Evidence Sharpe</span>
                      <strong>
                        {providerMetric(
                          providerEvidence?.observed.evidenceWindowSharpeRatio,
                          3,
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>Max drawdown</span>
                      <strong>
                        {providerPercent(
                          providerEvidence?.observed.maxDrawdown,
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>Positive pairs</span>
                      <strong>
                        {providerPercent(
                          providerEvidence?.observed.positiveInstrumentFraction,
                        )}
                      </strong>
                    </div>
                    <div>
                      <span>Median signal gap</span>
                      <strong>
                        {providerEvidence?.observed
                          .medianMinutesBetweenSignals == null
                          ? "—"
                          : `${providerEvidence.observed.medianMinutesBetweenSignals.toFixed(1)} min`}
                      </strong>
                    </div>
                  </div>

                  <div
                    className="ai-provider-evidence__gates"
                    aria-label="VPS Twelve Data qualification gates"
                  >
                    {[
                      ["BA ≥ 0.52", providerEvidence?.checks.balancedAccuracy],
                      ["Sharpe ≥ 1.0", providerEvidence?.checks.sharpeRatio],
                      ["PF ≥ 1.15", providerEvidence?.checks.profitFactor],
                      ["DD ≤ 12%", providerEvidence?.checks.maxDrawdown],
                      [
                        "Positive weeks ≥ 60%",
                        providerEvidence?.checks.positiveWindowFraction,
                      ],
                      [
                        "Positive pairs ≥ 67%",
                        providerEvidence?.checks.positiveInstrumentFraction,
                      ],
                      ["Confidence ≥ 60%", providerEvidence?.checks.confidence],
                      [
                        "Closed trades ≥ 100",
                        providerEvidence?.checks.evidence,
                      ],
                      ["Median gap ≤ 10m", providerEvidence?.checks.frequency],
                      [
                        "Evidence cohort integrity",
                        providerEvidence?.checks.evidenceCohortIntegrity,
                      ],
                    ].map(([label, passed]) => (
                      <span
                        key={String(label)}
                        className={passed ? "is-passed" : "is-pending"}
                      >
                        {passed ? "✓" : "·"} {String(label)}
                      </span>
                    ))}
                  </div>
                  {providerEvidence?.profitProtectionShadow ? (
                    <div className="ai-shadow-calibration">
                      <div className="ai-shadow-calibration__header">
                        <div>
                          <span className="workspace-hero__eyebrow">Profit path shadow</span>
                          <h3>MFE / MAE / give-back telemetry</h3>
                        </div>
                        <span className="badge badge--info">OBSERVE ONLY · EXITS UNCHANGED</span>
                      </div>
                      <p className="muted">
                        This measures how much profit trades reached and later gave back. It does not move v7 stops,
                        take partial profit, or close positions.
                      </p>
                      <div className="ai-provider-evidence__metrics">
                        <div><span>Path-observed closed</span><strong>{providerEvidence.profitProtectionShadow.observedClosedTrades}</strong></div>
                        <div><span>Losing trades observed</span><strong>{providerEvidence.profitProtectionShadow.losingTradesObserved}</strong></div>
                        <div><span>Losers previously positive</span><strong>{providerEvidence.profitProtectionShadow.losersWithPositiveMfe}</strong></div>
                        <div><span>Positive-MFE loser rate</span><strong>{providerPercent(providerEvidence.profitProtectionShadow.loserPositiveMfeFraction)}</strong></div>
                        <div><span>Avg peak profit</span><strong>{providerMetric(providerEvidence.profitProtectionShadow.averageMaxFavorablePnl, 2)} USD</strong></div>
                        <div><span>Avg adverse path</span><strong>{providerMetric(providerEvidence.profitProtectionShadow.averageMaxAdversePnl, 2)} USD</strong></div>
                        <div><span>Avg give-back</span><strong>{providerMetric(providerEvidence.profitProtectionShadow.averageProfitGiveback, 2)} USD</strong></div>
                        <div><span>Losers reached +$3 / +$5 / +$10</span><strong>{providerEvidence.profitProtectionShadow.losingTradesThatReached.usd3} / {providerEvidence.profitProtectionShadow.losingTradesThatReached.usd5} / {providerEvidence.profitProtectionShadow.losingTradesThatReached.usd10}</strong></div>
                      </div>
                    </div>
                  ) : null}

                  {providerEvidence?.driftDiagnostics ? (
                    <div className="ai-shadow-calibration">
                      <div className="ai-shadow-calibration__header">
                        <div>
                          <span className="workspace-hero__eyebrow">
                            Model drift monitor
                          </span>
                          <h3>Recent edge vs earlier evidence</h3>
                        </div>
                        <span
                          className={
                            providerEvidence.driftDiagnostics.status === "STABLE"
                              ? "badge badge--success"
                              : providerEvidence.driftDiagnostics.status === "DEGRADED"
                                ? "badge badge--warning"
                                : "badge badge--info"
                          }
                        >
                          {providerEvidence.driftDiagnostics.status.replaceAll("_", " ")}
                        </span>
                      </div>
                      <p className="muted">
                        Diagnostic only. This compares the latest {providerEvidence.driftDiagnostics.recentWindowSize}
                        {" "}qualification-closed trades with the earlier v7 cohort and never changes execution.
                      </p>
                      <div className="ai-provider-evidence__metrics">
                        <div>
                          <span>Recent P&amp;L</span>
                          <strong>
                            {providerEvidence.driftDiagnostics.recent.realisedPnl >= 0 ? "+" : ""}
                            {providerEvidence.driftDiagnostics.recent.realisedPnl.toFixed(2)} USD
                          </strong>
                        </div>
                        <div>
                          <span>Recent PF</span>
                          <strong>{providerMetric(providerEvidence.driftDiagnostics.recent.profitFactor, 3)}</strong>
                        </div>
                        <div>
                          <span>Recent win rate</span>
                          <strong>{providerPercent(providerEvidence.driftDiagnostics.recent.winRate)}</strong>
                        </div>
                        <div>
                          <span>Reference PF</span>
                          <strong>{providerMetric(providerEvidence.driftDiagnostics.reference.profitFactor, 3)}</strong>
                        </div>
                        <div>
                          <span>PF ratio</span>
                          <strong>{providerMetric(providerEvidence.driftDiagnostics.recentToReferenceProfitFactorRatio, 3)}</strong>
                        </div>
                        <div>
                          <span>Reference trades</span>
                          <strong>{providerEvidence.driftDiagnostics.reference.closedTrades}</strong>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {providerEvidence?.shadowCalibration ? (
                    <div className="ai-shadow-calibration">
                      <div className="ai-shadow-calibration__header">
                        <div>
                          <span className="workspace-hero__eyebrow">
                            Shadow calibration
                          </span>
                          <h3>Confidence &amp; pair diagnostics</h3>
                        </div>
                        <span className="badge badge--info">
                          DIAGNOSTIC ONLY · v7 UNCHANGED
                        </span>
                      </div>

                      <p className="muted">
                        This layer observes v7 without changing signal admission,
                        confidence thresholds, position sizing, SL/TP, or the v7
                        evidence counter. Pair/side adaptations remain locked until
                        the minimum evidence requirements are met.
                      </p>

                      <div className="ai-provider-evidence__metrics">
                        <div>
                          <span>Brier score</span>
                          <strong>
                            {providerMetric(
                              providerEvidence.shadowCalibration.brierScore,
                              3,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Calibration error</span>
                          <strong>
                            {providerPercent(
                              providerEvidence.shadowCalibration
                                .expectedCalibrationError,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Confidence ↔ P&amp;L</span>
                          <strong>
                            {providerMetric(
                              providerEvidence.shadowCalibration
                                .confidencePnlCorrelation,
                              3,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Adaptive-use gate</span>
                          <strong>
                            {
                              providerEvidence.shadowCalibration
                                .minimumEvidenceBeforeAdaptiveUse
                                .globalClosedTrades
                            }{" "}
                            closed
                          </strong>
                        </div>
                      </div>

                      <div className="ai-calibration-table-scroll">
                        <table className="ai-calibration-table">
                          <thead>
                            <tr>
                              <th>Pair / side</th>
                              <th>Closed</th>
                              <th>W / L</th>
                              <th>Win rate</th>
                              <th>P&amp;L</th>
                              <th>PF</th>
                              <th>Avg conf.</th>
                              <th>Shadow status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {providerEvidence.shadowCalibration.pairDirection
                              .filter((row) => row.closedTrades > 0)
                              .map((row) => (
                                <tr
                                  key={`${row.instrument}-${row.direction}`}
                                >
                                  <td>
                                    <strong>
                                      {row.instrument} {row.direction}
                                    </strong>
                                  </td>
                                  <td>{row.closedTrades}</td>
                                  <td>
                                    {row.wins} / {row.losses}
                                  </td>
                                  <td>{providerPercent(row.winRate)}</td>
                                  <td>
                                    <strong>
                                      {row.realisedPnl > 0 ? "+" : ""}
                                      {row.realisedPnl.toFixed(2)} USD
                                    </strong>
                                  </td>
                                  <td>
                                    {providerMetric(row.profitFactor, 3)}
                                  </td>
                                  <td>
                                    {providerPercent(row.averageConfidence)}
                                  </td>
                                  <td>
                                    <span
                                      className={
                                        row.evidenceStatus === "EARLY_ACTIONABLE"
                                          ? "badge badge--warning"
                                          : "badge badge--info"
                                      }
                                    >
                                      {row.evidenceStatus ===
                                      "EARLY_ACTIONABLE"
                                        ? "EARLY ACTIONABLE"
                                        : "OBSERVE"}
                                    </span>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="ai-calibration-table-scroll">
                        <table className="ai-calibration-table">
                          <thead>
                            <tr>
                              <th>Confidence band</th>
                              <th>Closed</th>
                              <th>Observed win rate</th>
                              <th>Avg confidence</th>
                              <th>Calibration gap</th>
                              <th>Avg P&amp;L</th>
                              <th>PF</th>
                            </tr>
                          </thead>
                          <tbody>
                            {providerEvidence.shadowCalibration.confidenceBins
                              .filter((bin) => bin.count > 0)
                              .map((bin) => (
                                <tr key={`${bin.lower}-${bin.upper}`}>
                                  <td>
                                    {(bin.lower * 100).toFixed(0)}–
                                    {(bin.upper * 100).toFixed(0)}%
                                  </td>
                                  <td>{bin.count}</td>
                                  <td>
                                    {providerPercent(bin.observedWinRate)}
                                  </td>
                                  <td>
                                    {providerPercent(bin.avgConfidence)}
                                  </td>
                                  <td>
                                    {bin.calibrationGap == null
                                      ? "—"
                                      : `${bin.calibrationGap >= 0 ? "+" : ""}${(
                                          bin.calibrationGap * 100
                                        ).toFixed(1)} pp`}
                                  </td>
                                  <td>
                                    {bin.averagePnl == null
                                      ? "—"
                                      : `${bin.averagePnl >= 0 ? "+" : ""}${bin.averagePnl.toFixed(
                                          2,
                                        )} USD`}
                                  </td>
                                  <td>
                                    {providerMetric(bin.profitFactor, 3)}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}

                  {providerEvidence?.v8ProspectiveShadow ? (
                    <div className="ai-v8-shadow">
                      <div className="ai-shadow-calibration__header">
                        <div>
                          <span className="workspace-hero__eyebrow">
                            Legacy v8 shadow archive
                          </span>
                          <h3>Frozen meta-filter screening</h3>
                        </div>
                        <span
                          className={
                            providerEvidence.v8ProspectiveShadow
                              .screeningReadyForDedicatedPaper
                              ? "badge badge--success"
                              : "badge badge--info"
                          }
                        >
                          {providerEvidence.v8ProspectiveShadow
                            .screeningReadyForDedicatedPaper
                            ? "LEGACY SCREEN PASSED · ARCHIVED"
                            : "ARCHIVED SHADOW EVIDENCE"}
                        </span>
                      </div>

                      <p className="muted">
                        This preserves the earlier v8 meta-filter experiment against
                        legacy v7 opportunities for audit and comparison. It no longer has
                        execution authority and is not the active strategy architecture.
                        The active research path is the iRexPro Multi-Model Ensemble.
                      </p>

                      <div className="ai-provider-evidence__metrics">
                        <div>
                          <span>Tagged</span>
                          <strong>
                            {providerEvidence.v8ProspectiveShadow.taggedSignals}
                          </strong>
                        </div>
                        <div>
                          <span>Would admit</span>
                          <strong>
                            {providerEvidence.v8ProspectiveShadow.admittedSignals}
                          </strong>
                        </div>
                        <div>
                          <span>Would reject</span>
                          <strong>
                            {providerEvidence.v8ProspectiveShadow.rejectedSignals}
                          </strong>
                        </div>
                        <div>
                          <span>Admission rate</span>
                          <strong>
                            {providerPercent(
                              providerEvidence.v8ProspectiveShadow.admittedFraction,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Closed shadow evidence</span>
                          <strong>
                            {providerEvidence.v8ProspectiveShadow.closedTrades} / 100
                          </strong>
                        </div>
                        <div>
                          <span>W / L</span>
                          <strong>
                            {providerEvidence.v8ProspectiveShadow.wins} /{" "}
                            {providerEvidence.v8ProspectiveShadow.losses}
                          </strong>
                        </div>
                        <div>
                          <span>Shadow P&amp;L</span>
                          <strong>
                            {providerEvidence.v8ProspectiveShadow.realisedPnl >= 0
                              ? "+"
                              : ""}
                            {providerEvidence.v8ProspectiveShadow.realisedPnl.toFixed(
                              2,
                            )}{" "}
                            USD
                          </strong>
                        </div>
                        <div>
                          <span>Rejected closed W / L</span>
                          <strong>
                            {providerEvidence.v8ProspectiveShadow.rejectedWins} /{" "}
                            {providerEvidence.v8ProspectiveShadow.rejectedLosses}
                          </strong>
                        </div>
                        <div>
                          <span>Rejected cohort P&amp;L</span>
                          <strong>
                            {providerEvidence.v8ProspectiveShadow.rejectedRealisedPnl >= 0
                              ? "+"
                              : ""}
                            {providerEvidence.v8ProspectiveShadow.rejectedRealisedPnl.toFixed(
                              2,
                            )}{" "}
                            USD
                          </strong>
                        </div>
                        <div>
                          <span>Rejected cohort PF</span>
                          <strong>
                            {providerMetric(
                              providerEvidence.v8ProspectiveShadow.rejectedProfitFactor,
                              3,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Profit factor</span>
                          <strong>
                            {providerMetric(
                              providerEvidence.v8ProspectiveShadow.profitFactor,
                              3,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Balanced accuracy</span>
                          <strong>
                            {providerPercent(
                              providerEvidence.v8ProspectiveShadow
                                .balancedAccuracy,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Evidence Sharpe</span>
                          <strong>
                            {providerMetric(
                              providerEvidence.v8ProspectiveShadow
                                .evidenceWindowSharpeRatio,
                              3,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Positive pairs</span>
                          <strong>
                            {providerPercent(
                              providerEvidence.v8ProspectiveShadow
                                .positiveInstrumentFraction,
                            )}
                          </strong>
                        </div>
                        <div>
                          <span>Median signal gap</span>
                          <strong>
                            {providerEvidence.v8ProspectiveShadow
                              .medianMinutesBetweenSignals == null
                              ? "—"
                              : providerEvidence.v8ProspectiveShadow.medianMinutesBetweenSignals.toFixed(
                                  1,
                                ) + " min"}
                          </strong>
                        </div>
                        <div>
                          <span>Latest v8 probability</span>
                          <strong>
                            {providerPercent(
                              providerEvidence.v8ProspectiveShadow
                                .latestProbability,
                            )}
                          </strong>
                        </div>
                      </div>

                      <div
                        className="ai-provider-evidence__gates"
                        aria-label="v8 prospective shadow screening checks"
                      >
                        {[
                          [
                            "BA ≥ 0.52",
                            providerEvidence.v8ProspectiveShadow.screeningChecks
                              .balancedAccuracy,
                          ],
                          [
                            "Sharpe ≥ 1.0",
                            providerEvidence.v8ProspectiveShadow.screeningChecks
                              .sharpeRatio,
                          ],
                          [
                            "PF ≥ 1.15",
                            providerEvidence.v8ProspectiveShadow.screeningChecks
                              .profitFactor,
                          ],
                          [
                            "Positive weeks ≥ 60%",
                            providerEvidence.v8ProspectiveShadow.screeningChecks
                              .positiveWindowFraction,
                          ],
                          [
                            "Positive pairs ≥ 67%",
                            providerEvidence.v8ProspectiveShadow.screeningChecks
                              .positiveInstrumentFraction,
                          ],
                          [
                            "Underlying confidence ≥ 60%",
                            providerEvidence.v8ProspectiveShadow.screeningChecks
                              .confidence,
                          ],
                          [
                            "Closed shadow trades ≥ 100",
                            providerEvidence.v8ProspectiveShadow.screeningChecks
                              .evidence,
                          ],
                          [
                            "Median gap ≤ 10m",
                            providerEvidence.v8ProspectiveShadow.screeningChecks
                              .frequency,
                          ],
                        ].map(([label, passed]) => (
                          <span
                            key={String(label)}
                            className={passed ? "is-passed" : "is-pending"}
                          >
                            {passed ? "✓" : "·"} {String(label)}
                          </span>
                        ))}
                      </div>

                      <p className="ai-provider-evidence__footnote">
                        This is screening evidence, not qualification evidence.
                        v8 shadow has no isolated account-equity drawdown because
                        v7 still owns execution. If every screening check matures,
                        the next step is a separate v8 PAPER cohort starting from
                        zero evidence.
                      </p>
                    </div>
                  ) : null}

                  {providerEvidence?.planBEnsembleShadow ? (
                    <div className="ai-v8-shadow">
                      <div className="ai-shadow-calibration__header">
                        <div>
                          <span className="workspace-hero__eyebrow">
                            Plan B multimodel ensemble
                          </span>
                          <h3>Regime-aware prospective screening</h3>
                        </div>
                        <span className="badge badge--info">
                          SHADOW ONLY · NO EXECUTION CHANGES
                        </span>
                      </div>

                      <p className="muted">
                        The ensemble separates regime, direction quality,
                        expected-return economics and trade quality before
                        producing one shadow decision. Every component is stored
                        so weak decisions can be diagnosed instead of hidden
                        behind a single confidence number.
                      </p>

                      <div className="ai-provider-evidence__metrics">
                        <div>
                          <span>Tagged</span>
                          <strong>{providerEvidence.planBEnsembleShadow.taggedSignals}</strong>
                        </div>
                        <div>
                          <span>Would admit</span>
                          <strong>{providerEvidence.planBEnsembleShadow.admittedSignals}</strong>
                        </div>
                        <div>
                          <span>Would reject</span>
                          <strong>{providerEvidence.planBEnsembleShadow.rejectedSignals}</strong>
                        </div>
                        <div>
                          <span>Admission rate</span>
                          <strong>{providerPercent(providerEvidence.planBEnsembleShadow.admittedFraction)}</strong>
                        </div>
                        <div>
                          <span>Closed evidence</span>
                          <strong>{providerEvidence.planBEnsembleShadow.closedTrades}</strong>
                        </div>
                        <div>
                          <span>W / L</span>
                          <strong>
                            {providerEvidence.planBEnsembleShadow.wins} /{" "}
                            {providerEvidence.planBEnsembleShadow.losses}
                          </strong>
                        </div>
                        <div>
                          <span>Shadow P&amp;L</span>
                          <strong>
                            {providerEvidence.planBEnsembleShadow.realisedPnl >= 0 ? "+" : ""}
                            {providerEvidence.planBEnsembleShadow.realisedPnl.toFixed(2)} USD
                          </strong>
                        </div>
                        <div>
                          <span>Profit factor</span>
                          <strong>
                            {providerMetric(providerEvidence.planBEnsembleShadow.profitFactor, 3)}
                          </strong>
                        </div>
                        <div>
                          <span>Avg direction quality</span>
                          <strong>
                            {providerPercent(providerEvidence.planBEnsembleShadow.averageDirectionQuality)}
                          </strong>
                        </div>
                        <div>
                          <span>Avg trade quality</span>
                          <strong>
                            {providerPercent(providerEvidence.planBEnsembleShadow.averageTradeQuality)}
                          </strong>
                        </div>
                        <div>
                          <span>Avg exit quality</span>
                          <strong>
                            {providerPercent(providerEvidence.planBEnsembleShadow.averageExitQuality)}
                          </strong>
                        </div>
                        <div>
                          <span>Avg pair/side quality</span>
                          <strong>
                            {providerPercent(providerEvidence.planBEnsembleShadow.averagePairSideQuality)}
                          </strong>
                        </div>
                        <div>
                          <span>Avg session quality</span>
                          <strong>
                            {providerPercent(providerEvidence.planBEnsembleShadow.averageSessionQuality)}
                          </strong>
                        </div>
                        <div>
                          <span>Model consensus</span>
                          <strong>
                            {providerMetric(providerEvidence.planBEnsembleShadow.averageConsensusPassed, 1)} / {providerMetric(providerEvidence.planBEnsembleShadow.averageConsensusRequired, 1)}
                          </strong>
                        </div>
                        <div>
                          <span>Avg portfolio quality</span>
                          <strong>
                            {providerPercent(providerEvidence.planBEnsembleShadow.averagePortfolioQuality)}
                          </strong>
                        </div>
                        <div>
                          <span>Avg portfolio risk</span>
                          <strong>
                            {providerPercent(providerEvidence.planBEnsembleShadow.averagePortfolioRiskScore)}
                          </strong>
                        </div>
                        <div>
                          <span>Avg open exposure</span>
                          <strong>
                            {providerMetric(providerEvidence.planBEnsembleShadow.averageOpenPositionCount, 1)} positions
                          </strong>
                        </div>
                        <div>
                          <span>Avg same-instrument load</span>
                          <strong>
                            {providerMetric(providerEvidence.planBEnsembleShadow.averageSameInstrumentCount, 1)}
                          </strong>
                        </div>
                        <div>
                          <span>Avg meta probability</span>
                          <strong>
                            {providerPercent(providerEvidence.planBEnsembleShadow.averageMetaProbability)}
                          </strong>
                        </div>
                        <div>
                          <span>Avg ensemble score</span>
                          <strong>
                            {providerPercent(providerEvidence.planBEnsembleShadow.averageEnsembleScore)}
                          </strong>
                        </div>
                      </div>

                      <div className="ai-provider-evidence__gates">
                        {Object.entries(providerEvidence.planBEnsembleShadow.pairSideRouteCounts).map(
                          ([route, count]) => (
                            <span key={`pair-${route}`} className={route === "CORE" ? "is-pass" : "is-pending"}>
                              Pair/side {route.toLowerCase()} · {count}
                            </span>
                          ),
                        )}
                        {Object.entries(providerEvidence.planBEnsembleShadow.regimeCounts).map(
                          ([regime, count]) => (
                            <span key={regime} className="is-pending">
                              {regime.replaceAll("_", " ")} · {count}
                            </span>
                          ),
                        )}
                      </div>

                      <p className="ai-provider-evidence__footnote">
                        {providerEvidence.planBEnsembleShadow.methodology}
                      </p>
                    </div>
                  ) : null}

                  <p className="ai-provider-evidence__footnote">
                    Passing every v7 gate only permits a separate DEMO review.
                    Automatic DEMO and LIVE promotion remain disabled.
                  </p>
                </Card>
              </section>
            )}

            {automationOn && (
              <section
                className="ai-runtime-panel ai-cockpit"
                data-ai-state={aiVisualState}
                aria-label="AI trading cockpit"
              >
                <div className="ai-cockpit__topbar">
                  <div>
                    <p className="workspace-hero__eyebrow">AI market cockpit</p>
                    <h2>Live Market Intelligence</h2>
                  </div>
                  <div className="ai-cockpit__status">
                    <MotionStatusOrb
                      tone={
                        aiVisualState === "error"
                          ? "error"
                          : aiVisualState === "blocked"
                            ? "warning"
                            : aiVisualState === "signal"
                              ? "info"
                              : "success"
                      }
                      active={automationOn}
                    />
                    <Badge
                      variant={
                        aiVisualState === "error"
                          ? "error"
                          : aiVisualState === "blocked"
                            ? "warning"
                            : "success"
                      }
                    >
                      {aiVisualState === "signal"
                        ? "SIGNAL READY"
                        : aiVisualState === "blocked"
                          ? "WAITING"
                          : aiVisualState === "error"
                            ? "DATA ISSUE"
                            : "SCANNING"}
                    </Badge>
                  </div>
                </div>

                <div
                  className="ai-cockpit__instruments"
                  aria-label="Watched instruments"
                >
                  {watchedInstruments.map((instrument) => (
                    <button
                      key={instrument}
                      type="button"
                      className={
                        instrument === chartInstrument ? "is-active" : ""
                      }
                      onClick={() => setChartInstrument(instrument)}
                    >
                      {instrument}
                    </button>
                  ))}
                </div>

                <div className="ai-cockpit__grid">
                  <div className="ai-cockpit__chart-card">
                    <div className="ai-cockpit__chart-head">
                      <div>
                        <span className="ai-cockpit__label">
                          {chartInstrument}
                        </span>
                        <strong>
                          {automationRuntime?.research_uat
                            ? (automationRuntime.last_market_data_close ??
                              market?.quote.bid ??
                              "—")
                            : (market?.quote.bid ?? "—")}
                        </strong>
                        <small>
                          {chartLoading
                            ? "Updating chart…"
                            : `${chartTimeframe} market view`}
                        </small>
                      </div>
                      <div className="ai-cockpit__timeframes">
                        {(vpsScannerStatus?.enabled
                          ? (["M5", "M15", "H1", "H4"] as const)
                          : (["M1", "M5", "M15", "H1", "H4"] as const)
                        ).map((timeframe) => (
                          <button
                            key={timeframe}
                            type="button"
                            className={
                              chartTimeframe === timeframe ? "is-active" : ""
                            }
                            onClick={() => setChartTimeframe(timeframe)}
                          >
                            {timeframe}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="ai-cockpit__market-stats">
                      <div>
                        <span>Open</span>
                        <strong>{latestChartCandle?.open ?? "—"}</strong>
                      </div>
                      <div>
                        <span>High</span>
                        <strong>{latestChartCandle?.high ?? "—"}</strong>
                      </div>
                      <div>
                        <span>Low</span>
                        <strong>{latestChartCandle?.low ?? "—"}</strong>
                      </div>
                      <div>
                        <span>Spread</span>
                        <strong>{market?.quote.spread ?? "—"}</strong>
                      </div>
                      <div
                        className={
                          chartMove != null && chartMove < 0
                            ? "is-down"
                            : "is-up"
                        }
                      >
                        <span>Last move</span>
                        <strong>
                          {chartMove == null || chartMovePercent == null
                            ? "—"
                            : `${chartMove >= 0 ? "+" : ""}${chartMove.toFixed(3)} (${chartMovePercent >= 0 ? "+" : ""}${chartMovePercent.toFixed(3)}%)`}
                        </strong>
                      </div>
                    </div>
                    <MarketPriceChart candles={market?.candles ?? []} />
                  </div>

                  <aside
                    className={`ai-confidence ai-confidence--${confidenceTone}`}
                  >
                    <span className="ai-cockpit__label">
                      {vpsConfidenceActive ? "Multi-model ensemble score" : "AI confidence"}
                    </span>
                    <strong className="ai-confidence__value">
                      {formatConfidence(displayedConfidence)}
                    </strong>
                    <div className="ai-confidence__track" aria-hidden="true">
                      <span style={{ width: `${confidencePercent}%` }} />
                    </div>
                    <div className="ai-confidence__meta">
                      <span>
                        {vpsConfidenceActive
                          ? vpsScannerStatus?.marketSchedule.paused
                            ? "No new decision while market is paused"
                            : vpsScannerStatus?.lastEnsembleDecision.admitted
                              ? "Ensemble would admit this setup"
                              : "Ensemble decision · NO TRADE"
                          : automationRuntime?.last_decision === "NO_NEW_MARKET_DATA"
                            ? "Waiting for new market data"
                            : confidencePercent >= 60
                              ? "Qualified strength"
                              : "Building conviction"}
                      </span>
                      <span>
                        {vpsConfidenceActive
                          ? `${vpsScannerStatus?.lastEnsembleDecision.consensusPassed ?? 0}/${vpsScannerStatus?.lastEnsembleDecision.consensusRequired ?? 0} model votes`
                          : `${formatConfidence(displayedConfidenceThreshold)} gate`}
                      </span>
                    </div>
                    <p>
                      {vpsConfidenceActive
                        ? vpsScannerStatus?.marketSchedule.paused
                          ? `Market paused: ${vpsScannerStatus.marketSchedule.reason === "WEEKEND" ? "weekend closure" : "rollover / low-liquidity window"}. Next eligible scan ${formatTimestamp(vpsScannerStatus.marketSchedule.nextEligibleScanAt)}.`
                          : vpsScannerStatus?.lastEnsembleDecision.evaluatedAt
                            ? `${vpsScannerStatus.lastEnsembleDecision.instrument ?? "Setup"} ${vpsScannerStatus.lastEnsembleDecision.direction ?? ""} · ${vpsScannerStatus.lastEnsembleDecision.regime ?? "regime pending"} · ${vpsScannerStatus.lastEnsembleDecision.reasons.join(", ") || "ADMIT"} · evaluated ${formatTimestamp(vpsScannerStatus.lastEnsembleDecision.evaluatedAt)}`
                            : "Multi-model ensemble is waiting for its first eligible market scan. Legacy v7 cannot execute during this transition."
                        : automationRuntime?.last_decision === "NO_NEW_MARKET_DATA"
                          ? `No new candle after ${formatTimestamp(automationRuntime?.last_market_data_at)}. Confidence will update when a new market revision is evaluated.`
                          : runtimeReasonLabel(automationRuntime?.last_reason)}
                    </p>
                  </aside>
                </div>

                <details className="ai-cockpit__technical">
                  <summary>Technical details</summary>
                  <div className="ai-cockpit__technical-grid">
                    <div>
                      <span>Model</span>
                      <strong>
                        {automationRuntime?.model_version ?? "Awaiting model"}
                      </strong>
                    </div>
                    <div>
                      <span>Timeframes</span>
                      <strong>{automationRuntime?.timeframe ?? "MTF"}</strong>
                    </div>
                    <div>
                      <span>Last scan</span>
                      <strong>
                        {formatTimestamp(automationRuntime?.last_run_at)}
                      </strong>
                    </div>
                    <div>
                      <span>Next scan</span>
                      <strong>
                        {formatTimestamp(automationRuntime?.next_run_at)}
                      </strong>
                    </div>
                    <div>
                      <span>Replay steps</span>
                      <strong>
                        {automationRuntime?.replay_steps_total ?? 0}
                      </strong>
                    </div>
                    <div>
                      <span>Executions</span>
                      <strong>
                        {automationRuntime?.executions_succeeded_total ?? 0}{" "}
                        succeeded
                      </strong>
                    </div>
                    <div>
                      <span>Last decision</span>
                      <strong>
                        {automationRuntime?.last_decision?.replaceAll(
                          "_",
                          " ",
                        ) ?? "WAITING"}
                      </strong>
                    </div>
                    <div>
                      <span>Market timestamp</span>
                      <strong>
                        {formatTimestamp(
                          automationRuntime?.last_market_data_at,
                        )}
                      </strong>
                    </div>
                  </div>
                </details>
              </section>
            )}

            <section
              className="ai-section ai-section--positions"
              aria-labelledby="open-positions-title"
            >
              <div className="ai-section__heading ai-section__heading--positions">
                <div>
                  <p className="workspace-hero__eyebrow">Live exposure</p>
                  <h2 id="open-positions-title">Open Positions</h2>
                </div>
                <div className="ai-position-toolbar">
                  <div
                    className="ai-position-total"
                    aria-label="Total unrealized profit or loss"
                  >
                    <span>Total unrealized P&amp;L</span>
                    <strong
                      className={
                        totalUnrealisedPnlUnavailable
                          ? ""
                          : totalUnrealisedPnl?.startsWith("-")
                            ? "is-negative"
                            : "is-positive"
                      }
                    >
                      {livePositions.length === 0
                        ? money("0", allocation?.accountCurrency)
                        : totalUnrealisedPnlUnavailable
                          ? "Awaiting complete broker marks"
                          : `${totalUnrealisedPnl!.startsWith("-") ? "" : "+"}${money(
                              totalUnrealisedPnl,
                              positionCurrency ?? allocation?.accountCurrency,
                            )}`}
                    </strong>
                  </div>
                  <div
                    className="ai-view-toggle"
                    role="group"
                    aria-label="Open position display"
                  >
                    <button
                      type="button"
                      className={positionView === "table" ? "is-active" : ""}
                      aria-pressed={positionView === "table"}
                      onClick={() => setPositionView("table")}
                    >
                      Table
                    </button>
                    <button
                      type="button"
                      className={positionView === "grid" ? "is-active" : ""}
                      aria-pressed={positionView === "grid"}
                      onClick={() => setPositionView("grid")}
                    >
                      Grid
                    </button>
                  </div>
                  <Badge variant={livePositions.length ? "success" : "info"}>
                    {livePositions.length} open
                  </Badge>
                  {livePositions.length > 0 && (
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      loading={closingAllPositions}
                      disabled={closingAllPositions || closingTradeId !== null}
                      onClick={() => void closeAllPositionsNow()}
                    >
                      {closingAllPositions ? "Closing all…" : "Close all"}
                    </Button>
                  )}
                </div>
              </div>
              {livePositions.length === 0 ? (
                <Card className="ai-empty-card">
                  <strong>No open positions</strong>
                  <p className="muted">
                    Current unrealized P&amp;L:{" "}
                    {money("0", allocation?.accountCurrency)}. When AI
                    automation opens a trade, its entry, current price, costs
                    and live unrealized P&amp;L will appear here.
                  </p>
                </Card>
              ) : positionView === "table" ? (
                <PositionTable
                  positions={livePositions}
                  closingTradeId={closingTradeId}
                  onClose={(tradeId) => void closePositionNow(tradeId)}
                />
              ) : (
                <div className="ai-position-grid">
                  {livePositions.map((position) => (
                    <PositionCard
                      key={position.id}
                      position={position}
                      closing={closingTradeId === position.id}
                      onClose={(tradeId) => void closePositionNow(tradeId)}
                    />
                  ))}
                </div>
              )}
            </section>

            <section
              className="ai-trading-grid ai-trading-grid--history"
              aria-label="Closed trades and recent AI activity"
            >
              <section
                className="ai-section ai-history-card ai-section--closed-trades"
                aria-labelledby="closed-trades-title"
              >
                <div className="ai-section__heading">
                  <div>
                    <p className="workspace-hero__eyebrow">
                      Completed positions
                    </p>
                    <h2 id="closed-trades-title">
                      Closed Trades &amp; Realized P&amp;L
                    </h2>
                  </div>
                  <Badge
                    variant={recentClosedTrades.length ? "success" : "info"}
                  >
                    {recentClosedTrades.length} recent
                  </Badge>
                </div>
                {recentClosedTrades.length === 0 ? (
                  <Card className="ai-empty-card ai-empty-card--compact">
                    <strong>
                      No closed trades in the latest execution history
                    </strong>
                    <p className="muted">
                      Closed positions stay separate so realized profit or loss
                      remains easy to audit.
                    </p>
                  </Card>
                ) : (
                  <div className="ai-activity-list ai-activity-list--scroll">
                    {recentClosedTrades.map((trade) => (
                      <ExecutionRow key={trade.id} trade={trade} />
                    ))}
                  </div>
                )}
              </section>

              <section
                className="ai-section ai-history-card ai-section--activity"
                aria-labelledby="recent-ai-activity-title"
              >
                <div className="ai-section__heading">
                  <div>
                    <p className="workspace-hero__eyebrow">
                      Orders &amp; decisions
                    </p>
                    <h2 id="recent-ai-activity-title">Recent AI Activity</h2>
                  </div>
                  <Link href="/live-account" className="ai-text-link">
                    View all
                  </Link>
                </div>
                {!execution || execution.recentExecutions.length === 0 ? (
                  <Card className="ai-empty-card ai-empty-card--compact">
                    <strong>No execution activity yet</strong>
                    <p className="muted">
                      Orders, fills, execution outcomes and AI workflow
                      decisions will appear here.
                    </p>
                  </Card>
                ) : (
                  <div className="ai-activity-list ai-activity-list--scroll">
                    {execution.recentExecutions.slice(0, 10).map((trade) => (
                      <ExecutionRow key={trade.id} trade={trade} />
                    ))}
                  </div>
                )}
              </section>
            </section>

            <section
              className="ai-simple-note"
              aria-label="Automatic risk protection"
            >
              <div>
                <strong>Automatic risk protection is active</strong>
                <span>
                  There is no fixed trades-per-day cap. The AI may take every
                  qualified opportunity while daily loss, drawdown,
                  concurrent-position, margin, market-safety and kill-switch
                  protections remain enforced by the server.
                </span>
              </div>
              <Link href="/onboarding/risk" className="ai-text-link">
                View protection
              </Link>
            </section>
          </>
        )}

        <style jsx global>{`
          .ai-trader__hero,
          .ai-runtime-panel,
          .ai-control-card,
          .ai-overview-card,
          .ai-history-card {
            transition:
              transform 180ms ease,
              border-color 180ms ease,
              box-shadow 180ms ease,
              background 180ms ease;
          }
          .ai-runtime-panel {
            position: relative;
            overflow: hidden;
          }
          .ai-runtime-panel::after {
            content: "";
            position: absolute;
            top: 0;
            left: -38%;
            width: 38%;
            height: 1px;
            background: linear-gradient(
              90deg,
              transparent,
              rgba(56, 189, 248, 0.9),
              transparent
            );
            opacity: 0;
            pointer-events: none;
          }
          .ai-runtime-panel[data-ai-state="running"],
          .ai-runtime-panel[data-ai-state="scanning"] {
            border-color: rgba(34, 197, 94, 0.28);
            box-shadow:
              0 18px 50px rgba(2, 6, 23, 0.18),
              inset 0 0 30px rgba(34, 197, 94, 0.025);
          }
          .ai-runtime-panel[data-ai-state="running"]::after,
          .ai-runtime-panel[data-ai-state="scanning"]::after {
            opacity: 0.72;
            animation: irexSweep 3.2s linear infinite;
          }
          .ai-runtime-panel[data-ai-state="signal"] {
            border-color: rgba(56, 189, 248, 0.42);
            box-shadow: 0 20px 56px rgba(14, 165, 233, 0.12);
          }
          .ai-runtime-panel[data-ai-state="signal"]::after {
            opacity: 0.95;
            animation: irexSweep 1.35s linear infinite;
          }
          .ai-runtime-panel[data-ai-state="blocked"] {
            border-color: rgba(245, 158, 11, 0.34);
          }
          .ai-runtime-panel[data-ai-state="error"] {
            border-color: rgba(239, 68, 68, 0.36);
          }
          @media (hover: hover) {
            .ai-control-card:hover,
            .ai-overview-card:hover,
            .ai-history-card:hover,
            .ai-runtime-grid > div:hover {
              transform: translateY(-2px);
              box-shadow: 0 14px 32px rgba(2, 6, 23, 0.18);
            }
          }
          @keyframes irexSweep {
            from {
              transform: translateX(0);
            }
            to {
              transform: translateX(365%);
            }
          }
          @media (prefers-reduced-motion: reduce) {
            .ai-runtime-panel::after {
              animation: none !important;
            }
            .ai-trader__hero,
            .ai-runtime-panel,
            .ai-control-card,
            .ai-overview-card,
            .ai-history-card {
              transition: none !important;
            }
          }
        `}</style>

        {pendingAutomationAction && (
          <div
            className="ai-confirm-overlay"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !togglingAutomation) {
                setPendingAutomationAction(null);
              }
            }}
          >
            <section
              className="ai-confirm-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="ai-confirm-title"
              aria-describedby="ai-confirm-description"
            >
              <div className="ai-confirm-dialog__header">
                <span className="ai-control-card__label">
                  {pendingAutomationAction === "STOP"
                    ? "Confirmation required"
                    : "Ready to start"}
                </span>
                <h2 id="ai-confirm-title">
                  {pendingAutomationAction === "STOP"
                    ? "Stop AI Trading and close AI positions?"
                    : "Start AI Trading?"}
                </h2>
              </div>

              <p
                id="ai-confirm-description"
                className="ai-confirm-dialog__description"
              >
                {pendingAutomationAction === "STOP"
                  ? "Confirming will stop new AI trading first, then immediately request closure of every currently open position that iRexPro can prove was opened by the AI."
                  : "Confirm that you want iRexPro AI to begin trading this broker account automatically using the capital you allocated."}
              </p>

              <div
                className="ai-confirm-facts"
                aria-label="AI Trading confirmation details"
              >
                <div>
                  <span>Broker</span>
                  <strong>{connectionLabel(selectedBroker)}</strong>
                </div>
                <div>
                  <span>AI allocation</span>
                  <strong>
                    {money(
                      allocation?.allocatedCapital,
                      allocation?.accountCurrency,
                    )}
                  </strong>
                </div>
                <div>
                  <span>Open positions shown</span>
                  <strong>{livePositions.length}</strong>
                </div>
              </div>

              {pendingAutomationAction === "STOP" ? (
                <Alert variant="warning">
                  <strong>Stopping also closes AI-opened positions.</strong>{" "}
                  Broker market conditions determine the actual exit price. If a
                  broker cannot immediately prove a closure, iRexPro will report
                  it as unresolved/reconciliation pending instead of pretending
                  it is closed.
                </Alert>
              ) : (
                <Alert variant="info">
                  Once started, the AI may open, manage and close positions
                  automatically within your allocation and server-enforced
                  protections until you stop AI Trading.
                </Alert>
              )}

              <div className="ai-confirm-dialog__actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={togglingAutomation}
                  onClick={() => setPendingAutomationAction(null)}
                >
                  {pendingAutomationAction === "STOP"
                    ? "Keep AI Trading Running"
                    : "Cancel"}
                </Button>
                <Button
                  type="button"
                  variant={
                    pendingAutomationAction === "STOP" ? "danger" : "primary"
                  }
                  loading={togglingAutomation}
                  autoFocus
                  onClick={() => void confirmAutomationAction()}
                >
                  {pendingAutomationAction === "STOP"
                    ? "Stop & Close AI Positions"
                    : "Start AI Trading"}
                </Button>
              </div>
            </section>
          </div>
        )}
      </main>
    </DashboardShell>
  );
}
