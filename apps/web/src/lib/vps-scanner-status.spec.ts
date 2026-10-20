import {
  deriveFastMarkFeedUiState,
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
