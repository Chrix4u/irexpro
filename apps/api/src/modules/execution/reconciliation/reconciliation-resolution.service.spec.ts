import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Trade, TradeStatus } from '../entities/trade.entity';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order.enums';
import { OrderService } from '../orders/order.service';
import { TradeStateMachine } from '../orders/trade-state-machine';
import { AuditService } from '../../audit/audit.service';
import { DomainEventBus } from '../../events/event-bus.service';
import { DomainEventType } from '../../events/enums/domain-event-type.enum';
import { BrokerOrderState } from '../../broker/interfaces/broker-adapter.interface';
import { ReconciliationResolutionService } from './reconciliation-resolution.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';

const TRADE_REPO = getRepositoryToken(Trade);

const baseTrade = (overrides: Partial<Trade> = {}): Trade =>
  ({
    id: 'trade-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    signalId: null,
    idempotencyKey: 'k',
    instrument: 'EURUSD',
    direction: 'BUY',
    lotSize: '1.0000',
    requestedEntryPrice: '1.10000',
    fillPrice: '1.10000',
    stopLoss: '0',
    takeProfit: '0',
    trailingStopPips: null,
    externalOrderId: 'pos-1',
    externalPositionId: null,
    commission: null,
    swap: null,
    status: TradeStatus.OPEN,
    exitPrice: null,
    realisedPnl: null,
    closeReason: null,
    brokerRejectionReason: null,
    openedAt: new Date('2025-01-01T00:00:00Z'),
    closedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Trade;

const baseOrder = (overrides: Partial<Order> = {}): Order =>
  ({
    id: 'order-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    tradeId: null,
    signalId: null,
    clientOrderId: 'client-1',
    providerOrderId: 'ticket-1',
    idempotencyKey: 'k',
    orderKind: 'LIMIT',
    timeInForce: 'GTC',
    instrument: 'EURUSD',
    direction: 'BUY',
    requestedQuantity: '1.0000',
    requestedPrice: '1.10000',
    stopPrice: null,
    filledQuantity: '0.0000',
    avgFillPrice: null,
    status: OrderStatus.RECONCILIATION_PENDING,
    rejectReason: null,
    submittedAt: new Date('2025-01-01T00:00:00Z'),
    finalizedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Order;

const providerOrder = (overrides: Partial<BrokerOrderState> = {}): BrokerOrderState => ({
  providerOrderId: 'ticket-1',
  clientOrderId: 'client-1',
  status: 'FILLED',
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedQuantity: '1.0000',
  filledQuantity: '1.0000',
  avgFillPrice: '1.10000',
  orderKind: 'LIMIT',
  limitPrice: '1.10000',
  stopPrice: null,
  timeInForce: 'GTC',
  placedAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('ReconciliationResolutionService', () => {
  let service: ReconciliationResolutionService;
  let tradeRepo: { update: jest.Mock };
  let orderService: {
    resolveReconciliation: jest.Mock;
    applyFill: jest.Mock;
    findByTradeId: jest.Mock;
  };
  let auditService: { log: jest.Mock };
  let eventBus: { publish: jest.Mock };

  beforeEach(async () => {
    tradeRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    orderService = {
      resolveReconciliation: jest.fn().mockResolvedValue(baseOrder()),
      applyFill: jest.fn().mockResolvedValue(baseOrder()),
      findByTradeId: jest.fn().mockResolvedValue(null),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    eventBus = { publish: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        ReconciliationResolutionService,
        { provide: TRADE_REPO, useValue: tradeRepo },
        { provide: OrderService, useValue: orderService },
        { provide: AuditService, useValue: auditService },
        { provide: DomainEventBus, useValue: eventBus },
      ],
    }).compile();

    service = module.get(ReconciliationResolutionService);
  });

  // ─── closeTradeFromProvider ────────────────────────────────────────────────

  describe('closeTradeFromProvider', () => {
    it('closes an OPEN trade with provider exit economics (guarded update)', async () => {
      const closed = await service.closeTradeFromProvider(baseTrade(), {
        externalOrderId: 'pos-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '1.0000',
        openPrice: '1.10000',
        closePrice: '1.12000',
        stopLoss: '0',
        takeProfit: '0',
        realisedPnl: '20.00',
        openedAt: new Date(),
        closedAt: new Date(),
        commission: '0.00',
        swap: '0.00',
        closeReason: 'TP',
      });

      expect(closed).toBe(true);
      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.OPEN },
        expect.objectContaining({
          status: TradeStatus.CLOSED,
          exitPrice: '1.12000',
          realisedPnl: '20.00',
          closeReason: 'BROKER_CLOSE',
        }),
      );
    });

    it('closes with NULL economics when the provider close is unknown', async () => {
      await service.closeTradeFromProvider(baseTrade(), null);
      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.OPEN },
        expect.objectContaining({ exitPrice: null, realisedPnl: null }),
      );
    });

    it('returns false (no double mutation) when the guarded update loses the race', async () => {
      tradeRepo.update.mockResolvedValueOnce({ affected: 0 });
      const closed = await service.closeTradeFromProvider(baseTrade(), null);
      expect(closed).toBe(false);
      expect(auditService.log).not.toHaveBeenCalled();
      expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('rejects an invalid transition loudly (state machine guard)', async () => {
      // CLOSED → CLOSED is illegal; reconciliation must surface, not swallow.
      const alreadyClosed = baseTrade({ status: TradeStatus.CLOSED });
      await expect(service.closeTradeFromProvider(alreadyClosed, null)).rejects.toThrow(
        /Invalid trade transition/,
      );
      expect(tradeRepo.update).not.toHaveBeenCalled();
    });

    it('audits TRADE_CLOSED with source state-reconciliation and emits trade.closed', async () => {
      await service.closeTradeFromProvider(baseTrade(), null);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.TRADE_CLOSED }),
      );
      expect(eventBus.publish).toHaveBeenCalledWith(
        DomainEventType.TRADE_CLOSED,
        'user-1',
        expect.objectContaining({ tradeId: 'trade-1', status: 'CLOSED' }),
      );
    });

    it('resolves the linked RECONCILIATION_PENDING entry order to FILLED', async () => {
      orderService.findByTradeId.mockResolvedValue(
        baseOrder({ status: OrderStatus.RECONCILIATION_PENDING }),
      );
      await service.closeTradeFromProvider(baseTrade(), null);
      expect(orderService.resolveReconciliation).toHaveBeenCalledWith(
        'order-1',
        OrderStatus.FILLED,
        expect.anything(),
      );
    });
  });

  // ─── recoverTradeToOpen ────────────────────────────────────────────────────

  describe('recoverTradeToOpen', () => {
    it('recovers RECONCILIATION_PENDING → OPEN (guarded)', async () => {
      const pending = baseTrade({ status: TradeStatus.RECONCILIATION_PENDING });
      const recovered = await service.recoverTradeToOpen(pending);

      expect(recovered).toBe(true);
      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.RECONCILIATION_PENDING },
        { status: TradeStatus.OPEN },
      );
    });

    it('skips when the trade is no longer pending (race lost)', async () => {
      tradeRepo.update.mockResolvedValueOnce({ affected: 0 });
      const pending = baseTrade({ status: TradeStatus.RECONCILIATION_PENDING });
      expect(await service.recoverTradeToOpen(pending)).toBe(false);
    });

    it('emits trade.opened recovery event + TRADE_RECONCILED audit', async () => {
      const pending = baseTrade({ status: TradeStatus.RECONCILIATION_PENDING });
      await service.recoverTradeToOpen(pending);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.TRADE_RECONCILED }),
      );
      expect(eventBus.publish).toHaveBeenCalledWith(
        DomainEventType.TRADE_OPENED,
        'user-1',
        expect.anything(),
      );
    });
  });

  // ─── resolveOrderFromProviderState ─────────────────────────────────────────

  describe('resolveOrderFromProviderState', () => {
    it('resolves RECONCILIATION_PENDING order to ACKNOWLEDGED when provider says WORKING', async () => {
      const changed = await service.resolveOrderFromProviderState(
        baseOrder(),
        providerOrder({ status: 'WORKING' }),
      );
      expect(changed).toBe(true);
      expect(orderService.resolveReconciliation).toHaveBeenCalledWith(
        'order-1',
        OrderStatus.ACKNOWLEDGED,
        expect.anything(),
      );
    });

    it('resolves to FILLED when provider terminal FILLED (with fill delta applied)', async () => {
      const order = baseOrder({ filledQuantity: '0.0000' });
      const changed = await service.resolveOrderFromProviderState(
        order,
        providerOrder({ status: 'FILLED', filledQuantity: '1.0000', avgFillPrice: '1.10000' }),
      );
      expect(changed).toBe(true);
      expect(orderService.applyFill).toHaveBeenCalledWith('order-1', {
        quantity: '1',
        price: '1.10000',
        providerOrderId: 'ticket-1',
      });
      expect(orderService.resolveReconciliation).toHaveBeenCalledWith(
        'order-1',
        OrderStatus.FILLED,
        expect.anything(),
      );
    });

    it('applies only the MISSED fill delta (delta math, no floats)', async () => {
      const order = baseOrder({ filledQuantity: '0.2500' });
      await service.resolveOrderFromProviderState(
        order,
        providerOrder({ status: 'PARTIALLY_FILLED', filledQuantity: '0.7500' }),
      );
      expect(orderService.applyFill).toHaveBeenCalledWith(
        'order-1',
        expect.objectContaining({ quantity: '0.5' }),
      );
    });

    for (const providerStatus of ['CANCELLED', 'REJECTED', 'EXPIRED'] as const) {
      it(`resolves provider ${providerStatus} through the order state machine`, async () => {
        const changed = await service.resolveOrderFromProviderState(
          baseOrder(),
          providerOrder({ status: providerStatus }),
        );
        expect(changed).toBe(true);
        const expectedTarget = {
          CANCELLED: OrderStatus.CANCELLED,
          REJECTED: OrderStatus.REJECTED,
          EXPIRED: OrderStatus.EXPIRED,
        }[providerStatus];
        expect(orderService.resolveReconciliation).toHaveBeenCalledWith(
          'order-1',
          expectedTarget,
          expect.anything(),
        );
      });
    }

    it('never mutates on UNKNOWN provider state (fail-closed)', async () => {
      const changed = await service.resolveOrderFromProviderState(
        baseOrder(),
        providerOrder({ status: 'UNKNOWN' }),
      );
      expect(changed).toBe(false);
      expect(orderService.resolveReconciliation).not.toHaveBeenCalled();
    });

    it('never mutates a terminal internal order (nothing to converge)', async () => {
      const filled = baseOrder({ status: OrderStatus.FILLED, filledQuantity: '1.0000' });
      const changed = await service.resolveOrderFromProviderState(
        filled,
        providerOrder({ status: 'CANCELLED' }),
      );
      expect(changed).toBe(false);
    });

    it('does nothing when internal state is already current', async () => {
      const acked = baseOrder({ status: OrderStatus.ACKNOWLEDGED, filledQuantity: '0.0000' });
      const changed = await service.resolveOrderFromProviderState(
        acked,
        providerOrder({ status: 'WORKING' }),
      );
      expect(changed).toBe(false);
    });
  });

  // ─── Concurrency proof: state-machine validity of every mutation path ─────

  describe('machine-guard coverage', () => {
    it('every trade mutation the service performs is a legal transition', () => {
      // The mutations this service performs:
      const exercised = [
        [TradeStatus.OPEN, TradeStatus.CLOSED],
        [TradeStatus.RECONCILIATION_PENDING, TradeStatus.CLOSED],
        [TradeStatus.RECONCILIATION_PENDING, TradeStatus.OPEN],
      ] as const;
      for (const [from, to] of exercised) {
        expect(() => TradeStateMachine.assertTransition(from, to)).not.toThrow();
      }
    });
  });
});
