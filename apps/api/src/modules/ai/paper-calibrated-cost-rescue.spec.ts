import { evaluatePaperCalibratedCostResearchRescue } from './paper-calibrated-cost-rescue';
import type { PaperResearchThroughputInput } from './paper-research-throughput';
import type { PaperSpreadCalibrationDecision } from './paper-spread-calibration-shadow';

const researchInput = (
  overrides: Partial<PaperResearchThroughputInput> = {},
): PaperResearchThroughputInput => ({
  normalPaperExecution: false,
  confidence: 0.68,
  netExpectedR: -0.05,
  executionSpreadEvidenceValid: false,
  paperExecutionCostUsable: true,
  eventRisk: 'CLEAR',
  strategyRoute: 'TREND_CONTINUATION',
  driftState: 'NORMAL',
  driftDiagnostics: [],
  directionQuality: 0.4,
  alignedMomentumAtr: 0.2,
  tradeQuality: 0.55,
  exitQuality: 0.55,
  paperExecutionBlockers: [
    'ENSEMBLE_NOT_PAPER_ADMITTED',
    'ENSEMBLE_NOT_PROMOTABLE_ADMISSION',
    'PAPER_NET_EXPECTED_R',
  ],
  routeReliabilityDemoted: false,
  ...overrides,
});

const calibration = (
  overrides: Partial<PaperSpreadCalibrationDecision> = {},
): PaperSpreadCalibrationDecision => ({
  artifact: 'paper-spread-calibration-shadow-v1',
  instrument: 'EURUSD',
  session: 'LONDON',
  fixedSpreadPrice: 0.0001,
  calibratedSpreadPrice: 0.00004,
  minimumSpreadFloorPrice: 0.000025,
  sampleCount: 320,
  p95SpreadPrice: 0.00004,
  fixedCostR: 0.25,
  calibratedCostR: 0.1,
  costReductionR: 0.15,
  reason: 'CALIBRATED_P95_WITH_FLOOR',
  executionAuthority: 'NONE',
  modifiesExecution: false,
  qualificationEvidence: false,
  ...overrides,
});

describe('PAPER calibrated cost research rescue', () => {
  it('rescues a fixed-cost-negative setup when mature non-rollover calibrated economics clear 0.10R and all other research rules pass', () => {
    const decision = evaluatePaperCalibratedCostResearchRescue({
      grossExpectedR: 0.22,
      fixedNetExpectedR: -0.03,
      researchInput: researchInput(),
      calibration: calibration(),
      freshBrokerSpreadAvailable: false,
    });

    expect(decision).toMatchObject({
      eligible: true,
      reason: 'CALIBRATED_COST_RESEARCH_RESCUE',
      calibratedNetExpectedR: 0.12,
      executionAuthority: 'PAPER_ONLY_RESEARCH',
      qualificationEvidence: false,
      lotCap: 0.01,
    });
  });

  it('never rescues rollover even when calibrated economics appear positive', () => {
    const decision = evaluatePaperCalibratedCostResearchRescue({
      grossExpectedR: 0.3,
      fixedNetExpectedR: -0.02,
      researchInput: researchInput(),
      calibration: calibration({ session: 'ROLLOVER', calibratedCostR: 0.05, costReductionR: 0.2 }),
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('ROLLOVER_EXCLUDED');
  });

  it('does not rescue when the fixed model is not actually net-negative', () => {
    const decision = evaluatePaperCalibratedCostResearchRescue({
      grossExpectedR: 0.22,
      fixedNetExpectedR: 0.01,
      researchInput: researchInput({ netExpectedR: 0.01 }),
      calibration: calibration(),
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('FIXED_NET_NOT_NEGATIVE');
  });

  it('does not rescue when calibrated P95 cost is not lower than fixed cost', () => {
    const decision = evaluatePaperCalibratedCostResearchRescue({
      grossExpectedR: 0.4,
      fixedNetExpectedR: -0.02,
      researchInput: researchInput(),
      calibration: calibration({ calibratedCostR: 0.3, fixedCostR: 0.25, costReductionR: -0.05 }),
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('NO_CALIBRATED_COST_ADVANTAGE');
  });

  it('does not rescue when calibrated net edge is below the 0.10R safety margin', () => {
    const decision = evaluatePaperCalibratedCostResearchRescue({
      grossExpectedR: 0.18,
      fixedNetExpectedR: -0.07,
      researchInput: researchInput(),
      calibration: calibration({ calibratedCostR: 0.09, costReductionR: 0.16 }),
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('CALIBRATED_NET_EDGE_TOO_LOW');
  });

  it('preserves every non-cost research blocker and refuses rescue when underlying research quality is unsafe', () => {
    const decision = evaluatePaperCalibratedCostResearchRescue({
      grossExpectedR: 0.22,
      fixedNetExpectedR: -0.03,
      researchInput: researchInput({ eventRisk: 'BLOCKED' }),
      calibration: calibration(),
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('UNDERLYING_RESEARCH_NOT_ELIGIBLE');
    expect(decision.underlyingResearchReason).toBe('EVENT_RISK_NOT_CLEAR');
  });

  it('never substitutes historical calibration for a fresh broker-native execution spread', () => {
    const decision = evaluatePaperCalibratedCostResearchRescue({
      grossExpectedR: 0.22,
      fixedNetExpectedR: -0.03,
      researchInput: researchInput(),
      calibration: calibration(),
      freshBrokerSpreadAvailable: true,
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('FRESH_BROKER_SPREAD_AUTHORITATIVE');
  });

  it('requires mature calibrated broker evidence', () => {
    const decision = evaluatePaperCalibratedCostResearchRescue({
      grossExpectedR: 0.22,
      fixedNetExpectedR: -0.03,
      researchInput: researchInput(),
      calibration: calibration({ sampleCount: 99 }),
    });
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('CALIBRATION_EVIDENCE_IMMATURE');
  });
});
