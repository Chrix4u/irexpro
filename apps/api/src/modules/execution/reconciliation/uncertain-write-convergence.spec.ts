import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerAccount } from '../../broker/entities/broker-account.entity';
import { BrokerService } from '../../broker/broker.service';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../../broker/services/credential-encryption.service';
import { AuditService } from '../../audit/audit.service';
import { DomainEventBus } from '../../events/event-bus.service';
import { Trade } from '../entities/trade.entity';
import { Order } from '../orders/order.entity';
import { OrderStatus } from '../orders/order.enums';
import { OrderService } from '../orders/order.service';
import { OrderStateMachine } from '../orders/order-state-machine';
import { StateReconciliationService } from './state-reconciliation.service';
import { ReconciliationPersistenceService } from './reconciliation-persistence.service';
import { ReconciliationResolutionService } from './reconciliation-resolution.service';
import { ReconciliationRunStatus } from './reconciliation.enums';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { BrokerOrderState } from '../../broker/interfaces/broker-adapter.interface';

const TRADE_REPO = getRepositoryToken(Trade);
const ORDER_REPO = getRepositoryToken(Order);
const ACCOUNT_REPO = getRepositoryToken(BrokerAccount);

// ─── Fixtures (mirror state-reconciliation.service.spec.ts) ──────────────────

const connection = (): BrokerConnection =>
  ({
    id: 'conn-1',
    userId: 'user-1',
    brokerId: 'paper-broker',
    accountId: 'paper-account-001',
    accountType: 'DEMO',
    status: 'CONNECTED',
    credentialStatus: 'VERIFIED',
    encryptedCredentials: null,
    credentialIv: null,
    credentialTag: null,
    encryptionKeyId: null,
  }) as unknown as BrokerConnection;

/** The order left behind by an uncertain PLACE write (lost response). */
const pendingOrder = (): Order =>
  ({
    id: 'order-1',
    userId: 'user-1',
    brokerConnectionId: 'conn-1',
    clientOrderId: 'client-1',
    providerOrderId: 'ticket-1',
    status: OrderStatus.RECONCILIATION_PENDING,
    submittedAt: new Date('2025-01-01T00:00:00Z'),
    instrument: 'EURUSD',
    orderKind: 'LIMIT',
    requestedQuantity: '1.0000',
    filledQuantity: '0.0000',
    avgFillPrice: null,
    requestedPrice: '1.10000',
    tradeId: null,
  }) as unknown as Order;

// ─── Fixtures (mirror reconciliation-resolution.service.spec.ts) ─────────────

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

/** Decimal-string addition (a + b) with scale normalization; no floats. */
const addDecimal = (a: string, b: string, scale = 4): string => {
  const toScaled = (v: string): bigint => {
    const [i = '0', f = ''] = String(v ?? '0').split('.');
    return (
      BigInt(i || '0') * 10n ** BigInt(scale) + BigInt((f + '0'.repeat(scale)).slice(0, scale))
    );
  };
  const result = toScaled(a) + toScaled(b);
  const base = 10n ** BigInt(scale);
  return `${result / base}.${(result % base).toString().padStart(scale, '0')}`;
};

