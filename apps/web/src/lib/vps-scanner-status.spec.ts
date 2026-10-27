import {
  deriveActiveModelUiState,
  deriveFastMarkFeedUiState,
  deriveTradeReadinessUiState,
  hasExternalProviderPerformanceUiShape,
  hasVpsScannerUiShape,
} from "./vps-scanner-status";

const VALID_STATUS = {
  enabled: true,
  activeEngineCode: "irexpro-multimodel-ensemble-v1",
  executionAuthority: "PAPER_ONLY",
  ensembleThresholds: {
    candidateConfidenceFloor: 0.64,
    metaProbabilityFloor: 0.40828402366863903,
    grossExpectedRFloor: 0.08,
    paperNetExpectedRFloor: 0,
    promotionNetExpectedRFloor: 0.08,
    sleeveCoreMinClosedTrades: 100,
  },
  marketSchedule: {
    paused: false,
    reason: null,
    nextEligibleScanAt: "2026-10-05T00:30:00.000Z",
  },
  lastEnsembleDecision: {
    reasons: [],
    governance: {
      paperNetExpectedRPassed: false,
      paperExecutionEligible: false,
      paperExecutionBlockers: ["ENSEMBLE_NOT_ADMITTED"],
      paperPromotionEligible: false,
    },
    macroEventAssessment: null,
    highConvictionOverlay: null,
  },
  ensembleCampaign: {
    sleeves: [],
    highConvictionOverlayCounts: {},
    highConvictionOverlayPerformance: {
      CONFIRM: {},
      CONFLICT: {},
      ABSTAIN: {},
    },
    profitProtection: {
      counterfactuals: [],
    },
  },
  highConvictionChallenger: {
    frozenConsensus: null,
    historicalValidation: null,
  },
  expertRegistry: {
    entries: [],
  },
  marketCache: {},
  postEntryShadow: {
    evidenceMinimums: {},
  },
  pairSideReliability: [
    {
      instrument: "USDJPY",
      direction: "BUY",
      state: "COLLECTING",
      episodes: 3,
      profitFactor: 3.04,
      sharpe: 0.81,
      maxDrawdown: 0.0103,
      positiveWindowFraction: 1,
      fullSizeEligible: true,
      researchFallbackRequested: false,
      reason: "INSUFFICIENT_PAIR_SIDE_EVIDENCE",
    },
  ],
};

describe("VPS scanner UI status runtime guard", () => {
  it("accepts the nested containers the Trade cockpit safely consumes", () => {
    expect(hasVpsScannerUiShape(VALID_STATUS)).toBe(true);
  });

  it("rejects an empty rolling-deployment payload instead of letting the page crash", () => {
    expect(hasVpsScannerUiShape({})).toBe(false);
  });

  it("rejects an older payload without authoritative ensemble thresholds", () => {
    const { ensembleThresholds: _ignored, ...oldStatus } = VALID_STATUS;
    expect(hasVpsScannerUiShape(oldStatus)).toBe(false);
  });

  it("rejects governance without the PAPER execution split", () => {
    expect(
      hasVpsScannerUiShape({
        ...VALID_STATUS,
        lastEnsembleDecision: {
          ...VALID_STATUS.lastEnsembleDecision,
          governance: { paperPromotionEligible: false },
        },
      }),
    ).toBe(false);
  });

  it("rejects malformed pair-side reliability evidence", () => {
    expect(
      hasVpsScannerUiShape({
        ...VALID_STATUS,
        pairSideReliability: [{ instrument: "USDJPY", direction: "BUY" }],
      }),
    ).toBe(false);
  });

  it("rejects a malformed nested market schedule", () => {
    expect(
      hasVpsScannerUiShape({
        ...VALID_STATUS,
        marketSchedule: {},
      }),
    ).toBe(false);
  });

  it("accepts provider-health telemetry when its nested shape is safe", () => {
    expect(
      hasVpsScannerUiShape({
        ...VALID_STATUS,
        marketCache: HEALTHY_DERIV_MARKET_CACHE,
      }),
    ).toBe(true);
  });

  it("rejects malformed provider-health telemetry when it is present", () => {
    expect(
      hasVpsScannerUiShape({
        ...VALID_STATUS,
        marketCache: {
          ...HEALTHY_DERIV_MARKET_CACHE,
          providerHealth: {
            providers: { DERIV: { freshInstrumentCount: "six" } },
          },
        },
      }),
    ).toBe(false);
  });
});

