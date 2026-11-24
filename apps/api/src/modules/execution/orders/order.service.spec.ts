import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Order } from './order.entity';
import { OrderKind, OrderStatus, OrderTimeInForce } from './order.enums';
import { OrderService, SubmitOrderInput } from './order.service';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseInput: SubmitOrderInput = {
  userId: '11111111-1111-1111-1111-111111111111',
  brokerConnectionId: '22222222-2222-2222-2222-222222222222',
  clientOrderId: 'web-order-001',
  orderKind: OrderKind.MARKET,
  timeInForce: OrderTimeInForce.IOC,
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedQuantity: '0.5000',
  requestedPrice: null,
  stopPrice: null,
};

function rawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    user_id: baseInput.userId,
    broker_connection_id: baseInput.brokerConnectionId,
    trade_id: null,
    signal_id: null,
    client_order_id: baseInput.clientOrderId,
    idempotency_key: 'key-1',
    provider_order_id: null,
    order_kind: OrderKind.MARKET,
    time_in_force: OrderTimeInForce.IOC,
    instrument: 'EURUSD',
    direction: 'BUY',
    requested_quantity: '0.5000',
    requested_price: null,
    stop_price: null,
    filled_quantity: '0',
    avg_fill_price: null,
    status: OrderStatus.CREATED,
    reject_reason: null,
    submitted_at: null,
    finalized_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function entity(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    userId: baseInput.userId,
    brokerConnectionId: baseInput.brokerConnectionId,
    tradeId: null,
    signalId: null,
    clientOrderId: baseInput.clientOrderId,
    idempotencyKey: 'key-1',
    providerOrderId: null,
    orderKind: OrderKind.MARKET,
    timeInForce: OrderTimeInForce.IOC,
    instrument: 'EURUSD',
    direction: 'BUY',
    requestedQuantity: '0.5000',
    requestedPrice: null,
    stopPrice: null,
    filledQuantity: '0',
    avgFillPrice: null,
    status: OrderStatus.CREATED,
    rejectReason: null,
    submittedAt: null,
    finalizedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Order;
}

