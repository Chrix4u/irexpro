import { ForbiddenException, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ExecutionOrchestrator } from './execution-orchestrator.service';
import { FinalDispatchBoundary, FinalDispatchBlockedException } from './final-dispatch-boundary';
import type { MarketSafetyGateService } from './market-safety-gate.service';
import { ProviderOperationClass } from '../interfaces/execution-authority';
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
  // Round 7.1 (P0-1): the default adapter mock ECHOES the mode it was set
  // to (the silent-provider contract — connect results carry the
  // contractually-required accountType). Tests that need the provider to
  // CONTRADICT the declaration override adapter.connect explicitly.
  let adapterMode: BrokerMode;
  let auditService: { log: jest.Mock };
  let eventBus: { publish: jest.Mock };
  let encryptionService: { decrypt: jest.Mock };
  // Round 7 (P1): the provider-dispatch commitment seam — mockable so the
  // commitment-block matrix can drive it.
  let boundaryMock: { commitProviderDispatch: jest.Mock };

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    // Round 7.1 (P0-1): default echo mode (silent-provider contract).
    adapterMode = BrokerMode.DEMO;

    boundaryMock = {
      commitProviderDispatch: jest.fn().mockResolvedValue({
        context: {},
        connection,
        confirmationId: null,
        operationClass: 'NEW_EXPOSURE',
      }),
    };

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
      setMode: jest.fn((mode: BrokerMode) => {
        adapterMode = mode;
      }),
      connect: jest.fn().mockImplementation(() =>
        Promise.resolve({ success: true, accountType: adapterMode }),
      ),
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
      // Round 6 (#365): the provider-dispatch commitment seam — suites that
      // drive dispatchOrder WITHOUT a commitment payload never invoke it.
      boundaryMock as unknown as FinalDispatchBoundary,
      // Round 6 §5/§18: the market-safety gate is exercised at the SEAM
      // (its own matrix lives in market-safety-gate.spec.ts) — passes by
      // default; per-test overrides make it fail closed.
      {
        assertMarketSafeForDispatch: jest.fn().mockResolvedValue(undefined),
      } as unknown as MarketSafetyGateService,
      // Round 6 §14: the per-account dispatch lease (real implementation —
      // its own matrix lives in account-dispatch-lease.spec.ts).
      new AccountDispatchLeaseService(),
      // Round 7 (P1 metrics): the lazy MetricsService ModuleRef seam — the
      // stub's get() returns undefined, so every metrics call site no-ops.
      { get: jest.fn() } as unknown as ModuleRef,
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

    // ─── Round 7 (§10): Gate B is OPERATION-AWARE ─────────────────────────

    it('Round 7 §10: a NON-executable LIVE connection still permits RISK-REDUCING CLOSE_POSITION (de-risking must survive authorization degradation)', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(false);
      brokerService.findConnectionById.mockResolvedValue(liveConnection);
      // The credential gate (C) still applies — usable credentials.
      await expect(
        orchestrator.assertDispatchable({
          userId,
          connection: liveConnection,
          operationClass: ProviderOperationClass.CLOSE_POSITION,
        }),
      ).resolves.toBeUndefined();
      // Gate B was consulted for the record but did not block the close.
      expect(brokerService.isConnectionExecutable).toHaveBeenCalled();
    });

    it('Round 7 §10: a NON-executable LIVE connection still permits CANCEL_PENDING', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(false);
      brokerService.findConnectionById.mockResolvedValue(liveConnection);
      await expect(
        orchestrator.assertDispatchable({
          userId,
          connection: liveConnection,
          operationClass: ProviderOperationClass.CANCEL_PENDING,
        }),
      ).resolves.toBeUndefined();
    });

    it('Round 7 §10: NEW_EXPOSURE on a NON-executable LIVE connection stays BLOCKED (the fix never weakens new-exposure gates)', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(false);
      brokerService.findConnectionById.mockResolvedValue(liveConnection);
      await expect(
        orchestrator.assertDispatchable({
          userId,
          connection: liveConnection,
          operationClass: ProviderOperationClass.NEW_EXPOSURE,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('Round 7 §10: the credential gate (C) still applies to risk-reducing closes — unusable credentials never reach the provider', async () => {
      brokerService.isConnectionExecutable.mockReturnValue(false);
      brokerService.findConnectionById.mockResolvedValue({
        ...liveConnection,
        credentialStatus: 'REVOKED',
      } as unknown as BrokerConnection);
      await expect(
        orchestrator.assertDispatchable({
          userId,
          connection: liveConnection,
          operationClass: ProviderOperationClass.CLOSE_POSITION,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    // ─── Round 7.1 (P1): Gate A is OPERATION-AWARE — the close exemption ────
    // Gate A (the emergency control plane) blocks only EXPOSURE-INCREASING
    // operations for EVERY control-plane scope — CLOSE_POSITION / CANCEL_PENDING
    // are exempt so an active emergency can never prevent de-risking. Round 7's
    // §10 matrix covered Gate B (LIVE non-executable); THIS matrix pins the
    // Gate-A exemption per scope (incl. the fail-closed store-unavailable
    // case) together with the invariant that NEW_EXPOSURE stays blocked.

    it.each([
      ['GLOBAL', { scope: 'GLOBAL', scopeKey: null, reason: 'INCIDENT' }],
      ['PROVIDER', { scope: 'PROVIDER', scopeKey: 'paper-broker', reason: 'INCIDENT' }],
      ['USER', { scope: 'USER', scopeKey: userId, reason: 'INCIDENT' }],
      ['BROKER_CONNECTION', { scope: 'BROKER_CONNECTION', scopeKey: 'conn-1', reason: 'INCIDENT' }],
    ])(
      'Round 7.1 (P1): an active %s execution control still permits CLOSE_POSITION (de-risking survives every control scope) while NEW_EXPOSURE stays blocked',
      async (_scope: string, blockedBy: Record<string, unknown>) => {
        controlService.checkExecutionPermission.mockResolvedValue({
          allowed: false,
          blockedBy,
        });

        // CLOSE_POSITION is exempt from Gate A at this scope → resolves.
        await expect(
          orchestrator.assertDispatchable({
            userId,
            connection,
            operationClass: ProviderOperationClass.CLOSE_POSITION,
          }),
        ).resolves.toBeUndefined();

        // The same active control still blocks exposure-INCREASING dispatch.
        await expect(
          orchestrator.assertDispatchable({
            userId,
            connection,
            operationClass: ProviderOperationClass.NEW_EXPOSURE,
          }),
        ).rejects.toThrow(ForbiddenException);
        expect(auditService.log).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.ORDER_REJECTED,
            metadata: expect.objectContaining({
              reason: 'EXECUTION_CONTROL_BLOCKED',
              operationClass: ProviderOperationClass.NEW_EXPOSURE,
            }),
            severity: AuditSeverity.WARNING,
          }),
        );
      },
    );

    it('Round 7.1 (P1): the fail-closed EXECUTION_CONTROL_STORE_UNAVAILABLE case still exempts CLOSE_POSITION while blocking NEW_EXPOSURE (a control-plane outage must never trap open positions)', async () => {
      controlService.checkExecutionPermission.mockResolvedValue({
        allowed: false,
        blockedBy: {
          scope: 'GLOBAL',
          scopeKey: null,
          reason: 'EXECUTION_CONTROL_STORE_UNAVAILABLE',
        },
      });

      await expect(
        orchestrator.assertDispatchable({
          userId,
          connection,
          operationClass: ProviderOperationClass.CLOSE_POSITION,
        }),
      ).resolves.toBeUndefined();

      await expect(
        orchestrator.assertDispatchable({
          userId,
          connection,
          operationClass: ProviderOperationClass.NEW_EXPOSURE,
        }),
      ).rejects.toThrow(ForbiddenException);
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

  describe('dispatchOrder() — Round 7 P1: commitment-block outcome separation', () => {
    it('a FINAL-DISPATCH-BOUNDARY block terminally REJECTS the order, makes ZERO provider calls, and propagates the typed exception', async () => {
      boundaryMock.commitProviderDispatch.mockRejectedValueOnce(
        new FinalDispatchBlockedException(
          'TRADING_AUTHORITY_GENERATION_MISMATCH',
          'The user authority generation advanced after the grant was issued',
        ),
      );

      await expect(
        orchestrator.dispatchOrder(intent, connection, {
          grantId: 'grant-1',
          origin: 'PIPELINE',
        }),
      ).rejects.toMatchObject({ code: 'TRADING_AUTHORITY_GENERATION_MISMATCH' });

      // The reserved order converged to TERMINAL REJECTED — never left
      // SUBMITTED to be mistaken for an uncertain dispatch.
      expect(orderService.rejectOrder).toHaveBeenCalledWith(
        'order-1',
        expect.stringContaining('DISPATCH_BOUNDARY_TRADING_AUTHORITY_GENERATION_MISMATCH'),
      );
      // ZERO provider calls (the boundary threw before dispatchToProvider).
      expect(adapter.placeOrder).not.toHaveBeenCalled();
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ORDER_REJECTED,
          metadata: expect.objectContaining({
            blockedReason: 'TRADING_AUTHORITY_GENERATION_MISMATCH',
            dispatchCertainty: 'DEFINITELY_NOT_SENT',
            gate: 'FINAL_DISPATCH_BOUNDARY',
          }),
        }),
      );
    });

    it('a NON-boundary commitment error propagates WITHOUT rejecting the order (uncertainty is preserved for the reconciliation path)', async () => {
      boundaryMock.commitProviderDispatch.mockRejectedValueOnce(
        new Error('db connection lost mid-commitment'),
      );

      await expect(
        orchestrator.dispatchOrder(intent, connection, {
          grantId: 'grant-1',
          origin: 'PIPELINE',
        }),
      ).rejects.toThrow('db connection lost mid-commitment');

      // A non-boundary failure is NOT provably unsent — the order stays
      // untouched here (executeTrade's uncertain path converges it).
      expect(orderService.rejectOrder).not.toHaveBeenCalled();
      expect(adapter.placeOrder).not.toHaveBeenCalled();
    });

    it('a SUCCESSFUL commitment proceeds to the provider dispatch as before', async () => {
      const outcome = await orchestrator.dispatchOrder(intent, connection, {
        grantId: 'grant-1',
        origin: 'PIPELINE',
      });
      expect(boundaryMock.commitProviderDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ grantId: 'grant-1', orderId: 'order-1', origin: 'PIPELINE' }),
      );
      expect(outcome.outcome).toBe('FILLED');
      expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Round 7.1 (P0-1): pre-dispatch environment fence ─────────────────────

  // ─── Round 7.1 (P0-4): fail-closed action router ──────────────────────────

  describe('dispatchOrder() — Round 7.1 P0-4: fail-closed provider-action router', () => {
    it('an UNKNOWN providerAction NEVER falls through to placeOrder — typed DEFINITELY_NOT_SENT refusal, zero provider calls', async () => {
      // A hypothetical future caller minting e.g. a CANCEL_PENDING intent
      // must not silently OPEN exposure under an exit label (the previous
      // fall-through reached placeOrder for any non-CLOSE_POSITION action).
      const unknownActionIntent: ExecutionIntent = {
        ...intent,
        providerAction: 'CANCEL_PENDING' as ExecutionIntent['providerAction'],
      };

      const outcome = await orchestrator.dispatchOrder(unknownActionIntent, connection);

      expect(adapter.placeOrder).not.toHaveBeenCalled();
      expect(adapter.closeOrder).not.toHaveBeenCalled();
      expect(outcome.outcome).toBe('UNKNOWN');
      if (outcome.outcome === 'UNKNOWN') {
        expect(outcome.certainty).toBe('DEFINITELY_NOT_SENT');
        expect(outcome.reason).toContain('Unsupported providerAction');
      }
    });
  });

  describe('dispatchOrder() — Round 7.1 P0-1: pre-dispatch environment fence', () => {
    it('a provider environment CONTRADICTION at the dispatch connection makes ZERO provider calls and fails closed with DEFINITELY_NOT_SENT certainty (declared DEMO, provider reports LIVE)', async () => {
      // The provider session comes back LIVE while the connection is
      // declared DEMO — the fence must throw BEFORE placeOrder.
      adapter.connect.mockResolvedValueOnce({ success: true, accountType: BrokerMode.LIVE });

      const outcome = await orchestrator.dispatchOrder(intent, connection);

      // ZERO state-changing provider calls — the entire point of the fence.
      expect(adapter.placeOrder).not.toHaveBeenCalled();
      expect(adapter.closeOrder).not.toHaveBeenCalled();
      // The order converges to RECONCILIATION_PENDING with the typed
      // certainty (post-commitment errors never terminally reject — the
      // reconciliation path owns convergence).
      expect(outcome.outcome).toBe('UNKNOWN');
      if (outcome.outcome === 'UNKNOWN') {
        expect(outcome.certainty).toBe('DEFINITELY_NOT_SENT');
        expect(outcome.reason).toContain('Environment mismatch at dispatch');
      }
      expect(orderService.markReconciliationPending).toHaveBeenCalledWith('order-1');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ORDER_RECONCILIATION_PENDING,
          severity: AuditSeverity.CRITICAL,
          metadata: expect.objectContaining({
            dispatchCertainty: 'DEFINITELY_NOT_SENT',
            reason: expect.stringContaining('Environment mismatch at dispatch'),
          }),
        }),
      );
    });

    it('the symmetric contradiction fails closed too (declared LIVE, provider reports DEMO — never a DEMO session executing under LIVE authority)', async () => {
      adapter.connect.mockResolvedValueOnce({ success: true, accountType: BrokerMode.DEMO });

      const outcome = await orchestrator.dispatchOrder(intent, liveConnection);

      expect(adapter.placeOrder).not.toHaveBeenCalled();
      expect(outcome.outcome).toBe('UNKNOWN');
      if (outcome.outcome === 'UNKNOWN') {
        expect(outcome.certainty).toBe('DEFINITELY_NOT_SENT');
      }
    });

    it('a MATCHING provider environment never trips the fence (no false positive — dispatch proceeds)', async () => {
      const outcome = await orchestrator.dispatchOrder(intent, connection);

      expect(outcome.outcome).toBe('FILLED');
      expect(adapter.placeOrder).toHaveBeenCalledTimes(1);
      expect(orderService.markReconciliationPending).not.toHaveBeenCalled();
    });

    it('the fence applies to CLOSE_POSITION dispatches too (an exit must never execute on a mislabeled session)', async () => {
      adapter.connect.mockResolvedValueOnce({ success: true, accountType: BrokerMode.LIVE });
      const closeIntent: ExecutionIntent = {
        ...intent,
        providerAction: 'CLOSE_POSITION',
        providerReferenceId: 'pos-1',
      };

      const outcome = await orchestrator.dispatchOrder(closeIntent, connection);

      expect(adapter.closeOrder).not.toHaveBeenCalled();
      expect(outcome.outcome).toBe('UNKNOWN');
      if (outcome.outcome === 'UNKNOWN') {
        expect(outcome.certainty).toBe('DEFINITELY_NOT_SENT');
      }
    });
  });

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

      // Correction round 4 (finding 7): the reconciliation reason carries the
      // write-certainty classification (sanitized) for downstream evidence.
      expect(outcome).toMatchObject({
        outcome: 'UNKNOWN',
        reason: 'Dispatch error (MAY_HAVE_REACHED_PROVIDER): MetaAPI network error',
      });
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
        return { success: true, accountType: BrokerMode.DEMO };
      });

      await orchestrator.dispatchOrder(intent, connection);

      // The SAME object that was handed to the adapter is zeroed afterwards.
      expect(captured).toHaveLength(1);
      expect(Object.values(captured[0]).every((v) => v === null)).toBe(true);
      expect(encryptionService.decrypt).toHaveBeenCalledTimes(1);
    });
  });
});
