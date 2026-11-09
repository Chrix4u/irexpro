import {
  deriveActiveModelUiState,
  deriveFastMarkFeedUiState,
  deriveTradeReadinessUiState,
  hasExternalProviderPerformanceUiShape,
  hasDemoFocusedEntryDiagnosticUiShape,
  hasM1TacticalStatusUiShape,
  hasVpsScannerUiShape,
} from "./vps-scanner-status";

describe("user-scoped recent DEMO entry decision evidence", () => {
  const evidence = {
    scope: "ACTIVE_CTRADER_DEMO",
    windowMinutes: 60,
    evaluatedDecisions: 281,
    candidateDecisions: 22,
    brokerAuthorizedDecisions: 0,
    executionSucceeded: 0,
    sessionInactiveDecisions: 0,
    sessionAgeMinutes: 396,
    lastDecisionAgeSeconds: 35,
    planBAdmittedDecisions: 2,
    primaryPathDecisions: 1,
    primaryReliabilityVetoDecisions: 1,
    eligibleFallbackProbationVetoDecisions: 0,
    operatingState: "SCANNING_NO_APPROVED_ENTRY",
    leadingBlockers: [
      { code: "ENSEMBLE_NOT_PROMOTABLE_ADMISSION", label: "Primary model admission not met", count: 211 },
    ],
    leadingPlanBReasons: [
      { code: "DIRECTION_QUALITY", label: "Direction quality below threshold", count: 12 },
    ],
    onlyCurrentSession: true,
  };
  it("accepts only complete bounded current-session diagnostic evidence", () => {
    expect(hasDemoFocusedEntryDiagnosticUiShape(evidence)).toBe(true);
    expect(hasDemoFocusedEntryDiagnosticUiShape({
      ...evidence, scope: "NO_ACTIVE_CTRADER_DEMO_SESSION",
      evaluatedDecisions: 0, candidateDecisions: 0,
      sessionAgeMinutes: 0,
      lastDecisionAgeSeconds: null,
      planBAdmittedDecisions: 0,
      primaryPathDecisions: 0,
      primaryReliabilityVetoDecisions: 0,
      eligibleFallbackProbationVetoDecisions: 0,
      operatingState: "NO_ACTIVE_SESSION",
      leadingBlockers: [],
      leadingPlanBReasons: [],
    })).toBe(true);
  });
  it("rejects malformed counts, unscoped evidence or unbounded reasons", () => {
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, evaluatedDecisions: -1 })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, sessionAgeMinutes: -5 })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, lastDecisionAgeSeconds: -5 })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, lastDecisionAgeSeconds: undefined })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, lastDecisionAgeSeconds: null })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({
      ...evidence, operatingState: "STALE_SCAN_EVIDENCE", lastDecisionAgeSeconds: 600,
    })).toBe(true);
    expect(hasDemoFocusedEntryDiagnosticUiShape({
      ...evidence, operatingState: "STALE_SCAN_EVIDENCE", lastDecisionAgeSeconds: 40,
    })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, operatingState: "BROKER_READY" })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, primaryPathDecisions: 23 })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, primaryReliabilityVetoDecisions: 7 })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, onlyCurrentSession: false })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, leadingPlanBReasons: undefined })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, leadingPlanBReasons: [{ code: "DIRECTION_QUALITY", label: "bad", count: 23 }] })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, leadingPlanBReasons: [{ code: 5, label: "bad", count: 3 }] })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, leadingPlanBReasons: new Array(4).fill(evidence.leadingPlanBReasons[0]) })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, leadingBlockers: new Array(9).fill(evidence.leadingBlockers[0]) })).toBe(false);
    expect(hasDemoFocusedEntryDiagnosticUiShape({ ...evidence, leadingBlockers: [{ code: 4, label: "bad", count: 1 }] })).toBe(false);
  });
});

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

