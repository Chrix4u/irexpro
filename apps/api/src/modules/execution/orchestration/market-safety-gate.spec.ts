import {
  MARKET_QUOTE_MAX_AGE_MS,
  MarketSafetyError,
  MarketSafetyGateService,
} from './market-safety-gate.service';
import { BrokerService } from '../../broker/broker.service';
import { AuditService } from '../../audit/audit.service';
import { OrderService } from '../orders/order.service';
import type { ExecutionIntent } from './execution-intent.interface';
import { OrderKind, OrderTimeInForce } from '../orders/order.enums';
import type { BrokerPrice } from '../../broker/interfaces/broker-adapter.interface';

/**
 * MarketSafetyGateService (Round 6 live-execution completion §5/§18) — the
 * final pre-commitment market-safety gate.
 *
 * Collaborators are mocked at the seam; the CHECK LOGIC under test is the
 * real production code. Matrix:
 *   - a fresh, sane quote passes (no rejection)
 *   - no provable quote → MARKET_DATA_UNAVAILABLE (§18 — never invented)
 *   - unparseable timestamp → MARKET_DATA_UNAVAILABLE
 *   - quote older than the execution window → STALE_PRICE
 *   - crossed/invalid bid-ask → MARKET_DATA_UNAVAILABLE
 *   - spread above the anomaly threshold → ABNORMAL_SPREAD
 *   - mid deviating from the risk-validated reference → PRICE_DEVIATION_EXCESSIVE
 *   - every failure terminally REJECTS the order (audited) BEFORE any
 *     provider call or commitment
 */

const USER = '11111111-1111-4111-8111-111111111111';
const CONN = '22222222-2222-4222-8222-222222222222';

const quote = (overrides: Partial<BrokerPrice> = {}): BrokerPrice => ({
  instrument: 'EURUSD',
  bid: '1.08490',
  ask: '1.08510',
  spread: '0.00020',
  timestamp: new Date(),
  ...overrides,
});

const intent = (overrides: Partial<ExecutionIntent> = {}): ExecutionIntent => ({
  userId: USER,
  brokerConnectionId: CONN,
  clientOrderId: 'sig-sig-1',
  orderKind: OrderKind.MARKET,
  timeInForce: OrderTimeInForce.GTC,
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedQuantity: '0.20',
  requestedPrice: null,
  stopPrice: null,
  stopLoss: '1.07500',
  takeProfit: '1.09500',
  referencePrice: '1.08500',
  providerAction: 'PLACE',
  ...overrides,
});

