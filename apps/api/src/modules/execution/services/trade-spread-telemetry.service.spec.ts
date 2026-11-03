import type { BrokerPrice } from '../../broker/interfaces/broker-adapter.interface';
import { BrokerService } from '../../broker/broker.service';
import { BrokerFxConversionService } from '../../market-data/services/broker-fx-conversion.service';
import { TradeSpreadTelemetryService } from './trade-spread-telemetry.service';

const quote: BrokerPrice = {
  instrument: 'EURUSD',
  bid: '1.08490',
  ask: '1.08510',
  spread: '0.00020',
  timestamp: new Date('2026-11-03T10:00:00.000Z'),
};

const spec = {
  symbol: 'EURUSD',
  description: 'Euro vs US Dollar',
  digits: 5,
  minLot: '0.01',
  maxLot: '100',
  lotStep: '0.01',
  contractSize: '100000',
};

describe('TradeSpreadTelemetryService', () => {
  let brokerService: { getInstrumentSpecForConnection: jest.Mock };
  let fxConversion: { resolveCachedBid: jest.Mock };
  let service: TradeSpreadTelemetryService;

  beforeEach(() => {
    brokerService = {
      getInstrumentSpecForConnection: jest.fn().mockResolvedValue(spec),
    };
    fxConversion = {
      resolveCachedBid: jest.fn().mockResolvedValue(null),
    };
    service = new TradeSpreadTelemetryService(
      brokerService as unknown as BrokerService,
      fxConversion as unknown as BrokerFxConversionService,
    );
  });

  it('estimates one entry spread across the round trip when account currency is quote currency', async () => {
    await expect(
      service.estimateEntrySpreadCost({
        userId: 'user-1',
        brokerConnectionId: 'connection-1',
        instrument: 'EURUSD',
        lotSize: '0.20',
        accountCurrency: 'USD',
        quote,
      }),
    ).resolves.toEqual({
      estimatedSpreadCost: '4',
      spreadCostEstimateMethod: 'ENTRY_SPREAD_ROUND_TRIP_PROXY',
      spreadCostContractSize: '100000',
      spreadCostQuoteCurrency: 'USD',
      spreadCostConversionRate: '1',
      spreadCostConversionInstrument: null,
    });
    expect(fxConversion.resolveCachedBid).not.toHaveBeenCalled();
  });

  it('converts quote-currency cost into base-account currency using entry midpoint', async () => {
    await expect(
      service.estimateEntrySpreadCost({
        userId: 'user-1',
        brokerConnectionId: 'connection-1',
        instrument: 'EURUSD',
        lotSize: '0.20',
        accountCurrency: 'EUR',
        quote,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        estimatedSpreadCost: '3.68663594',
        spreadCostConversionRate: '1.085',
        spreadCostConversionInstrument: 'EURUSD',
      }),
    );
  });

  it('uses fresh broker-native account-to-quote conversion evidence for a third currency', async () => {
    fxConversion.resolveCachedBid.mockResolvedValue({
      rate: '1.25',
      path: ['GBPUSD'],
      source: 'BROKER_NATIVE_CACHE_DIRECT',
      observedAt: new Date('2026-11-03T09:59:59.000Z'),
    });

    await expect(
      service.estimateEntrySpreadCost({
        userId: 'user-1',
        brokerConnectionId: 'connection-1',
        instrument: 'EURUSD',
        lotSize: '0.20',
        accountCurrency: 'GBP',
        quote,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        estimatedSpreadCost: '3.2',
        spreadCostConversionRate: '1.25',
        spreadCostConversionInstrument: 'GBPUSD',
      }),
    );
  });

  it('returns null when quote or conversion evidence cannot support an honest estimate', async () => {
    await expect(
      service.estimateEntrySpreadCost({
        userId: 'user-1',
        brokerConnectionId: 'connection-1',
        instrument: 'EURUSD',
        lotSize: '0.20',
        accountCurrency: 'GBP',
        quote: { ...quote, bid: '1.09', ask: '1.08' },
      }),
    ).resolves.toBeNull();

    await expect(
      service.estimateEntrySpreadCost({
        userId: 'user-1',
        brokerConnectionId: 'connection-1',
        instrument: 'EURUSD',
        lotSize: '0.20',
        accountCurrency: 'GBP',
        quote,
      }),
    ).resolves.toBeNull();
  });
});
