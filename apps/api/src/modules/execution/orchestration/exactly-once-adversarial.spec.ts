import { Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ExecutionOrchestrator } from './execution-orchestrator.service';
import type { MarketSafetyGateService } from './market-safety-gate.service';
import { AccountDispatchLeaseService } from './account-dispatch-lease.service';
import { ExecutionIntent } from './execution-intent.interface';
import { Order } from '../orders/order.entity';
import { OrderKind, OrderStatus, OrderTimeInForce } from '../orders/order.enums';
import { OrderService } from '../orders/order.service';
import { BrokerService } from '../../broker/broker.service';
import { BrokerAdapterRegistry } from '../../broker/adapters/broker-adapter.registry';
import { CredentialEncryptionService } from '../../broker/services/credential-encryption.service';
import { ExecutionControlService } from '../../execution-control/execution-control.service';
import { AuditService } from '../../audit/audit.service';
import { DomainEventBus } from '../../events/event-bus.service';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { BrokerMode, IBrokerAdapter } from '../../broker/interfaces/broker-adapter.interface';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';

/**
 * Round 6 live-execution completion (§13) — EXACTLY-ONCE ADVERSARIAL matrix
 * at the dispatch seam: the REAL §14 account lease composed with the REAL
 * orchestrator (collaborators mocked at the seam).
 *
 * Threat model: concurrent, duplicate, and racing dispatch requests against
 * ONE broker account inside one process:
 *
 *   1. two concurrent dispatchOrder with the SAME clientOrderId → exactly
 *      ONE provider call; the loser is the typed DUPLICATE (the lease makes
 *      the reservation idempotency deterministic — without serialization
 *      both callers could pass the reservation before either writes)
 *   2. a DUPLICATE reservation NEVER contacts the provider (audited)
 *   3. an entry (PLACE) and a §10 exit (CLOSE_POSITION) racing on the SAME
 *      account NEVER interleave their critical sections
 *   4. the same duplicate request against a DIFFERENT account proceeds
 *      (per-account, never global)
 */

const userId = 'user-1';

const connection = {
  id: 'conn-1',
  userId,
  brokerId: 'paper-broker',
  accountType: BrokerMode.DEMO,
  credentialStatus: 'VERIFIED',
  encryptedCredentials: 'ciphertext',
  credentialIv: 'iv',
  credentialTag: 'tag',
  encryptionKeyId: 'key-1',
  authorizationStatus: 'AUTHORIZED',
} as unknown as BrokerConnection;

const baseOrder = {
  id: 'order-1',
  userId,
  clientOrderId: 'sig-signal-1',
  status: OrderStatus.CREATED,
  orderKind: OrderKind.MARKET,
  timeInForce: OrderTimeInForce.GTC,
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedQuantity: '0.05',
  filledQuantity: '0',
} as unknown as Order;

const entryIntent = (overrides: Partial<ExecutionIntent> = {}): ExecutionIntent => ({
  userId,
  brokerConnectionId: 'conn-1',
  clientOrderId: 'sig-signal-1',
  tradeId: 'trade-1',
  signalId: 'signal-1',
  orderKind: OrderKind.MARKET,
  timeInForce: OrderTimeInForce.GTC,
  instrument: 'EURUSD',
  direction: 'BUY',
  requestedQuantity: '0.05',
  requestedPrice: null,
  stopPrice: null,
  stopLoss: '1.07500',
  takeProfit: '1.09500',
  referencePrice: '1.08500',
  comment: 'caller-idem-key',
  providerAction: 'PLACE',
  ...overrides,
});

