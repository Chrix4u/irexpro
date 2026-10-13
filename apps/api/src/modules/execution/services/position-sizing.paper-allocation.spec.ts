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
  const makeService = (profileOverrides: Partial<RiskProfile> = {}) => {
    const brokerService = {
      getBrokerAccountState: jest.fn().mockResolvedValue({
        balance: '10000.00',
        equity: '10000.00',
        freeMargin: '9500.00',
        currency: 'USD',
      }),
      getRequiredMargin: jest.fn().mockResolvedValue('200.00'),
    };
    const orderGeometry = {
      resolveOrderGeometry: jest.fn().mockResolvedValue({
        contractSize: ExactDecimal.parse('100000'),
        freshQuote: ExactDecimal.parse('1.08500'),
        quoteRef: { source: 'M1' },
        instrumentSpec: EURUSD_SPEC,
      }),
    };
    const profileRepo = {
      findOne: jest.fn().mockResolvedValue({
        userId: USER,
        maxTradeRiskPercent: '2.00',
        maxPositionSizeLot: '0.1000',
        minStopLossPips: '5.00',
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
    requestedLotUpperBound: '0.01',
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
    expect(sized.inputs.requestedLotUpperBound).toBe('0.01');
    expect(sized.inputs.profileMaxPositionSizeLot).toBe('0.1');
  });

  it('re-anchors an undersized PAPER MARKET stop to the fresh executable quote before sizing', async () => {
    const service = makeService();

    const sized = await service.sizePosition({
      ...params,
      direction: 'SELL',
      // The model stop was 5.1 pips from its candle close, but the executable
      // broker bid has moved toward it; at sizing time this is only 4.1 pips.
      stopLoss: '1.08541',
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'BASE',
      },
    });

    // Keep the durable 5-pip risk floor intact. Re-anchor to 5.1 pips from
    // the fresh 1.08500 SELL entry, then recalculate $20 risk: 20 / $51 =
    // 0.392... lots, normalized DOWN to broker step 0.01 => 0.39.
    expect(sized.inputs.stopLoss).toBe('1.08551');
    expect(sized.inputs.stopLossDistance).toBe('0.00051');
    expect(sized.lots).toBe('0.39');
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

  it('replaces the research 0.01-lot choke point with a 1% allocation risk budget', async () => {
    const service = makeService();

    const sized = await service.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'PAPER_ONLY',
        allocatedCapital: '1000.00',
        confidenceTier: 'RESEARCH',
      },
    });

    // $1,000 × 1% = $10 risk; at $100 risk per full lot this is 0.10 lot.
    // The legacy signal still carries requestedLotUpperBound=0.01 for
    // provenance/fail-closed fallback, but it is not an active PAPER cap.
    expect(sized.lots).toBe('0.1');
    expect(sized.inputs.riskAmount).toBe('10');
    expect(sized.inputs.riskPercent).toBe('1');
    expect(sized.inputs.requestedLotUpperBound).toBe('0.01');
    expect(sized.inputs.allocationAwarePaper).toBe(true);
  });

  it('keeps legacy lot ceilings outside PAPER_ONLY', async () => {
    const service = makeService({ maxTradeRiskPercent: '3.00' });

    const sized = await service.sizePosition({
      ...params,
      paperAllocationSizing: {
        executionMode: 'DEMO',
        allocatedCapital: '1000.00',
        confidenceTier: 'VERY_STRONG',
      },
    });

    expect(sized.lots).toBe('0.01');
    expect(sized.inputs.allocationAwarePaper).toBe(false);
  });
});