/** Mock DataSource whose transaction() invokes the callback with a fake manager. */
function mockDataSource(
  managerQuery: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
) {
  const manager = { query: managerQuery };
  return {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    query: managerQuery,
  } as unknown as DataSource;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('OrderService', () => {
  let service: OrderService;
  let orderRepo: { findOne: jest.Mock; find: jest.Mock; update: jest.Mock };
  let dataSource: DataSource;

  beforeEach(async () => {
    orderRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    dataSource = mockDataSource(async () => []);
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        OrderService,
        { provide: getRepositoryToken(Order), useValue: orderRepo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = moduleRef.get(OrderService);
  });

  // ─── submitOrder validation (fail-closed) ────────────────────────────────

  describe('submitOrder — input validation', () => {
    it('rejects missing clientOrderId', async () => {
      await expect(service.submitOrder({ ...baseInput, clientOrderId: '' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('rejects clientOrderId with illegal characters/spaces', async () => {
      await expect(
        service.submitOrder({ ...baseInput, clientOrderId: 'order id with spaces!' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown orderKind', async () => {
      await expect(
        service.submitOrder({ ...baseInput, orderKind: 'UNKNOWN' as OrderKind }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown timeInForce', async () => {
      await expect(
        service.submitOrder({ ...baseInput, timeInForce: 'GTD' as OrderTimeInForce }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects non-positive quantity', async () => {
      await expect(service.submitOrder({ ...baseInput, requestedQuantity: '0' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.submitOrder({ ...baseInput, requestedQuantity: '-1.5' }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.submitOrder({ ...baseInput, requestedQuantity: '0.12345' }),
      ).rejects.toThrow(BadRequestException); // scale > 4
    });

    it('LIMIT requires requestedPrice; MARKET must not carry one', async () => {
      await expect(
        service.submitOrder({ ...baseInput, orderKind: OrderKind.LIMIT, requestedPrice: null }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.submitOrder({ ...baseInput, orderKind: OrderKind.MARKET, requestedPrice: '1.08' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('STOP requires stopPrice and must not carry requestedPrice', async () => {
      await expect(
        service.submitOrder({ ...baseInput, orderKind: OrderKind.STOP, stopPrice: null }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.submitOrder({
          ...baseInput,
          orderKind: OrderKind.STOP,
          requestedPrice: '1.08',
          stopPrice: null,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('STOP_LIMIT requires BOTH prices', async () => {
      await expect(
        service.submitOrder({
          ...baseInput,
          orderKind: OrderKind.STOP_LIMIT,
          requestedPrice: '1.085',
          stopPrice: null,
        }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.submitOrder({
          ...baseInput,
          orderKind: OrderKind.STOP_LIMIT,
          requestedPrice: null,
          stopPrice: '1.090',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── submitOrder idempotency (exactly-once) ──────────────────────────────

  describe('submitOrder — idempotency', () => {
    it('returns RESERVED_NEW on first submission and persists via transaction', async () => {
      const query = jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.startsWith('SELECT * FROM trading.orders')) return [];
        if (sql.startsWith('INSERT INTO trading.orders')) return [rawRow()];
        return [];
      });
      (dataSource as unknown as { transaction: jest.Mock }).transaction.mockImplementationOnce(
        async (cb: (m: unknown) => Promise<unknown>) =>
          cb({ query: (s: string, p?: unknown[]) => query(s, p) }),
      );

      const result = await service.submitOrder(baseInput);

      expect(result.status).toBe('RESERVED_NEW');
      expect(result.order.id).toBe('order-1');
      expect(query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock($1)',
        expect.arrayContaining([expect.any(Number)]),
      );
    });

    it('returns DUPLICATE_EXISTING when the idempotency key already exists (SELECT hit)', async () => {
      const query = jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.startsWith('SELECT * FROM trading.orders')) return [rawRow({ status: 'FILLED' })];
        return [];
      });
      (dataSource as unknown as { transaction: jest.Mock }).transaction.mockImplementationOnce(
        async (cb: (m: unknown) => Promise<unknown>) =>
          cb({ query: (s: string, p?: unknown[]) => query(s, p) }),
      );

      const result = await service.submitOrder(baseInput);
      expect(result.status).toBe('DUPLICATE_EXISTING');
      expect(result.order.status).toBe(OrderStatus.FILLED);
    });

    it('catches SQLSTATE 23505 on INSERT and returns DUPLICATE_EXISTING', async () => {
      let insertAttempted = false;
      const existing = rawRow({ status: OrderStatus.ACKNOWLEDGED });
      const query = jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.startsWith('SELECT * FROM trading.orders')) {
          if (!insertAttempted) return []; // first SELECT sees nothing
          return [existing]; // post-23505 SELECT sees the winner
        }
        if (sql.startsWith('INSERT INTO trading.orders')) {
          insertAttempted = true;
          const err = new Error('duplicate key value violates unique constraint') as Error & {
            code: string;
          };
          err.code = '23505';
          throw err;
        }
        return [];
      });
      (dataSource as unknown as { transaction: jest.Mock }).transaction.mockImplementation(
        async (cb: (m: unknown) => Promise<unknown>) =>
          cb({ query: (s: string, p?: unknown[]) => query(s, p) }),
      );

      const result = await service.submitOrder(baseInput);
      expect(result.status).toBe('DUPLICATE_EXISTING');
      expect(result.order.status).toBe(OrderStatus.ACKNOWLEDGED);
    });

    it('propagates non-unique-constraint INSERT errors (fail-closed)', async () => {
      const query = jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.startsWith('SELECT * FROM trading.orders')) return [];
        if (sql.startsWith('INSERT INTO trading.orders')) {
          throw new Error('connection refused');
        }
        return [];
      });
      (dataSource as unknown as { transaction: jest.Mock }).transaction.mockImplementationOnce(
        async (cb: (m: unknown) => Promise<unknown>) =>
          cb({ query: (s: string, p?: unknown[]) => query(s, p) }),
      );

      await expect(service.submitOrder(baseInput)).rejects.toThrow('connection refused');
    });
  });

  // ─── Lifecycle transitions ───────────────────────────────────────────────

  describe('markSubmitted / markAcknowledged', () => {
    it('CREATED → SUBMITTED stamps submitted_at', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.CREATED }));
      orderRepo.findOne.mockResolvedValueOnce(
        entity({ status: OrderStatus.SUBMITTED, submittedAt: new Date() }),
      );

      const updated = await service.markSubmitted('order-1', 'prov-123');
      expect(updated.status).toBe(OrderStatus.SUBMITTED);
      expect(orderRepo.update).toHaveBeenCalledWith(
        { id: 'order-1', status: OrderStatus.CREATED },
        expect.objectContaining({ status: OrderStatus.SUBMITTED, submittedAt: expect.any(Date) }),
      );
    });

    it('markAcknowledged requires a providerOrderId', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.SUBMITTED }));
      await expect(service.markAcknowledged('order-1', '')).rejects.toThrow(BadRequestException);
    });

    it('SUBMITTED → ACKNOWLEDGED records the provider order id', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.SUBMITTED }));
      orderRepo.findOne.mockResolvedValueOnce(
        entity({ status: OrderStatus.ACKNOWLEDGED, providerOrderId: 'prov-123' }),
      );
      const updated = await service.markAcknowledged('order-1', 'prov-123');
      expect(updated.providerOrderId).toBe('prov-123');
    });
  });

  describe('reject / cancel / expire — terminal transitions', () => {
    it('rejects with a required reason and stamps finalized_at', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.SUBMITTED }));
      orderRepo.findOne.mockResolvedValueOnce(
        entity({ status: OrderStatus.REJECTED, rejectReason: 'no margin' }),
      );
      const updated = await service.rejectOrder('order-1', 'no margin');
      expect(updated.status).toBe(OrderStatus.REJECTED);
      expect(orderRepo.update).toHaveBeenCalledWith(
        { id: 'order-1', status: OrderStatus.SUBMITTED },
        expect.objectContaining({
          status: OrderStatus.REJECTED,
          finalizedAt: expect.any(Date),
          rejectReason: 'no margin',
        }),
      );
    });

    it('rejectOrder without a reason throws BadRequest', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.SUBMITTED }));
      await expect(service.rejectOrder('order-1', '   ')).rejects.toThrow(BadRequestException);
    });

    it('rejects from a terminal state throw (machine-guarded)', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.FILLED }));
      await expect(service.rejectOrder('order-1', 'late')).rejects.toThrow(
        'Invalid order transition: FILLED → REJECTED',
      );
    });

    it('cancel from CREATED is legal (cancel before submission)', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.CREATED }));
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.CANCELLED }));
      const updated = await service.cancelOrder('order-1', 'user request');
      expect(updated.status).toBe(OrderStatus.CANCELLED);
    });

    it('expire stamps finalized_at', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.ACKNOWLEDGED }));
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.EXPIRED }));
      const updated = await service.expireOrder('order-1');
      expect(updated.status).toBe(OrderStatus.EXPIRED);
    });
  });

  describe('reconciliation transitions', () => {
    it('SUBMITTED → RECONCILIATION_PENDING is legal', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.SUBMITTED }));
      orderRepo.findOne.mockResolvedValueOnce(
        entity({ status: OrderStatus.RECONCILIATION_PENDING }),
      );
      const updated = await service.markReconciliationPending('order-1');
      expect(updated.status).toBe(OrderStatus.RECONCILIATION_PENDING);
    });

    it('resolveReconciliation rejects fill-bearing targets before persistence', async () => {
      await expect(service.resolveReconciliation('order-1', OrderStatus.FILLED)).rejects.toThrow(
        /applyFill/,
      );
      await expect(
        service.resolveReconciliation('order-1', OrderStatus.PARTIALLY_FILLED),
      ).rejects.toThrow(/applyFill/);
      expect(orderRepo.findOne).not.toHaveBeenCalled();
      expect(orderRepo.update).not.toHaveBeenCalled();
    });

    it('resolveReconciliation rejects an illegal target (machine-guarded)', async () => {
      orderRepo.findOne.mockResolvedValueOnce(
        entity({ status: OrderStatus.RECONCILIATION_PENDING }),
      );
      await expect(service.resolveReconciliation('order-1', OrderStatus.SUBMITTED)).rejects.toThrow(
        'Invalid order transition',
      );
    });
  });

  describe('concurrent modification (optimistic concurrency)', () => {
    it('throws ConflictException when the conditional UPDATE affects 0 rows', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.CREATED }));
      orderRepo.update.mockResolvedValueOnce({ affected: 0 });
      await expect(service.markSubmitted('order-1')).rejects.toThrow(ConflictException);
    });
  });

  // ─── applyFill ───────────────────────────────────────────────────────────

  describe('applyFill — atomic exact-decimal fill accounting', () => {
    it('validates fill quantity/price (fail-closed)', async () => {
      orderRepo.findOne.mockResolvedValue(entity({ status: OrderStatus.ACKNOWLEDGED }));
      await expect(service.applyFill('order-1', { quantity: '0', price: '1.1' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.applyFill('order-1', { quantity: '0.1', price: '0' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(
        service.applyFill('order-1', { quantity: '0.12345', price: '1.1' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFound for an unknown order', async () => {
      orderRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.applyFill('missing', { quantity: '0.1', price: '1.1' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects fills on non-fillable states (machine-guarded)', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.CREATED }));
      await expect(service.applyFill('order-1', { quantity: '0.1', price: '1.1' })).rejects.toThrow(
        ConflictException,
      );

      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.FILLED }));
      await expect(service.applyFill('order-1', { quantity: '0.1', price: '1.1' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('applies a fill via atomic numeric SQL with optimistic concurrency', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.ACKNOWLEDGED }));
      const query = jest.fn(async (_sql: string, _params?: unknown[]) => [
        rawRow({
          status: OrderStatus.PARTIALLY_FILLED,
          filled_quantity: '0.2000',
          avg_fill_price: '1.10000000',
        }),
      ]);
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const updated = await service.applyFill('order-1', {
        quantity: '0.2000',
        price: '1.10000000',
        providerOrderId: 'prov-9',
      });
      expect(updated.status).toBe(OrderStatus.PARTIALLY_FILLED);
      expect(updated.filledQuantity).toBe('0.2000');

      const [sql, params] = query.mock.calls[0];
      expect(sql).toContain('avg_fill_price * filled_quantity');
      expect(params).toEqual(
        expect.arrayContaining(['order-1', '0.2000', '1.10000000', 'prov-9', 'ACKNOWLEDGED']),
      );
    });

    it('persists native position and deal identifiers alongside the fill (identity separation)', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.ACKNOWLEDGED }));
      const query = jest.fn(async (_sql: string, _params?: unknown[]) => [
        rawRow({
          status: OrderStatus.FILLED,
          filled_quantity: '0.5000',
          avg_fill_price: '1.08500000',
          provider_position_id: 'pos-77',
          provider_deal_id: 'deal-951',
        }),
      ]);
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const updated = await service.applyFill('order-1', {
        quantity: '0.5000',
        price: '1.08500000',
        providerOrderId: 'order-951',
        providerPositionId: 'pos-77',
        providerDealId: 'deal-951',
      });
      // The deal-attribution pre-check (SELECT) runs first; the UPDATE is the
      // second query call.
      const [sql, params] = query.mock.calls[1];
      expect(sql).toContain('provider_position_id = COALESCE($6, provider_position_id)');
      expect(sql).toContain('provider_deal_id = COALESCE($7, provider_deal_id)');
      expect(params).toEqual(
        expect.arrayContaining([
          'order-1',
          '0.5000',
          '1.08500000',
          'order-951',
          'ACKNOWLEDGED',
          'pos-77',
          'deal-951',
        ]),
      );
      expect(updated.providerPositionId).toBe('pos-77');
      expect(updated.providerDealId).toBe('deal-951');
    });

    it("unwraps TypeORM's [rows, rowCount] UPDATE shape (real-PG driver contract)", async () => {
      // TypeORM's Postgres driver returns [rows, rowCount] for UPDATE queries
      // even with RETURNING * — the hydrated result must still be the row.
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.ACKNOWLEDGED }));
      (dataSource as unknown as { query: jest.Mock }).query = jest.fn(
        async (_sql: string, _params?: unknown[]) => [
          [
            rawRow({
              status: OrderStatus.FILLED,
              filled_quantity: '0.5000',
              avg_fill_price: '1.08500000',
              provider_order_id: 'prov-77',
            }),
          ],
          1,
        ],
      );

      const updated = await service.applyFill('order-1', {
        quantity: '0.5000',
        price: '1.08500000',
        providerOrderId: 'prov-77',
      });
      expect(updated.id).toBe('order-1');
      expect(updated.status).toBe(OrderStatus.FILLED);
      expect(updated.filledQuantity).toBe('0.5000');
      expect(updated.providerOrderId).toBe('prov-77');
    });

    it('overfill (0 rows affected, still fillable) fails closed with Conflict', async () => {
      orderRepo.findOne
        .mockResolvedValueOnce(
          entity({ status: OrderStatus.ACKNOWLEDGED, filledQuantity: '0.4000' }),
        )
        .mockResolvedValueOnce(
          entity({ status: OrderStatus.ACKNOWLEDGED, filledQuantity: '0.4000' }),
        );
      (dataSource as unknown as { query: jest.Mock }).query = jest.fn(
        async (_sql: string, _params?: unknown[]) => [],
      );

      await expect(
        service.applyFill('order-1', { quantity: '0.2000', price: '1.1' }),
      ).rejects.toThrow(/exceeds remaining quantity/);
    });

    it('concurrent state change (0 rows, no longer fillable) throws Conflict', async () => {
      orderRepo.findOne
        .mockResolvedValueOnce(entity({ status: OrderStatus.ACKNOWLEDGED }))
        .mockResolvedValueOnce(entity({ status: OrderStatus.CANCELLED }));
      (dataSource as unknown as { query: jest.Mock }).query = jest.fn(
        async (_sql: string, _params?: unknown[]) => [],
      );

      await expect(service.applyFill('order-1', { quantity: '0.1', price: '1.1' })).rejects.toThrow(
        /state changed concurrently/,
      );
    });
  });

  // ─── applyFill — native deal attribution guards (duplicate-deal prevention) ──

  describe('applyFill — native deal attribution guards', () => {
    it('ignores a duplicate fill for a provider deal already booked on THIS order (idempotent no-op)', async () => {
      orderRepo.findOne.mockResolvedValueOnce(
        entity({
          status: OrderStatus.PARTIALLY_FILLED,
          providerDealId: 'deal-951',
          filledQuantity: '0.2500',
          avgFillPrice: '1.10000000',
        }),
      );
      const query = jest.fn(async () => [rawRow({})]);
      (dataSource as unknown as { query: jest.Mock }).query = query;

      // The SAME broker deal event delivered a second time (duplicate
      // provider event / repeated reconciliation) must never book twice.
      const unchanged = await service.applyFill('order-1', {
        quantity: '0.2500',
        price: '1.10000000',
        providerDealId: 'deal-951',
      });
      expect(query).not.toHaveBeenCalled(); // no second UPDATE — no double fill
      expect(unchanged.providerDealId).toBe('deal-951');
      expect(unchanged.filledQuantity).toBe('0.2500');
    });

    it('refuses to book a provider deal already attributed to a DIFFERENT order row', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.ACKNOWLEDGED }));
      const query = jest.fn();
      query.mockResolvedValueOnce([{ id: 'order-other' }]); // findDealOwner hit
      (dataSource as unknown as { query: jest.Mock }).query = query;

      await expect(
        service.applyFill('order-1', {
          quantity: '0.5000',
          price: '1.10000000',
          providerDealId: 'deal-951',
        }),
      ).rejects.toThrow(/already attributed to order order-other/);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
      expect(sql).toContain('SELECT id FROM trading.orders');
      expect(sql).toContain('provider_deal_id = $2');
      expect(params).toEqual(expect.arrayContaining([baseInput.brokerConnectionId, 'deal-951']));
    });

    it('translates a concurrent unique-index violation into a duplicate-attribution Conflict', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.ACKNOWLEDGED }));
      const query = jest.fn();
      query.mockResolvedValueOnce([]); // ownership pre-check: no current owner
      query.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        }),
      );
      (dataSource as unknown as { query: jest.Mock }).query = query;

      // A concurrent worker booked the same deal onto another row between the
      // pre-check and the UPDATE — the partial unique index refuses it and
      // the failure surfaces as an explicit duplicate-attribution conflict.
      const promise = service.applyFill('order-1', {
        quantity: '0.5000',
        price: '1.10000000',
        providerDealId: 'deal-951',
      });
      await expect(promise).rejects.toThrow(ConflictException);
      await expect(promise).rejects.toThrow(/concurrently attributed/);
    });

    it('findDealOwner resolves the owning order row for a native deal id', async () => {
      const query = jest.fn().mockResolvedValue([{ id: 'order-owner' }]);
      (dataSource as unknown as { query: jest.Mock }).query = query;

      await expect(service.findDealOwner(baseInput.brokerConnectionId, 'deal-9')).resolves.toBe(
        'order-owner',
      );
      expect(query).toHaveBeenCalledWith(expect.stringContaining('provider_deal_id = $2'), [
        baseInput.brokerConnectionId,
        'deal-9',
      ]);
    });

    it('findDealOwner returns null when no row owns the deal', async () => {
      const query = jest.fn().mockResolvedValue([]);
      (dataSource as unknown as { query: jest.Mock }).query = query;

      await expect(
        service.findDealOwner(baseInput.brokerConnectionId, 'deal-9'),
      ).resolves.toBeNull();
    });
  });

  // ─── Reads ───────────────────────────────────────────────────────────────

  describe('reads', () => {
    it('findByClientOrderId resolves the derived idempotency key', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity());
      const found = await service.findByClientOrderId(baseInput.userId, 'web-order-001');
      expect(found).not.toBeNull();
      expect(orderRepo.findOne).toHaveBeenCalledWith({
        where: { idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/) },
      });
    });

    it('listOrdersByUser clamps the limit', async () => {
      await service.listOrdersByUser(baseInput.userId, 5000);
      expect(orderRepo.find).toHaveBeenCalledWith(expect.objectContaining({ take: 200 }));
    });
  });
});