const HEALTHY_DERIV_MARKET_CACHE = {
  cachedInstruments: [
    "AUDUSD",
    "EURUSD",
    "GBPUSD",
    "USDCAD",
    "USDCHF",
    "USDJPY",
  ],
  cachedInstrumentCount: 6,
  streamingInstruments: [
    "AUDUSD",
    "EURUSD",
    "GBPUSD",
    "USDCAD",
    "USDCHF",
    "USDJPY",
  ],
  streamingInstrumentCount: 6,
  fastMarkFallbackInstruments: [],
  latestObservedAt: "2026-10-20T02:55:00.000Z",
  latestQuoteObservedAt: "2026-10-20T02:55:00.000Z",
  providerHealth: {
    freshnessMaxAgeMs: 45_000,
    providers: {
      DERIV: {
        freshInstruments: [
          "AUDUSD",
          "EURUSD",
          "GBPUSD",
          "USDCAD",
          "USDCHF",
          "USDJPY",
        ],
        freshInstrumentCount: 6,
        staleInstruments: [],
        latestObservedAt: "2026-10-20T02:55:00.000Z",
        latestReceivedAt: "2026-10-20T02:55:00.120Z",
        latestSourceLagMs: 120,
        maxFreshSourceLagMs: 240,
      },
      TWELVE_DATA: {
        freshInstruments: [],
        freshInstrumentCount: 0,
        staleInstruments: [],
        latestObservedAt: null,
        latestReceivedAt: null,
        latestSourceLagMs: null,
        maxFreshSourceLagMs: null,
      },
    },
    executionReference: {
      comparisonMaxSkewMs: 360_000,
      comparisonCount: 1,
      comparisons: [
        {
          instrument: "USDJPY",
          streamProvider: "DERIV",
          timestampSkewMs: 20_000,
          divergencePips: 0.4,
          divergenceBps: 0.27,
          streamObservedAt: "2026-10-20T02:55:00.000Z",
          referenceObservedAt: "2026-10-20T02:54:40.000Z",
        },
      ],
      maxDivergencePips: 0.4,
      averageDivergencePips: 0.4,
    },
  },
};

describe("fast-mark feed UI state", () => {
  it("reports a healthy six-pair Deriv stream as live", () => {
    expect(
      deriveFastMarkFeedUiState(HEALTHY_DERIV_MARKET_CACHE, "USDJPY"),
    ).toMatchObject({
      state: "LIVE",
      provider: "DERIV",
      freshCount: 6,
      expectedCount: 6,
      selectedInstrumentFallback: false,
      latestSourceLagMs: 120,
      maxFreshSourceLagMs: 240,
      divergencePips: 0.4,
      divergenceBps: 0.27,
      badgeLabel: "DERIV · LIVE · 6/6",
      badgeVariant: "success",
    });
  });

  it("reports a partially stale six-pair stream as degraded", () => {
    const cache: any = JSON.parse(JSON.stringify(HEALTHY_DERIV_MARKET_CACHE));
    cache.streamingInstruments = cache.streamingInstruments.filter(
      (symbol: string) => symbol !== "GBPUSD",
    );
    cache.streamingInstrumentCount = 5;
    cache.providerHealth.providers.DERIV.freshInstruments =
      cache.providerHealth.providers.DERIV.freshInstruments.filter(
        (symbol: string) => symbol !== "GBPUSD",
      );
    cache.providerHealth.providers.DERIV.freshInstrumentCount = 5;
    cache.providerHealth.providers.DERIV.staleInstruments = ["GBPUSD"];

    expect(deriveFastMarkFeedUiState(cache, "USDJPY")).toMatchObject({
      state: "DEGRADED",
      provider: "DERIV",
      freshCount: 5,
      selectedInstrumentFallback: false,
      badgeLabel: "DERIV · DEGRADED · 5/6",
      badgeVariant: "warning",
    });
  });

  it("makes selected-pair M5 fallback more visible than general provider health", () => {
    const cache: any = JSON.parse(JSON.stringify(HEALTHY_DERIV_MARKET_CACHE));
    cache.streamingInstruments = cache.streamingInstruments.filter(
      (symbol: string) => symbol !== "USDJPY",
    );
    cache.streamingInstrumentCount = 5;
    cache.fastMarkFallbackInstruments = ["USDJPY"];
    cache.providerHealth.providers.DERIV.freshInstruments =
      cache.providerHealth.providers.DERIV.freshInstruments.filter(
        (symbol: string) => symbol !== "USDJPY",
      );
    cache.providerHealth.providers.DERIV.freshInstrumentCount = 5;
    cache.providerHealth.providers.DERIV.staleInstruments = ["USDJPY"];

    expect(deriveFastMarkFeedUiState(cache, "USDJPY")).toMatchObject({
      state: "M5_FALLBACK",
      provider: "DERIV",
      freshCount: 5,
      selectedInstrumentFallback: true,
      badgeLabel: "M5 FALLBACK · USDJPY",
      badgeVariant: "warning",
    });
  });

  it("fails closed to unavailable while provider telemetry is absent during a rolling deployment", () => {
    expect(
      deriveFastMarkFeedUiState(
        {
          cachedInstruments: ["USDJPY"],
          cachedInstrumentCount: 1,
          streamingInstruments: ["USDJPY"],
          streamingInstrumentCount: 1,
        },
        "USDJPY",
      ),
    ).toMatchObject({
      state: "UNAVAILABLE",
      provider: null,
      selectedInstrumentFallback: false,
      badgeLabel: "MARKET FEED · VERIFYING",
      badgeVariant: "info",
    });
  });
});

