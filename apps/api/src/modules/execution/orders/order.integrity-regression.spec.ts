import * as fs from 'fs';
import * as path from 'path';
import { DataSource } from 'typeorm';
import { OrderService, SubmitOrderInput } from './order.service';
import { OrderKind, OrderStatus, OrderTimeInForce } from './order.enums';

const input: SubmitOrderInput = {
  userId: '11111111-1111-1111-1111-111111111111',
  brokerConnectionId: '22222222-2222-2222-2222-222222222222',
  clientOrderId: 'savepoint-regression-001',
  orderKind: OrderKind.MARKET,
  timeInForce: OrderTimeInForce.IOC,
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedQuantity: '0.1000',
  requestedPrice: null,
  stopPrice: null,
};

function rawExistingOrder(): Record<string, unknown> {
  return {
    id: 'order-winner',
    user_id: input.userId,
    broker_connection_id: input.brokerConnectionId,
    trade_id: null,
    signal_id: null,
    client_order_id: input.clientOrderId,
    idempotency_key: 'winner-key',
    provider_order_id: null,
    order_kind: OrderKind.MARKET,
    time_in_force: OrderTimeInForce.IOC,
    instrument: 'EURUSD',
    direction: 'BUY',
    requested_quantity: '0.1000',
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
  };
}

describe('Order integrity regressions', () => {
  it('rolls back to a savepoint before reading the winner after PostgreSQL 23505', async () => {
    const calls: string[] = [];
    let firstIdempotencySelect = true;
    let savepointActive = false;
    let transactionAborted = false;

    const manager = {
      query: jest.fn(async (sql: string) => {
        calls.push(sql);

        if (sql === 'SELECT pg_advisory_xact_lock($1)') return [];

        if (sql === 'SAVEPOINT order_insert') {
          savepointActive = true;
          return [];
        }

        if (sql.startsWith('INSERT INTO trading.orders')) {
          transactionAborted = true;
          const error = new Error('duplicate key value violates unique constraint') as Error & {
            code: string;
          };
          error.code = '23505';
          throw error;
        }

        if (sql === 'ROLLBACK TO SAVEPOINT order_insert') {
          if (!savepointActive) throw new Error('no active savepoint');
          transactionAborted = false;
          return [];
        }

        if (sql === 'RELEASE SAVEPOINT order_insert') {
          savepointActive = false;
          return [];
        }

        if (sql.startsWith('SELECT * FROM trading.orders WHERE idempotency_key')) {
          if (transactionAborted) {
            throw new Error(
              'current transaction is aborted, commands ignored until end of transaction block',
            );
          }
          if (firstIdempotencySelect) {
            firstIdempotencySelect = false;
            return [];
          }
          return [rawExistingOrder()];
        }

        return [];
      }),
    };

    const dataSource = {
      transaction: jest.fn(async (callback: (m: typeof manager) => Promise<unknown>) =>
        callback(manager),
      ),
    } as unknown as DataSource;

    const repo = {
      findOne: jest.fn(),
      find: jest.fn(),
      update: jest.fn(),
    };

    const service = new OrderService(repo as never, dataSource);
    const result = await service.submitOrder(input);

    expect(result.status).toBe('DUPLICATE_EXISTING');
    expect(result.order.id).toBe('order-winner');

    const insertIndex = calls.findIndex((sql) => sql.startsWith('INSERT INTO trading.orders'));
    const rollbackIndex = calls.indexOf('ROLLBACK TO SAVEPOINT order_insert');
    const idempotencySelects = calls
      .map((sql, index) => ({ sql, index }))
      .filter(({ sql }) => sql.startsWith('SELECT * FROM trading.orders WHERE idempotency_key'));

    expect(calls.indexOf('SAVEPOINT order_insert')).toBeGreaterThan(-1);
    expect(rollbackIndex).toBeGreaterThan(insertIndex);
    expect(idempotencySelects).toHaveLength(2);
    expect(rollbackIndex).toBeLessThan(idempotencySelects[1].index);
  });

  it('pins the database invariant that FILLED/PARTIALLY_FILLED match fill quantities', () => {
    const migrationPath = path.resolve(
      __dirname,
      '../../../database/migrations/1753600000000-CreateNormalizedOrderDomain.ts',
    );
    const source = fs.readFileSync(migrationPath, 'utf-8');

    expect(source).toContain('CONSTRAINT "chk_orders_status_fill_consistency"');
    expect(source).toContain('"status" = \'FILLED\' AND "filled_quantity" = "requested_quantity"');
    expect(source).toContain('"status" = \'PARTIALLY_FILLED\'');
    expect(source).toContain('"filled_quantity" > 0');
    expect(source).toContain('"filled_quantity" < "requested_quantity"');
  });
});