describe('ExecutionOrchestrator exactly-once adversarial (Round 6 §13+§14 composition)', () => {
  let orchestrator: ExecutionOrchestrator;
  let lease: AccountDispatchLeaseService;
  let orderService: {
    submitOrder: jest.Mock;
    markSubmitted: jest.Mock;
    markAcknowledged: jest.Mock;
    applyFill: jest.Mock;
    rejectOrder: jest.Mock;
    markReconciliationPending: jest.Mock;
    generateIdempotencyKey: jest.Mock;
  };
  let adapter: Record<string, jest.Mock>;
  let auditService: { log: jest.Mock };

  const build = () =>
    new ExecutionOrchestrator(
      orderService as unknown as OrderService,
      {
        isConnectionExecutable: jest.fn().mockReturnValue(true),
        findConnectionById: jest.fn().mockResolvedValue(connection),
      } as unknown as BrokerService,
      {
        checkExecutionPermission: jest.fn().mockResolvedValue({ allowed: true, blockedBy: null }),
      } as unknown as ExecutionControlService,
      {
        getAdapterForConnection: jest.fn().mockReturnValue(adapter as unknown as IBrokerAdapter),
      } as unknown as BrokerAdapterRegistry,
      {
        decrypt: jest.fn().mockReturnValue({ apiKey: 'k', apiSecret: 's', accountId: 'acc-1' }),
      } as unknown as CredentialEncryptionService,
      auditService as unknown as AuditService,
      { publish: jest.fn() } as unknown as DomainEventBus,
      {} as never,
      {
        assertMarketSafeForDispatch: jest.fn().mockResolvedValue(undefined),
      } as unknown as MarketSafetyGateService,
      lease,
      // Round 7 (P1 metrics): the lazy MetricsService ModuleRef seam — the
      // stub's get() returns undefined, so every metrics call site no-ops.
      { get: jest.fn() } as unknown as ModuleRef,
    );

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    orderService = {
      submitOrder: jest.fn().mockResolvedValue({ status: 'RESERVED_NEW', order: baseOrder }),
      markSubmitted: jest.fn().mockResolvedValue({ ...baseOrder, status: OrderStatus.SUBMITTED }),
      markAcknowledged: jest.fn().mockResolvedValue({
        ...baseOrder,
        status: OrderStatus.ACKNOWLEDGED,
        providerOrderId: 'pos-1',
      }),
      applyFill: jest.fn().mockResolvedValue({
        ...baseOrder,
        status: OrderStatus.FILLED,
        providerOrderId: 'pos-1',
        filledQuantity: '0.05',
        avgFillPrice: '1.08500',
      }),
      rejectOrder: jest.fn().mockResolvedValue({ ...baseOrder, status: OrderStatus.REJECTED }),
      markReconciliationPending: jest.fn().mockResolvedValue({
        ...baseOrder,
        status: OrderStatus.RECONCILIATION_PENDING,
      }),
      generateIdempotencyKey: jest.fn().mockReturnValue('hashed-idem-key'),
    };
    adapter = {
      // Round 6 §7: full-capability declaration (per-test overrides can
      // narrow it to exercise the fail-closed contract).
      getOrderCapabilities: jest.fn().mockReturnValue({
        brokerId: 'paper-broker',
        supportedOrderKinds: ['MARKET', 'LIMIT', 'STOP', 'STOP_LIMIT'],
        requirements: {
          MARKET: { limitPriceRequired: false, stopPriceRequired: false },
          LIMIT: { limitPriceRequired: true, stopPriceRequired: false },
          STOP: { limitPriceRequired: false, stopPriceRequired: true },
          STOP_LIMIT: { limitPriceRequired: true, stopPriceRequired: true },
        },
        marketSlTpAttachedAtPlacement: true,
      }),
      setMode: jest.fn(),
      connect: jest.fn().mockResolvedValue({ success: true, accountType: 'DEMO' }),
      placeOrder: jest.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return {
          success: true,
          externalOrderId: 'pos-1',
          filledPrice: '1.08500',
          filledQuantity: '0.05',
          status: 'FILLED',
        };
      }),
      closeOrder: jest.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
        return {
          success: true,
          externalOrderId: 'pos-1',
          filledPrice: '1.09000',
          status: 'FILLED',
        };
      }),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    lease = new AccountDispatchLeaseService();
    orchestrator = build();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('two concurrent dispatches with the SAME clientOrderId → exactly ONE provider call (lease + idempotency)', async () => {
    // The lease serializes the two critical sections, so the reservation
    // idempotency is DETERMINISTIC: the first submitOrder sees no prior row
    // (RESERVED_NEW), the second — strictly after — sees the first's row
    // (DUPLICATE_EXISTING). Without serialization both could reserve before
    // either write lands (the classic double-dispatch race).
    orderService.submitOrder
      .mockResolvedValueOnce({ status: 'RESERVED_NEW', order: baseOrder })
      .mockResolvedValueOnce({
        status: 'DUPLICATE_EXISTING',
        order: { ...baseOrder, status: OrderStatus.SUBMITTED },
      });

    const [first, second] = await Promise.all([
      orchestrator.dispatchOrder(entryIntent(), connection),
      orchestrator.dispatchOrder(entryIntent(), connection),
    ]);

    // Exactly one provider call.
    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    // The winner filled; the loser is the typed DUPLICATE.
    expect(first.outcome === 'FILLED' || second.outcome === 'FILLED').toBe(true);
    expect([first, second].map((d) => d.outcome).sort()).toEqual(['DUPLICATE', 'FILLED']);
  });

  it('a DUPLICATE reservation NEVER contacts the provider (typed suppression, audited)', async () => {
    orderService.submitOrder.mockResolvedValue({
      status: 'DUPLICATE_EXISTING',
      order: { ...baseOrder, status: OrderStatus.SUBMITTED },
    });

    const dispatch = await orchestrator.dispatchOrder(entryIntent(), connection);

    expect(dispatch.outcome).toBe('DUPLICATE');
    expect(adapter.placeOrder).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.ORDER_DUPLICATE_SUPPRESSED }),
    );
  });

  it('an entry (PLACE) and a §10 exit (CLOSE_POSITION) racing on ONE account never interleave', async () => {
    const windows: Array<{ kind: string; start: number; end: number }> = [];
    adapter.placeOrder.mockImplementation(async () => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 15));
      windows.push({ kind: 'PLACE', start, end: Date.now() });
      return {
        success: true,
        externalOrderId: 'pos-1',
        filledPrice: '1.08500',
        filledQuantity: '0.05',
        status: 'FILLED',
      };
    });
    adapter.closeOrder.mockImplementation(async () => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 15));
      windows.push({ kind: 'CLOSE', start, end: Date.now() });
      return { success: true, externalOrderId: 'pos-1', filledPrice: '1.09000', status: 'FILLED' };
    });

    const closeIntent = entryIntent({
      clientOrderId: 'close-trade-1',
      signalId: null,
      providerAction: 'CLOSE_POSITION',
      providerReferenceId: 'pos-1',
      direction: 'SELL',
      stopLoss: '0',
      takeProfit: '0',
      referencePrice: null,
    });

    await Promise.all([
      orchestrator.dispatchOrder(entryIntent(), connection),
      orchestrator.dispatchOrder(closeIntent, connection),
    ]);

    expect(windows).toHaveLength(2);
    const ordered = [...windows].sort((a, b) => a.start - b.start);
    expect(ordered[1].start).toBeGreaterThanOrEqual(ordered[0].end);
  });

  it('the same clientOrderId against a DIFFERENT account proceeds (per-account, never global)', async () => {
    const otherConnection = { ...connection, id: 'conn-2' } as unknown as BrokerConnection;
    orderService.submitOrder.mockResolvedValue({ status: 'RESERVED_NEW', order: baseOrder });

    const [a, b] = await Promise.all([
      orchestrator.dispatchOrder(entryIntent(), connection),
      orchestrator.dispatchOrder(entryIntent({ brokerConnectionId: 'conn-2' }), otherConnection),
    ]);

    // Two accounts → two independent dispatches (no global lock).
    expect(adapter.placeOrder).toHaveBeenCalledTimes(2);
    expect(a.outcome).toBe('FILLED');
    expect(b.outcome).toBe('FILLED');
  });
});
