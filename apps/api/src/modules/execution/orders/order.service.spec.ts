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

/** Mock DataSource whose transaction() invokes the callback with a fake
 *  manager that DELEGATES to the (reassignable) ds.query — applyFill now
 *  runs every statement (row lock, ledger dedup read, evidence INSERT,
 *  order-row UPDATE) through the transaction manager, so per-query mocks
 *  swapped onto dataSource.query must be visible inside the transaction. */
function mockDataSource(
  defaultQuery: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>,
) {
  const ds = {
    query: jest.fn(defaultQuery),
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) =>
      cb({ query: (sql: string, params?: unknown[]) => ds.query(sql, params) }),
    ),
  };
  return ds as unknown as DataSource;
}

/** All recorded query calls whose SQL contains the fragment (order kept). */
function callsMatching(query: { mock: { calls: unknown[][] } }, fragment: string) {
  return query.mock.calls.filter((call) => (call[0] as string).includes(fragment));
}

/** Statement-order facts for a recorded query mock (lock first; insert precedes update). */
function queryCallOrder(query: { mock: { calls: unknown[][] } }) {
  const firstIndex = (fragment: string) =>
    query.mock.calls.findIndex((call) => (call[0] as string).includes(fragment));
  const lastIndex = (fragment: string) => {
    for (let i = query.mock.calls.length - 1; i >= 0; i--) {
      if ((query.mock.calls[i]![0] as string).includes(fragment)) return i;
    }
    return -1;
  };
  return {
    lockFirst: firstIndex('FOR UPDATE') === 0,
    insertBeforeUpdate:
      lastIndex('INSERT INTO trading.order_fill_evidence') < lastIndex('UPDATE trading.orders'),
  };
}

