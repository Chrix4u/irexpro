import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { LiveAccountController } from './live-account.controller';
import { LiveAccountService } from './live-account.service';
import { Order } from '../execution/orders/order.entity';
import { OrderKind, OrderStatus, OrderTimeInForce } from '../execution/orders/order.enums';
import { TradeDirection } from '../execution/entities/trade.entity';
import { AuditLog } from '../audit/entities/audit-log.entity';
import { toLiveOrderRowView } from './dto/live-account-orders-response.dto';
import { toLiveActivityRowView } from './dto/live-account-activity-response.dto';

/**
 * LiveAccountController identity-contract tests (Directive §40 tenant
 * isolation + §51 substantial tests).
 *
 * Proves:
 * - the four read endpoints exist under the right paths/methods;
 * - ONLY the authenticated user's UUID is ever passed to the service (never
 *   client-supplied connection/account identifiers);
 * - query pagination is clamped and invalid status filters fall back to ALL;
 * - service entities serialize into the frozen response DTO shapes.
 */
describe('LiveAccountController (identity contract)', () => {
  let controller: LiveAccountController;
  let service: Record<string, jest.Mock>;

  const USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  beforeEach(() => {
    service = {
      getOverview: jest.fn().mockResolvedValue({
        generatedAt: '2026-01-15T12:00:00.000Z',
        connections: [],
        automation: { status: 'IDLE' },
        executionHealth: {},
        alerts: [],
        environment: 'PAPER',
        hasConnections: false,
      }),
      getOrders: jest.fn().mockResolvedValue({ orders: [], total: 0, limit: 50, offset: 0 }),
      getPositions: jest.fn().mockResolvedValue({ positions: [], total: 0 }),
      getActivity: jest.fn().mockResolvedValue({ activity: [], total: 0, limit: 50, offset: 0 }),
    };

    controller = new LiveAccountController(service as unknown as LiveAccountService);
  });

  describe('routes', () => {
    it('registers the live-account controller path', () => {
      expect(Reflect.getMetadata('path', LiveAccountController)).toBe('live-account');
    });

    it('exposes GET live-account/overview', () => {
      expect(Reflect.getMetadata('path', controller.getOverview)).toBe('overview');
      expect(Reflect.getMetadata('method', controller.getOverview)).toBe(RequestMethod.GET);
    });

    it('exposes GET live-account/orders', () => {
      expect(Reflect.getMetadata('path', controller.getOrders)).toBe('orders');
      expect(Reflect.getMetadata('method', controller.getOrders)).toBe(RequestMethod.GET);
    });

    it('exposes GET live-account/positions', () => {
      expect(Reflect.getMetadata('path', controller.getPositions)).toBe('positions');
      expect(Reflect.getMetadata('method', controller.getPositions)).toBe(RequestMethod.GET);
    });

    it('exposes GET live-account/activity', () => {
      expect(Reflect.getMetadata('path', controller.getActivity)).toBe('activity');
      expect(Reflect.getMetadata('method', controller.getActivity)).toBe(RequestMethod.GET);
    });
  });

  describe('passes ONLY the authenticated user UUID to the service', () => {
    it('getOverview receives exactly the userId', async () => {
      await controller.getOverview(USER_ID);
      expect(service.getOverview).toHaveBeenCalledTimes(1);
      expect(service.getOverview).toHaveBeenCalledWith(USER_ID);
      expect(service.getOverview.mock.calls[0]).toHaveLength(1);
    });

    it('getPositions receives exactly the userId', async () => {
      await controller.getPositions(USER_ID);
      expect(service.getPositions).toHaveBeenCalledTimes(1);
      expect(service.getPositions).toHaveBeenCalledWith(USER_ID);
      expect(service.getPositions.mock.calls[0]).toHaveLength(1);
    });

    it('getOrders passes the userId first and never a client connection id', async () => {
      await controller.getOrders(USER_ID, 'WORKING', 25, 50);
      expect(service.getOrders).toHaveBeenCalledWith(USER_ID, 'WORKING', 25, 50);
      expect(service.getOrders.mock.calls[0][0]).toBe(USER_ID);
      expect(typeof service.getOrders.mock.calls[0][0]).toBe('string');
    });

    it('getActivity passes the userId first', async () => {
      await controller.getActivity(USER_ID, 10, 20);
      expect(service.getActivity).toHaveBeenCalledWith(USER_ID, 10, 20);
      expect(service.getActivity.mock.calls[0][0]).toBe(USER_ID);
    });

    it('never forwards a principal object in place of the UUID', async () => {
      // The controller method itself accepts exactly ONE argument — identity
      // extraction is owned exclusively by the @CurrentUserId() decorator
      // (which rejects malformed principals). Nothing else can inject a
      // connection/account identifier into the service call.
      expect(controller.getOverview.length).toBe(1);
      expect(controller.getPositions.length).toBe(1);

      await controller.getOverview(USER_ID);
      expect(service.getOverview).toHaveBeenCalledWith(USER_ID);
    });
  });

  // ─── Phase F structural tenant-isolation proofs (verification, not paths) ──

  describe('structural tenant-isolation proofs (Phase F)', () => {
    const paramTypes = (
      methodName: 'getOverview' | 'getOrders' | 'getPositions' | 'getActivity',
    ): unknown[] =>
      (Reflect.getMetadata(
        'design:paramtypes',
        Object.getPrototypeOf(controller),
        methodName,
      ) as unknown[]) ?? [];

    it('identity-only handlers declare exactly one parameter (the userId)', () => {
      expect(paramTypes('getOverview')).toHaveLength(1);
      expect(paramTypes('getPositions')).toHaveLength(1);
      expect(controller.getOverview.length).toBe(1);
      expect(controller.getPositions.length).toBe(1);
    });

    it('query-parameter handlers accept ONLY scalars after the userId (no identifier objects)', () => {
      const orderParams = paramTypes('getOrders');
      const activityParams = paramTypes('getActivity');

      expect(orderParams[0]).toBe(String);
      expect(orderParams.slice(1).every((type) => type === String || type === Number)).toBe(true);
      expect(activityParams[0]).toBe(String);
      expect(activityParams.slice(1).every((type) => type === Number)).toBe(true);
    });

    it('no route accepts a client-supplied identifier as a path parameter', () => {
      // All four endpoints are static paths — there is no :id route segment a
      // client could use to address another tenant's connection/account.
      for (const handler of [
        controller.getOverview,
        controller.getOrders,
        controller.getPositions,
        controller.getActivity,
      ]) {
        const path = Reflect.getMetadata('path', handler) as string;
        expect(path).not.toMatch(/:/);
      }
    });

    it('every service call is led by exactly the authenticated userId', async () => {
      await controller.getOverview(USER_ID);
      await controller.getPositions(USER_ID);
      await controller.getOrders(USER_ID, 'ALL', 50, 0);
      await controller.getActivity(USER_ID, 50, 0);

      expect(service.getOverview.mock.calls[0]).toEqual([USER_ID]);
      expect(service.getPositions.mock.calls[0]).toEqual([USER_ID]);
      expect(service.getOrders.mock.calls[0][0]).toBe(USER_ID);
      expect(service.getActivity.mock.calls[0][0]).toBe(USER_ID);
      expect(service.getOrders).toHaveBeenCalledWith(USER_ID, 'ALL', 50, 0);
      expect(service.getActivity).toHaveBeenCalledWith(USER_ID, 50, 0);
    });
  });

  describe('query validation (limit clamping, status fallback)', () => {
    it('falls back to ALL for an invalid status and clamps limit/offset', async () => {
      await controller.getOrders(USER_ID, 'NOT_A_STATUS', 999, -5);
      expect(service.getOrders).toHaveBeenCalledWith(USER_ID, 'ALL', 100, 0);
    });

    it('keeps a valid WORKING status and normal pagination untouched', async () => {
      await controller.getOrders(USER_ID, 'WORKING', 50, 0);
      expect(service.getOrders).toHaveBeenCalledWith(USER_ID, 'WORKING', 50, 0);
    });

    it('treats a missing status as ALL', async () => {
      await controller.getOrders(USER_ID, undefined, 50, 0);
      expect(service.getOrders).toHaveBeenCalledWith(USER_ID, 'ALL', 50, 0);
    });

    it('clamps activity pagination', async () => {
      await controller.getActivity(USER_ID, 0, -3);
      expect(service.getActivity).toHaveBeenCalledWith(USER_ID, 1, 0);
    });
  });

  describe('DTO mapping applied (service entities → response DTO)', () => {
    it('maps an Order entity row to the frontend-safe order view', () => {
      const entity = {
        id: 'order-1',
        brokerConnectionId: 'conn-1',
        clientOrderId: 'client-1',
        providerOrderId: 'ticket-1',
        tradeId: 'trade-1',
        orderKind: OrderKind.LIMIT,
        timeInForce: OrderTimeInForce.GTC,
        instrument: 'EURUSD',
        direction: TradeDirection.BUY,
        requestedQuantity: '1.0000',
        requestedPrice: '1.10000000',
        stopPrice: null,
        filledQuantity: '0.5000',
        avgFillPrice: '1.10005000',
        status: OrderStatus.PARTIALLY_FILLED,
        rejectReason: null,
        submittedAt: new Date('2026-01-15T10:00:00Z'),
        finalizedAt: null,
        createdAt: new Date('2026-01-15T09:59:00Z'),
      } as unknown as Order;

      const row = toLiveOrderRowView(entity, 'MetaTrader 5');

      expect(row).toMatchObject({
        id: 'order-1',
        brokerName: 'MetaTrader 5',
        clientOrderId: 'client-1',
        status: 'PARTIALLY_FILLED',
        requestedQuantity: '1.0000',
        submittedAt: '2026-01-15T10:00:00.000Z',
      });
      expect(JSON.stringify(row)).not.toContain('idempotencyKey');
      expect(JSON.stringify(row)).not.toContain('userId');
    });

    it('maps an AuditLog entity row to the activity view without metadata', () => {
      const entity = {
        id: 'audit-1',
        action: 'ORDER_REJECTED',
        resourceType: 'Order',
        resourceId: 'order-1',
        severity: 'WARNING',
        metadata: { apiKey: 'secret' },
        ipAddress: '203.0.113.10',
        createdAt: new Date('2026-01-15T11:00:00Z'),
      } as unknown as AuditLog;

      const row = toLiveActivityRowView(entity);

      expect(row).toMatchObject({
        id: 'audit-1',
        action: 'ORDER_REJECTED',
        resourceType: 'Order',
        resourceId: 'order-1',
        severity: 'WARNING',
        createdAt: '2026-01-15T11:00:00.000Z',
      });
      expect(JSON.stringify(row)).not.toContain('metadata');
      expect(JSON.stringify(row)).not.toContain('apiKey');
      expect(JSON.stringify(row)).not.toContain('ipAddress');
    });

    it('returns the service DTO payloads verbatim (thin controller)', async () => {
      service.getOrders.mockResolvedValue({ orders: [], total: 42, limit: 50, offset: 0 });

      const page = await controller.getOrders(USER_ID, 'ALL', 50, 0);

      expect(page).toEqual({ orders: [], total: 42, limit: 50, offset: 0 });
    });
  });
});