describe('server-authoritative DEMO focused-pair status contract', () => {
  const base = { enabled: true, phase: 'DEMO_EARLY_TRANSITION_PROFESSIONAL',
    lastRunAt: null, lastError: null, latestDecision: null };

  it('accepts the explicit server-reported entry and research-only pairs', () => {
    expect(hasM1TacticalStatusUiShape({
      ...base,
      demoEntryInstruments: ['AUDUSD', 'GBPUSD', 'EURUSD'],
      researchOnlyInstruments: ['USDJPY', 'USDCAD', 'USDCHF'],
    })).toBe(true);
  });

  it('rejects an invalid server pair list instead of displaying invented authority', () => {
    expect(hasM1TacticalStatusUiShape({
      ...base, demoEntryInstruments: ['AUDUSD', 4],
    })).toBe(false);
  });
});

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
  const statusModule = require("./vps-scanner-status") as Record<
    string,
    unknown
  >;

  function derive(input: Record<string, unknown>) {
    expect(typeof statusModule.deriveTradeReadinessUiState).toBe("function");
    return (
      statusModule.deriveTradeReadinessUiState as (
        value: Record<string, unknown>,
      ) => any
    )(input);
  }

  it("shows the connected but unauthorized DEMO broker as the primary 9/100 blocker", () => {
    const state = derive({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      brokerAccountType: "DEMO",
      brokerId: "ctrader",
      brokerAuthorizationStatus: "CONNECTED",
      m1TacticalStatus: {
        enabled: true,
        phase: "DEMO_EARLY_TRANSITION_PROFESSIONAL",
        lastRunAt: "2026-11-03T23:00:00.000Z",
        lastError: null,
        latestDecision: {
          instrument: "EURUSD",
          direction: "BUY",
          route: "M1_EARLY_TRANSITION",
          barTime: "2026-11-03T22:59:00.000Z",
          confidence: 0.738,
          netExpectedR: -1.48,
          executionAuthority: "NONE",
          blockers: ["PAPER_NET_EXPECTED_R", "DRIFT_OUT_OF_DISTRIBUTION"],
          outcomeState: null,
          primaryConfidence: 0.74,
        },
      },
    });
    expect(state).toMatchObject({
      score: 9,
      band: "WAITING",
      headline: "DEMO broker automation inactive — new trades paused",
      tradeExpected: false,
      instrument: "EURUSD",
      direction: "BUY",
    });
    expect(state.detail).toMatch(/not ACTIVE/i);
  });

  it("does not call a negative expectancy and drift-rejected signal a strong setup", () => {
    const state = derive({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      brokerAccountType: "DEMO",
      brokerId: "ctrader",
      brokerAuthorizationStatus: "ACTIVE",
      m1TacticalStatus: {
        enabled: true,
        phase: "DEMO_EARLY_TRANSITION_PROFESSIONAL",
        lastRunAt: "2026-11-03T23:00:00.000Z",
        lastError: null,
        latestDecision: {
          instrument: "EURUSD",
          direction: "BUY",
          route: "M1_EARLY_TRANSITION",
          barTime: "2026-11-03T22:59:00.000Z",
          confidence: 0.738,
          netExpectedR: -1.48,
          executionAuthority: "NONE",
          blockers: ["PAPER_NET_EXPECTED_R", "DRIFT_OUT_OF_DISTRIBUTION"],
          outcomeState: null,
          primaryConfidence: 0.74,
          primaryBlockerGroup: "MODEL_EXPECTANCY",
        },
      },
    });
    expect(state).toMatchObject({
      headline: "Negative after-cost expectancy — trade rejected",
      tradeExpected: false,
    });
    expect(state.score).toBeLessThan(70);
    expect(state.detail).toContain("-1.48R");
  });

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
      derive({
        automationOn: true,
        scannerStatus: status,
        fastMarkState: "LIVE",
      }),
    ).toMatchObject({
      band: "FORMING",
      tradeExpected: false,
    });
    expect(
      derive({
        automationOn: true,
        scannerStatus: status,
        fastMarkState: "LIVE",
      }).score,
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
      score: 59,
      band: "FORMING",
      tradeExpected: false,
      instrument: "EURUSD",
      direction: "SELL",
    });
    expect(result.detail).toMatch(/drift/i);
  });

  it("shows stale broker-native M1 as a feed pause instead of a frozen model score", () => {
    const m1Status = {
      enabled: true,
      phase: "DEMO_EARLY_TRANSITION_PROFESSIONAL",
      lastRunAt: "2026-10-29T20:45:00.000Z",
      lastError: null,
      marketReadiness: {
        EURUSD: {
          ready: false,
          reason: "BROKER_M1_STALE",
          authority: null,
          observedAt: "2026-10-29T20:45:00.000Z",
        },
      },
      latestDecision: {
        instrument: "EURUSD",
        direction: "BUY",
        route: "ABSTAIN",
        barTime: "2026-10-29T20:29:00.000Z",
        confidence: 0.35,
        netExpectedR: 0.12,
        executionAuthority: "NONE",
        blockers: ["MULTIMODEL_GOVERNANCE_BLOCKED"],
        outcomeState: null,
      },
    };

    const result = derive({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: m1Status,
      fastMarkState: "LIVE",
    });

    expect(result).toMatchObject({
      score: 8,
      band: "WAITING",
      tradeExpected: false,
      instrument: "EURUSD",
      direction: "BUY",
      headline: "Broker M1 feed stale — trading paused",
    });
    expect(result.detail).toMatch(/resume automatically/i);
  });

  it("shows broker context recovery as a data pause instead of reusing the old model score", () => {
    const m1Status = {
      enabled: true,
      phase: "DEMO_EARLY_TRANSITION_PROFESSIONAL",
      lastRunAt: "2026-10-29T21:01:15.000Z",
      lastError: null,
      marketReadiness: {
        EURUSD: {
          ready: false,
          reason: "BROKER_FEATURE_CONTEXT_UNAVAILABLE",
          authority: null,
          observedAt: "2026-10-29T21:01:15.000Z",
        },
      },
      latestDecision: {
        instrument: "EURUSD",
        direction: "BUY",
        route: "ABSTAIN",
        barTime: "2026-10-29T20:29:00.000Z",
        confidence: 0.35,
        netExpectedR: 0.12,
        executionAuthority: "NONE",
        blockers: ["MULTIMODEL_GOVERNANCE_BLOCKED"],
        outcomeState: null,
      },
    };

    const result = derive({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: m1Status,
      fastMarkState: "LIVE",
    });

    expect(result).toMatchObject({
      score: 12,
      band: "WAITING",
      tradeExpected: false,
      instrument: "EURUSD",
      direction: "BUY",
      headline: "Broker feature history incomplete — trading paused",
    });
    expect(result.detail).toMatch(/not sufficient/i);
  });

  it.each([
    [
      "BROKER_M5_CONTEXT_STALE",
      "Broker M5 candles stale — trading paused",
      "10-minute",
    ],
    [
      "BROKER_M15_CONTEXT_STALE",
      "Broker M15 candles stale — trading paused",
      "20-minute",
    ],
  ])(
    "shows the exact %s data blocker without implying an authorized trade",
    (reason, headline, limit) => {
      const m1Status = {
        enabled: true,
        phase: "DEMO_EARLY_TRANSITION_PROFESSIONAL",
        lastRunAt: "2026-11-03T22:45:00.000Z",
        lastError: null,
        marketReadiness: {
          GBPUSD: {
            ready: false,
            reason,
            authority: null,
            observedAt: "2026-11-03T22:45:00.000Z",
          },
        },
        latestDecision: {
          instrument: "GBPUSD",
          direction: "BUY" as const,
          route: "ABSTAIN",
          barTime: "2026-11-03T22:44:00.000Z",
          confidence: 0.72,
          netExpectedR: -0.15,
          executionAuthority: "NONE" as const,
          blockers: ["MULTIMODEL_GOVERNANCE_BLOCKED"],
          outcomeState: null,
        },
      };
      const result = derive({
        automationOn: true,
        scannerStatus: VALID_STATUS,
        m1TacticalStatus: m1Status,
        fastMarkState: "LIVE",
      });

      expect(result).toMatchObject({
        score: 12,
        band: "WAITING",
        tradeExpected: false,
        instrument: "GBPUSD",
        direction: "BUY",
        headline,
      });
      expect(result.detail).toContain(limit);
    },
  );

  it("shows the broker's verified M15 close time without treating stale data as ready", () => {
    const result = derive({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      fastMarkState: "LIVE",
      m1TacticalStatus: {
        enabled: true,
        phase: "DEMO_EARLY_TRANSITION_PROFESSIONAL",
        lastRunAt: "2026-11-05T22:04:00.000Z",
        lastError: null,
        marketReadiness: {
          EURUSD: {
            ready: false,
            reason: "BROKER_M15_CONTEXT_STALE",
            authority: null,
            observedAt: "2026-11-05T22:04:00.000Z",
            detail: "lastClosedAt=2026-11-05T21:30:00.000Z ageMinutes=34 maxAgeMinutes=20",
          },
        },
        latestDecision: {
          instrument: "EURUSD",
          direction: "BUY" as const,
          route: "ABSTAIN",
          barTime: "2026-11-05T22:03:00.000Z",
          confidence: 0.8,
          netExpectedR: 0.0,
          executionAuthority: "NONE" as const,
          blockers: ["MULTIMODEL_GOVERNANCE_BLOCKED"],
          outcomeState: null,
        },
      },
    });
    expect(result.tradeExpected).toBe(false);
    expect(result.headline).toBe("Broker M15 candles stale — trading paused");
    expect(result.detail).toContain("21:30 UTC");
    expect(result.detail).toContain("20-minute freshness limit");
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
    expect(result.score).toBe(74);
    expect(result.instrument).toBe("USDJPY");
    expect(result.direction).toBe("SELL");
  });

  it("does not stay green after the final risk engine rejects an otherwise executable setup", () => {
    const m1Status = {
      enabled: true,
      phase: "DEMO_EARLY_TRANSITION_PROFESSIONAL",
      primaryEngineCode: "irexpro-multimodel-ensemble-v1",
      lastRunAt: "2026-10-28T11:54:09.000Z",
      lastError: null,
      latestDecision: {
        instrument: "AUDUSD",
        direction: "BUY",
        route: "M1_TREND_CONTINUATION",
        barTime: "2026-10-28T11:53:00.000Z",
        confidence: 0.738,
        primaryConfidence: 0.746,
        netExpectedR: 0.519,
        executionAuthority: "PAPER_ONLY_RESEARCH",
        blockers: [],
        multimodelExecutable: true,
        outcomeState: "RISK_REJECTED",
      },
    };

    const result = derive({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: m1Status,
      fastMarkState: "LIVE",
    });

    expect(result.band).not.toBe("READY");
    expect(result.tradeExpected).toBe(false);
    expect(result.score).toBeLessThan(70);
    expect(result.headline).toMatch(/risk|blocked/i);
  });

  it("shows a waiting state while the authoritative market schedule is paused", () => {
    const status = JSON.parse(JSON.stringify(VALID_STATUS));
    status.marketSchedule.paused = true;
    status.marketSchedule.reason = "WEEKEND";

    expect(
      derive({
        automationOn: true,
        scannerStatus: status,
        fastMarkState: "LIVE",
      }),
    ).toMatchObject({
      band: "WAITING",
      tradeExpected: false,
      headline: "Market paused",
    });
  });

  it("shows AI stopped instead of implying a setup can execute", () => {
    expect(
      derive({
        automationOn: false,
        scannerStatus: VALID_STATUS,
        fastMarkState: "LIVE",
      }),
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
      trainedExpertLabel: "Shadow challenger · 3/3 SELL votes · 81%",
      m1TimingLabel: "M1 timing · Trend continuation",
      executable: true,
    });
  });

  it("explains the shadow broker-history gap without suggesting trade authority", () => {
    const unavailable = {
      ...status,
      latestDecision: {
        ...status.latestDecision,
        trainedExpertState: "UNAVAILABLE",
        trainedExpertReason: "BROKER_MARKET_DATA_UNAVAILABLE",
        trainedExpertDirection: null,
        trainedExpertConfidence: null,
        trainedExpertLongVotes: null,
        trainedExpertShortVotes: null,
        multimodelExecutable: false,
      },
    };
    expect(hasM1TacticalStatusUiShape(unavailable)).toBe(true);
    expect(deriveActiveModelUiState(unavailable)).toMatchObject({
      trainedExpertLabel: "Shadow challenger · waiting for broker MTF history",
      executable: false,
    });
    unavailable.latestDecision.trainedExpertReason = "UNVERIFIED_CAUSE".repeat(12);
    expect(hasM1TacticalStatusUiShape(unavailable)).toBe(false);
  });

  it("does not call a regime-rejected fallback a qualified trend-continuation route", () => {
    const rejected = {
      ...status,
      latestDecision: {
        ...status.latestDecision,
        planBRoute: "TREND_CONTINUATION",
        planBRegime: "TREND_WEAK",
        planBRegimeAllowed: false,
        planBPaperAdmitted: false,
        multimodelExecutable: false,
        executionAuthority: "NONE" as const,
        blockers: ["MULTIMODEL_PLAN_B_NOT_ADMITTED"],
      },
    };
    expect(deriveActiveModelUiState(rejected)).toMatchObject({
      planBLabel: "No qualified strategy route · Trend weak",
      executable: false,
    });
    const eligibleRegimeButRejected = {
      ...rejected,
      latestDecision: {
        ...rejected.latestDecision,
        planBRegime: "TREND_HEALTHY",
        planBRegimeAllowed: true,
      },
    };
    expect(deriveActiveModelUiState(eligibleRegimeButRejected)).toMatchObject({
      planBLabel: "Plan-B not admitted · Trend continuation",
      executable: false,
    });
    expect(deriveActiveModelUiState(status).planBLabel).toBe(
      "Trend continuation · 70%",
    );
  });

  it("labels research-only USDJPY before a model expectancy or shadow commission warning", () => {
    const research = {
      ...status,
      demoEntryInstruments: ["AUDUSD", "EURUSD", "GBPUSD"],
      researchOnlyInstruments: ["USDJPY", "USDCAD", "USDCHF"],
      latestDecision: {
        ...status.latestDecision,
        instrument: "USDJPY",
        direction: "BUY" as const,
        netExpectedR: -0.01,
        route: "M1_TREND_CONTINUATION",
        planBPaperAdmitted: false,
        multimodelExecutable: false,
        executionAuthority: "NONE" as const,
        primaryConfidence: 0.58,
        primaryBlockerGroup: "MODEL_EXPECTANCY",
        blockers: [
          "M1_DEMO_INSTRUMENT_RESEARCH_ONLY",
          "PAPER_NET_EXPECTED_R",
          "MULTIMODEL_PLAN_B_NOT_ADMITTED",
        ],
      },
    };
    expect(hasM1TacticalStatusUiShape(research)).toBe(true);
    const state = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: research,
      fastMarkState: "LIVE",
    });
    expect(state).toMatchObject({
      score: 58,
      band: "WAITING",
      headline: "Research-only pair — no DEMO entry",
      instrument: "USDJPY",
      direction: "BUY",
      tradeExpected: false,
    });
    expect(state.detail).toContain("AUDUSD, EURUSD, GBPUSD");
    expect(state.detail).toContain("-0.01R");
    expect(state.detail).toContain("shadow-only");
  });

  it("explains an M1 timing rejection without turning Plan-B admission into execution approval", () => {
    const waiting = {
      ...status,
      latestDecision: {
        ...status.latestDecision,
        route: "ABSTAIN",
        m1TimingRoute: "ABSTAIN",
        m1TimingReason: "HIGHER_TIMEFRAME_CONFLICT",
        planBRoute: "TREND_CONTINUATION",
        planBPaperAdmitted: true,
        multimodelExecutable: false,
        executionAuthority: "NONE" as const,
        blockers: ["MULTIMODEL_CONTINUATION_TIMING_NOT_READY"],
        primaryBlockerGroup: "ENTRY_TIMING",
      },
    };
    expect(deriveActiveModelUiState(waiting)).toMatchObject({
      m1TimingLabel: "M1 timing · Wait: Higher timeframe conflict",
      executable: false,
    });
    const readiness = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: waiting,
    });
    expect(readiness.tradeExpected).toBe(false);
    expect(readiness.band).not.toBe("READY");
    expect(readiness.detail).toMatch(/Plan-B admitted/i);
    expect(readiness.detail).toMatch(/Higher timeframe conflict/i);
    expect(readiness.headline).toBe("Plan-B admitted — M1 timing conflict");
  });

  it("does not label M1 continuation as reversal confirmation", () => {
    const mismatch = {
      ...status,
      latestDecision: {
        ...status.latestDecision,
        planBRoute: "CONFIRMED_REVERSAL",
        planBPaperAdmitted: true,
        m1TimingRoute: "M1_TREND_CONTINUATION",
        m1TimingReason: "TREND_STRUCTURE_ALIGNED",
        multimodelExecutable: false,
        executionAuthority: "NONE" as const,
        blockers: ["MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED"],
      },
    };
    expect(deriveActiveModelUiState(mismatch)).toMatchObject({
      m1TimingLabel: "M1 timing · Trend continuation (reversal not confirmed)",
      executable: false,
    });
    expect(deriveActiveModelUiState(status).m1TimingLabel).toBe(
      "M1 timing · Trend continuation",
    );
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
    expect(result.score).toBe(70);
    expect(result.detail).toMatch(/promoted PAPER champion/i);
    expect(result.detail).toMatch(/shadow/i);
  });

  it("identifies a qualified forecast-shadow DEMO entry without claiming original economic admission", () => {
    const rescued = JSON.parse(JSON.stringify(status));
    rescued.latestDecision.executionAuthority = "BROKER_NATIVE";
    rescued.latestDecision.blockers = [];
    rescued.latestDecision.outcomeState = null;
    rescued.latestDecision.planBPaperAdmitted = false;
    rescued.latestDecision.multimodelExecutable = true;
    rescued.latestDecision.multimodelAuthorityPath = "FORECAST_SHADOW_CONSENSUS";
    rescued.latestDecision.trainedExpertDirection = "SELL";
    rescued.latestDecision.trainedExpertShortVotes = 3;
    rescued.latestDecision.trainedExpertLongVotes = 0;
    const active = deriveActiveModelUiState(rescued);
    expect(active.planBLabel).toContain("predicted economics in shadow");
    expect(active.trainedExpertLabel).toContain("DEMO unanimous forecast-shadow authority");
    const view = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: rescued,
      fastMarkState: "LIVE",
    });
    expect(view.tradeExpected).toBe(true);
    expect(view.headline).toBe("Qualified DEMO consensus — forecasts shadow-only");
    expect(view.detail).toContain("0.20-lot DEMO");
    expect(view.detail).toContain("economic-news");
  });

  it("explains when DEMO readiness comes from the high-conviction rescue path", () => {
    const rescued = JSON.parse(JSON.stringify(status));
    rescued.latestDecision.executionAuthority = "BROKER_NATIVE";
    rescued.latestDecision.primaryConfidence = 0.714;
    rescued.latestDecision.planBPaperAdmitted = false;
    rescued.latestDecision.multimodelAuthorityPath = "HIGH_CONVICTION_RESCUE";
    rescued.latestDecision.multimodelRescueVolumeCap = 0.2;

    const result = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: rescued,
      fastMarkState: "LIVE",
    });

    expect(result.band).toBe("READY");
    expect(result.tradeExpected).toBe(true);
    expect(result.score).toBe(71);
    expect(result.detail).toMatch(/high-conviction/i);
    expect(result.detail).toMatch(/0\.20 lot/i);
    expect(deriveActiveModelUiState(rescued).trainedExpertLabel).toMatch(
      /High-conviction authority · 3\/3 SELL votes · 81%/i,
    );
  });

  it("explains the original Plan B model expectancy threshold without blaming shadow costs", () => {
    const blocked = JSON.parse(JSON.stringify(status));
    blocked.latestDecision.primaryConfidence = 0.7;
    blocked.latestDecision.multimodelExecutable = false;
    blocked.latestDecision.executionAuthority = "NONE";
    blocked.latestDecision.blockers = [
      "MULTIMODEL_PLAN_B_NOT_ADMITTED",
      "MULTIMODEL_GOVERNANCE_BLOCKED",
      "EXPECTED_R",
    ];
    blocked.latestDecision.primaryBlockerGroup = "MODEL_EXPECTANCY";
    blocked.latestDecision.primaryBlockerCode = "EXPECTED_R";
    const result = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: blocked,
      fastMarkState: "LIVE",
    });
    expect(result.tradeExpected).toBe(false);
    expect(result.band).not.toBe("READY");
    expect(result.headline).toBe(
      "Plan-B signal quality not met — trade blocked",
    );
    expect(result.detail).toMatch(/signal-quality admission/i);
    expect(result.detail).toMatch(/shadow research/i);
    expect(result.detail).not.toMatch(/after-cost checks may also reject/i);
  });

  it("shows historical commission impact without presenting it as trade permission", () => {
    const blocked = JSON.parse(JSON.stringify(status));
    blocked.latestDecision.executionAuthority = "NONE";
    blocked.latestDecision.multimodelExecutable = false;
    blocked.latestDecision.blockers = ["PAPER_NET_EXPECTED_R"];
    blocked.latestDecision.primaryBlockerGroup = "MODEL_EXPECTANCY";
    blocked.latestDecision.brokerCommissionResearchReason =
      "CAUSAL_FEE_EVIDENCE_READY";
    blocked.latestDecision.brokerCommissionSampleCount = 27;
    blocked.latestDecision.brokerCommissionP90CostR = 0.285;
    blocked.latestDecision.m1EstimatedNetAfterCommissionR = -0.115;
    blocked.latestDecision.planBEstimatedNetAfterCommissionR = 0.033;
    expect(hasM1TacticalStatusUiShape(blocked)).toBe(true);
    const result = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: blocked,
      fastMarkState: "LIVE",
    });
    expect(result.tradeExpected).toBe(false);
    expect(result.band).not.toBe("READY");
    expect(result.detail).not.toContain("historical p90 commission");
    expect(result.researchNote).toContain("Historical p90 commission/financing estimate: 0.28R");
    expect(result.researchNote).toContain("M1 estimated net after those fees: -0.12R");
    expect(result.researchNote).toContain("Plan-B after commission: 0.03R");
    expect(result.researchNote).toContain("NOT an active trading blocker or approval");
    blocked.latestDecision.brokerCommissionP90CostR = Number.POSITIVE_INFINITY;
    expect(hasM1TacticalStatusUiShape(blocked)).toBe(false);
  });

  it("identifies the screenshot's news restriction instead of inventing an account-risk or commission veto", () => {
    const blocked = JSON.parse(JSON.stringify(status));
    blocked.latestDecision.instrument = "AUDUSD";
    blocked.latestDecision.direction = "SELL";
    blocked.latestDecision.primaryConfidence = 0.69;
    blocked.latestDecision.multimodelExecutable = false;
    blocked.latestDecision.executionAuthority = "NONE";
    blocked.latestDecision.outcomeState = null;
    blocked.latestDecision.primaryBlockerGroup = "RISK_OR_ACCOUNT";
    blocked.latestDecision.primaryBlockerCode = "EVENT_RISK_HIGH_IMPACT_BLOCK";
    blocked.latestDecision.planBPaperAdmitted = false;
    blocked.latestDecision.blockers = [
      "MULTIMODEL_GOVERNANCE_BLOCKED",
      "EVENT_RISK_HIGH_IMPACT_BLOCK",
      "MULTIMODEL_PLAN_B_NOT_ADMITTED",
      "DRIFT_OUT_OF_DISTRIBUTION",
      "MULTIMODEL_CONTINUATION_TIMING_NOT_READY",
    ];
    blocked.latestDecision.brokerCommissionResearchReason = "CAUSAL_FEE_EVIDENCE_READY";
    blocked.latestDecision.brokerCommissionP90CostR = 0.13;
    blocked.latestDecision.m1EstimatedNetAfterCommissionR = 0.08;
    blocked.latestDecision.planBEstimatedNetAfterCommissionR = 0.21;
    const view = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: blocked,
      fastMarkState: "LIVE",
    });
    expect(view).toMatchObject({
      score: 69,
      band: "FORMING",
      headline: "High-impact news — new entries paused",
      instrument: "AUDUSD",
      direction: "SELL",
      tradeExpected: false,
    });
    expect(view.detail).toContain("high-impact economic event");
    expect(view.detail).not.toContain("commission");
    expect(view.detail).not.toContain("account-risk");
    expect(view.secondaryChecks).toEqual([
      "Plan B model has not admitted this setup",
      "Market outside the validated model range",
      "M1 entry timing is not confirmed",
    ]);
    expect(view.researchNote).toContain("0.13R");
    expect(view.researchNote).toContain("0.08R");
    expect(view.researchNote).toContain("0.21R");
    expect(view.researchNote).toContain("NOT an active trading blocker");
  });

  it("still reports a real account exposure veto when news is also active", () => {
    const blocked = JSON.parse(JSON.stringify(status));
    blocked.latestDecision.executionAuthority = "NONE";
    blocked.latestDecision.multimodelExecutable = false;
    blocked.latestDecision.primaryBlockerGroup = "RISK_OR_ACCOUNT";
    blocked.latestDecision.primaryBlockerCode = "ACCOUNT_RISK_EXPOSURE";
    blocked.latestDecision.blockers = [
      "ACCOUNT_RISK_EXPOSURE",
      "EVENT_RISK_HIGH_IMPACT_BLOCK",
    ];
    const view = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: blocked,
      fastMarkState: "LIVE",
    });
    expect(view.headline).toBe("Account safety limit — entry blocked");
    expect(view.secondaryChecks).toContain("High-impact economic-news restriction");
  });

  it("identifies the real no-trade chain when Plan B is not admitted and drift also fails", () => {
    const rejected = JSON.parse(JSON.stringify(status));
    rejected.latestDecision.primaryConfidence = 0.64;
    rejected.latestDecision.planBPaperAdmitted = false;
    rejected.latestDecision.planBRegime = "TREND_EXTENDED";
    rejected.latestDecision.planBRegimeAllowed = false;
    rejected.latestDecision.multimodelExecutable = false;
    rejected.latestDecision.blockers = [
      "MULTIMODEL_PLAN_B_NOT_ADMITTED",
      "ENSEMBLE_NOT_PAPER_ADMITTED",
      "MULTIMODEL_GOVERNANCE_BLOCKED",
      "DRIFT_OUT_OF_DISTRIBUTION",
    ];
    rejected.latestDecision.primaryBlockerGroup = "MODEL_DRIFT";
    rejected.latestDecision.modelDriftDiagnostics = ["extensionAtr:HARD_HIGH"];
    const result = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: rejected,
      fastMarkState: "LIVE",
    });
    expect(result).toMatchObject({
      score: 64,
      band: "FORMING",
      headline: "No qualified strategy route — trade blocked",
      tradeExpected: false,
    });
    expect(result.detail).toContain("Plan B has not admitted an entry");
    expect(result.detail).toContain("price extension versus ATR above the hard validation range");
    expect(deriveActiveModelUiState(rejected).planBLabel).toBe(
      "No qualified strategy route · Trend extended",
    );
  });

  it("explains a trend-extended SELL abstention as higher-timeframe opposition, not ordinary waiting", () => {
    const rejected = JSON.parse(JSON.stringify(status));
    rejected.latestDecision.instrument = "EURUSD";
    rejected.latestDecision.direction = "SELL";
    rejected.latestDecision.route = "ABSTAIN";
    rejected.latestDecision.m1TimingRoute = "ABSTAIN";
    rejected.latestDecision.m1TimingReason = "HIGHER_TIMEFRAME_CONFLICT";
    rejected.latestDecision.primaryConfidence = 0.64;
    rejected.latestDecision.planBRegime = "TREND_EXTENDED";
    rejected.latestDecision.planBRegimeAllowed = false;
    rejected.latestDecision.planBPaperAdmitted = false;
    rejected.latestDecision.executionAuthority = "NONE";
    rejected.latestDecision.multimodelExecutable = false;
    rejected.latestDecision.blockers = [
      "MULTIMODEL_PLAN_B_NOT_ADMITTED",
      "DRIFT_OUT_OF_DISTRIBUTION",
      "MULTIMODEL_CONTINUATION_TIMING_NOT_READY",
    ];
    rejected.latestDecision.modelDriftDiagnostics = [
      "emaSeparation:HARD_LOW",
      "mtfStrength:HARD_LOW",
    ];
    const view = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: rejected,
      fastMarkState: "LIVE",
    });
    expect(view.headline).toBe("No qualified strategy route — trade blocked");
    expect(view.score).toBe(64);
    expect(view.tradeExpected).toBe(false);
    expect(view.detail).toContain("extended trend");
    expect(view.detail).toContain("proposed SELL also conflicts with the higher-timeframe trend");
    expect(view.secondaryChecks).toContain("Higher-timeframe trend conflicts with proposed SELL");
    expect(view.detail).toContain("shadow-only research");
    expect(view.detail).not.toContain("entry timing is not confirmed");
  });

  it("reports that aligned M1 BUY timing does not qualify an extended Plan-B regime", () => {
    const rejected = JSON.parse(JSON.stringify(status));
    rejected.latestDecision.instrument = "EURUSD";
    rejected.latestDecision.direction = "BUY";
    rejected.latestDecision.route = "M1_TREND_CONTINUATION";
    rejected.latestDecision.m1TimingRoute = "M1_TREND_CONTINUATION";
    rejected.latestDecision.m1TimingReason = "TREND_STRUCTURE_ALIGNED";
    rejected.latestDecision.planBRegime = "TREND_EXTENDED";
    rejected.latestDecision.planBRegimeAllowed = false;
    rejected.latestDecision.planBPaperAdmitted = false;
    rejected.latestDecision.executionAuthority = "NONE";
    rejected.latestDecision.multimodelExecutable = false;
    rejected.latestDecision.blockers = ["MULTIMODEL_PLAN_B_NOT_ADMITTED"];
    const view = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: rejected,
      fastMarkState: "LIVE",
    });
    expect(view.tradeExpected).toBe(false);
    expect(view.headline).toBe("No qualified strategy route — trade blocked");
    expect(view.detail).toContain("M1 BUY entry timing is aligned");
    expect(view.detail).toContain("extended trend");
    expect(view.secondaryChecks ?? []).not.toContain("M1 entry timing is not confirmed");
  });

  it("labels Sunday rollover as unqualified rather than claiming shadow costs can block execution", () => {
    const rejected = JSON.parse(JSON.stringify(status));
    rejected.latestDecision.instrument = "GBPUSD";
    rejected.latestDecision.direction = "BUY";
    rejected.latestDecision.planBRegime = "ROLLOVER_RISK";
    rejected.latestDecision.planBRegimeAllowed = false;
    rejected.latestDecision.planBPaperAdmitted = false;
    rejected.latestDecision.multimodelExecutable = false;
    rejected.latestDecision.executionAuthority = "NONE";
    rejected.latestDecision.primaryBlockerGroup = "MODEL_DRIFT";
    rejected.latestDecision.blockers = [
      "MULTIMODEL_PLAN_B_NOT_ADMITTED",
      "MULTIMODEL_GOVERNANCE_BLOCKED",
      "DRIFT_OUT_OF_DISTRIBUTION",
    ];
    const view = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: rejected,
      fastMarkState: "LIVE",
    });
    expect(view.headline).toBe("No qualified strategy route — trade blocked");
    expect(view.detail).toContain("rollover market");
    expect(view.detail).toContain("shadow-only research");
    expect(view.detail).not.toContain("after-cost checks may also reject");
    expect(view.tradeExpected).toBe(false);
  });

  it("does not present a core Plan-B expectancy failure as a commission veto", () => {
    const rejected = JSON.parse(JSON.stringify(status));
    rejected.latestDecision.planBPaperAdmitted = false;
    rejected.latestDecision.multimodelExecutable = false;
    rejected.latestDecision.executionAuthority = "NONE";
    rejected.latestDecision.primaryBlockerGroup = "MODEL_EXPECTANCY";
    rejected.latestDecision.blockers = ["MULTIMODEL_PLAN_B_NOT_ADMITTED"];
    const view = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: rejected,
      fastMarkState: "LIVE",
    });
    expect(view.headline).toBe("Plan-B signal quality not met — trade blocked");
    expect(view.detail).toContain("signal-quality admission");
    expect(view.detail).toContain("shadow research");
  });

  it("keeps drift-blocked multi-model readiness moving instead of pinning every setup at 49", () => {
    const weaker = JSON.parse(JSON.stringify(status));
    weaker.latestDecision.primaryConfidence = 0.55;
    weaker.latestDecision.multimodelExecutable = false;
    weaker.latestDecision.blockers = ["DRIFT_OUT_OF_DISTRIBUTION"];
    weaker.latestDecision.modelDriftState = "OUT_OF_DISTRIBUTION";
    weaker.latestDecision.modelDriftDiagnostics = [
      "confidence:HARD_HIGH",
      "extensionAtr:STRESSED_LOW",
    ];

    const stronger = JSON.parse(JSON.stringify(status));
    stronger.latestDecision.primaryConfidence = 0.85;
    stronger.latestDecision.multimodelExecutable = false;
    stronger.latestDecision.blockers = ["DRIFT_OUT_OF_DISTRIBUTION"];

    const weakerResult = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: weaker,
      fastMarkState: "LIVE",
    });
    const strongerResult = deriveTradeReadinessUiState({
      automationOn: true,
      scannerStatus: VALID_STATUS,
      m1TacticalStatus: stronger,
      fastMarkState: "LIVE",
    });

    expect(weakerResult).toMatchObject({
      score: 55,
      band: "FORMING",
      tradeExpected: false,
    });
    expect(strongerResult).toMatchObject({
      score: 69,
      band: "FORMING",
      tradeExpected: false,
    });
    expect(weakerResult.headline).toMatch(/execution blocked/i);
    expect(weakerResult.detail).toMatch(/drift.*blocked|blocked.*drift/i);
    expect(weakerResult.detail).toContain(
      "model confidence above the hard validation range",
    );
    expect(weakerResult.detail).toContain(
      "price extension versus ATR below the usual validation range",
    );
    expect(weakerResult.tradeExpected).toBe(false);
    expect(strongerResult.score).toBeGreaterThan(weakerResult.score);
  });
});