describe('MarketSafetyGateService — the final pre-commitment gate (Round 6 §5/§18)', () => {
  let service: MarketSafetyGateService;
  let brokerService: { getCurrentPriceForConnection: jest.Mock };
  let orderService: { rejectOrder: jest.Mock };
  let auditService: { log: jest.Mock };

  beforeEach(() => {
    brokerService = {
      getCurrentPriceForConnection: jest.fn().mockResolvedValue(quote()),
    };
    orderService = { rejectOrder: jest.fn().mockResolvedValue({ id: 'order-1' }) };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    service = new MarketSafetyGateService(
      brokerService as unknown as BrokerService,
      orderService as unknown as OrderService,
      auditService as unknown as AuditService,
    );
  });

  it('passes a fresh, sane quote within deviation bounds', async () => {
    await expect(
      service.assertMarketSafeForDispatch(intent(), {} as never, 'order-1'),
    ).resolves.toBeUndefined();
    expect(orderService.rejectOrder).not.toHaveBeenCalled();
  });

  it('MARKET_DATA_UNAVAILABLE when no provable quote exists (§18 — never invented)', async () => {
    brokerService.getCurrentPriceForConnection.mockResolvedValue(null);
    await expect(
      service.assertMarketSafeForDispatch(intent(), {} as never, 'order-1'),
    ).rejects.toMatchObject({ code: 'MARKET_DATA_UNAVAILABLE' });
    expect(orderService.rejectOrder).toHaveBeenCalledWith(
      'order-1',
      expect.stringContaining('MARKET_SAFETY_MARKET_DATA_UNAVAILABLE'),
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ blockedReason: 'MARKET_DATA_UNAVAILABLE', gate: 'MARKET_SAFETY' }),
      }),
    );
  });

  it('MARKET_DATA_UNAVAILABLE for an unparseable quote timestamp', async () => {
    brokerService.getCurrentPriceForConnection.mockResolvedValue(
      quote({ timestamp: new Date('not-a-date') }),
    );
    await expect(
      service.assertMarketSafeForDispatch(intent(), {} as never, 'order-1'),
    ).rejects.toMatchObject({ code: 'MARKET_DATA_UNAVAILABLE' });
  });

  it('STALE_PRICE when the quote exceeds the execution freshness window', async () => {
    brokerService.getCurrentPriceForConnection.mockResolvedValue(
      quote({ timestamp: new Date(Date.now() - MARKET_QUOTE_MAX_AGE_MS - 5_000) }),
    );
    await expect(
      service.assertMarketSafeForDispatch(intent(), {} as never, 'order-1'),
    ).rejects.toMatchObject({ code: 'STALE_PRICE' });
    expect(orderService.rejectOrder).toHaveBeenCalled();
  });

  it('MARKET_DATA_UNAVAILABLE for crossed/invalid bid-ask', async () => {
    brokerService.getCurrentPriceForConnection.mockResolvedValue(
      quote({ bid: '1.08600', ask: '1.08500', spread: '-0.00100' }),
    );
    await expect(
      service.assertMarketSafeForDispatch(intent(), {} as never, 'order-1'),
    ).rejects.toMatchObject({ code: 'MARKET_DATA_UNAVAILABLE' });
  });

  it('ABNORMAL_SPREAD when the spread ratio exceeds the anomaly threshold', async () => {
    // 2%+ spread: bid 1.06 / ask 1.09 → spread 0.03 / mid ~1.075 ≈ 2.79%.
    brokerService.getCurrentPriceForConnection.mockResolvedValue(
      quote({ bid: '1.06000', ask: '1.09000', spread: '0.03000' }),
    );
    await expect(
      service.assertMarketSafeForDispatch(intent(), {} as never, 'order-1'),
    ).rejects.toMatchObject({ code: 'ABNORMAL_SPREAD' });
  });

  it('PRICE_DEVIATION_EXCESSIVE when the market moved materially from the reference', async () => {
    // reference 1.085 → mid ~1.10 is ~1.38% deviation (> 1%).
    brokerService.getCurrentPriceForConnection.mockResolvedValue(
      quote({ bid: '1.09980', ask: '1.10020', spread: '0.00040' }),
    );
    await expect(
      service.assertMarketSafeForDispatch(intent(), {} as never, 'order-1'),
    ).rejects.toMatchObject({ code: 'PRICE_DEVIATION_EXCESSIVE' });
  });

  it('skips the deviation check when the intent carries no provable reference', async () => {
    // Mid is far from any reference — but no reference is present, so only
    // freshness + spread apply and the gate passes.
    brokerService.getCurrentPriceForConnection.mockResolvedValue(
      quote({ bid: '1.09980', ask: '1.10020', spread: '0.00040' }),
    );
    await expect(
      service.assertMarketSafeForDispatch(
        intent({ referencePrice: null }),
        {} as never,
        'order-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('rejects the order even when the order-store rejection itself fails (fail-closed either way)', async () => {
    brokerService.getCurrentPriceForConnection.mockResolvedValue(null);
    orderService.rejectOrder.mockRejectedValue(new Error('order store down'));
    await expect(
      service.assertMarketSafeForDispatch(intent(), {} as never, 'order-1'),
    ).rejects.toBeInstanceOf(MarketSafetyError);
  });

  it('carries the stable machine code in the typed error', async () => {
    brokerService.getCurrentPriceForConnection.mockResolvedValue(null);
    try {
      await service.assertMarketSafeForDispatch(intent(), {} as never, 'order-1');
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(MarketSafetyError);
      expect((err as MarketSafetyError).code).toBe('MARKET_DATA_UNAVAILABLE');
      expect((err as Error).message).toContain('MARKET_DATA_UNAVAILABLE');
    }
  });
});
