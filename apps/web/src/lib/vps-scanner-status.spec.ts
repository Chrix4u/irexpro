import {
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
    netExpectedRFloor: 0.08,
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

  it("rejects a malformed nested market schedule", () => {
    expect(
      hasVpsScannerUiShape({
        ...VALID_STATUS,
        marketSchedule: {},
      }),
    ).toBe(false);
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
