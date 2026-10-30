import { ExactDecimal } from '../../../common/utils/exact-decimal';
import type { BrokerInstrument } from '../../broker/interfaces/broker-adapter.interface';
import { BrokerService } from '../../broker/broker.service';
import { RiskProfile } from '../../risk/entities/risk-profile.entity';
import { RiskOrderGeometryService } from '../../risk/risk-order-geometry.service';
import { PositionSizingService } from './position-sizing.service';

const USER = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';

const EURUSD_SPEC: BrokerInstrument = {
  symbol: 'EURUSD',
  description: 'Euro vs US Dollar',
  digits: 5,
  minLot: '0.01',
  maxLot: '10.00',
  lotStep: '0.01',
  contractSize: '100000',
};

describe('PositionSizingService — allocation-aware PAPER sizing', () => {
  const makeService = (
    profileOverrides: Partial<RiskProfile> = {},
    freshQuote = '1.08500',
    accountEquity = '10000.00',
  ) => {
    const brokerService = {
      findConnectionById: jest.fn().mockResolvedValue({ accountType: 'DEMO' }),
      getBrokerAccountState: jest.fn().mockResolvedValue({
        balance: accountEquity,
        equity: accountEquity,
        freeMargin: accountEquity,
        currency: 'USD',
      }),
      getRequiredMargin: jest.fn().mockResolvedValue('200.00'),
    };
    const orderGeometry = {
      resolveOrderGeometry: jest.fn().mockResolvedValue({
        contractSize: ExactDecimal.parse('100000'),
        freshQuote: ExactDecimal.parse(freshQuote),
        quoteRef: { source: 'M1' },
        instrumentSpec: EURUSD_SPEC,
      }),
    };
    const profileRepo = {
      findOne: jest.fn().mockResolvedValue({
        userId: USER,
        maxTradeRiskPercent: '2.00',
        maxDrawdownPercent: '10.00',
        maxPositionSizeLot: '0.1000',
        maxLeverageAllowed: 30,
        ...profileOverrides,
      } as RiskProfile),
    };

    return new PositionSizingService(
      brokerService as unknown as BrokerService,
      orderGeometry as unknown as RiskOrderGeometryService,
      profileRepo as never,
    );
  };

  const params = {
    userId: USER,
    brokerConnectionId: CONN,
    instrument: 'EURUSD',
    direction: 'BUY' as const,
    entryType: 'MARKET' as const,
    requestedEntryPrice: null,
    stopLoss: '1.08400',
    requestedLotUpperBound: '1.0',
  };

  it('sizes from the explicit PAPER allocation instead of fixed AI/profile lot ceilings', async () => {
    const service = makeService();

    const sized = await service.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'BASE',
      },
    });

    // $1,000 allocation × 2% = $20 risk. A 0.001 EURUSD stop risks $100
    // per 1.00 lot, therefore the stop-distance sizing result is 0.20 lot.
    expect(sized.lots).toBe('0.2');
    expect(sized.inputs.riskAmount).toBe('20');
    expect(sized.inputs.riskPercent).toBe('2');
    expect(sized.inputs.riskCapitalBase).toBe('1000');
    expect(sized.inputs.allocationAwarePaper).toBe(true);
    expect(sized.inputs.requestedLotUpperBound).toBe('1');
    expect(sized.inputs.profileMaxPositionSizeLot).toBe('0.1');
  });

  it('never exceeds the durable profile risk percent even when the PAPER tier requests 2.5%', async () => {
    const service = makeService();

    const sized = await service.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'VERY_STRONG',
      },
    });

    expect(sized.lots).toBe('0.2');
    expect(sized.inputs.riskPercent).toBe('2');
    expect(sized.inputs.requestedRiskPercent).toBe('2.5');
  });

  it('allows a 2.5% PAPER tier only when the durable profile permits it', async () => {
    const service = makeService({ maxTradeRiskPercent: '3.00' });

    const sized = await service.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'VERY_STRONG',
      },
    });

    expect(sized.lots).toBe('0.25');
    expect(sized.inputs.riskAmount).toBe('25');
    expect(sized.inputs.riskPercent).toBe('2.5');
  });

  it('risk-sizes RESEARCH PAPER instead of collapsing it to the old 0.01-lot ceiling', async () => {
    const service = makeService();

    const sized = await service.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'RESEARCH',
      },
    });

    // $1,000 × 1% produces a 0.10-lot soft budget, but allocation-aware PAPER
    // has a product minimum of 0.20 lots. The 0.20 stop risk is exactly the
    // durable 2% profile ceiling, so the engine lifts to the product floor.
    expect(sized.lots).toBe('0.2');
    expect(sized.inputs.riskAmount).toBe('10');
    expect(sized.inputs.riskPercent).toBe('1');
    expect(sized.inputs.requestedLotUpperBound).toBe('1');
    expect(sized.inputs.allocationAwarePaper).toBe(true);
  });

  it('can reach 1.0 lot when the allocation and stop-distance risk budget justify it', async () => {
    const service = makeService();

    const sized = await service.sizePosition({
      ...params,
      requestedLotUpperBound: '1.0',
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '10000.00',
        confidenceTier: 'RESEARCH',
      },
    });

    expect(sized.inputs.riskAmount).toBe('100');
    expect(sized.inputs.riskPercent).toBe('1');
    expect(sized.inputs.lotsByRiskBudget).toBe('1');
    expect(sized.lots).toBe('1');
  });

  it('sizes PAPER MARKET risk from the model stop distance when the executable quote moved toward the stop', async () => {
    const service = makeService({}, '1.10010');

    const sized = await service.sizePosition({
      ...params,
      direction: 'SELL',
      stopLoss: '1.10051',
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'BASE',
        marketReferenceEntryPrice: '1.10000',
      } as never,
    });

    // The model intended 5.1 pips of stop risk ($51 per standard lot). The
    // fresh SELL quote moved one pip toward that absolute stop, but sizing
    // must preserve the intended risk geometry: $20 / $51 = 0.392... -> 0.39.
    expect(sized.lots).toBe('0.39');
    expect((sized.inputs as unknown as Record<string, unknown>).riskReferenceEntryPrice).toBe(
      '1.1',
    );
    expect(sized.inputs.stopLossDistance).toBe('0.00051');
  });

  it('applies a 0.50x adaptive multiplier to the PAPER risk budget before lot sizing', async () => {
    const service = makeService();

    const sized = await service.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'BASE',
        adaptiveRiskMultiplier: '0.50',
      },
    });

    expect(sized.inputs.baseRiskPercent).toBe('2');
    expect(sized.inputs.adaptiveRiskMultiplier).toBe('0.5');
    expect(sized.inputs.adaptiveRiskPercent).toBe('1');
    expect(sized.inputs.baseRiskAmount).toBe('20');
    expect(sized.inputs.riskAmount).toBe('10');
    expect(sized.lots).toBe('0.2');
  });

  it.each([
    ['below first band', '9800.00', '1', '2', '0.2'],
    ['at 25% of allowed drawdown', '9750.00', '0.75', '1.5', '0.2'],
    ['at 50% of allowed drawdown', '9500.00', '0.5', '1', '0.2'],
    ['at 75% of allowed drawdown', '9250.00', '0.25', '0.5', '0.2'],
  ])(
    'softly de-risks PAPER sizing %s',
    async (_label, accountEquity, expectedMultiplier, expectedRiskPercent, expectedLots) => {
      const service = makeService({}, '1.08500', accountEquity);

      const sized = await service.sizePosition({
        ...params,
        paperAllocationSizing: {
          executionMode: 'PAPER_ONLY',
          allocatedCapital: '1000.00',
          confidenceTier: 'BASE',
          sessionPeakEquity: '10000.00',
        } as never,
      });

      expect((sized.inputs as unknown as Record<string, unknown>).drawdownRiskMultiplier).toBe(
        expectedMultiplier,
      );
      expect((sized.inputs as unknown as Record<string, unknown>).currentDrawdownPercent).toBe(
        accountEquity === '9800.00'
          ? '2'
          : accountEquity === '9750.00'
            ? '2.5'
            : accountEquity === '9500.00'
              ? '5'
              : '7.5',
      );
      expect(sized.inputs.riskPercent).toBe(expectedRiskPercent);
      expect(sized.lots).toBe(expectedLots);
    },
  );

  it('never penalizes a new equity high with the soft drawdown multiplier', async () => {
    const service = makeService({}, '1.08500', '10050.00');

    const sized = await service.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'BASE',
        sessionPeakEquity: '10000.00',
      } as never,
    });

    expect((sized.inputs as unknown as Record<string, unknown>).drawdownRiskMultiplier).toBe('1');
    expect((sized.inputs as unknown as Record<string, unknown>).currentDrawdownPercent).toBe('0');
    expect(sized.inputs.riskPercent).toBe('2');
    expect(sized.lots).toBe('0.2');
  });

  it('lifts AUDUSD-like 5.1-pip research geometry to the 0.20 PAPER product floor inside the durable risk ceiling', async () => {
    const service = makeService({}, '0.69576');

    const sized = await service.sizePosition({
      ...params,
      instrument: 'AUDUSD',
      direction: 'SELL',
      stopLoss: '0.69627',
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'RESEARCH',
        adaptiveRiskMultiplier: '0.75',
        minimumExecutableLot: '0.20',
        marketReferenceEntryPrice: '0.69576',
      },
    });

    expect(sized.inputs.baseRiskAmount).toBe('10');
    expect(sized.inputs.riskAmount).toBe('7.5');
    expect(sized.inputs.stopLossDistance).toBe('0.00051');
    expect(sized.lots).toBe('0.2');
    expect(sized.inputs.policyMinimumExecutableLot).toBe('0.2');
  });

  it('allows 1.25x only inside the durable profile risk ceiling', async () => {
    const permissive = makeService({ maxTradeRiskPercent: '3.00' });
    const sized = await permissive.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'BASE',
        adaptiveRiskMultiplier: '1.25',
      },
    });
    expect(sized.inputs.baseRiskPercent).toBe('2');
    expect(sized.inputs.adaptiveRiskPercent).toBe('2.5');
    expect(sized.inputs.combinedRiskMultiplier).toBe('1.25');
    expect(sized.inputs.baseRiskAmount).toBe('20');
    expect(sized.inputs.riskAmount).toBe('25');
    expect(sized.lots).toBe('0.25');

    const capped = makeService({ maxTradeRiskPercent: '2.00' });
    const cappedSized = await capped.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'BASE',
        adaptiveRiskMultiplier: '1.25',
      },
    });
    expect(cappedSized.inputs.adaptiveRiskPercent).toBe('2');
    expect(cappedSized.inputs.combinedRiskMultiplier).toBe('1');
    expect(cappedSized.inputs.riskAmount).toBe('20');
  });

  it('caps promoted allocation-aware execution at the 4.00-lot product maximum even when capital and the caller request more', async () => {
    const service = makeService({ maxTradeRiskPercent: '3.00' }, '1.08500', '100000.00');

    const sized = await service.sizePosition({
      ...params,
      requestedLotUpperBound: '9.99',
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '100000.00',
        confidenceTier: 'VERY_STRONG',
      },
    });

    expect(sized.inputs.lotsByRiskBudget).toBe('25');
    expect(sized.lots).toBe('4');
  });

  it.each([
    ['0.50', '2500.00', '0.5'],
    ['1.00', '5000.00', '1'],
    ['2.00', '10000.00', '2'],
    ['3.00', '15000.00', '3'],
    ['4.00', '20000.00', '4'],
  ])(
    'permits %s lots when stop-risk, allocation, broker limits and margin justify it',
    async (_label, capital, expectedLots) => {
      const service = makeService({}, '1.08500', capital);
      const sized = await service.sizePosition({
        ...params,
        requestedLotUpperBound: '4.00',
        paperAllocationSizing: {
          executionMode: 'PAPER_ONLY',
          allocatedCapital: capital,
          confidenceTier: 'BASE',
        },
      });
      expect(sized.lots).toBe(expectedLots);
      expect(Number(sized.inputs.finalRiskAtStopPercentOfCapital)).toBeLessThanOrEqual(2);
    },
  );

  it('applies professional allocation-aware sizing to validated DEMO execution instead of legacy micro caps', async () => {
    const service = makeService({ maxTradeRiskPercent: '3.00' });

    const sized = await service.sizePosition({
      ...params,
      requestedLotUpperBound: '4.00',
      paperAllocationSizing: {
        executionMode: 'FULL_AUTO',
        allocatedCapital: '1000.00',
        confidenceTier: 'VERY_STRONG',
      },
    });

    expect(sized.lots).toBe('0.25');
    expect(sized.inputs.allocationAwarePaper).toBe(true);
    expect(sized.inputs.policyMinimumExecutableLot).toBe('0.2');
  });

  it('lifts a PAPER RESEARCH soft budget to the 0.20 product floor when the durable 2% risk ceiling can afford it', async () => {
    const service = makeService();

    const sized = await service.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'RESEARCH',
        minimumExecutableLot: '0.20',
      },
    });

    // RESEARCH asks for 1% ($10), which would normally size 0.10 lot.
    // The product floor is 0.20 lot, whose $20 stop risk is exactly the
    // durable 2% profile ceiling, so PAPER may lift to the floor.
    expect(sized.inputs.lotsByRiskBudget).toBe('0.1');
    expect(sized.inputs.policyMinimumExecutableLot).toBe('0.2');
    expect(sized.lots).toBe('0.2');
  });

  it('steps below the preferred 0.20 professional size when the durable 2% ceiling safely supports at least 0.10 lot', async () => {
    const service = makeService();

    const sized = await service.sizePosition({
      ...params,
      requestedLotUpperBound: '0.20',
      paperAllocationSizing: {
        executionMode: 'FULL_AUTO',
        allocatedCapital: '900.00',
        confidenceTier: 'VERY_STRONG',
        minimumExecutableLot: '0.20',
      },
    });

    // VERY_STRONG requests 2.5%, but the durable profile caps the trade at 2%.
    // €/$900-equivalent risk capital with this 10-pip stop therefore supports
    // 0.18 lot: below the preferred 0.20 size, but still a meaningful trade.
    expect(sized.inputs.riskPercent).toBe('2');
    expect(sized.inputs.lotsByRiskBudget).toBe('0.18');
    expect(sized.inputs.policyMinimumExecutableLot).toBe('0.2');
    expect(sized.inputs.policyMinimumLotLifted).toBe(false);
    expect(sized.lots).toBe('0.18');
  });

  it('rejects the 0.10 scout floor when its actual stop risk would exceed the durable risk ceiling', async () => {
    const service = makeService();

    await expect(
      service.sizePosition({
        ...params,
        paperAllocationSizing: {
          executionMode: 'PAPER_ONLY',
          allocatedCapital: '400.00',
          confidenceTier: 'RESEARCH',
          minimumExecutableLot: '0.10',
        },
      }),
    ).rejects.toMatchObject({ code: 'POSITION_SIZE_BELOW_POLICY_MINIMUM' });
  });

  it('refuses a promoted 0.10 scout cap instead of dispatching below the 0.20 professional floor', async () => {
    const service = makeService();
    await expect(
      service.sizePosition({
        ...params,
        requestedLotUpperBound: '0.10',
        paperAllocationSizing: {
          executionMode: 'PAPER_ONLY',
          allocatedCapital: '1000.00',
          confidenceTier: 'RESEARCH',
          minimumExecutableLot: '0.10',
        },
      }),
    ).rejects.toMatchObject({ code: 'POSITION_SIZE_BELOW_POLICY_MINIMUM' });
  });

  it('refuses a promoted 0.05 provisional scout cap instead of dispatching a micro lot', async () => {
    const service = makeService();
    await expect(
      service.sizePosition({
        ...params,
        requestedLotUpperBound: '0.05',
        paperAllocationSizing: {
          executionMode: 'PAPER_ONLY',
          allocatedCapital: '1000.00',
          confidenceTier: 'RESEARCH',
          minimumExecutableLot: '0.05',
        },
      }),
    ).rejects.toMatchObject({ code: 'POSITION_SIZE_BELOW_POLICY_MINIMUM' });
  });

  it('fails closed instead of rounding a caller lot cap upward to a PAPER floor', async () => {
    const service = makeService();

    await expect(
      service.sizePosition({
        ...params,
        requestedLotUpperBound: '0.01',
        paperAllocationSizing: {
          executionMode: 'PAPER_ONLY',
          allocatedCapital: '1000.00',
          confidenceTier: 'RESEARCH',
          minimumExecutableLot: '0.05',
        },
      }),
    ).rejects.toMatchObject({ code: 'POSITION_SIZE_BELOW_POLICY_MINIMUM' });
  });

  it('enforces the same 0.20 professional floor for DEMO and refuses a micro caller cap', async () => {
    const service = makeService({ maxTradeRiskPercent: '3.00' });
    await expect(
      service.sizePosition({
        ...params,
        requestedLotUpperBound: '0.10',
        paperAllocationSizing: {
          executionMode: 'FULL_AUTO',
          allocatedCapital: '1000.00',
          confidenceTier: 'VERY_STRONG',
          minimumExecutableLot: '0.10',
        },
      }),
    ).rejects.toMatchObject({ code: 'POSITION_SIZE_BELOW_POLICY_MINIMUM' });
  });
});