describe("external provider performance runtime guard", () => {
  const validEvidence = {
    observed: { strategyRealisedPnl: 0 },
    checks: {},
  };

  it("accepts the minimum safe provider evidence shape", () => {
    expect(hasExternalProviderPerformanceUiShape(validEvidence)).toBe(true);
  });

  it("rejects an empty provider evidence payload", () => {
    expect(hasExternalProviderPerformanceUiShape({})).toBe(false);
  });

  it("rejects malformed optional nested evidence", () => {
    expect(
      hasExternalProviderPerformanceUiShape({
        ...validEvidence,
        profitProtectionShadow: {},
      }),
    ).toBe(false);
  });
});

describe("production trade-readiness presentation", () => {
  const statusModule = require("./vps-scanner-status") as Record<string, unknown>;

  function derive(input: Record<string, unknown>) {
    expect(typeof statusModule.deriveTradeReadinessUiState).toBe("function");
    return (statusModule.deriveTradeReadinessUiState as (value: Record<string, unknown>) => any)(input);
  }

  it("never enters the green zone when backend PAPER execution is blocked", () => {
    const status = JSON.parse(JSON.stringify(VALID_STATUS));
    status.lastEnsembleDecision.candidateConfidence = 0.91;
    status.lastEnsembleDecision.metaProbability = 0.81;
    status.lastEnsembleDecision.expectedR = 0.42;
    status.lastEnsembleDecision.consensusPassed = 6;
    status.lastEnsembleDecision.consensusRequired = 6;
    status.lastEnsembleDecision.paperAdmitted = true;
    status.lastEnsembleDecision.admitted = true;
    status.lastEnsembleDecision.governance = {
      ...status.lastEnsembleDecision.governance,
      netExpectedR: 0.3,
      paperNetExpectedRPassed: true,
      paperDriftPassed: true,
      driftState: "NORMAL",
      eventRisk: "CLEAR",
      paperExecutionEligible: false,
      paperExecutionBlockers: ["PAIR_SIDE_RELIABILITY"],
    };

    expect(
      derive({ automationOn: true, scannerStatus: status, fastMarkState: "LIVE" }),
    ).toMatchObject({
      band: "FORMING",
      tradeExpected: false,
    });
    expect(
      derive({ automationOn: true, scannerStatus: status, fastMarkState: "LIVE" }).score,
    ).toBeLessThan(70);
  });

  it("keeps blocked readiness dynamic instead of pinning distinct setups at 69", () => {
    const strong = JSON.parse(JSON.stringify(VALID_STATUS));
    strong.lastEnsembleDecision.candidateConfidence = 0.82;
    strong.lastEnsembleDecision.metaProbability = 0.72;
    strong.lastEnsembleDecision.expectedR = 0.24;
    strong.lastEnsembleDecision.consensusPassed = 6;
    strong.lastEnsembleDecision.consensusRequired = 6;
    strong.lastEnsembleDecision.paperAdmitted = true;
    strong.lastEnsembleDecision.admitted = true;
    strong.lastEnsembleDecision.governance = {
      ...strong.lastEnsembleDecision.governance,
      paperNetExpectedRPassed: true,
      paperDriftPassed: true,
      eventRisk: "CLEAR",
      paperExecutionEligible: false,
      paperExecutionBlockers: ["PAIR_SIDE_RELIABILITY"],
    };

    const forming = JSON.parse(JSON.stringify(strong));
    forming.lastEnsembleDecision.governance = {
      ...forming.lastEnsembleDecision.governance,
      paperNetExpectedRPassed: false,
      paperExecutionBlockers: ["PAPER_NET_EXPECTED_R", "PAIR_SIDE_RELIABILITY"],
    };

    const strongResult = derive({
      automationOn: true,
      scannerStatus: strong,
      fastMarkState: "LIVE",
    });
    const formingResult = derive({
      automationOn: true,
      scannerStatus: forming,
      fastMarkState: "LIVE",
    });

    expect(strongResult.score).toBeLessThan(70);
    expect(formingResult.score).toBeLessThan(strongResult.score);
    expect(formingResult.score).not.toBe(69);
  });

  it("enters the green zone only when the current setup is execution eligible", () => {
    const status = JSON.parse(JSON.stringify(VALID_STATUS));
    status.lastEnsembleDecision.candidateConfidence = 0.82;
    status.lastEnsembleDecision.metaProbability = 0.72;
    status.lastEnsembleDecision.expectedR = 0.24;
    status.lastEnsembleDecision.consensusPassed = 6;
    status.lastEnsembleDecision.consensusRequired = 6;
    status.lastEnsembleDecision.paperAdmitted = true;
    status.lastEnsembleDecision.admitted = true;
    status.lastEnsembleDecision.instrument = "EURUSD";
    status.lastEnsembleDecision.direction = "BUY";
    status.lastEnsembleDecision.governance = {
      ...status.lastEnsembleDecision.governance,
      netExpectedR: 0.18,
      paperNetExpectedRPassed: true,
      paperDriftPassed: true,
      driftState: "NORMAL",
      eventRisk: "CLEAR",
      paperExecutionEligible: true,
      paperExecutionBlockers: [],
    };

    const result = derive({
      automationOn: true,
      scannerStatus: status,
      fastMarkState: "LIVE",
    });
    expect(result.band).toBe("READY");
    expect(result.tradeExpected).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.instrument).toBe("EURUSD");
    expect(result.direction).toBe("BUY");
  });

  it("prefers the active M1 cTrader decision over a stale legacy scanner decision", () => {
    const staleStatus = JSON.parse(JSON.stringify(VALID_STATUS));
    staleStatus.lastEnsembleDecision.instrument = "USDJPY";
    staleStatus.lastEnsembleDecision.direction = "SELL";
    staleStatus.lastEnsembleDecision.candidateConfidence = 0.36;

    const m1Status = {
      enabled: true,
      phase: "DEMO_EARLY_TRANSITION_PROFESSIONAL",
      lastRunAt: "2026-10-27T20:30:09.000Z",
      lastError: null,
      latestDecision: {
        instrument: "EURUSD",
        direction: "SELL",
        route: "M1_TREND_CONTINUATION",
        barTime: "2026-10-27T20:29:00.000Z",
        confidence: 0.738,
        netExpectedR: 0.2794,
        executionAuthority: "NONE",
        blockers: ["DRIFT_OUT_OF_DISTRIBUTION", "M1_PHASE_ROUTE_SHADOW"],
        outcomeState: null,
      },
    };

    const result = derive({
      automationOn: true,
      scannerStatus: staleStatus,
      m1TacticalStatus: m1Status,
      fastMarkState: "UNAVAILABLE",
    });

    expect(result).toMatchObject({
      score: 49,
      band: "FORMING",
      tradeExpected: false,
      instrument: "EURUSD",
      direction: "SELL",
    });
    expect(result.detail).toMatch(/drift/i);
  });

  it("shows M1 broker-native execution eligibility as ready without legacy fast-mark capping", () => {
    const m1Status = {
      enabled: true,
      phase: "DEMO_EARLY_TRANSITION_PROFESSIONAL",
      lastRunAt: "2026-10-27T20:31:09.000Z",
      lastError: null,
      latestDecision: {
        instrument: "USDJPY",
        direction: "SELL",
        route: "M1_EARLY_TRANSITION",
        barTime: "2026-10-27T20:30:00.000Z",
        confidence: 0.738,
        netExpectedR: 0.24,
        executionAuthority: "PAPER_ONLY_RESEARCH",
        blockers: [],
        outcomeState: null,
      },
    };

    const result = derive({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: m1Status,
      fastMarkState: "UNAVAILABLE",
    });

    expect(result.band).toBe("READY");
    expect(result.tradeExpected).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(78);
    expect(result.instrument).toBe("USDJPY");
    expect(result.direction).toBe("SELL");
  });

  it("shows a waiting state while the authoritative market schedule is paused", () => {
    const status = JSON.parse(JSON.stringify(VALID_STATUS));
    status.marketSchedule.paused = true;
    status.marketSchedule.reason = "WEEKEND";

    expect(
      derive({ automationOn: true, scannerStatus: status, fastMarkState: "LIVE" }),
    ).toMatchObject({
      band: "WAITING",
      tradeExpected: false,
      headline: "Market paused",
    });
  });

  it("shows AI stopped instead of implying a setup can execute", () => {
    expect(
      derive({ automationOn: false, scannerStatus: VALID_STATUS, fastMarkState: "LIVE" }),
    ).toMatchObject({
      score: 0,
      band: "WAITING",
      tradeExpected: false,
      headline: "AI Trading is stopped",
    });
  });
});


