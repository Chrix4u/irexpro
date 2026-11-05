import { ExactDecimal } from '../../../common/utils/exact-decimal';
import { BrokerService } from '../../broker/broker.service';
import type { BrokerInstrument } from '../../broker/interfaces/broker-adapter.interface';
import { RiskOrderGeometryService } from '../../risk/risk-order-geometry.service';
import { RiskProfile } from '../../risk/entities/risk-profile.entity';
import { PositionSizingService } from './position-sizing.service';

const USER = '11111111-1111-4111-8111-111111111111';
const CONNECTION = '22222222-2222-4222-8222-222222222222';

const standardMicro: BrokerInstrument = {
  symbol: 'EURUSD',
  description: 'EUR/USD broker supports 0.001 lots',
  digits: 5,
  minLot: '0.001',
  maxLot: '100',
  lotStep: '0.001',
  contractSize: '100000',
};
const standardCent: BrokerInstrument = {
  ...standardMicro,
  description: 'Broker volume step is 0.01 lots',
  minLot: '0.01',
  lotStep: '0.01',
};
const smallerContract: BrokerInstrument = {
  ...standardCent,
  description: 'Small-contract EURUSD offered by broker',
  contractSize: '1000',
};

function fixture(options: {
  equity: string;
  instrument?: BrokerInstrument;
  freeMargin?: string;
  marginPerLot?: string;
  accountType?: 'DEMO' | 'LIVE';
  riskPercent?: string;
  leverage?: number;
}) {
  const instrument = options.instrument ?? standardMicro;
  const marginPerLot = ExactDecimal.parse(options.marginPerLot ?? '3600');
  const broker = {
    findConnectionById: jest.fn().mockResolvedValue({
      accountType: options.accountType ?? 'DEMO',
    }),
    getBrokerAccountState: jest.fn().mockResolvedValue({
      balance: options.equity,
      equity: options.equity,
      freeMargin: options.freeMargin ?? options.equity,
      currency: 'USD',
    }),
    getRequiredMargin: jest
      .fn()
      .mockImplementation(async (_brokerConnectionId: string, request: { lotSize: string }) =>
        ExactDecimal.parse(request.lotSize).mul(marginPerLot).toString(),
      ),
  };
  const geometry = {
    resolveOrderGeometry: jest.fn().mockResolvedValue({
      contractSize: ExactDecimal.parse(instrument.contractSize),
      freshQuote: ExactDecimal.parse('1.08500'),
      instrumentSpec: instrument,
      quoteRef: { source: 'M1' },
    }),
  };
  const profile = {
    findOne: jest.fn().mockResolvedValue({
      userId: USER,
      maxTradeRiskPercent: options.riskPercent ?? '2.00',
      maxDrawdownPercent: '10.00',
      maxPositionSizeLot: '1.0000',
      maxLeverageAllowed: options.leverage ?? 30,
    } as RiskProfile),
  };
  const service = new PositionSizingService(
    broker as unknown as BrokerService,
    geometry as unknown as RiskOrderGeometryService,
    profile as never,
  );
  const size = (allocatedCapital = options.equity, requestedLotUpperBound = '0.2') =>
    service.sizePosition({
      userId: USER,
      brokerConnectionId: CONNECTION,
      instrument: 'EURUSD',
      direction: 'BUY',
      entryType: 'MARKET',
      requestedEntryPrice: null,
      stopLoss: '1.08400',
      requestedLotUpperBound,
      paperAllocationSizing: {
        executionMode: 'FULL_AUTO',
        allocatedCapital,
        confidenceTier: 'BASE',
        minimumExecutableLot: '0.2',
      },
    });
  return { broker, size, service };
}

