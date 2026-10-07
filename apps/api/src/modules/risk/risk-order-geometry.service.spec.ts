import { RiskOrderGeometryService } from './risk-order-geometry.service';
import { BrokerService } from '../broker/broker.service';
import type { BrokerInstrument } from '../broker/interfaces/broker-adapter.interface';

const SPEC: BrokerInstrument = {
  symbol: 'EURUSD',
  description: 'Euro / US Dollar',
  digits: 5,
  minLot: '0.01',
  maxLot: '100',
  lotStep: '0.01',
  contractSize: '100000',
};

describe('RiskOrderGeometryService — executable-side MARKET geometry', () => {
  let broker: {
    getCurrentPriceForConnection: jest.Mock;
    getInstrumentSpecForConnection: jest.Mock;
  };
  let service: RiskOrderGeometryService;

  beforeEach(() => {
    broker = {
      getCurrentPriceForConnection: jest.fn().mockResolvedValue({
        instrument: 'EURUSD',
        bid: '1.08490',
        ask: '1.08510',
        spread: '0.00020',
        timestamp: new Date('2026-10-06T17:05:00.000Z'),
      }),
      getInstrumentSpecForConnection: jest.fn().mockResolvedValue(SPEC),
    };
    service = new RiskOrderGeometryService(broker as unknown as BrokerService);
  });

  it('uses ASK as the fresh MARKET reference for BUY', async () => {
    const result = await service.resolveOrderGeometry({
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      needFreshQuote: true,
    });

    expect(result.freshQuote?.toString()).toBe('1.0851');
    expect(result.quoteRef).toEqual(
      expect.objectContaining({
        direction: 'BUY',
        price: '1.0851',
        bid: '1.0849',
        ask: '1.0851',
        source: 'broker-current-price',
      }),
    );
  });

  it('uses BID as the fresh MARKET reference for SELL', async () => {
    const result = await service.resolveOrderGeometry({
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      direction: 'SELL',
      needFreshQuote: true,
    });

    expect(result.freshQuote?.toString()).toBe('1.0849');
    expect(result.quoteRef).toEqual(
      expect.objectContaining({ direction: 'SELL', price: '1.0849' }),
    );
  });

  it('does not fetch a market quote for non-MARKET geometry', async () => {
    const result = await service.resolveOrderGeometry({
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      needFreshQuote: false,
    });

    expect(broker.getCurrentPriceForConnection).not.toHaveBeenCalled();
    expect(result.freshQuote).toBeNull();
    expect(result.contractSize?.toString()).toBe('100000');
  });

  it('never exposes a price without a provable quote timestamp', async () => {
    broker.getCurrentPriceForConnection.mockResolvedValue({
      instrument: 'EURUSD',
      bid: '1.08490',
      ask: '1.08510',
      spread: '0.00020',
      timestamp: new Date('not-a-date'),
    });

    const result = await service.resolveOrderGeometry({
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      needFreshQuote: true,
    });

    expect(result.freshQuote).toBeNull();
    expect(result.quoteRef).toBeNull();
  });

  it('never fabricates a quote when bid/ask are invalid', async () => {
    broker.getCurrentPriceForConnection.mockResolvedValue({
      instrument: 'EURUSD',
      bid: '1.08600',
      ask: '1.08500',
      spread: '-0.00100',
      timestamp: new Date('2026-10-06T17:05:00.000Z'),
    });

    const result = await service.resolveOrderGeometry({
      userId: 'user-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      needFreshQuote: true,
    });

    expect(result.freshQuote).toBeNull();
    expect(result.quoteRef).toBeNull();
    expect(result.contractSize?.toString()).toBe('100000');
  });
});