/** Exact decimal addition on quantity strings (scale ≤ 4) — BigInt, never floats. */
function addQuantity(a: string, b: string): string {
  const toQ = (s: string): bigint => {
    const [i, f = ''] = s.split('.');
    return BigInt(i) * 10000n + BigInt((f + '0000').slice(0, 4));
  };
  const total = toQ(a) + toQ(b);
  const negative = total < 0n;
  const abs = (negative ? -total : total).toString().padStart(5, '0');
  return `${negative ? '-' : ''}${abs.slice(0, -4)}.${abs.slice(-4)}`;
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

    it('locks the order row first and applies a fill via atomic numeric SQL with optimistic concurrency', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.ACKNOWLEDGED }));
      const query = jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) {
          return [rawRow({ status: OrderStatus.ACKNOWLEDGED })];
        }
        if (sql.startsWith('INSERT INTO trading.order_fill_evidence')) {
          return [];
        }
        return [
          rawRow({
            status: OrderStatus.PARTIALLY_FILLED,
            filled_quantity: '0.2000',
            avg_fill_price: '1.10000000',
          }),
        ];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const updated = await service.applyFill('order-1', {
        quantity: '0.2000',
        price: '1.10000000',
        providerOrderId: 'prov-9',
      });
      expect(updated.status).toBe(OrderStatus.PARTIALLY_FILLED);
      expect(updated.filledQuantity).toBe('0.2000');

      // The row lock is the FIRST statement — concurrent fill accounting for
      // the same order is serialized before any ledger read or write.
      expect(query.mock.calls[0]![0]).toContain('FOR UPDATE');

      const [sql, params] = callsMatching(query, 'UPDATE trading.orders')[0]!;
      expect(sql).toContain('avg_fill_price * filled_quantity');
      expect(params).toEqual(
        expect.arrayContaining(['order-1', '0.2000', '1.10000000', 'prov-9', 'ACKNOWLEDGED']),
      );
    });

    it('persists native position and deal identifiers alongside the fill (identity separation, ledger row appended)', async () => {
      orderRepo.findOne.mockResolvedValueOnce(entity({ status: OrderStatus.ACKNOWLEDGED }));
      const query = jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) {
          return [rawRow({ status: OrderStatus.ACKNOWLEDGED })];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          return []; // no ledger row owns deal-951 yet
        }
        if (sql.startsWith('INSERT INTO trading.order_fill_evidence')) {
          return [];
        }
        return [
          rawRow({
            status: OrderStatus.FILLED,
            filled_quantity: '0.5000',
            avg_fill_price: '1.08500000',
            provider_position_id: 'pos-77',
            provider_deal_id: 'deal-951',
          }),
        ];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const updated = await service.applyFill('order-1', {
        quantity: '0.5000',
        price: '1.08500000',
        providerOrderId: 'order-951',
        providerPositionId: 'pos-77',
        providerDealId: 'deal-951',
      });
      // The ledger dedup read runs after the row lock; the order-row UPDATE
      // is the final statement of the transaction.
      const ledgerRead = callsMatching(query, 'provider_deal_id = $2');
      expect(ledgerRead).toHaveLength(1);
      expect(ledgerRead[0]![0]).toContain('provider_deal_id = $2');

      const insert = callsMatching(query, 'INSERT INTO trading.order_fill_evidence')[0]!;
      expect(insert[0]).toContain('evidence_class');
      expect(insert[1]).toEqual(
        expect.arrayContaining([
          'order-1',
          baseInput.brokerConnectionId,
          'deal-951',
          'order-951',
          'pos-77',
          '0.5000',
          '1.08500000',
          'PROVIDER_DEAL',
        ]),
      );

      const [sql, params] = callsMatching(query, 'UPDATE trading.orders')[0]!;
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
      const query = jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) {
          return [rawRow({ status: OrderStatus.ACKNOWLEDGED })];
        }
        if (sql.startsWith('INSERT INTO trading.order_fill_evidence')) {
          return [];
        }
        return [
          [
            rawRow({
              status: OrderStatus.FILLED,
              filled_quantity: '0.5000',
              avg_fill_price: '1.08500000',
              provider_order_id: 'prov-77',
            }),
          ],
          1,
        ];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

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

    it('overfill (0 rows affected, still fillable) fails closed with Conflict — evidence row rolls back with it', async () => {
      orderRepo.findOne
        .mockResolvedValueOnce(
          entity({ status: OrderStatus.ACKNOWLEDGED, filledQuantity: '0.4000' }),
        )
        .mockResolvedValueOnce(
          entity({ status: OrderStatus.ACKNOWLEDGED, filledQuantity: '0.4000' }),
        );
      const query = jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) {
          return [rawRow({ status: OrderStatus.ACKNOWLEDGED, filled_quantity: '0.4000' })];
        }
        if (sql.startsWith('INSERT INTO trading.order_fill_evidence')) {
          return [];
        }
        return []; // UPDATE matches 0 rows — overfill
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      await expect(
        service.applyFill('order-1', { quantity: '0.2000', price: '1.1' }),
      ).rejects.toThrow(/exceeds remaining quantity/);

      // All-or-nothing: the evidence INSERT ran inside the SAME transaction as
      // the refused UPDATE — the thrown Conflict rolls the whole transaction
      // back, so no accounting event survives a refused fill.
      const order = queryCallOrder(query as unknown as { mock: { calls: unknown[][] } });
      expect(order.insertBeforeUpdate).toBe(true);
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(1);
    });

    it('concurrent state change (0 rows, no longer fillable) throws Conflict', async () => {
      orderRepo.findOne
        .mockResolvedValueOnce(entity({ status: OrderStatus.ACKNOWLEDGED }))
        .mockResolvedValueOnce(entity({ status: OrderStatus.CANCELLED }));
      const query = jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) {
          return [rawRow({ status: OrderStatus.ACKNOWLEDGED })];
        }
        if (sql.startsWith('INSERT INTO trading.order_fill_evidence')) {
          return [];
        }
        return []; // UPDATE matches 0 rows — status CAS fails
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      await expect(service.applyFill('order-1', { quantity: '0.1', price: '1.1' })).rejects.toThrow(
        /state changed concurrently/,
      );
    });
  });

  // ─── applyFill — native deal attribution guards (duplicate-deal prevention) ──

  describe('applyFill — native deal attribution guards', () => {
    it('ignores a duplicate fill for a provider deal already booked on THIS order (ledger replay, idempotent no-op)', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({
          status: OrderStatus.PARTIALLY_FILLED,
          providerDealId: 'deal-951',
          filledQuantity: '0.2500',
          avgFillPrice: '1.10000000',
        }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [
            rawRow({
              status: OrderStatus.PARTIALLY_FILLED,
              provider_deal_id: 'deal-951',
              filled_quantity: '0.2500',
              avg_fill_price: '1.10000000',
            }),
          ];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          // the ledger remembers the booked deal — with its full economics
          // (contradiction detection compares against this row)
          return [
            {
              order_id: 'order-1',
              quantity: '0.2500',
              price: '1.10000000',
              provider_order_id: null,
              provider_position_id: null,
              evidence_class: 'PROVIDER_DEAL',
            },
          ];
        }
        return [rawRow({})];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      // The SAME broker deal event delivered a second time (duplicate
      // provider event / repeated or concurrent reconciliation) — identical
      // economics — must never book twice.
      const unchanged = await service.applyFill('order-1', {
        quantity: '0.2500',
        price: '1.10000000',
        providerDealId: 'deal-951',
      });
      // Row lock + ledger read — NO evidence INSERT, NO order-row UPDATE.
      expect(query).toHaveBeenCalledTimes(2);
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(0);
      expect(callsMatching(query, 'UPDATE trading.orders')).toHaveLength(0);
      expect(unchanged.providerDealId).toBe('deal-951');
      expect(unchanged.filledQuantity).toBe('0.2500');
    });

    it('ignores a duplicate fill known only through the legacy order-row pointer (pre-ledger population)', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({
          status: OrderStatus.PARTIALLY_FILLED,
          providerDealId: 'deal-951',
          filledQuantity: '0.2500',
          avgFillPrice: '1.10000000',
        }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [
            rawRow({
              status: OrderStatus.PARTIALLY_FILLED,
              provider_deal_id: 'deal-951',
              filled_quantity: '0.2500',
              avg_fill_price: '1.10000000',
            }),
          ];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          return []; // booked BEFORE the ledger existed — no row (never fabricated)
        }
        return [rawRow({})];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const unchanged = await service.applyFill('order-1', {
        quantity: '0.2500',
        price: '1.10000000',
        providerDealId: 'deal-951',
      });
      // Row lock + ledger read only — the legacy pointer prevented the rebook.
      expect(query).toHaveBeenCalledTimes(2);
      expect(callsMatching(query, 'UPDATE trading.orders')).toHaveLength(0);
      expect(unchanged.filledQuantity).toBe('0.2500');
    });

    it('refuses to book a provider deal already attributed to a DIFFERENT order row (ledger ownership)', async () => {
      orderRepo.findOne.mockResolvedValue(entity({ status: OrderStatus.ACKNOWLEDGED }));
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [rawRow({ status: OrderStatus.ACKNOWLEDGED })];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          return [{ order_id: 'order-other' }]; // ledger row on ANOTHER order
        }
        return [];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      await expect(
        service.applyFill('order-1', {
          quantity: '0.5000',
          price: '1.10000000',
          providerDealId: 'deal-951',
        }),
      ).rejects.toThrow(/already attributed to order order-other/);
      expect(query).toHaveBeenCalledTimes(2); // row lock + ledger read — refused before any write
      const [sql, params] = query.mock.calls[1] as unknown as [string, unknown[]];
      expect(sql).toContain('FROM trading.order_fill_evidence');
      expect(sql).toContain('provider_deal_id = $2');
      expect(params).toEqual(expect.arrayContaining([baseInput.brokerConnectionId, 'deal-951']));
    });

    it('translates a concurrent ledger unique-index violation (INSERT 23505) into a duplicate-attribution Conflict', async () => {
      orderRepo.findOne.mockResolvedValue(entity({ status: OrderStatus.ACKNOWLEDGED }));
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [rawRow({ status: OrderStatus.ACKNOWLEDGED })];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          return []; // ledger read: no committed owner YET
        }
        if (sql.startsWith('INSERT INTO trading.order_fill_evidence')) {
          // A concurrent worker booked the same deal onto another row between
          // the ledger read and this INSERT — the partial unique index
          // uq_order_fill_evidence_deal refuses it.
          throw Object.assign(new Error('duplicate key value violates unique constraint'), {
            code: '23505',
          });
        }
        return [];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const promise = service.applyFill('order-1', {
        quantity: '0.5000',
        price: '1.10000000',
        providerDealId: 'deal-951',
      });
      await expect(promise).rejects.toThrow(ConflictException);
      await expect(promise).rejects.toThrow(/concurrently attributed/);
    });

    it('findDealOwner resolves ownership from LEDGER evidence (complete historical evidence, finding 2)', async () => {
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FROM trading.order_fill_evidence')) {
          return [{ order_id: 'order-owner' }]; // the immutable ledger owns it
        }
        if (sql.includes('FROM trading.orders')) {
          return []; // no order-row pointer carries the deal
        }
        return [];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const lookup = await service.findDealOwner(baseInput.brokerConnectionId, 'deal-9');
      expect(lookup.orderId).toBe('order-owner');
      expect(lookup.ambiguous).toBe(false);
      expect(lookup.sources).toEqual(['LEDGER_EVIDENCE']);
      expect(lookup.candidateOrderIds).toEqual(['order-owner']);
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('FROM trading.order_fill_evidence'),
        [baseInput.brokerConnectionId, 'deal-9'],
      );
    });

    it('findDealOwner resolves the LEGACY population from the order-row pointer', async () => {
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FROM trading.order_fill_evidence')) {
          return []; // pre-ledger history — no ledger row
        }
        if (sql.includes('FROM trading.orders')) {
          return [{ id: 'order-legacy' }]; // ...but the latest-deal pointer does
        }
        return [];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const lookup = await service.findDealOwner(baseInput.brokerConnectionId, 'deal-9');
      expect(lookup.orderId).toBe('order-legacy');
      expect(lookup.ambiguous).toBe(false);
      expect(lookup.sources).toEqual(['ORDER_ROW_POINTER']);
    });

    it('findDealOwner reports AMBIGUITY when ledger evidence and a legacy pointer disagree (finding 2)', async () => {
      // The accounting-ownership assessment must reflect ALL available
      // historical evidence and report disagreement — never silently pick.
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FROM trading.order_fill_evidence')) {
          return [{ order_id: 'order-A' }];
        }
        if (sql.includes('FROM trading.orders')) {
          return [{ id: 'order-B' }];
        }
        return [];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const lookup = await service.findDealOwner(baseInput.brokerConnectionId, 'deal-9');
      expect(lookup.ambiguous).toBe(true);
      expect(lookup.orderId).toBeNull();
      expect(lookup.sources).toEqual(['LEDGER_EVIDENCE', 'ORDER_ROW_POINTER']);
      expect(lookup.candidateOrderIds).toEqual(['order-A', 'order-B']);
    });

    it('findDealOwner returns an explicit empty lookup when no evidence knows the deal', async () => {
      const query = jest.fn(async () => []);
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const lookup = await service.findDealOwner(baseInput.brokerConnectionId, 'deal-9');
      expect(lookup.orderId).toBeNull();
      expect(lookup.ambiguous).toBe(false);
      expect(lookup.sources).toEqual([]);
      expect(lookup.candidateOrderIds).toEqual([]);
    });
  });

  // ─── applyFill — duplicate deal delivery after FILLED ────────────────────

  describe('applyFill — duplicate deal delivery after a terminal state (FILLED)', () => {
    it('redelivery of the FINAL fill deal after FILLED is an idempotent no-op (not a fake conflict)', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({
          status: OrderStatus.FILLED,
          providerDealId: 'deal-final',
          filledQuantity: '0.5000',
          avgFillPrice: '1.08500000',
        }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [
            rawRow({
              status: OrderStatus.FILLED,
              provider_deal_id: 'deal-final',
              filled_quantity: '0.5000',
              avg_fill_price: '1.08500000',
            }),
          ];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          // The ledger retains the final fill's deal — with its economics
          return [
            {
              order_id: 'order-1',
              quantity: '0.5000',
              price: '1.08500000',
              provider_order_id: null,
              provider_position_id: null,
              evidence_class: 'PROVIDER_DEAL',
            },
          ];
        }
        return [rawRow({})];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      // The broker redelivered the final fill's deal event AFTER the order
      // had already reached FILLED (reconnect replay / repeated
      // reconciliation) — identical economics, must book NOTHING.
      const unchanged = await service.applyFill('order-1', {
        quantity: '0.5000',
        price: '1.08500000',
        providerDealId: 'deal-final',
      });
      expect(query).toHaveBeenCalledTimes(2); // row lock + ledger read only
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(0);
      expect(callsMatching(query, 'UPDATE trading.orders')).toHaveLength(0);
      expect(unchanged.status).toBe(OrderStatus.FILLED);
      expect(unchanged.filledQuantity).toBe('0.5000');
    });

    it('redelivery of an EARLIER partial fill deal after FILLED (ledger-retained identifier) is a no-op', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({
          status: OrderStatus.FILLED,
          providerDealId: 'deal-B',
          filledQuantity: '0.5000',
          avgFillPrice: '1.10000000',
        }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [
            rawRow({
              status: OrderStatus.FILLED,
              provider_deal_id: 'deal-B',
              filled_quantity: '0.5000',
              avg_fill_price: '1.10000000',
            }),
          ];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          // A: the earlier partial fill, retained by the immutable ledger
          return [
            {
              order_id: 'order-1',
              quantity: '0.2000',
              price: '1.10000000',
              provider_order_id: null,
              provider_position_id: null,
              evidence_class: 'PROVIDER_DEAL',
            },
          ];
        }
        return [rawRow({})];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const unchanged = await service.applyFill('order-1', {
        quantity: '0.2000',
        price: '1.10000000',
        providerDealId: 'deal-A',
      });
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(0);
      expect(callsMatching(query, 'UPDATE trading.orders')).toHaveLength(0);
      expect(unchanged.status).toBe(OrderStatus.FILLED);
      expect(unchanged.filledQuantity).toBe('0.5000');
    });

    it('redelivery via the LEGACY order-row pointer after FILLED (pre-ledger population) is a no-op', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({
          status: OrderStatus.FILLED,
          providerDealId: 'deal-legacy',
          filledQuantity: '0.5000',
          avgFillPrice: '1.10000000',
        }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [
            rawRow({
              status: OrderStatus.FILLED,
              provider_deal_id: 'deal-legacy',
              filled_quantity: '0.5000',
              avg_fill_price: '1.10000000',
            }),
          ];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          return []; // booked before the ledger existed — never fabricated
        }
        return [rawRow({})];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const unchanged = await service.applyFill('order-1', {
        quantity: '0.5000',
        price: '1.10000000',
        providerDealId: 'deal-legacy',
      });
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(0);
      expect(callsMatching(query, 'UPDATE trading.orders')).toHaveLength(0);
      expect(unchanged.status).toBe(OrderStatus.FILLED);
    });

    it('contradictory redelivery of a booked deal AFTER FILLED is refused (both facts stated)', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({
          status: OrderStatus.FILLED,
          providerDealId: 'deal-final',
          filledQuantity: '0.5000',
          avgFillPrice: '1.08500000',
        }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [
            rawRow({
              status: OrderStatus.FILLED,
              provider_deal_id: 'deal-final',
              filled_quantity: '0.5000',
              avg_fill_price: '1.08500000',
            }),
          ];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          return [
            {
              order_id: 'order-1',
              quantity: '0.5000',
              price: '1.08500000',
              provider_order_id: null,
              provider_position_id: null,
              evidence_class: 'PROVIDER_DEAL',
            },
          ];
        }
        return [];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      // The same native deal id redelivered with a DIFFERENT quantity after
      // FILLED — inconsistent financial data is never silently accepted,
      // not even on a terminal order.
      await expect(
        service.applyFill('order-1', {
          quantity: '0.6000',
          price: '1.08500000',
          providerDealId: 'deal-final',
        }),
      ).rejects.toThrow(/Contradictory accounting evidence/);
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(0);
      expect(callsMatching(query, 'UPDATE trading.orders')).toHaveLength(0);
    });

    it('a genuinely NEW deal delivered after FILLED fails closed (not booked evidence)', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({
          status: OrderStatus.FILLED,
          providerDealId: 'deal-final',
          filledQuantity: '0.5000',
          avgFillPrice: '1.08500000',
        }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [
            rawRow({
              status: OrderStatus.FILLED,
              provider_deal_id: 'deal-final',
              filled_quantity: '0.5000',
              avg_fill_price: '1.08500000',
            }),
          ];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          return []; // the delivered deal was never booked anywhere
        }
        return [];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      await expect(
        service.applyFill('order-1', {
          quantity: '0.1000',
          price: '1.08500000',
          providerDealId: 'deal-unknown',
        }),
      ).rejects.toThrow(/not fillable .* not booked evidence for this order/);
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(0);
      expect(callsMatching(query, 'UPDATE trading.orders')).toHaveLength(0);
    });
  });

  // ─── applyFill — state-premise fence ─────────────────────────────────────

  describe('applyFill — state-premise fence (concurrent unidentified evidence)', () => {
    it('a STALE premise (concurrent writer moved the accounting) makes the derived delivery an idempotent no-op', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({ status: OrderStatus.RECONCILIATION_PENDING, filledQuantity: '0' }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          // A concurrent sweep already booked its 0.3000 delta before this
          // worker's premise (0) was fenced under the lock.
          return [
            rawRow({
              status: OrderStatus.PARTIALLY_FILLED,
              filled_quantity: '0.3000',
              avg_fill_price: '1.10000000',
            }),
          ];
        }
        return [];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      // This worker derived the SAME state delta from a stale read — without
      // the fence it would have double-booked 0.3000.
      const unchanged = await service.applyFill(
        'order-1',
        { quantity: '0.3000', price: '1.10000000', providerOrderId: 'prov-1' },
        { expectedFilledQuantity: '0' },
      );
      expect(query).toHaveBeenCalledTimes(1); // row lock only — no writes at all
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(0);
      expect(callsMatching(query, 'UPDATE trading.orders')).toHaveLength(0);
      expect(unchanged.filledQuantity).toBe('0.3000');
      expect(unchanged.status).toBe(OrderStatus.PARTIALLY_FILLED);
    });

    it('a MATCHING premise books the state-derived fill normally (fence passes)', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({ status: OrderStatus.RECONCILIATION_PENDING, filledQuantity: '0' }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [rawRow({ status: OrderStatus.RECONCILIATION_PENDING, filled_quantity: '0' })];
        }
        if (sql.startsWith('INSERT INTO trading.order_fill_evidence')) {
          return [];
        }
        return [rawRow({ status: OrderStatus.PARTIALLY_FILLED, filled_quantity: '0.3000' })];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const booked = await service.applyFill(
        'order-1',
        { quantity: '0.3000', price: '1.10000000', providerOrderId: 'prov-1' },
        { expectedFilledQuantity: '0' },
      );
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(1);
      expect(callsMatching(query, 'UPDATE trading.orders')).toHaveLength(1);
      expect(booked.filledQuantity).toBe('0.3000');
    });

    it('the fence no-op also covers a concurrent writer that already FILLED the order', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({ status: OrderStatus.RECONCILIATION_PENDING, filledQuantity: '0' }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [
            rawRow({
              status: OrderStatus.FILLED,
              filled_quantity: '0.5000',
              avg_fill_price: '1.08500000',
            }),
          ];
        }
        return [];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const unchanged = await service.applyFill(
        'order-1',
        { quantity: '0.5000', price: '1.08500000', providerOrderId: 'prov-1' },
        { expectedFilledQuantity: '0' },
      );
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(0);
      expect(callsMatching(query, 'UPDATE trading.orders')).toHaveLength(0);
      expect(unchanged.status).toBe(OrderStatus.FILLED);
      expect(unchanged.filledQuantity).toBe('0.5000');
    });

    it('a fenced delivery on a terminal state with a FRESH premise still fails closed (new fill, not booked evidence)', async () => {
      orderRepo.findOne.mockResolvedValue(
        entity({ status: OrderStatus.CANCELLED, filledQuantity: '0' }),
      );
      const query = jest.fn(async (sql: string) => {
        if (sql.includes('FOR UPDATE')) {
          return [rawRow({ status: OrderStatus.CANCELLED, filled_quantity: '0' })];
        }
        return [];
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;

      await expect(
        service.applyFill(
          'order-1',
          { quantity: '0.3000', price: '1.10000000' },
          { expectedFilledQuantity: '0' },
        ),
      ).rejects.toThrow(/not fillable/);
      expect(callsMatching(query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(0);
    });

    it('combining the fence with a deal-grade delivery fails closed (contract violation)', async () => {
      orderRepo.findOne.mockResolvedValue(entity({ status: OrderStatus.ACKNOWLEDGED }));
      await expect(
        service.applyFill(
          'order-1',
          { quantity: '0.1', price: '1.1', providerDealId: 'deal-951' },
          { expectedFilledQuantity: '0' },
        ),
      ).rejects.toThrow(BadRequestException);
      (dataSource as unknown as { transaction: jest.Mock }).transaction.mockClear();
      expect(
        (dataSource as unknown as { transaction: jest.Mock }).transaction,
      ).not.toHaveBeenCalled();
    });

    it('a malformed premise fails closed (validation)', async () => {
      orderRepo.findOne.mockResolvedValue(entity({ status: OrderStatus.ACKNOWLEDGED }));
      await expect(
        service.applyFill(
          'order-1',
          { quantity: '0.1', price: '1.1' },
          { expectedFilledQuantity: 'not-a-number' },
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── applyFill — immutable per-fill evidence ledger ──────────────────────

  describe('applyFill — immutable per-fill evidence ledger (partial-fill replay defence)', () => {
    /**
     * Stateful in-memory model of the two tables applyFill touches —
     * trading.order_fill_evidence (append-only rows keyed by deal id) and
     * the trading.orders row (latest-deal pointer + filled_quantity). The
     * model mirrors the real statements' semantics (including the
     * LEGACY_BASELINE capture of finding 1) so the confirmed partial-fill
     * replay defect — and the mixed-era variants of it — are reproduced
     * honestly at the mock level.
     */
    function statefulLedgerModel(options?: {
      requestedQuantity?: string;
      ledgerSeed?: Array<{
        dealId: string;
        orderId: string;
        quantity?: string;
        price?: string;
        evidenceClass?: string;
        providerOrderId?: string | null;
        providerPositionId?: string | null;
      }>;
      preLedger?: {
        filledQuantity: string;
        avgFillPrice: string | null;
        providerDealId?: string | null;
      };
    }) {
      let orderRow = rawRow({
        status: OrderStatus.ACKNOWLEDGED,
        requested_quantity: options?.requestedQuantity ?? '0.5000',
        filled_quantity: options?.preLedger?.filledQuantity ?? '0',
        avg_fill_price: options?.preLedger?.avgFillPrice ?? null,
        provider_deal_id: options?.preLedger?.providerDealId ?? null,
      });
      const ledger: Array<{
        dealId: string | null;
        orderId: string;
        quantity: string;
        price: string;
        evidenceClass: string;
        providerOrderId: string | null;
        providerPositionId: string | null;
      }> = (options?.ledgerSeed ?? []).map((seed) => ({
        dealId: seed.dealId,
        orderId: seed.orderId,
        quantity: seed.quantity ?? '0.1000',
        price: seed.price ?? '1.10000000',
        evidenceClass: seed.evidenceClass ?? 'PROVIDER_DEAL',
        providerOrderId: seed.providerOrderId ?? null,
        providerPositionId: seed.providerPositionId ?? null,
      }));

      orderRepo.findOne.mockResolvedValue(
        entity({
          status: OrderStatus.ACKNOWLEDGED,
          requestedQuantity: orderRow.requested_quantity as string,
          filledQuantity: orderRow.filled_quantity as string,
        }),
      );

      const query = jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FOR UPDATE')) {
          return [orderRow];
        }
        if (sql.includes('SELECT EXISTS')) {
          // order-scoped existence probe (the baseline-capture guard)
          return [{ present: ledger.some((r) => r.orderId === (params![0] as string)) }];
        }
        if (sql.includes('SELECT order_id') && sql.includes('provider_deal_id = $2')) {
          // deal-grade dedup read — full economics row (finding 3 compares)
          const dealId = params![1] as string;
          const hit = ledger.find((r) => r.dealId === dealId);
          return hit
            ? [
                {
                  order_id: hit.orderId,
                  quantity: hit.quantity,
                  price: hit.price,
                  provider_order_id: hit.providerOrderId,
                  provider_position_id: hit.providerPositionId,
                  evidence_class: hit.evidenceClass,
                },
              ]
            : [];
        }
        if (sql.startsWith('INSERT INTO trading.order_fill_evidence')) {
          if (sql.includes("'LEGACY_BASELINE'")) {
            const [orderId, , dealId, providerOrderId, providerPositionId, quantity, price] =
              params as unknown[];
            ledger.push({
              dealId: (dealId as string | null) ?? null,
              orderId: orderId as string,
              quantity: quantity as string,
              price: price as string,
              evidenceClass: 'LEGACY_BASELINE',
              providerOrderId: (providerOrderId as string | null) ?? null,
              providerPositionId: (providerPositionId as string | null) ?? null,
            });
            return [];
          }
          const [
            orderId,
            ,
            dealId,
            providerOrderId,
            providerPositionId,
            quantity,
            price,
            evidenceClass,
          ] = params as unknown[];
          ledger.push({
            dealId: (dealId as string | null) ?? null,
            orderId: orderId as string,
            quantity: quantity as string,
            price: price as string,
            evidenceClass: evidenceClass as string,
            providerOrderId: (providerOrderId as string | null) ?? null,
            providerPositionId: (providerPositionId as string | null) ?? null,
          });
          return [];
        }
        if (sql.includes('UPDATE trading.orders')) {
          const qty = params![1] as string;
          const price = params![2] as string;
          const deal = (params![6] as string | null) ?? null;
          const filled = addQuantity(orderRow.filled_quantity as string, qty);
          const filledInt = BigInt(filled.replace('.', ''));
          const requestedInt = BigInt((orderRow.requested_quantity as string).replace('.', ''));
          if (filledInt > requestedInt) {
            return []; // overfill — WHERE clause fails closed
          }
          orderRow = rawRow({
            ...orderRow,
            filled_quantity: filled,
            avg_fill_price: orderRow.avg_fill_price ?? price,
            status:
              filled === orderRow.requested_quantity ? OrderStatus.FILLED : 'PARTIALLY_FILLED',
            provider_deal_id: deal ?? (orderRow.provider_deal_id as string | null),
          });
          return [orderRow];
        }
        throw new Error(`unexpected SQL in model: ${sql}`);
      });
      (dataSource as unknown as { query: jest.Mock }).query = query;
      return { query, ledger, orderRowRef: () => orderRow };
    }

    it('defeats the confirmed partial-fill replay defect (A 0.10, B 0.10, replayed A stays 0.20)', async () => {
      const model = statefulLedgerModel();
      const fillA = { quantity: '0.1000', price: '1.10000000', providerDealId: 'deal-A' };
      const fillB = { quantity: '0.1000', price: '1.20000000', providerDealId: 'deal-B' };

      const afterA = await service.applyFill('order-1', fillA);
      expect(afterA.filledQuantity).toBe('0.1000');

      const afterB = await service.applyFill('order-1', fillB);
      expect(afterB.filledQuantity).toBe('0.2000');
      // The order-row pointer now remembers ONLY deal-B — the exact
      // precondition of the confirmed defect (the identifier of fill A is
      // no longer on the order row).
      expect(afterB.providerDealId).toBe('deal-B');

      // REPLAY of partial fill A: its identifier survives in the IMMUTABLE
      // ledger (not the overwritten pointer) — the replay is detected and
      // ignored instead of inflating the total to 0.3000.
      const replayed = await service.applyFill('order-1', fillA);
      expect(replayed.filledQuantity).toBe('0.2000');
      expect(replayed.status).toBe('PARTIALLY_FILLED');

      // Exactly two evidence rows, two order-row updates — never three.
      expect(model.ledger.map((r) => r.dealId)).toEqual(['deal-A', 'deal-B']);
      expect(callsMatching(model.query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(2);
      expect(callsMatching(model.query, 'UPDATE trading.orders')).toHaveLength(2);
    });

    it('replays of the LATEST fill stay idempotent too (pointer and ledger agree)', async () => {
      const model = statefulLedgerModel();
      await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.10000000',
        providerDealId: 'deal-A',
      });
      await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.20000000',
        providerDealId: 'deal-B',
      });
      const replayed = await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.20000000',
        providerDealId: 'deal-B',
      });
      expect(replayed.filledQuantity).toBe('0.2000');
      expect(callsMatching(model.query, 'UPDATE trading.orders')).toHaveLength(2);
    });

    it('mixed-era (finding 1): the pre-ledger state is transcribed ONCE and the retained pointer stays replay-protected after newer fills overwrite it', async () => {
      const model = statefulLedgerModel({
        requestedQuantity: '0.5000',
        preLedger: {
          filledQuantity: '0.2500',
          avgFillPrice: '1.10000000',
          providerDealId: 'deal-legacy',
        },
      });

      // A NEW ledger-era fill books → the pre-ledger cumulative accounting
      // state is transcribed into ONE LEGACY_BASELINE row first (same
      // transaction). The baseline is a SUMMARY of what the order row
      // already asserted — never a reconstructed per-fill deal.
      const after = await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.20000000',
        providerDealId: 'deal-N',
      });
      expect(after.filledQuantity).toBe('0.3500');
      expect(after.providerDealId).toBe('deal-N'); // the pointer MOVED — the hole finding 1 identified

      expect(model.ledger.map((r) => [r.evidenceClass, r.dealId, r.quantity, r.price])).toEqual([
        ['LEGACY_BASELINE', 'deal-legacy', '0.2500', '1.10000000'],
        ['PROVIDER_DEAL', 'deal-N', '0.1000', '1.20000000'],
      ]);

      // REPLAY of the pre-ledger latest deal AFTER the pointer moved to a
      // newer fill: the retained identifier lives on in the ledger (the
      // baseline row) → identity-level no-op. This is the exact sequence the
      // review found unprotected (replay after a subsequent fill).
      const replayed = await service.applyFill('order-1', {
        quantity: '0.2500',
        price: '1.10000000',
        providerDealId: 'deal-legacy',
      });
      expect(replayed.filledQuantity).toBe('0.3500');
      expect(callsMatching(model.query, 'UPDATE trading.orders')).toHaveLength(1);

      // Invariant (finding 5) for a mixed-era order: SUM(ledger.quantity)
      // == filled_quantity (baseline + ledger-era fills).
      expect(addQuantity('0.2500', '0.1000')).toBe('0.3500');
      expect(replayed.filledQuantity).toBe('0.3500');
    });

    it('mixed-era: the baseline is transcribed AT MOST ONCE — later fills never re-transcribe it', async () => {
      const model = statefulLedgerModel({
        requestedQuantity: '0.5000',
        preLedger: {
          filledQuantity: '0.2000',
          avgFillPrice: '1.10000000',
          providerDealId: 'deal-legacy',
        },
      });
      await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.20000000',
        providerDealId: 'deal-N1',
      });
      await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.30000000',
        providerDealId: 'deal-N2',
      });
      const baselineRows = model.ledger.filter((r) => r.evidenceClass === 'LEGACY_BASELINE');
      expect(baselineRows).toHaveLength(1);
      expect(model.ledger.map((r) => r.dealId)).toEqual(['deal-legacy', 'deal-N1', 'deal-N2']);
      expect(model.orderRowRef().filled_quantity).toBe('0.4000');
    });

    it('untouched legacy order (finding 5): an immediate pointer replay books nothing and the ledger claims NO history', async () => {
      const model = statefulLedgerModel({
        preLedger: {
          filledQuantity: '0.2500',
          avgFillPrice: '1.10000000',
          providerDealId: 'deal-legacy',
        },
      });
      const replayed = await service.applyFill('order-1', {
        quantity: '0.2500',
        price: '1.10000000',
        providerDealId: 'deal-legacy',
      });
      expect(replayed.filledQuantity).toBe('0.2500');
      expect(model.ledger).toHaveLength(0); // the ledger does not fabricate pre-ledger history
      expect(callsMatching(model.query, 'INSERT INTO trading.order_fill_evidence')).toHaveLength(0);
    });

    it('mixed-era pathological row (finding 1): quantity without avg price → the baseline is NOT invented, the insufficiency is surfaced', async () => {
      const model = statefulLedgerModel({
        requestedQuantity: '0.5000',
        preLedger: { filledQuantity: '0.2500', avgFillPrice: null, providerDealId: 'deal-legacy' },
      });
      const after = await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.20000000',
        providerDealId: 'deal-N',
      });
      // The fill still books; no baseline row is written (a price would
      // have had to be invented) — the documented insufficient-evidence
      // case: the ledger sum will NOT equal filled_quantity for this row.
      expect(after.filledQuantity).toBe('0.3500');
      expect(model.ledger.map((r) => r.evidenceClass)).toEqual(['PROVIDER_DEAL']);
    });

    it('contradictory redelivery (finding 3): same deal id, DIFFERENT quantity — refused, both facts stated', async () => {
      const model = statefulLedgerModel();
      await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.10000000',
        providerDealId: 'deal-X',
      });
      await expect(
        service.applyFill('order-1', {
          quantity: '0.2000',
          price: '1.10000000',
          providerDealId: 'deal-X',
        }),
      ).rejects.toThrow(/Contradictory accounting evidence for provider deal deal-X/);
      // Nothing changed: one evidence row, quantity still 0.1000.
      expect(model.ledger).toHaveLength(1);
      expect(model.orderRowRef().filled_quantity).toBe('0.1000');
      expect(callsMatching(model.query, 'UPDATE trading.orders')).toHaveLength(1);
    });

    it('contradictory redelivery (finding 3): same deal id, DIFFERENT price — refused', async () => {
      const model = statefulLedgerModel();
      await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.10000000',
        providerDealId: 'deal-X',
      });
      await expect(
        service.applyFill('order-1', {
          quantity: '0.1000',
          price: '1.20000000',
          providerDealId: 'deal-X',
        }),
      ).rejects.toThrow(/Contradictory accounting evidence/);
      expect(model.ledger).toHaveLength(1);
    });

    it('contradictory redelivery (finding 3): same deal id, conflicting associated native order id — refused; weaker redelivery without ids stays idempotent', async () => {
      const model = statefulLedgerModel({
        preLedger: { filledQuantity: '0.1000', avgFillPrice: '1.10000000' },
        ledgerSeed: [
          {
            dealId: 'deal-X',
            orderId: 'order-1',
            quantity: '0.1000',
            price: '1.10000000',
            providerOrderId: 'po-1',
          },
        ],
      });
      // Both sides carry a provider order id and they disagree.
      await expect(
        service.applyFill('order-1', {
          quantity: '0.1000',
          price: '1.10000000',
          providerDealId: 'deal-X',
          providerOrderId: 'po-2',
        }),
      ).rejects.toThrow(
        /Contradictory accounting evidence.*provider order po-1.*provider order po-2/,
      );

      // A redelivery of the same deal carrying NO order id is weaker
      // evidence of the SAME fact (not a contradiction) → idempotent no-op.
      const unchanged = await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.10000000',
        providerDealId: 'deal-X',
      });
      expect(unchanged.filledQuantity).toBe('0.1000');
      expect(model.ledger).toHaveLength(1);
    });

    it('repeated identical NULL-deal deliveries each book (finding 4 honest limit — no identifier exists to dedup on)', async () => {
      const model = statefulLedgerModel({ requestedQuantity: '0.5000' });
      const first = await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.10000000',
        providerPositionId: 'pos-77',
      });
      const second = await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.10000000',
        providerPositionId: 'pos-77',
      });
      expect(first.filledQuantity).toBe('0.1000');
      expect(second.filledQuantity).toBe('0.2000'); // both booked — ambiguous evidence cannot be deduplicated
      expect(
        model.ledger.every((r) => r.dealId === null && r.evidenceClass === 'POSITION_FACTS'),
      ).toBe(true);
      expect(model.ledger).toHaveLength(2);
    });

    it('records fills without a native deal id honestly (NULL identifier, real evidence class, no replay defence)', async () => {
      const model = statefulLedgerModel();

      // Live dispatch shape: fill from the provider response, position id
      // present, no deal id → POSITION_FACTS.
      const afterFirst = await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.10000000',
        providerPositionId: 'pos-77',
      });
      expect(afterFirst.filledQuantity).toBe('0.1000');
      expect(model.ledger[0]!.dealId).toBeNull();
      expect(model.ledger[0]!.evidenceClass).toBe('POSITION_FACTS');

      // Reconciliation order-state shape: no identifiers at all →
      // PROVIDER_ORDER_STATE.
      const afterSecond = await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.15000000',
      });
      expect(afterSecond.filledQuantity).toBe('0.2000');
      expect(model.ledger[1]!.dealId).toBeNull();
      expect(model.ledger[1]!.evidenceClass).toBe('PROVIDER_ORDER_STATE');

      // HONEST LIMITATION (documented, asserted): without an identifier the
      // ledger cannot detect a replay of the SAME unidentified event — the
      // quantity grows again. This is the boundary of incomplete evidence;
      // deal-grade replays are the ones that must never double-book.
      const afterReplay = await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.15000000',
      });
      expect(afterReplay.filledQuantity).toBe('0.3000');
      expect(model.ledger).toHaveLength(3);
    });

    it('passes exact decimal strings into the ledger INSERT (no float coercion)', async () => {
      const model = statefulLedgerModel();
      await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.12345678',
        providerOrderId: 'prov-1',
        providerDealId: 'deal-A',
      });
      const insert = callsMatching(model.query, 'INSERT INTO trading.order_fill_evidence')[0]!;
      expect(insert[1]).toEqual(
        expect.arrayContaining([
          'order-1',
          baseInput.brokerConnectionId,
          'deal-A',
          'prov-1',
          '0.1000',
          '1.12345678',
          'PROVIDER_DEAL',
        ]),
      );
      // No numeric-string was stringified through a float first.
      expect(insert[1]).not.toEqual(expect.arrayContaining([0.1, 1.12345678]));
    });

    it('transactional all-or-nothing: a refused overfill leaves no surviving evidence row', async () => {
      const model = statefulLedgerModel({ requestedQuantity: '0.2000' });
      const afterFirst = await service.applyFill('order-1', {
        quantity: '0.1500',
        price: '1.10000000',
        providerDealId: 'deal-A',
      });
      expect(afterFirst.status).toBe('PARTIALLY_FILLED');
      expect(afterFirst.filledQuantity).toBe('0.1500');

      // The second (deal-bearing) fill overfills: 0.1500 + 0.1000 > 0.2000 —
      // the UPDATE's WHERE fails closed → ConflictException; the transaction
      // (and its evidence INSERT) rolls back together — a refused fill leaves
      // no accounting event behind.
      orderRepo.findOne.mockResolvedValue(
        entity({
          status: OrderStatus.PARTIALLY_FILLED,
          filledQuantity: '0.1500',
          requestedQuantity: '0.2000',
        }),
      );
      await expect(
        service.applyFill('order-1', {
          quantity: '0.1000',
          price: '1.20000000',
          providerDealId: 'deal-B',
        }),
      ).rejects.toThrow(/exceeds remaining quantity/);

      // The evidence INSERT for deal-B ran inside the SAME transaction as the
      // refused UPDATE (statement order proves the shared transaction); a
      // real PostgreSQL rolls both back — the ledger stays at one row.
      const order = queryCallOrder(model.query as unknown as { mock: { calls: unknown[][] } });
      expect(order.insertBeforeUpdate).toBe(true);
      expect(
        callsMatching(
          model.query as unknown as { mock: { calls: unknown[][] } },
          'INSERT INTO trading.order_fill_evidence',
        ),
      ).toHaveLength(2);
    });

    it('locks the order row (FOR UPDATE) before any ledger read or write (concurrent fill serialisation)', async () => {
      const model = statefulLedgerModel();
      await service.applyFill('order-1', {
        quantity: '0.1000',
        price: '1.10000000',
        providerDealId: 'deal-A',
      });
      const firstSql = model.query.mock.calls[0]![0] as string;
      expect(firstSql).toContain('FOR UPDATE');
      const order = queryCallOrder(model.query as unknown as { mock: { calls: unknown[][] } });
      expect(order.lockFirst).toBe(true);
    });

    it('findFillEvidenceByOrderId returns the ordered ledger view (read-only)', async () => {
      const query = jest.fn().mockResolvedValue([
        {
          id: 'ev-1',
          order_id: 'order-1',
          broker_connection_id: baseInput.brokerConnectionId,
          provider_deal_id: 'deal-A',
          provider_order_id: 'prov-1',
          provider_position_id: null,
          quantity: '0.1000',
          price: '1.10000000',
          evidence_class: 'PROVIDER_DEAL',
          recorded_at: new Date('2026-11-25T00:00:01Z'),
        },
        {
          id: 'ev-2',
          order_id: 'order-1',
          broker_connection_id: baseInput.brokerConnectionId,
          provider_deal_id: null,
          provider_order_id: null,
          provider_position_id: 'pos-77',
          quantity: '0.1000',
          price: '1.20000000',
          evidence_class: 'POSITION_FACTS',
          recorded_at: new Date('2026-11-25T00:00:02Z'),
        },
      ]);
      (dataSource as unknown as { query: jest.Mock }).query = query;

      const evidence = await service.findFillEvidenceByOrderId('order-1');
      expect(evidence).toHaveLength(2);
      expect(evidence[0]!.providerDealId).toBe('deal-A');
      expect(evidence[0]!.quantity).toBe('0.1000');
      expect(evidence[1]!.providerDealId).toBeNull();
      expect(evidence[1]!.evidenceClass).toBe('POSITION_FACTS');
      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('ORDER BY recorded_at ASC, id ASC'),
        ['order-1'],
      );
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
