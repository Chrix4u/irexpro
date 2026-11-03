import { Repository } from 'typeorm';
import { Trade, TradeStatus } from '../entities/trade.entity';
import {
  buildEntryQuoteTelemetryPatch,
  TradeLifecycleCasService,
} from './trade-lifecycle-cas.service';
import {
  clearProvenExecutionQuoteRegistryForTests,
  rememberProvenExecutionQuote,
} from '../services/execution-quote-registry';
import { TradeSpreadTelemetryService } from '../services/trade-spread-telemetry.service';

function mockOpenTrade(): Trade {
  return {
    id: 'trade-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    instrument: 'EURUSD',
    lotSize: '0.20',
    accountCurrency: 'USD',
    status: TradeStatus.OPEN,
    entryQuoteBid: null,
  } as Trade;
}

function createHarness(options?: { estimatorRejects?: boolean }) {
  const set = jest.fn().mockReturnThis();
  const execute = jest.fn().mockResolvedValue({ affected: 1 });
  const queryBuilder = {
    update: jest.fn().mockReturnThis(),
    set,
    where: jest.fn().mockReturnThis(),
    execute,
  };
  const tradeRepo = {
    createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
    findOne: jest.fn().mockResolvedValue(mockOpenTrade()),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  } as unknown as Repository<Trade>;
  const auditService = { log: jest.fn().mockResolvedValue(undefined) };
  const estimateEntrySpreadCost = options?.estimatorRejects
    ? jest.fn().mockRejectedValue(new Error('telemetry unavailable'))
    : jest.fn().mockResolvedValue({
        estimatedSpreadCost: '4',
        spreadCostEstimateMethod: 'ENTRY_SPREAD_ROUND_TRIP_PROXY',
        spreadCostContractSize: '100000',
        spreadCostQuoteCurrency: 'USD',
        spreadCostConversionRate: '1',
        spreadCostConversionInstrument: null,
      });
  const spreadTelemetry = {
    estimateEntrySpreadCost,
  } as unknown as TradeSpreadTelemetryService;
  const service = new TradeLifecycleCasService(
    tradeRepo,
    auditService as never,
    spreadTelemetry,
  );
  return { service, tradeRepo, set, estimateEntrySpreadCost };
}

describe('TradeLifecycleCasService spread telemetry', () => {
  beforeEach(() => clearProvenExecutionQuoteRegistryForTests());
  afterEach(() => clearProvenExecutionQuoteRegistryForTests());

  it('derives raw spread from ASK - BID instead of trusting provider spread', () => {
    const patch = buildEntryQuoteTelemetryPatch({
      instrument: 'EURUSD',
      bid: '1.10000',
      ask: '1.10020',
      spread: '99',
      timestamp: Date.now(),
    });

    expect(patch).toEqual(
      expect.objectContaining({
        entryQuoteBid: '1.1',
        entryQuoteAsk: '1.1002',
        entrySpread: '0.0002',
        entryQuoteObservedAt: expect.any(Date),
      }),
    );
  });

  it('rejects crossed or structurally invalid quote evidence', () => {
    expect(
      buildEntryQuoteTelemetryPatch({
        instrument: 'EURUSD',
        bid: '1.1010',
        ask: '1.1000',
        spread: '0.0010',
        timestamp: Date.now(),
      }),
    ).toBeNull();
  });

  it('writes proven bid/ask/spread in the same CAS patch that opens the trade', async () => {
    const { service, set } = createHarness();
    rememberProvenExecutionQuote('trade-1', {
      instrument: 'EURUSD',
      bid: '1.10000',
      ask: '1.10020',
      spread: '0.00020',
      timestamp: Date.now(),
    });

    const outcome = await service.applyCasTransition({
      tradeId: 'trade-1',
      expectedFrom: TradeStatus.PENDING,
      target: TradeStatus.OPEN,
      patch: { status: TradeStatus.OPEN, fillPrice: '1.10020' },
      context: { userId: 'user-1', source: 'test:FILLED' },
    });

    expect(outcome.outcome).toBe('APPLIED');
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: TradeStatus.OPEN,
        fillPrice: '1.10020',
        entryQuoteBid: '1.1',
        entryQuoteAsk: '1.1002',
        entrySpread: '0.0002',
        entryQuoteObservedAt: expect.any(Date),
      }),
    );
  });

  it('keeps the OPEN result successful when spread estimation fails after the CAS', async () => {
    const { service, estimateEntrySpreadCost } = createHarness({ estimatorRejects: true });
    rememberProvenExecutionQuote('trade-1', {
      instrument: 'EURUSD',
      bid: '1.10000',
      ask: '1.10020',
      spread: '0.00020',
      timestamp: Date.now(),
    });

    await expect(
      service.applyCasTransition({
        tradeId: 'trade-1',
        expectedFrom: TradeStatus.PENDING,
        target: TradeStatus.OPEN,
        patch: { status: TradeStatus.OPEN, fillPrice: '1.10020' },
        context: { userId: 'user-1', source: 'test:FILLED' },
      }),
    ).resolves.toEqual(expect.objectContaining({ outcome: 'APPLIED' }));

    await new Promise((resolve) => setImmediate(resolve));
    expect(estimateEntrySpreadCost).toHaveBeenCalledTimes(1);
  });

  it('does not invent telemetry when no proven execution quote exists', async () => {
    const { service, set, estimateEntrySpreadCost } = createHarness();

    await service.applyCasTransition({
      tradeId: 'trade-1',
      expectedFrom: TradeStatus.PENDING,
      target: TradeStatus.OPEN,
      patch: { status: TradeStatus.OPEN, fillPrice: '1.10020' },
      context: { userId: 'user-1', source: 'test:FILLED' },
    });

    expect(set).toHaveBeenCalledWith({ status: TradeStatus.OPEN, fillPrice: '1.10020' });
    expect(estimateEntrySpreadCost).not.toHaveBeenCalled();
  });
});
