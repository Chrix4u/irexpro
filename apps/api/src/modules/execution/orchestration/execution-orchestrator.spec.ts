import { ForbiddenException, Logger } from '@nestjs/common';
import { ExecutionOrchestrator } from './execution-orchestrator.service';
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

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

const liveConnection = {
  ...connection,
  accountType: BrokerMode.LIVE,
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ExecutionOrchestrator', () => {
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
      // Phase D: assertDispatchable re-loads the persisted connection —
      // default echo of the fixture (tests override for stale-snapshot cases)
      findConnectionById: jest.fn().mockResolvedValue(connection),
    };
    controlService = {
      checkExecutionPermission: jest.fn().mockResolvedValue({ allowed: true, blockedBy: null }),
    };
    adapter = {
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
        getAdapter: jest.fn().mockReturnValue(adapter as unknown as IBrokerAdapter),
      } as unknown as BrokerAdapterRegistry,
      encryptionService as unknown as CredentialEncryptionService,
      auditService as unknown as AuditService,
      eventBus as unknown as DomainEventBus,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ─── Validation pipeline (assertDispatchable) ─────────────────────────────

  describe('assertDispatchable()', () => {
    it('passes when the control plane allows and the connection is DEMO', async () => {
      await expect(
        orchestrator.assertDispatchable({ userId, connection }),
      ).resolves.toBeUndefined();
      expect(controlService.checkExecutionPermission).toHaveBeenCalledWith({
        userId,
        brokerId: 'paper-broker',
        brokerConnectionId: 'conn-1',
      });
    });

    it('control plane blocked → ForbiddenException + audit (fail-closed)', async () => {
      controlService.checkExecutionPermission.mockResolvedValue({
        allowed: false,
        blockedBy: { scope: 'GLOBAL', scopeKey: null, reason: 'INCIDENT' },
      });
      await expect(orchestrator.assertDispatchable({ userId, connection })).rejects.toThrow(
        ForbiddenException,
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ORDER_REJECTED,
          metadata: expect.objectContaining({ reason: 'EXECUTION_CONTROL_BLOCKED' }),
          severity: AuditSeverity.WARNING,
        }),
      );
    });

    it('control store unreadable → fail-closed block', async () => {
      controlService.checkExecutionPermission.mockResolvedValue({
        allowed: false,
        blockedBy: {
          scope: 'GLOBAL',
          scopeKey: null,
          reason: 'EXECUTION_CONTROL_STORE_UNAVAILABLE',
        },
      });
      await expect(orchestrator.assertDispatchable({ userId, connection })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('LIVE connection not executable → ForbiddenException (fail-closed)', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(false);
      // Phase D: the PERSISTED (re-loaded) connection is the LIVE one
      brokerService.findConnectionById.mockResolvedValue(liveConnection);
      await expect(
        orchestrator.assertDispatchable({ userId, connection: liveConnection }),
      ).rejects.toThrow(ForbiddenException);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ORDER_REJECTED,
          metadata: expect.objectContaining({ reason: 'LIVE_AUTHORIZATION_REQUIRED' }),
        }),
      );
    });

    it('LIVE connection executable (ACTIVE) → passes', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(true);
      brokerService.findConnectionById.mockResolvedValue(liveConnection);
      await expect(
        orchestrator.assertDispatchable({ userId, connection: liveConnection }),
      ).resolves.toBeUndefined();
    });

    it('Phase D: stale snapshot defense — persisted state REVOKED blocks despite an ACTIVE snapshot', async () => {
      // Caller's snapshot says ACTIVE, but the re-loaded persisted state is REVOKED
      brokerService.findConnectionById.mockResolvedValue({
        ...liveConnection,
        authorizationStatus: 'REVOKED',
      } as unknown as BrokerConnection);
      brokerService.isConnectionExecutable.mockReturnValue(false);

      await expect(
        orchestrator.assertDispatchable({ userId, connection: liveConnection }),
      ).rejects.toThrow(ForbiddenException);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            reason: 'LIVE_AUTHORIZATION_REQUIRED',
            authorizationStatus: 'REVOKED',
          }),
        }),
      );
    });

    it('Phase D: connection deleted between load and dispatch → fail-closed Forbidden', async () => {
      brokerService.findConnectionById.mockRejectedValue(new Error('not found'));
      await expect(orchestrator.assertDispatchable({ userId, connection })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('Phase D (A3 boundary): unusable credential lifecycle blocks BEFORE decrypt', async () => {
      brokerService.findConnectionById.mockResolvedValue({
        ...connection,
        credentialStatus: 'REVOKED',
      } as unknown as BrokerConnection);

      await expect(orchestrator.assertDispatchable({ userId, connection })).rejects.toThrow(
        ForbiddenException,
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            reason: 'CREDENTIAL_LIFECYCLE_BLOCKED',
            credentialStatus: 'REVOKED',
          }),
        }),
      );
    });

    it('Phase D (A3 boundary): missing ciphertext blocks provider dispatch', async () => {
      brokerService.findConnectionById.mockResolvedValue({
        ...connection,
        encryptedCredentials: null,
      } as unknown as BrokerConnection);

      await expect(orchestrator.assertDispatchable({ userId, connection })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('Phase D: secret-like material in provider reject reasons is redacted', async () => {
      adapter.placeOrder.mockResolvedValue({
        success: false,
        status: 'REJECTED',
        brokerMessage: 'Auth failed for token AbCdEf1234567890GhIjKl (provider 8)',
      });
      const outcome = await orchestrator.dispatchOrder(intent, connection);

      expect(outcome.outcome).toBe('REJECTED');
      if (outcome.outcome === 'REJECTED') {
        expect(outcome.reason).not.toMatch(/AbCdEf1234567890GhIjKl/);
        expect(outcome.reason).toMatch(/\[redacted\]/);
      }
      expect(orderService.rejectOrder).toHaveBeenCalledWith(
        'order-1',
        expect.stringMatching(/\[redacted\]/),
      );
    });

    it('DEMO connection passes even when the authorization machine is not ACTIVE', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(false);
      await expect(
        orchestrator.assertDispatchable({ userId, connection }),
      ).resolves.toBeUndefined();
      // Gate B (LIVE-only) was never consulted for a DEMO connection.
      expect(brokerService.isConnectionExecutable).not.toHaveBeenCalled();
    });
  });

  // ─── Idempotency: duplicates never re-dispatch ────────────────────────────

  describe('dispatchOrder() — idempotency', () => {
    it('DUPLICATE submission → NO provider call, audit suppression, DUPLICATE outcome', async () => {
      orderService.submitOrder.mockResolvedValue({
        status: 'DUPLICATE_EXISTING',
        order: { ...baseOrder, status: OrderStatus.FILLED },
      });

      const outcome = await orchestrator.dispatchOrder(intent, connection);

      expect(outcome.outcome).toBe('DUPLICATE');
      expect(adapter.placeOrder).not.toHaveBeenCalled();
      expect(orderService.markSubmitted).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ORDER_DUPLICATE_SUPPRESSED,
          severity: AuditSeverity.WARNING,
        }),
      );
    });
  });

  // ─── Provider dispatch + response handling ────────────────────────────────

  describe('dispatchOrder() — response handling', () => {
    it('FILLED result → markSubmitted → markAcknowledged → applyFill → FILLED outcome + events', async () => {
      const outcome = await orchestrator.dispatchOrder(intent, connection);

      expect(outcome).toMatchObject({
        outcome: 'FILLED',
        providerOrderId: 'pos-1',
        filledQuantity: '0.05',
        avgFillPrice: '1.08500',
      });
      expect(orderService.markSubmitted).toHaveBeenCalledWith('order-1');
      expect(orderService.markAcknowledged).toHaveBeenCalledWith('order-1', 'pos-1');
      expect(orderService.applyFill).toHaveBeenCalledWith('order-1', {
        quantity: '0.05',
        price: '1.08500',
        providerOrderId: 'pos-1',
      });

      // Full order.* event stream
      const emittedTypes = eventBus.publish.mock.calls.map((c) => c[0]);
      expect(emittedTypes).toContain(DomainEventType.ORDER_SUBMITTED);
      expect(emittedTypes).toContain(DomainEventType.ORDER_ACKNOWLEDGED);
      expect(emittedTypes).toContain(DomainEventType.ORDER_FILLED);

      // Full ORDER_* audit trail
      const auditedActions = auditService.log.mock.calls.map((c) => c[0].action);
      expect(auditedActions).toContain(AuditAction.ORDER_SUBMITTED);
      expect(auditedActions).toContain(AuditAction.ORDER_ACKNOWLEDGED);
      expect(auditedActions).toContain(AuditAction.ORDER_FILLED);
    });

    it('places the provider request with the normalized order fields + hashed idempotency key', async () => {
      await orchestrator.dispatchOrder(intent, connection);

      expect(adapter.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          instrument: 'EURUSD',
          direction: 'BUY',
          lotSize: '0.05',
          stopLoss: '1.07500',
          takeProfit: '1.09500',
          comment: 'caller-idem-key',
          orderKind: 'MARKET',
          timeInForce: 'GTC',
          clientOrderId: 'sig-signal-1',
          idempotencyKey: 'hashed-idem-key',
          connectionReference: 'acc-1',
        }),
      );
    });

    it('FILLED result without provider id → fill applied without ack (fast-market path)', async () => {
      adapter.placeOrder.mockResolvedValueOnce({
        success: true,
        filledPrice: '1.08500',
        status: 'FILLED',
      });
      const outcome = await orchestrator.dispatchOrder(intent, connection);

      expect(outcome.outcome).toBe('FILLED');
      expect(orderService.markAcknowledged).not.toHaveBeenCalled();
      expect(orderService.applyFill).toHaveBeenCalledWith('order-1', {
        quantity: '0.05',
        price: '1.08500',
        providerOrderId: null,
      });
    });

    it('FILLED result with partial fill quantity → applyFill uses the provider quantity', async () => {
      adapter.placeOrder.mockResolvedValueOnce({
        success: true,
        externalOrderId: 'pos-1',
        filledPrice: '1.08500',
        filledQuantity: '0.02',
        status: 'FILLED',
      });
      await orchestrator.dispatchOrder(intent, connection);

      expect(orderService.applyFill).toHaveBeenCalledWith('order-1', {
        quantity: '0.02',
        price: '1.08500',
        providerOrderId: 'pos-1',
      });
    });

    it('PENDING result → markAcknowledged only → WORKING outcome', async () => {
      adapter.placeOrder.mockResolvedValueOnce({
        success: true,
        externalOrderId: 'ord-77',
        status: 'PENDING',
      });
      const outcome = await orchestrator.dispatchOrder(intent, connection);

      expect(outcome).toMatchObject({ outcome: 'WORKING', providerOrderId: 'ord-77' });
      expect(orderService.markAcknowledged).toHaveBeenCalledWith('order-1', 'ord-77');
      expect(orderService.applyFill).not.toHaveBeenCalled();
      expect(eventBus.publish.mock.calls.map((c) => c[0])).toContain(
        DomainEventType.ORDER_ACKNOWLEDGED,
      );
    });

    it('REJECTED result → rejectOrder → REJECTED outcome + warning audit', async () => {
      adapter.placeOrder.mockResolvedValueOnce({
        success: false,
        status: 'REJECTED',
        brokerMessage: 'Insufficient margin',
      });
      const outcome = await orchestrator.dispatchOrder(intent, connection);

      expect(outcome).toMatchObject({ outcome: 'REJECTED', reason: 'Insufficient margin' });
      expect(orderService.rejectOrder).toHaveBeenCalledWith('order-1', 'Insufficient margin');
      expect(eventBus.publish.mock.calls.map((c) => c[0])).toContain(
        DomainEventType.ORDER_REJECTED,
      );
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ORDER_REJECTED,
          severity: AuditSeverity.WARNING,
        }),
      );
    });

    it('FAILED result → rejectOrder → REJECTED outcome', async () => {
      adapter.placeOrder.mockResolvedValueOnce({
        success: false,
        status: 'FAILED',
        brokerMessage: 'TRADE_RETCODE_INVALID',
      });
      const outcome = await orchestrator.dispatchOrder(intent, connection);
      expect(outcome).toMatchObject({ outcome: 'REJECTED', reason: 'TRADE_RETCODE_INVALID' });
    });

    it('FILLED result without a fill price → RECONCILIATION_PENDING (fail-closed)', async () => {
      adapter.placeOrder.mockResolvedValueOnce({
        success: true,
        externalOrderId: 'pos-1',
        status: 'FILLED',
        // no filledPrice
      });
      const outcome = await orchestrator.dispatchOrder(intent, connection);

      expect(outcome.outcome).toBe('UNKNOWN');
      expect(orderService.markReconciliationPending).toHaveBeenCalledWith('order-1');
      expect(eventBus.publish.mock.calls.map((c) => c[0])).toContain(
        DomainEventType.ORDER_RECONCILIATION_PENDING,
      );
    });

    it('provider THROWS → order RECONCILIATION_PENDING → UNKNOWN outcome (never dropped)', async () => {
      adapter.placeOrder.mockRejectedValueOnce(new Error('MetaAPI network error'));
      const outcome = await orchestrator.dispatchOrder(intent, connection);

      expect(outcome).toMatchObject({ outcome: 'UNKNOWN', reason: 'MetaAPI network error' });
      expect(orderService.markReconciliationPending).toHaveBeenCalledWith('order-1');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ORDER_RECONCILIATION_PENDING,
          severity: AuditSeverity.CRITICAL,
        }),
      );
    });

    it('transition failure during recovery does not mask the UNKNOWN outcome', async () => {
      adapter.placeOrder.mockRejectedValueOnce(new Error('network error'));
      orderService.markReconciliationPending.mockRejectedValueOnce(
        new Error('order already terminal'),
      );
      const outcome = await orchestrator.dispatchOrder(intent, connection);

      // The UNKNOWN outcome still surfaces — the transition error is logged,
      // never silently swallowed.
      expect(outcome.outcome).toBe('UNKNOWN');
    });
  });

  // ─── CLOSE_POSITION dispatch ──────────────────────────────────────────────

  describe('dispatchOrder() — CLOSE_POSITION', () => {
    const closeIntent: ExecutionIntent = {
      ...intent,
      clientOrderId: 'close-trade-1',
      direction: 'SELL',
      providerAction: 'CLOSE_POSITION',
      providerReferenceId: 'ext-pos-9',
    };

    it('routes to adapter.closeOrder with the provider reference + quantity', async () => {
      const outcome = await orchestrator.dispatchOrder(closeIntent, connection);

      expect(adapter.closeOrder).toHaveBeenCalledWith('ext-pos-9', '0.05');
      expect(adapter.placeOrder).not.toHaveBeenCalled();
      // The close-order fill price flows into the order's fill accounting...
      expect(orderService.applyFill).toHaveBeenCalledWith('order-1', {
        quantity: '0.05',
        price: '1.09000',
        providerOrderId: 'pos-1',
      });
      // ...and the outcome mirrors the recorded (VWAP) avg fill price.
      expect(outcome).toMatchObject({ outcome: 'FILLED', avgFillPrice: '1.08500' });
    });

    it('CLOSE_POSITION without providerReferenceId → UNKNOWN (fail-closed)', async () => {
      const outcome = await orchestrator.dispatchOrder(
        { ...closeIntent, providerReferenceId: undefined },
        connection,
      );

      expect(outcome.outcome).toBe('UNKNOWN');
      expect(adapter.closeOrder).not.toHaveBeenCalled();
      expect(adapter.placeOrder).not.toHaveBeenCalled();
    });
  });

  // ─── Credential hygiene ───────────────────────────────────────────────────

  describe('credential hygiene', () => {
    it('zeroes decrypted credentials from memory immediately after connect', async () => {
      const captured: Record<string, unknown>[] = [];
      adapter.connect.mockImplementation(async (creds: Record<string, unknown>) => {
        captured.push(creds);
        return { success: true };
      });

      await orchestrator.dispatchOrder(intent, connection);

      // The SAME object that was handed to the adapter is zeroed afterwards.
      expect(captured).toHaveLength(1);
      expect(Object.values(captured[0]).every((v) => v === null)).toBe(true);
      expect(encryptionService.decrypt).toHaveBeenCalledTimes(1);
    });
  });
});
