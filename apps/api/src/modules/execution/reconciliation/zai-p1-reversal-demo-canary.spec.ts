import {
  evaluateZaiP1ReversalDemoPreflight,
  exactHalfLotSplit,
} from './zai-p1-reversal-demo-canary';

const input = {
  brokerId: 'ctrader',
  accountType: 'DEMO',
  strategyRoute: 'CONFIRMED_REVERSAL',
  confirmedFreshTrend: true,
  direction: 'BUY' as const,
  initialLot: '0.20',
  initialRiskPnl: 10,
  currentGrossPnl: 7,
  estimateRoundTripFee: 1.2,
  historicalFeeSamples: 8,
  entryPrice: 1.1,
  currentPrice: 1.1007,
  originalStopPrice: 1.099,
  originalTakeProfitPrice: 1.1015,
};

describe('z.ai P1 cTrader DEMO preflight with zero provider authority', () => {
  it('describes a candidate half-close and runner without sending any order', () => {
    expect(evaluateZaiP1ReversalDemoPreflight(input)).toMatchObject({
      mode: 'DEMO_RESEARCH_ONLY',
      researchEligible: true,
      reason: 'PARTIAL_EXECUTION_LIFECYCLE_UNCERTIFIED',
      partialCloseLots: '0.1000',
      runnerLots: '0.1000',
      runnerOriginalStopPreserved: true,
      runnerOriginalTakeProfitPreserved: true,
      estimatedCurrentNetR: 0.58,
      canSendPartialClose: false,
      canModifyOrder: false,
      modifiesExecution: false,
    });
  });
  it('rejects LIVE, unsupported brokers and unrelated strategy routes', () => {
    expect(evaluateZaiP1ReversalDemoPreflight({ ...input, accountType: 'LIVE' }).reason).toBe(
      'NOT_CTRADER_DEMO',
    );
    expect(evaluateZaiP1ReversalDemoPreflight({ ...input, brokerId: 'direct-mt5' }).reason).toBe(
      'NOT_CTRADER_DEMO',
    );
    expect(
      evaluateZaiP1ReversalDemoPreflight({ ...input, strategyRoute: 'TREND_CONTINUATION' }).reason,
    ).toBe('NOT_CONFIRMED_REVERSAL');
  });
  it('requires fresh trend support and validated historical costs', () => {
    expect(
      evaluateZaiP1ReversalDemoPreflight({ ...input, confirmedFreshTrend: false }).reason,
    ).toBe('TREND_RECHECK_FAILED');
    expect(evaluateZaiP1ReversalDemoPreflight({ ...input, historicalFeeSamples: 4 }).reason).toBe(
      'NO_VERIFIED_BROKER_FEE_ESTIMATE',
    );
    expect(
      evaluateZaiP1ReversalDemoPreflight({ ...input, estimateRoundTripFee: null }).reason,
    ).toBe('NO_VERIFIED_BROKER_FEE_ESTIMATE');
  });
  it('requires a positive after-fee result and valid directional price geometry', () => {
    expect(evaluateZaiP1ReversalDemoPreflight({ ...input, estimateRoundTripFee: 6.9 }).reason).toBe(
      'NOT_POSITIVE_AFTER_COST',
    );
    expect(
      evaluateZaiP1ReversalDemoPreflight({ ...input, originalTakeProfitPrice: 1.1001 }).reason,
    ).toBe('INVALID_ENTRY_OR_BARRIERS');
    expect(evaluateZaiP1ReversalDemoPreflight({ ...input, direction: 'SELL' }).reason).toBe(
      'INVALID_ENTRY_OR_BARRIERS',
    );
  });
  it.each(['0.02', '0.04', '0.20', '1', '2', '3'])('splits decimal-4 lot %s exactly', (lot) => {
    const result = exactHalfLotSplit(lot);
    expect(result).not.toBeNull();
    expect(Number(result!.half) * 2).toBeCloseTo(Number(lot));
  });
  it.each(['0.01', '0.03', '0.05', '-0.02', 'abc', '0.005', '0.02001'])(
    'rejects unsafe lot split %s',
    (lot) => {
      expect(exactHalfLotSplit(lot)).toBeNull();
    },
  );
});