describe('Uncertain-write reconciliation convergence (Sprint 56 correction round 4, findings 5-7)', () => {
  // ─── G. Discovery + idempotent convergence, provider-authoritative ───────
  //
  // StateReconciliationService harness (mirrors state-reconciliation.service
  // .spec.ts) with the REAL ReconciliationResolutionService wired in — the
  // loop discovers the executed order by stable identifier (Directive §26)
  // and converges the internal order onto the provider-observed FILLED state.
  describe('G. reconciliation discovers the original order/fill for a RECONCILIATION_PENDING order', () => {
    let service: StateReconciliationService;
    let orderRepo: { find: jest.Mock; createQueryBuilder: jest.Mock };
    let orderService: {
      resolveReconciliation: jest.Mock;
      resolveReconciliationFillState: jest.Mock;
      applyFill: jest.Mock;
      findByTradeId: jest.Mock;
    };
    let auditService: { log: jest.Mock };
    let adapter: {
      setMode: jest.Mock;
      connect: jest.Mock;
      listOrders: jest.Mock;
      getOpenPositions: jest.Mock;
      getAccountInfo: jest.Mock;
      getPositionById: jest.Mock;
      getClosedTrades: jest.Mock;
      getOrderById: jest.Mock;
      placeOrder: jest.Mock;
      closeOrder: jest.Mock;
    };

    beforeEach(async () => {
      // The provider EXECUTED the uncertain order — it left the working-order
      // list (FILLED), so discovery happens via getOrderById (stable id, a
      // READ), never via a new placeOrder submission.
      adapter = {
        setMode: jest.fn(),
        connect: jest.fn().mockResolvedValue({ success: true }),
        listOrders: jest.fn().mockResolvedValue([]),
        getOpenPositions: jest.fn().mockResolvedValue([]),
        getAccountInfo: jest.fn().mockResolvedValue({
          accountId: 'a',
          currency: 'USD',
          leverage: 100,
          balance: '10000.00',
          equity: '10000.00',
          margin: '0.00',
          freeMargin: '10000.00',
          marginLevel: '0.00',
        }),
        getPositionById: jest.fn().mockResolvedValue(null),
        getClosedTrades: jest.fn().mockResolvedValue([]),
        getOrderById: jest
          .fn()
          .mockResolvedValue(
            providerOrder({ status: 'FILLED', filledQuantity: '1.0000', avgFillPrice: '1.10000' }),
          ),
        placeOrder: jest.fn(),
        closeOrder: jest.fn(),
      };

      orderRepo = {
        find: jest.fn().mockResolvedValue([pendingOrder()]),
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue([]),
        }),
      };

      // OrderService is mocked exactly like reconciliation-resolution.service
      // .spec.ts (the resolution service's contract harness): the missed fill
      // delta is applied through applyFill, and the pending state resolves to
      // the provider-observed terminal state.
      orderService = {
        resolveReconciliation: jest
          .fn()
          .mockResolvedValue(baseOrder({ status: OrderStatus.FILLED, filledQuantity: '1.0000' })),
        resolveReconciliationFillState: jest
          .fn()
          .mockResolvedValue(baseOrder({ status: OrderStatus.FILLED, filledQuantity: '1.0000' })),
        applyFill: jest
          .fn()
          .mockResolvedValue(baseOrder({ status: OrderStatus.FILLED, filledQuantity: '1.0000' })),
        findByTradeId: jest.fn().mockResolvedValue(null),
      };

      const tradeRepo = {
        find: jest.fn().mockResolvedValue([]),
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue([]),
        }),
      };
      const accountRepo = {
        findOne: jest.fn().mockResolvedValue(null),
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue([]),
        }),
      };
      const brokerService = {
        applyProviderAccountSnapshot: jest.fn().mockResolvedValue(undefined),
        findConnectionsByIds: jest.fn().mockResolvedValue([]),
      };
      const persistence = {
        createRun: jest
          .fn()
          .mockResolvedValue({ id: 'run-1', status: ReconciliationRunStatus.RUNNING }),
        completeRun: jest.fn().mockResolvedValue(undefined),
        failRun: jest.fn().mockResolvedValue(undefined),
        persistDiscrepancies: jest
          .fn()
          .mockResolvedValue({ inserted: 0, refreshed: 0, newRows: [] }),
        resolveDiscrepanciesByRef: jest.fn().mockResolvedValue([]),
        countOpenDiscrepancies: jest.fn().mockResolvedValue(0),
      };
      const auditMock = { log: jest.fn().mockResolvedValue(undefined) };
      auditService = auditMock;
      const eventBus = { publish: jest.fn() };

      const module = await Test.createTestingModule({
        providers: [
          StateReconciliationService,
          ReconciliationResolutionService,
          { provide: TRADE_REPO, useValue: tradeRepo },
          { provide: ORDER_REPO, useValue: orderRepo },
          { provide: ACCOUNT_REPO, useValue: accountRepo },
          { provide: BrokerService, useValue: brokerService },
          {
            provide: BrokerAdapterRegistry,
            useValue: { getAdapterForConnection: jest.fn().mockReturnValue(adapter) },
          },
          { provide: CredentialEncryptionService, useValue: { decrypt: jest.fn() } },
          { provide: ReconciliationPersistenceService, useValue: persistence },
          { provide: OrderService, useValue: orderService },
          { provide: AuditService, useValue: auditService },
          { provide: DomainEventBus, useValue: eventBus },
        ],
      }).compile();
      service = module.get(StateReconciliationService);
    });

    it('converges idempotently to the provider state with NO second provider order submission', async () => {
      // ── Run 1: discovery + convergence ───────────────────────────────────
      const first = await service.runForConnection(connection());

      // Discovery is a READ by stable identifier (Directive §26) — the
      // adapter surfaces touched are listOrders/getOrderById ONLY.
      expect(adapter.getOrderById).toHaveBeenCalledWith('ticket-1');
      expect(adapter.listOrders).toHaveBeenCalled();
      // NO second provider order submission — ever. An uncertain write is
      // resolved by reading provider truth, never by resending.
      expect(adapter.placeOrder).not.toHaveBeenCalled();
      expect(adapter.closeOrder).not.toHaveBeenCalled();

      // The internal order converged onto the provider-observed FILLED state:
      // the missed fill delta is applied through the exact-decimal path...
      expect(orderService.applyFill).toHaveBeenCalledWith('order-1', {
        quantity: '1',
        price: '1.10000',
        providerOrderId: 'ticket-1',
      });
      // CORRECTION ROUND 4 (finding 7): applyFill is the FILL-BEARING
      // authority — the atomic delta application itself transitions
      // RECONCILIATION_PENDING → FILLED with its economic facts. The old
      // status-only resolveReconciliation(FILLED) follow-up call threw by
      // design in production and is REMOVED: exactly ONE fill-bearing
      // convergence write, no status-only invention of economic facts.
      expect(orderService.applyFill).toHaveBeenCalledTimes(1);
      expect(orderService.resolveReconciliation).not.toHaveBeenCalledWith(
        'order-1',
        OrderStatus.FILLED,
        expect.anything(),
      );
      expect(orderService.resolveReconciliationFillState).not.toHaveBeenCalled();

      // Convergence evidence: ORDER_RECONCILED audit carrying the applied
      // provider state.
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ORDER_RECONCILED,
          metadata: expect.objectContaining({ resolution: 'Provider state FILLED applied' }),
        }),
      );
      expect(first.errors).toBe(0);
      expect(first.status).toBe(ReconciliationRunStatus.COMPLETED);

      // ── Run 2: idempotent — the converged order is terminal and excluded ─
      // FILLED is terminal → not in RECONCILABLE_ORDER_STATUSES → the run has
      // nothing left to mutate and nothing to re-submit.
      orderRepo.find.mockResolvedValue([]);
      const second = await service.runForConnection(connection());

      expect(second.errors).toBe(0);
      expect(orderService.applyFill).toHaveBeenCalledTimes(1);
      // Correction round 4 (finding 7): the FILLED convergence is performed
      // by applyFill (the fill-bearing authority); the status-only
      // resolveReconciliation(FILLED) follow-up is REMOVED.
      expect(orderService.resolveReconciliation).not.toHaveBeenCalledWith(
        'order-1',
        OrderStatus.FILLED,
        expect.anything(),
      );
      expect(adapter.getOrderById).toHaveBeenCalledTimes(1);
      expect(adapter.placeOrder).not.toHaveBeenCalled();
    });
  });

  // ─── H. Concurrent resolutions → exactly ONE authoritative convergence ────
  //
  // Implemented at the RESOLUTION-SERVICE level: a full concurrent pair of
  // StateReconciliationService runs would need advisory-lock/persistence
  // modeling for §30 run serialization (impractical at this harness level) —
  // the authoritative single-writer proof lives in
  // ReconciliationResolutionService + OrderService's optimistic-concurrency
  // contract, exercised here directly with two racing resolvers.
  describe('H. concurrent reconciliation of the same order → exactly ONE authoritative convergence (state-machine/CAS)', () => {
    let service: ReconciliationResolutionService;
    let orderService: {
      resolveReconciliation: jest.Mock;
      applyFill: jest.Mock;
      findByTradeId: jest.Mock;
    };
    let auditService: { log: jest.Mock };
    let eventBus: { publish: jest.Mock };

    beforeEach(async () => {
      const tradeRepo = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
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

    const orderReconciledAudits = (): number =>
      auditService.log.mock.calls
        .map((c) => c[0] as { action?: AuditAction })
        .filter((entry) => entry.action === AuditAction.ORDER_RECONCILED).length;

    it('provider FILLED: two racing resolvers → exactly ONE terminal transition; the loser fails loudly, never double-applies', async () => {
      // In-memory model of the order ROW carrying the real OrderService
      // optimistic-concurrency contract: applyFill is a conditional
      // UPDATE ... WHERE status is fillable — a stale contender gets 0 rows
      // → ConflictException, never a second mutation.
      let orderRow = baseOrder({
        status: OrderStatus.RECONCILIATION_PENDING,
        filledQuantity: '0.0000',
      });
      const terminalWrites: OrderStatus[] = [];

      orderService.applyFill.mockImplementation(
        async (
          orderId: string,
          fill: { quantity: string; price: string; providerOrderId?: string | null },
        ) => {
          if (!OrderStateMachine.isFillable(orderRow.status)) {
            throw new ConflictException(
              `Order ${orderId} is not fillable (status: ${orderRow.status})`,
            );
          }
          const filled = addDecimal(orderRow.filledQuantity, fill.quantity);
          orderRow = {
            ...orderRow,
            filledQuantity: filled,
            avgFillPrice: fill.price,
            providerOrderId: fill.providerOrderId ?? orderRow.providerOrderId,
            status:
              filled === orderRow.requestedQuantity
                ? OrderStatus.FILLED
                : OrderStatus.PARTIALLY_FILLED,
          };
          if (orderRow.status === OrderStatus.FILLED) terminalWrites.push(OrderStatus.FILLED);
          return orderRow;
        },
      );
      orderService.resolveReconciliation.mockImplementation(async () => orderRow);

      // Both resolvers hold the SAME stale RECONCILIATION_PENDING snapshot
      // (e.g. the scheduled job and an operator-triggered run overlapped).
      const staleSnapshot = baseOrder({
        status: OrderStatus.RECONCILIATION_PENDING,
        filledQuantity: '0.0000',
      });
      const provider = providerOrder({
        status: 'FILLED',
        filledQuantity: '1.0000',
        avgFillPrice: '1.10000',
      });

      const results = await Promise.allSettled([
        service.resolveOrderFromProviderState(staleSnapshot, provider),
        service.resolveOrderFromProviderState(staleSnapshot, provider),
      ]);

      // Both resolvers RACED (two fill attempts)...
      expect(orderService.applyFill).toHaveBeenCalledTimes(2);
      // ...but exactly ONE authoritative terminal transition was written.
      expect(terminalWrites).toEqual([OrderStatus.FILLED]);
      expect(orderRow.status).toBe(OrderStatus.FILLED);
      // The fill was applied ONCE — a doubled convergence would have produced
      // 2.0000 lots on a 1.0000-lot order.
      expect(orderRow.filledQuantity).toBe('1.0000');

      // One winner, one LOUD loser (ConflictException — surfaced, retried
      // next run; never silently swallowed, never double-applied).
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictException);

      // Exactly ONE convergence audit — the loser never reached the audit path.
      expect(orderReconciledAudits()).toBe(1);
    });

    it('provider CANCELLED: two racing resolvers → exactly ONE terminal transition (guarded resolveReconciliation)', async () => {
      let orderRow = baseOrder({ status: OrderStatus.RECONCILIATION_PENDING });
      const terminalWrites: OrderStatus[] = [];

      orderService.resolveReconciliation.mockImplementation(
        async (orderId: string, target: OrderStatus) => {
          // conditional UPDATE ... WHERE status = RECONCILIATION_PENDING —
          // the resolver that lost the race gets 0 rows → ConflictException.
          if (orderRow.status !== OrderStatus.RECONCILIATION_PENDING) {
            throw new ConflictException(`Order ${orderId} state changed concurrently — retry`);
          }
          orderRow = { ...orderRow, status: target };
          if (OrderStateMachine.isTerminal(target)) terminalWrites.push(target);
          return orderRow;
        },
      );

      const staleSnapshot = baseOrder({ status: OrderStatus.RECONCILIATION_PENDING });
      const provider = providerOrder({ status: 'CANCELLED' });

      const results = await Promise.allSettled([
        service.resolveOrderFromProviderState(staleSnapshot, provider),
        service.resolveOrderFromProviderState(staleSnapshot, provider),
      ]);

      // Exactly ONE transition to the terminal state was written.
      expect(terminalWrites).toEqual([OrderStatus.CANCELLED]);
      expect(orderRow.status).toBe(OrderStatus.CANCELLED);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ConflictException);
      // Exactly ONE convergence audit — the loser never reached the audit path.
      expect(orderReconciledAudits()).toBe(1);
    });
  });
});
