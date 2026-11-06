import {
  attributeZaiDemoBlockers,
  classifyZaiBlocker,
  diagnoseZaiDemoCostGeometry,
} from './zai-demo-diagnostics';
import type { M1TacticalCandidate } from './m1-tactical-candidate';
import type { M1TacticalFeatureSnapshot } from './m1-tactical-features';
import type { EnsembleGovernanceDecision } from './ensemble-governance';

const input = () => ({
  candidate: {
    instrument: 'EURUSD',
    direction: 'BUY',
    entry: 1.12,
    stopLoss: 1.1195,
    takeProfit: 1.1208,
    stopDistance: 0.0005,
    grossExpectedR: 1.6,
    alignedM5: 0.6,
    alignedM15: 0.5,
    alignedH1: 0.4,
    alignedH4: 0.3,
  } as M1TacticalCandidate,
  features: { m5Atr14: 0.0009 } as M1TacticalFeatureSnapshot,
  route: 'M1_TREND_CONTINUATION' as const,
  governance: {
    estimatedExecutionCostR: 0.25,
    effectiveSpreadPrice: 0.0001,
    executionSpreadEvidenceValid: true,
    executionCostSource: 'BROKER_OBSERVED_P90',
  } as EnsembleGovernanceDecision,
});

describe('z.ai DEMO diagnostic telemetry (never changes execution)', () => {
  it('shows the economic cause instead of duplicated admission wrappers', () => {
    const blockers = [
      'MULTIMODEL_GOVERNANCE_BLOCKED',
      'ENSEMBLE_NOT_PAPER_ADMITTED',
      'MULTIMODEL_PLAN_B_NOT_ADMITTED',
      'PAPER_NET_EXPECTED_R',
      'DRIFT_OUT_OF_DISTRIBUTION',
      'MULTIMODEL_CONTINUATION_TIMING_NOT_READY',
      'PAPER_NET_EXPECTED_R',
    ];
    const result = attributeZaiDemoBlockers(blockers);
    expect(result.primaryGroup).toBe('MODEL_EXPECTANCY');
    expect(result.rawBlockerCount).toBe(6);
    expect(result.wrapperCount).toBe(3);
    expect(result.modifiesExecution).toBe(false);
    expect(blockers).toHaveLength(7);
  });

  it('separates actual market, account, and timing blockers', () => {
    expect(classifyZaiBlocker('BROKER_M1_STALE')).toBe('MARKET_DATA');
    expect(classifyZaiBlocker('M1_MULTIMODEL_LOSS_STREAK_BRAKE')).toBe('RELIABILITY');
    expect(classifyZaiBlocker('M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK')).toBe('RELIABILITY');
    expect(classifyZaiBlocker('ACCOUNT_RISK_EXPOSURE')).toBe('RISK_OR_ACCOUNT');
    expect(classifyZaiBlocker('EVENT_RISK_HIGH_IMPACT_BLOCK')).toBe('NEWS_EVENT');
    expect(classifyZaiBlocker('MULTIMODEL_REVERSAL_NOT_M1_CONFIRMED')).toBe('ENTRY_TIMING');
  });

  it('does not mislabel news-calendar safety as an account-risk restriction', () => {
    const reasons = attributeZaiDemoBlockers([
      'MULTIMODEL_PLAN_B_NOT_ADMITTED',
      'EVENT_RISK_HIGH_IMPACT_BLOCK',
      'DRIFT_OUT_OF_DISTRIBUTION',
    ]);
    expect(reasons.primaryGroup).toBe('NEWS_EVENT');
    expect(reasons.primaryCode).toBe('EVENT_RISK_HIGH_IMPACT_BLOCK');
    expect(reasons.groups.some((reason) => reason.group === 'RISK_OR_ACCOUNT')).toBe(false);
    expect(reasons.modifiesExecution).toBe(false);
  });

  it('does not let route-specific loss streak hide genuinely negative after-cost expectancy', () => {
    const blockers = [
      'M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK',
      'MULTIMODEL_PLAN_B_NOT_ADMITTED',
      'PAPER_NET_EXPECTED_R',
      'DRIFT_OUT_OF_DISTRIBUTION',
      'MULTIMODEL_CONTINUATION_TIMING_NOT_READY',
    ];
    const attribution = attributeZaiDemoBlockers(blockers);
    expect(attribution.primaryGroup).toBe('MODEL_EXPECTANCY');
    expect(attribution.primaryCode).toBe('PAPER_NET_EXPECTED_R');
    expect(attribution.groups.some((group) => group.group === 'RISK_OR_ACCOUNT')).toBe(false);
    expect(attribution.groups.some((group) => group.group === 'RELIABILITY')).toBe(true);
    expect(attribution.modifiesExecution).toBe(false);
  });

  it('uses completed M5 ATR and broker P90, never exceeds a 0.10R estimated spread cost', () => {
    const result = diagnoseZaiDemoCostGeometry(input());
    expect(result.strongHigherTimeframeContinuation).toBe(true);
    expect(result.hypotheticalStopPrice).toBeCloseTo(0.00135);
    expect(result.hypotheticalCostR).toBeLessThanOrEqual(0.1);
    expect(result.hypotheticalTargetPrice).toBeCloseTo(1.12216);
    expect(result.modifiesExecution).toBe(false);
    expect(result.canPromote).toBe(false);
  });

  it('does not offer geometry without broker spread evidence', () => {
    const source = input();
    source.governance = {
      ...source.governance,
      executionSpreadEvidenceValid: false,
      executionCostSource: 'PAPER_SIMULATION_SPREAD',
    };
    const result = diagnoseZaiDemoCostGeometry(source);
    expect(result.evidenceValid).toBe(false);
    expect(result.hypotheticalStopPrice).toBeNull();
    expect(result.hypotheticalCostR).toBeNull();
  });

  it('does not offer M5 geometry for countertrend or missing true M5 ATR', () => {
    const source = input();
    source.candidate.alignedH4 = -0.3;
    expect(diagnoseZaiDemoCostGeometry(source).hypotheticalStopPrice).toBeNull();
    source.candidate.alignedH4 = 0.3;
    source.features.m5Atr14 = undefined;
    expect(diagnoseZaiDemoCostGeometry(source).hypotheticalStopPrice).toBeNull();
  });

  it('handles neutral decisions without inventing an admission blocker', () => {
    expect(attributeZaiDemoBlockers([])).toMatchObject({
      rawBlockerCount: 0,
      primaryGroup: null,
      primaryCode: null,
      modifiesExecution: false,
    });
  });
});