describe('broker-aware account dynamic lot size (DEMO only)', () => {
  it('supports a $5 DEMO account at 0.001 when the broker explicitly supports it', async () => {
    const { size, broker } = fixture({ equity: '5.00' });
    const result = await size();
    expect(result.lots).toBe('0.001');
    expect(result.inputs.finalRiskAtStop).toBe('0.1');
    expect(result.inputs.finalRiskAtStopPercentOfCapital).toBe('2');
    expect(result.inputs.microAccountMarginReservePercent).toBe('20');
    expect(result.inputs.lotSelectionReason).toBe('BROKER_RISK_SCALED_DOWN');
    expect(result.inputs.requiredMargin).toBe('3.6');
    expect(result.inputs.preferredLotTarget).toBe('0.2');
    expect(result.inputs.paperProductMinimumLot).toBe('0.001');
    expect(result.inputs.policyMinimumLotLifted).toBe(false);
    expect(broker.getRequiredMargin).toHaveBeenCalledWith(
      CONNECTION,
      expect.objectContaining({ lotSize: '0.001', instrument: 'EURUSD' }),
    );
  });

  it('supports a $10 account at 0.002 with strict 2% risk and broker margin evidence', async () => {
    const { size } = fixture({ equity: '10.00' });
    const result = await size();
    expect(result.lots).toBe('0.002');
    expect(result.inputs.finalRiskAtStop).toBe('0.2');
    expect(result.inputs.finalRiskAtStopPercentOfCapital).toBe('2');
    expect(result.inputs.requiredMargin).toBe('7.2');
    expect(result.inputs.microAccountMarginReservePercent).toBe('20');
    expect(result.inputs.finalEffectiveLeverage).toBe('21.7');
  });

  it('never invents a 0.001 lot if the connected broker has a 0.01 minimum', async () => {
    const { size, broker } = fixture({ equity: '10.00', instrument: standardCent });
    await expect(size()).rejects.toMatchObject({ code: 'POSITION_SIZE_BELOW_MINIMUM' });
    expect(broker.getRequiredMargin).not.toHaveBeenCalled();
  });

  it('can use a broker-supplied smaller FX contract size, without pretending it is a standard lot', async () => {
    const { size } = fixture({
      equity: '5.00',
      instrument: smallerContract,
      marginPerLot: '36',
    });
    const result = await size();
    expect(result.lots).toBe('0.1');
    expect(result.inputs.contractSize).toBe('1000');
    expect(result.inputs.finalRiskAtStop).toBe('0.1');
    expect(result.inputs.finalEffectiveLeverage).toBe('21.7');
    expect(result.inputs.lotSelectionReason).toBe('BROKER_RISK_SCALED_DOWN');
  });

  it('steps down below 0.10 on broker-required margin rather than losing a risk-eligible setup', async () => {
    const { size } = fixture({ equity: '1000.00', marginPerLot: '15000' });
    const result = await size();
    expect(result.lots).toBe('0.066');
    expect(result.inputs.requiredMargin).toBe('990');
    expect(result.inputs.finalRiskAtStop).toBe('6.6');
    expect(result.inputs.lotSelectionReason).toBe('BROKER_RISK_SCALED_DOWN');
  });

  it('still prefers at least 0.20 lot on an account that actually supports it', async () => {
    const { size } = fixture({ equity: '1000.00' });
    const result = await size();
    expect(result.lots).toBe('0.2');
    expect(result.inputs.lotSelectionReason).toBe('PREFERRED_LOT_ACHIEVED');
    expect(result.inputs.microAccountMarginReservePercent).toBeNull();
    expect(result.inputs.finalRiskAtStopPercentOfCapital).toBe('2');
  });

  it('refuses the broker minimum if remaining free margin cannot cover it with 20% headroom', async () => {
    const { size } = fixture({ equity: '5.00', freeMargin: '3.00' });
    await expect(size()).rejects.toMatchObject({
      code: 'BROKER_MINIMUM_MARGIN_UNAFFORDABLE',
    });
  });

  it('refuses even 0.001 when broker-required margin itself exceeds the micro-account buffer', async () => {
    const { size } = fixture({ equity: '5.00', marginPerLot: '4500' });
    await expect(size()).rejects.toMatchObject({
      code: 'BROKER_MINIMUM_MARGIN_UNAFFORDABLE',
    });
  });

  it('keeps LIVE volume ceiling policy unchanged even when PAPER metadata is supplied', async () => {
    const { size } = fixture({ equity: '1000.00', accountType: 'LIVE' });
    const result = await size();
    expect(result.lots).toBe('0.2');
    expect(result.inputs.allocationAwarePaper).toBe(false);
    expect(result.inputs.lotSelectionReason).toBe('STANDARD_RISK_SIZING');
    expect(result.inputs.microAccountMarginReservePercent).toBeNull();
  });
});
