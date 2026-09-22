import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ExecutionService } from './execution.service';
import { EmergencyFlattenProducer } from './jobs/emergency-flatten.producer';
import { ExecutionOrchestrator } from './orchestration/execution-orchestrator.service';
import { FinalDispatchBoundary } from './orchestration/final-dispatch-boundary';
import { TradeLifecycleCasService } from './orders/trade-lifecycle-cas.service';
import { Trade, TradeCloseReason, TradeStatus } from './entities/trade.entity';
import { TradingSession } from './entities/trading-session.entity';
import { RiskGrant } from './entities/risk-grant.entity';
import { ExecutionConfirmation } from './entities/execution-confirmation.entity';
import { ExecutionMode } from './interfaces/execution-authority';
import { BrokerService } from '../broker/broker.service';
import { BrokerMode, BrokerConnectionStatus } from '../broker/interfaces/broker-adapter.interface';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { DomainEventBus } from '../events/event-bus.service';
import { ExecutionSessionResolutionService } from './execution-session.resolution';
import { TradeIntentService } from './services/trade-intent.service';

/**
 * October UAT hardening (WS1) — the user-facing manual single-position close.
 *
 * These tests pin the HONEST outcome mapping, the ownership checks, the
 * idempotent/race-safe behavior (delegated to the same closeTrade engine the
 * AI exit / Stop flatten / kill switch use), the audit event, and the
 * sanitized provider error class (never credentials, never raw payloads).
 */
