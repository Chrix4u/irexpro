import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Trade, TradeCloseReason, TradeStatus } from '../entities/trade.entity';
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
    resolveReconciliationFillState: jest.Mock;
    applyFill: jest.Mock;
    findByTradeId: jest.Mock;
  };
  let auditService: { log: jest.Mock };
  let eventBus: { publish: jest.Mock };

  beforeEach(async () => {
    tradeRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    orderService = {
      resolveReconciliation: jest.fn().mockResolvedValue(baseOrder()),
      resolveReconciliationFillState: jest.fn().mockResolvedValue(baseOrder()),
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
        pathDiagnostics: {
          maxFavorablePnl: '31.00',
          maxAdversePnl: '-4.00',
          latestUnrealisedPnl: '20.00',
          profitGiveback: '11.00',
          observationCount: 17,
          sameBarProtectionAmbiguityCount: 1,
          lastSameBarProtectionAmbiguityAt: new Date('2026-10-02T12:34:00.000Z'),
          peakObservedAt: new Date('2026-10-02T12:30:00.000Z'),
          lastObservedAt: new Date('2026-10-02T12:35:00.000Z'),
        },
      });

      expect(closed).toBe(true);
      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.OPEN },
        expect.objectContaining({
          status: TradeStatus.CLOSED,
          exitPrice: '1.12000',
          realisedPnl: '20.00',
          closeReason: 'TAKE_PROFIT_HIT',
          maxFavorablePnl: '31.00',
          maxAdversePnl: '-4.00',
          profitGiveback: '11.00',
          pathObservationCount: 17,
          sameBarProtectionAmbiguityCount: 1,
          lastSameBarProtectionAmbiguityAt: new Date('2026-10-02T12:34:00.000Z'),
        }),
      );
    });

    it('preserves provider SL provenance as STOP_LOSS_HIT', async () => {
      await service.closeTradeFromProvider(baseTrade(), {
        externalOrderId: 'pos-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '1.0000',
        openPrice: '1.10000',
        closePrice: '1.09000',
        stopLoss: '1.09000',
        takeProfit: '1.12000',
        realisedPnl: '-10.00',
        openedAt: new Date(),
        closedAt: new Date(),
        commission: '0.00',
        swap: '0.00',
        closeReason: 'SL',
      });
      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.OPEN },
        expect.objectContaining({ closeReason: TradeCloseReason.STOP_LOSS_HIT }),
      );
    });

    it('preserves PAPER profit-lock provenance as PROFIT_PROTECTION', async () => {
      await service.closeTradeFromProvider(baseTrade(), {
        externalOrderId: 'pos-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '1.0000',
        openPrice: '1.10000',
        closePrice: '1.10600',
        stopLoss: '1.09000',
        takeProfit: '1.12000',
        realisedPnl: '6.00',
        openedAt: new Date(),
        closedAt: new Date(),
        commission: '0.00',
        swap: '0.00',
        closeReason: 'PROFIT_LOCK',
      });
      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.OPEN },
        expect.objectContaining({ closeReason: TradeCloseReason.PROFIT_PROTECTION }),
      );
    });

    it('preserves an app-initiated PROFIT_PROTECTION close across asynchronous provider reconciliation and reuses durable path telemetry', async () => {
      const peakAt = new Date('2026-10-28T10:36:08.871Z');
      const lastAt = new Date('2026-10-28T10:37:24.733Z');
      const pending = baseTrade({
        status: TradeStatus.RECONCILIATION_PENDING,
        closeReason: TradeCloseReason.PROFIT_PROTECTION,
        maxFavorablePnl: '10.60000000',
        maxAdversePnl: '0.00000000',
        profitGiveback: '2.15000000',
        pathObservationCount: 54,
        pathPeakObservedAt: peakAt,
        pathLastObservedAt: lastAt,
      });

      await service.closeTradeFromProvider(pending, {
        externalOrderId: 'pos-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '0.2000',
        openPrice: '1.11180',
        closePrice: '1.11283',
        stopLoss: '1.11180',
        takeProfit: '1.11310',
        realisedPnl: '9.53',
        openedAt: new Date('2026-10-28T01:10:17.589Z'),
        closedAt: new Date('2026-10-28T10:37:26.675Z'),
        commission: '-1.80',
        swap: '0.00',
        closeReason: 'UNKNOWN',
      });

      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.RECONCILIATION_PENDING },
        expect.objectContaining({
          closeReason: TradeCloseReason.PROFIT_PROTECTION,
          maxFavorablePnl: '10.60000000',
          maxAdversePnl: '0.00000000',
          profitGiveback: '2.15000000',
          pathObservationCount: 54,
          pathPeakObservedAt: peakAt,
          pathLastObservedAt: lastAt,
        }),
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.TRADE_CLOSED,
          metadata: expect.objectContaining({
            closeReason: TradeCloseReason.PROFIT_PROTECTION,
            providerCloseReason: 'UNKNOWN',
            closeReasonSource: 'APP_CLOSE_INTENT_FALLBACK',
            pathDiagnostics: expect.objectContaining({
              maxFavorablePnl: '10.60000000',
              profitGiveback: '2.15000000',
              observationCount: 54,
            }),
          }),
        }),
      );
    });

    it('lets explicit provider SL evidence override a pending app close intent', async () => {
      const pending = baseTrade({
        status: TradeStatus.RECONCILIATION_PENDING,
        closeReason: TradeCloseReason.PROFIT_PROTECTION,
      });
      await service.closeTradeFromProvider(pending, {
        externalOrderId: 'pos-1', instrument: 'EURUSD', direction: 'BUY', lotSize: '0.2000',
        openPrice: '1.10000', closePrice: '1.09000', stopLoss: '1.09000', takeProfit: '1.12000',
        realisedPnl: '-10.00', openedAt: new Date(), closedAt: new Date(), commission: '0.00', swap: '0.00',
        closeReason: 'SL',
      });
      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.RECONCILIATION_PENDING },
        expect.objectContaining({ closeReason: TradeCloseReason.STOP_LOSS_HIT }),
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
        {
          status: TradeStatus.OPEN,
          closeReason: null,
          brokerRejectionReason: null,
        },
      );
    });

    it('clears a provisional app close intent when reconciliation proves the provider position is still open', async () => {
      const pending = baseTrade({
        status: TradeStatus.RECONCILIATION_PENDING,
        closeReason: TradeCloseReason.PROFIT_PROTECTION,
        brokerRejectionReason: 'Close outcome unresolved: timeout',
      });

      await service.recoverTradeToOpen(pending);

      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.RECONCILIATION_PENDING },
        expect.objectContaining({
          status: TradeStatus.OPEN,
          closeReason: null,
          brokerRejectionReason: null,
        }),
      );
    });

    it('Round 7.1 (P0-5): recovers a WORKING-outcome PENDING trade → OPEN (the restart edge with a live provider position)', async () => {
      const working = baseTrade({ status: TradeStatus.PENDING, externalOrderId: 'pos-1' });
      const recovered = await service.recoverTradeToOpen(working);

      expect(recovered).toBe(true);
      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.PENDING },
        { status: TradeStatus.OPEN },
      );
      // The audit records the from-state (PENDING recovery is distinct).
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.TRADE_RECONCILED,
          metadata: expect.objectContaining({ recoveredFrom: TradeStatus.PENDING }),
        }),
      );
    });

    it('persists provider position identity and fill economics when an async fill is recovered', async () => {
      const working = baseTrade({ status: TradeStatus.PENDING, externalOrderId: 'order-777' });
      const recovered = await service.recoverTradeToOpen(working, {
        externalOrderId: 'position-7001',
        instrument: 'EURUSD',
        direction: 'BUY',
        lotSize: '1.0000',
        openPrice: '1.08651',
        currentPrice: '1.08700',
        stopLoss: '1.08000',
        takeProfit: '1.09500',
        unrealisedPnl: '4.50',
        openedAt: new Date('2026-10-28T00:25:17.324Z'),
        commission: '-0.90',
        swap: '0.00',
      });

      expect(recovered).toBe(true);
      expect(tradeRepo.update).toHaveBeenCalledWith(
        { id: 'trade-1', status: TradeStatus.PENDING },
        expect.objectContaining({
          status: TradeStatus.OPEN,
          externalPositionId: 'position-7001',
          fillPrice: '1.08651',
          openedAt: new Date('2026-10-28T00:25:17.324Z'),
        }),
      );
    });

    it('Round 7.1 (P0-5): refuses recovery from a state with no legal OPEN transition (fail-closed)', async () => {
      const rejected = baseTrade({ status: TradeStatus.REJECTED });
      await expect(service.recoverTradeToOpen(rejected)).rejects.toThrow();
      expect(tradeRepo.update).not.toHaveBeenCalled();
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
      // applyFill is the FILL-BEARING authority: the atomic delta application
      // itself transitions RECONCILIATION_PENDING → FILLED with its economic
      // facts. CORRECTION ROUND 4 (finding 7): the old status-only
      // resolveReconciliation(FILLED) call threw by design in production and
      // is REMOVED — exactly one fill-bearing convergence, no status-only
      // write that could invent a fill.
      expect(orderService.applyFill).toHaveBeenCalledWith('order-1', {
        quantity: '1',
        price: '1.10000',
        providerOrderId: 'ticket-1',
      });
      expect(orderService.resolveReconciliation).not.toHaveBeenCalledWith(
        'order-1',
        OrderStatus.FILLED,
        expect.anything(),
      );
      expect(orderService.resolveReconciliationFillState).not.toHaveBeenCalled();
    });

    it('resolves a fill-equal RECONCILIATION_PENDING order through the FILL-BEARING entry point (no invented fill)', async () => {
      // CORRECTION ROUND 4 (finding 7): when the recorded fill already
      // matches the provider (no delta), the provider-observed status is
      // recorded via resolveReconciliationFillState — guarded, never a
      // status-only invention of economic facts.
      const order = baseOrder({
        status: OrderStatus.RECONCILIATION_PENDING,
        filledQuantity: '1.0000',
      });
      const changed = await service.resolveOrderFromProviderState(
        order,
        providerOrder({ status: 'FILLED', filledQuantity: '1.0000' }),
      );
      expect(changed).toBe(true);
      expect(orderService.applyFill).not.toHaveBeenCalled();
      expect(orderService.resolveReconciliationFillState).toHaveBeenCalledWith(
        'order-1',
        OrderStatus.FILLED,
        expect.objectContaining({ providerOrderId: 'ticket-1' }),
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