describe("active multi-model execution presentation", () => {
  const status = {
    enabled: true,
    phase: "DEMO_EARLY_TRANSITION_PROFESSIONAL",
    primaryEngineCode: "irexpro-multimodel-ensemble-v1",
    primaryEngineDisplayName: "iRexPro Multi-Model Ensemble",
    authorityMode: "DEMO_FULL_AUTO",
    m1TacticalRole: "TIMING_SPECIALIST",
    lastRunAt: "2026-10-27T20:31:09.000Z",
    lastError: null,
    latestDecision: {
      instrument: "USDJPY",
      direction: "SELL",
      route: "M1_TREND_CONTINUATION",
      barTime: "2026-10-27T20:30:00.000Z",
      confidence: 0.738,
      netExpectedR: 0.24,
      executionAuthority: "PAPER_ONLY_RESEARCH",
      blockers: [],
      outcomeState: null,
      primaryEngineCode: "irexpro-multimodel-ensemble-v1",
      primaryConfidence: 0.704,
      primaryNetExpectedR: 0.19,
      planBRoute: "TREND_CONTINUATION",
      planBPaperAdmitted: true,
      multimodelExecutable: true,
      trainedExpertState: "CONFIRM",
      trainedExpertDirection: "SELL",
      trainedExpertConfidence: 0.81,
      trainedExpertLongVotes: 0,
      trainedExpertShortVotes: 3,
      m1TacticalRole: "TIMING_SPECIALIST",
      m1TimingRoute: "M1_TREND_CONTINUATION",
    },
  };

  it("labels the multi-model ensemble as active and M1 as the timing specialist", () => {
    expect(deriveActiveModelUiState(status)).toEqual({
      label: "Multi-model ensemble · ACTIVE",
      engineCode: "irexpro-multimodel-ensemble-v1",
      authorityLabel: "DEMO FULL AUTO",
      planBLabel: "Trend continuation · 70%",
      trainedExpertLabel: "3/3 SELL votes · 81%",
      m1TimingLabel: "M1 timing · Trend continuation",
      executable: true,
    });
  });

  it("uses primary ensemble confidence and blockers for readiness, not the M1 candidate confidence", () => {
    const result = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: status,
      fastMarkState: "UNAVAILABLE",
    });
    expect(result.band).toBe("READY");
    expect(result.tradeExpected).toBe(true);
    expect(result.score).toBe(78);
    expect(result.detail).toMatch(/multi-model/i);
  });
});
