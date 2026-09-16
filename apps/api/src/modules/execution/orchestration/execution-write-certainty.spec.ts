import { Logger } from '@nestjs/common';
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
import { DomainEventType } from '../../events/enums/domain-event-type.enum';
import { AuditAction } from '../../../common/enums/audit-action.enum';
import { AuditSeverity } from '../../audit/entities/audit-log.entity';
import { BrokerMode, IBrokerAdapter } from '../../broker/interfaces/broker-adapter.interface';
import { BrokerConnection } from '../../broker/entities/broker-connection.entity';
import { BrokerAdapterError, BrokerErrorCode } from '../../broker/interfaces/broker-adapter.errors';
import { ProviderDispatchCertainty } from '../../broker/interfaces/provider-dispatch-certainty';

// ─── Fixtures (mirrors execution-orchestrator.spec.ts exactly) ────────────────

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

const intent: ExecutionIntent = {
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
  stopLoss: '1.07500',
  takeProfit: '1.09500',
  comment: 'caller-idem-key',
  providerAction: 'PLACE',
};

/** All provider-write retry delays + the 10s dispatch race timeout. */
const ALL_RETRY_AND_TIMEOUT_DELAYS_MS = 1_000 + 3_000 + 9_000 + 10_000 + 1_000;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExecutionOrchestrator provider-write certainty (Sprint 56 correction round 4, findings 5-7)', () => {
  let orchestrator: ExecutionOrchestrator;
  let orderService: {
    submitOrder: jest.Mock;
    markSubmitted: jest.Mock;
    markAcknowledged: jest.Mock;
    applyFill: jest.Mock;
    rejectOrder: jest.Mock;
    markReconciliationPending: jest.Mock;
    generateIdempotencyKey: jest.Mock;
  };
  let brokerService: { isConnectionExecutable: jest.Mock; findConnectionById: jest.Mock };
  let controlService: { checkExecutionPermission: jest.Mock };
  let adapter: Record<string, jest.Mock>;
  let auditService: { log: jest.Mock };
  let eventBus: { publish: jest.Mock };
  let encryptionService: { decrypt: jest.Mock };

  beforeEach(() => {
    // Fake timers make the retry-gate proofs deterministic: a retry that the
    // certainty gate should have blocked can only fire when the clock is
    // advanced, so advancing past every delay (1s/3s/9s + the 10s race
    // timeout) proves the resend NEVER happens.
    jest.useFakeTimers();

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
      markReconciliationPending: jest
        .fn()
        .mockResolvedValue({ ...baseOrder, status: OrderStatus.RECONCILIATION_PENDING }),
      generateIdempotencyKey: jest.fn().mockReturnValue('hashed-idem-key'),
    };
    brokerService = {
      isConnectionExecutable: jest.fn().mockReturnValue(true),
      findConnectionById: jest.fn().mockResolvedValue(connection),
    };
    controlService = {
      checkExecutionPermission: jest.fn().mockResolvedValue({ allowed: true, blockedBy: null }),
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
      connect: jest.fn().mockResolvedValue({ success: true }),
      placeOrder: jest.fn().mockResolvedValue({
        success: true,
        externalOrderId: 'pos-1',
        filledPrice: '1.08500',
        filledQuantity: '0.05',
        status: 'FILLED',
      }),
      closeOrder: jest.fn().mockResolvedValue({
        success: true,
        externalOrderId: 'pos-1',
        filledPrice: '1.09000',
        status: 'FILLED',
      }),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    eventBus = { publish: jest.fn() };
    encryptionService = {
      decrypt: jest.fn().mockReturnValue({
        apiKey: 'k',
        apiSecret: 's',
        accountId: 'acc-1',
      }),
    };

    orchestrator = new ExecutionOrchestrator(
      orderService as unknown as OrderService,
      brokerService as unknown as BrokerService,
      controlService as unknown as ExecutionControlService,
      {
        getAdapterForConnection: jest.fn().mockReturnValue(adapter as unknown as IBrokerAdapter),
      } as unknown as BrokerAdapterRegistry,
      encryptionService as unknown as CredentialEncryptionService,
      auditService as unknown as AuditService,
      eventBus as unknown as DomainEventBus,
      // Round 6 (#365): the provider-dispatch commitment seam — these suites
      // drive dispatchOrder WITHOUT a commitment payload.
      {} as never,
      // Round 6 §5/§18: the market-safety gate is exercised at the SEAM
      // (its own matrix lives in market-safety-gate.spec.ts) — passes by
      // default; per-test overrides make it fail closed.
      {
        assertMarketSafeForDispatch: jest.fn().mockResolvedValue(undefined),
      } as unknown as MarketSafetyGateService,
      // Round 6 §14: the per-account dispatch lease (real implementation —
      // its own matrix lives in account-dispatch-lease.spec.ts).
      new AccountDispatchLeaseService(),
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // ─── Shared helpers ─────────────────────────────────────────────────────

  /** Audit entries logged for ORDER_RECONCILIATION_PENDING. */
  const reconciliationAudits = (): Array<{
    action: AuditAction;
    severity?: AuditSeverity;
    metadata?: Record<string, unknown>;
  }> =>
    auditService.log.mock.calls
      .map(
        (c) =>
          c[0] as {
            action: AuditAction;
            severity?: AuditSeverity;
            metadata?: Record<string, unknown>;
          },
      )
      .filter((entry) => entry.action === AuditAction.ORDER_RECONCILIATION_PENDING);

  // ─── A. Lost response AFTER a written provider frame ────────────────────

  it('A. provider executes PLACE but the response is lost → EXACTLY ONE provider send, order RECONCILIATION_PENDING, NO automatic resend', async () => {
    // A cTrader frame whose WRITE succeeded but whose RESPONSE never arrived:
    // transport-level timeout, classified MAY_HAVE_REACHED_PROVIDER (and even
    // retryable at the network level — which must NOT matter for a write).
    adapter.placeOrder.mockRejectedValueOnce(
      new BrokerAdapterError(
        BrokerErrorCode.CONNECTION_TIMEOUT,
        'cTrader request timed out',
        undefined,
        true,
        ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
      ),
    );

    // The dispatch settles through pure microtasks: the certainty gate
    // surfaces the uncertain write IMMEDIATELY (no retry delay scheduled).
    const outcome = await orchestrator.dispatchOrder(intent, connection);

    // EXACTLY ONE provider send — the uncertain write was never resent.
    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);

    // The uncertain outcome is persisted, never dropped.
    expect(outcome.outcome).toBe('UNKNOWN');
    if (outcome.outcome === 'UNKNOWN') {
      expect(outcome.orderId).toBe('order-1');
      expect(outcome.reason).toBe(
        'Dispatch error (MAY_HAVE_REACHED_PROVIDER): cTrader request timed out',
      );
    }
    expect(orderService.markReconciliationPending).toHaveBeenCalledWith('order-1');

    // The audit evidence carries the certainty classification.
    expect(reconciliationAudits()).toHaveLength(1);
    expect(reconciliationAudits()[0].metadata).toMatchObject({
      dispatchCertainty: 'MAY_HAVE_REACHED_PROVIDER',
      orderStatus: OrderStatus.RECONCILIATION_PENDING,
    });
    expect(reconciliationAudits()[0].severity).toBe(AuditSeverity.CRITICAL);

    // The ORDER_RECONCILIATION_PENDING event was emitted.
    expect(eventBus.publish).toHaveBeenCalledWith(
      DomainEventType.ORDER_RECONCILIATION_PENDING,
      userId,
      expect.objectContaining({
        orderId: 'order-1',
        status: OrderStatus.RECONCILIATION_PENDING,
        reason: expect.stringContaining('MAY_HAVE_REACHED_PROVIDER'),
      }),
    );

    // Prove no retry was even scheduled: advance past EVERY retry delay
    // (1s/3s/9s) and the 10s dispatch race timeout — still exactly ONE send.
    await jest.advanceTimersByTimeAsync(ALL_RETRY_AND_TIMEOUT_DELAYS_MS);
    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    expect(adapter.connect).toHaveBeenCalledTimes(1);
  });

  // ─── B. Deterministic pre-send rejection → safe retry ───────────────────

  it('B. deterministic pre-send queue rejection (DEFINITELY_NOT_SENT + retryable) → SAFE retry occurs and then succeeds', async () => {
    // Queue capacity failure BEFORE transport enqueue — the request provably
    // never left iRexPro, so the certainty gate ALLOWS the automatic retry.
    adapter.placeOrder.mockRejectedValueOnce(
      new BrokerAdapterError(
        BrokerErrorCode.RATE_LIMITED,
        'queue at capacity',
        undefined,
        true,
        ProviderDispatchCertainty.DEFINITELY_NOT_SENT,
      ),
    );
    // Second attempt resolves the FILLED result (default mock).

    const dispatch = orchestrator.dispatchOrder(intent, connection);

    // Drain the microtask chain: attempt 1 fails pre-send and the 1s retry
    // delay timer is scheduled.
    await jest.advanceTimersByTimeAsync(0);
    // Fire the 1s retry delay — attempt 2 reaches the provider and succeeds.
    await jest.advanceTimersByTimeAsync(1_000);

    const outcome = await dispatch;

    expect(adapter.placeOrder).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      outcome: 'FILLED',
      providerOrderId: 'pos-1',
      filledQuantity: '0.05',
    });
    // ONE order lifecycle — the retry re-dispatched the same reserved order,
    // it did not submit a second order.
    expect(orderService.submitOrder).toHaveBeenCalledTimes(1);
    expect(orderService.markSubmitted).toHaveBeenCalledTimes(1);
    expect(orderService.markReconciliationPending).not.toHaveBeenCalled();
  });

  // ─── C. Ambiguous WebSocket write → no retry despite retryable=true ─────

  it('C. ambiguous WebSocket write (MAY_HAVE_REACHED_PROVIDER + retryable) → NO retry, reconciliation pending', async () => {
    adapter.placeOrder.mockRejectedValueOnce(
      new BrokerAdapterError(
        BrokerErrorCode.CONNECTION_LOST,
        'transport write failed — generation unhealthy',
        undefined,
        true,
        ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
      ),
    );

    const outcome = await orchestrator.dispatchOrder(intent, connection);

    // Transport-level retryability is NOT permission to resend a write that
    // may have reached the provider.
    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    expect(outcome.outcome).toBe('UNKNOWN');
    if (outcome.outcome === 'UNKNOWN') {
      expect(outcome.reason).toContain('MAY_HAVE_REACHED_PROVIDER');
    }
    expect(orderService.markReconciliationPending).toHaveBeenCalledWith('order-1');

    // Advance past every retry delay — still no resend (the gate threw the
    // uncertain failure out of the retry loop before any delay was awaited).
    await jest.advanceTimersByTimeAsync(ALL_RETRY_AND_TIMEOUT_DELAYS_MS);
    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
  });

  // ─── D. Unclassified thrown error → conservatively never resent ─────────

  it('D. unclassified thrown error → conservatively NO retry (never resent)', async () => {
    adapter.placeOrder.mockRejectedValueOnce(new Error('adapter bug'));

    const outcome = await orchestrator.dispatchOrder(intent, connection);

    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    expect(outcome.outcome).toBe('UNKNOWN');
    if (outcome.outcome === 'UNKNOWN') {
      // The reason string carries the conservative certainty classification.
      expect(outcome.reason).toBe('Dispatch error (MAY_HAVE_REACHED_PROVIDER): adapter bug');
    }
    expect(orderService.markReconciliationPending).toHaveBeenCalledWith('order-1');
    expect(reconciliationAudits()).toHaveLength(1);
    expect(reconciliationAudits()[0].metadata).toMatchObject({
      dispatchCertainty: 'MAY_HAVE_REACHED_PROVIDER',
    });
  });

  // ─── E. Provider ANSWERED the request → no auto-retry ───────────────────

  it('E. SENT_RESPONSE_RECEIVED provider rejection → no auto-retry (provider answered)', async () => {
    adapter.placeOrder.mockRejectedValueOnce(
      new BrokerAdapterError(
        BrokerErrorCode.MARKET_CLOSED,
        'Market is closed',
        undefined,
        false,
        ProviderDispatchCertainty.SENT_RESPONSE_RECEIVED,
      ),
    );

    const outcome = await orchestrator.dispatchOrder(intent, connection);

    expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    expect(outcome.outcome).toBe('UNKNOWN');
    expect(orderService.markReconciliationPending).toHaveBeenCalledWith('order-1');
    // The audit classification records that the provider ANSWERED — the
    // outcome is authoritative for this request, never auto-resent.
    expect(reconciliationAudits()).toHaveLength(1);
    expect(reconciliationAudits()[0].metadata).toMatchObject({
      dispatchCertainty: 'SENT_RESPONSE_RECEIVED',
      orderStatus: OrderStatus.RECONCILIATION_PENDING,
    });
  });

  // ─── F. CLOSE_POSITION intents obey the same certainty gate ─────────────

  it('F. CLOSE_POSITION intents obey the same certainty gate', async () => {
    const closeIntent: ExecutionIntent = {
      ...intent,
      clientOrderId: 'close-trade-1',
      direction: 'SELL',
      providerAction: 'CLOSE_POSITION',
      providerReferenceId: 'ext-pos-9',
    };
    // A close whose frame was written but whose response was lost — a resent
    // close cannot be assumed safe just because the transport is retryable.
    adapter.closeOrder.mockRejectedValueOnce(
      new BrokerAdapterError(
        BrokerErrorCode.CONNECTION_TIMEOUT,
        'close frame written — response never arrived',
        undefined,
        true,
        ProviderDispatchCertainty.MAY_HAVE_REACHED_PROVIDER,
      ),
    );

    const outcome = await orchestrator.dispatchOrder(closeIntent, connection);

    expect(adapter.closeOrder).toHaveBeenCalledTimes(1);
    expect(adapter.placeOrder).not.toHaveBeenCalled();
    expect(outcome.outcome).toBe('UNKNOWN');
    if (outcome.outcome === 'UNKNOWN') {
      expect(outcome.reason).toContain('MAY_HAVE_REACHED_PROVIDER');
    }
    expect(orderService.markReconciliationPending).toHaveBeenCalledWith('order-1');

    // Advance past every retry delay — the close is never re-sent either.
    await jest.advanceTimersByTimeAsync(ALL_RETRY_AND_TIMEOUT_DELAYS_MS);
    expect(adapter.closeOrder).toHaveBeenCalledTimes(1);
  });
});