describe('ExecutionService.closeOpenPositionManually (WS1 manual close)', () => {
  let module: TestingModule;
  let service: ExecutionService;
  let tradeRepo: { findOne: jest.Mock; find: jest.Mock; count: jest.Mock };
  let auditService: { log: jest.Mock };
  let closeTradeSpy: jest.SpyInstance;

  const USER = 'user-1';
  const OTHER_USER = 'user-2';
  const TRADE_ID = '11111111-1111-4111-8111-111111111111';

  const makeTrade = (overrides: Partial<Trade> = {}): Trade =>
    ({
      id: TRADE_ID,
      userId: USER,
      status: TradeStatus.OPEN,
      externalOrderId: 'ext-1',
      brokerConnectionId: 'conn-1',
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.05',
      signalId: null,
      stopLoss: '1.0700',
      takeProfit: '1.0900',
      requestedEntryPrice: '1.0800',
      fillPrice: '1.0805',
      exitPrice: null,
      accountCurrency: 'USD',
      realisedPnl: null,
      commission: null,
      swap: null,
      closeReason: null,
      openedAt: new Date(),
      closedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as Trade;

  beforeEach(async () => {
    jest.clearAllMocks();
    tradeRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    module = await Test.createTestingModule({
      providers: [
        ExecutionService,
        { provide: EmergencyFlattenProducer, useValue: { enqueueDurableFlatten: jest.fn() } },
        { provide: getRepositoryToken(Trade), useValue: tradeRepo },
        {
          provide: getRepositoryToken(TradingSession),
          useValue: { findOne: jest.fn(), find: jest.fn(), update: jest.fn() },
        },
        {
          provide: getRepositoryToken(RiskGrant),
          useValue: { findOne: jest.fn(), update: jest.fn(), createQueryBuilder: jest.fn() },
        },
        {
          provide: getRepositoryToken(ExecutionConfirmation),
          useValue: { findOne: jest.fn(), update: jest.fn() },
        },
        {
          provide: BrokerService,
          useValue: {
            findConnectionById: jest.fn().mockResolvedValue({
              id: 'conn-1',
              userId: USER,
              brokerId: 'metatrader',
              accountType: BrokerMode.DEMO,
              status: BrokerConnectionStatus.CONNECTED,
              authorizationStatus: 'ACTIVE',
            }),
            isConnectionExecutable: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: ExecutionOrchestrator,
          useValue: { assertDispatchable: jest.fn(), dispatchOrder: jest.fn() },
        },
        { provide: FinalDispatchBoundary, useValue: { authorizeNewExposureDispatch: jest.fn() } },
        { provide: TradeLifecycleCasService, useValue: { applyCasTransition: jest.fn() } },
        { provide: TradeIntentService, useValue: {} },
        { provide: AuditService, useValue: auditService },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        {
          provide: DomainEventBus,
          useValue: { publish: jest.fn(), subscribe: jest.fn().mockReturnValue(() => {}) },
        },
        {
          provide: ExecutionSessionResolutionService,
          useValue: {
            resolveActiveSessionAuthority: jest.fn().mockResolvedValue({
              sessionId: 'session-1',
              sessionGeneration: 1,
              executionMode: ExecutionMode.PAPER_ONLY,
              brokerConnectionId: 'conn-1',
            }),
          },
        },
      ],
    }).compile();

    service = module.get<ExecutionService>(ExecutionService);
    // The dispatch engine itself is exhaustively covered by the closeTrade
    // suites — here we pin the manual surface's mapping over its outcomes.
    closeTradeSpy = jest.spyOn(service, 'closeTrade');
  });

  afterEach(async () => {
    await module.close();
  });

  // ─── Ownership ─────────────────────────────────────────────────────────────

  it('rejects a foreign user\u2019s position with NotFound (no existence oracle)', async () => {
    tradeRepo.findOne.mockResolvedValue(null);

    await expect(service.closeOpenPositionManually(TRADE_ID, OTHER_USER)).rejects.toThrow(
      NotFoundException,
    );
    expect(tradeRepo.findOne).toHaveBeenCalledWith({
      where: { id: TRADE_ID, userId: OTHER_USER },
    });
    expect(closeTradeSpy).not.toHaveBeenCalled();
  });

  it('authorizes the owning user and routes through closeTrade with MANUAL_CLOSE', async () => {
    const open = makeTrade();
    const closed = makeTrade({ status: TradeStatus.CLOSED, exitPrice: '1.0810' });
    tradeRepo.findOne
      .mockResolvedValueOnce(open) // pre-check
      .mockResolvedValueOnce(closed); // post-refresh
    closeTradeSpy.mockResolvedValue(closed);

    const result = await service.closeOpenPositionManually(TRADE_ID, USER);

    expect(result.outcome).toBe('CLOSED');
    expect(result.position?.status).toBe('CLOSED');
    expect(closeTradeSpy).toHaveBeenCalledWith(TRADE_ID, USER, TradeCloseReason.MANUAL_CLOSE);
  });

  // ─── Honest outcome mapping ────────────────────────────────────────────────

  it('ALREADY_CLOSED: an idempotent retry against a closed position is a safe no-op', async () => {
    tradeRepo.findOne.mockResolvedValue(makeTrade({ status: TradeStatus.CLOSED }));

    const result = await service.closeOpenPositionManually(TRADE_ID, USER);

    expect(result.outcome).toBe('ALREADY_CLOSED');
    expect(closeTradeSpy).not.toHaveBeenCalled();
  });

  it('RECONCILIATION_REQUIRED: a reconciliation-held position is never double-closed manually', async () => {
    tradeRepo.findOne.mockResolvedValue(makeTrade({ status: TradeStatus.RECONCILIATION_PENDING }));

    const result = await service.closeOpenPositionManually(TRADE_ID, USER);

    expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
    expect(closeTradeSpy).not.toHaveBeenCalled();
  });

  it('rejects non-openable terminal states with a typed conflict', async () => {
    tradeRepo.findOne.mockResolvedValue(makeTrade({ status: TradeStatus.PENDING }));

    await expect(service.closeOpenPositionManually(TRADE_ID, USER)).rejects.toThrow(
      ConflictException,
    );
  });

  it('CLOSE_IN_PROGRESS: a concurrent close (AI exit / Stop / kill switch / earlier click) is reported honestly', async () => {
    const stillOpen = makeTrade();
    tradeRepo.findOne.mockResolvedValue(stillOpen);
    closeTradeSpy.mockResolvedValue(stillOpen); // DUPLICATE path — in-flight close

    const result = await service.closeOpenPositionManually(TRADE_ID, USER);

    expect(result.outcome).toBe('CLOSE_IN_PROGRESS');
  });

  it('RECONCILIATION_REQUIRED: an unknown provider outcome maps to reconciliation, never a fabricated close', async () => {
    const pending = makeTrade({ status: TradeStatus.RECONCILIATION_PENDING });
    tradeRepo.findOne.mockResolvedValueOnce(makeTrade()).mockResolvedValueOnce(pending);
    closeTradeSpy.mockResolvedValue(pending);

    const result = await service.closeOpenPositionManually(TRADE_ID, USER);

    expect(result.outcome).toBe('RECONCILIATION_REQUIRED');
  });

  it('PROVIDER_REFUSED: a provider refusal keeps the position OPEN and sanitizes the error class', async () => {
    tradeRepo.findOne.mockResolvedValue(makeTrade());
    closeTradeSpy.mockRejectedValue(
      new ConflictException(
        'Broker refused to close position: MARKET_CLOSED is closed. The trade remains OPEN.',
      ),
    );

    const result = await service.closeOpenPositionManually(TRADE_ID, USER);

    expect(result.outcome).toBe('PROVIDER_REFUSED');
    expect(result.providerErrorClass).toBe('MARKET_CLOSED');
    expect(result.message).toContain('remains OPEN');
  });

  it('sanitizes an unrecognizable provider refusal to the coarse class (no raw payload leak)', async () => {
    tradeRepo.findOne.mockResolvedValue(makeTrade());
    closeTradeSpy.mockRejectedValue(
      new ConflictException('Broker refused to close position: something odd happened'),
    );

    const result = await service.closeOpenPositionManually(TRADE_ID, USER);

    expect(result.outcome).toBe('PROVIDER_REFUSED');
    expect(result.providerErrorClass).toBe('PROVIDER_REFUSED');
  });

  // ─── Audit ────────────────────────────────────────────────────────────────

  it('writes the TRADE_MANUAL_CLOSE_REQUESTED audit with actor, connection, trade, outcome and timestamp', async () => {
    const closed = makeTrade({ status: TradeStatus.CLOSED, exitPrice: '1.0810' });
    tradeRepo.findOne.mockResolvedValueOnce(makeTrade()).mockResolvedValueOnce(closed);
    closeTradeSpy.mockResolvedValue(closed);

    await service.closeOpenPositionManually(TRADE_ID, USER);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        actorUserId: USER,
        action: AuditAction.TRADE_MANUAL_CLOSE_REQUESTED,
        resourceType: 'Trade',
        resourceId: TRADE_ID,
        metadata: expect.objectContaining({
          brokerConnectionId: 'conn-1',
          instrument: 'EURUSD',
          outcome: 'CLOSED',
          finalStatus: TradeStatus.CLOSED,
          requestedAt: expect.any(String),
        }),
      }),
    );
  });

  it('audits a provider refusal as a WARNING with the sanitized error class', async () => {
    tradeRepo.findOne.mockResolvedValue(makeTrade());
    closeTradeSpy.mockRejectedValue(
      new ConflictException(
        'Broker refused to close position: RATE_LIMITED. The trade remains OPEN.',
      ),
    );

    await service.closeOpenPositionManually(TRADE_ID, USER);

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.TRADE_MANUAL_CLOSE_REQUESTED,
        metadata: expect.objectContaining({
          outcome: 'PROVIDER_REFUSED',
          providerErrorClass: 'RATE_LIMITED',
        }),
      }),
    );
  });

  it('audits and re-throws unexpected failures (never a silent skip)', async () => {
    tradeRepo.findOne.mockResolvedValue(makeTrade());
    closeTradeSpy.mockRejectedValue(new Error('connection store unavailable'));

    await expect(service.closeOpenPositionManually(TRADE_ID, USER)).rejects.toThrow(
      'connection store unavailable',
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.TRADE_MANUAL_CLOSE_REQUESTED,
        metadata: expect.objectContaining({
          outcome: 'FAILED',
          errorClass: 'Error',
        }),
      }),
    );
  });

  it('never includes credential-shaped material in the audit metadata or response', async () => {
    const closed = makeTrade({ status: TradeStatus.CLOSED });
    tradeRepo.findOne.mockResolvedValueOnce(makeTrade()).mockResolvedValueOnce(closed);
    closeTradeSpy.mockResolvedValue(closed);

    await service.closeOpenPositionManually(TRADE_ID, USER);

    const calls = auditService.log.mock.calls as unknown as Array<
      {
        actorUserId: string;
        metadata: Record<string, unknown>;
      }[]
    >;
    for (const call of calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toMatch(/apiKey|apiSecret|token|password/i);
    }
  });
});
