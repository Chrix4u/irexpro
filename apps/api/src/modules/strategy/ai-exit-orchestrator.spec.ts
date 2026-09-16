import { ModuleRef } from '@nestjs/core';
import {
  AiExitOrchestratorService,
  EXIT_CONFIDENCE_THRESHOLD,
} from './ai-exit-orchestrator.service';
import { AuditService } from '../audit/audit.service';
import { ExecutionService } from '../execution/execution.service';
import { ExecutionReadService } from '../execution/execution-read.service';
import {
  AiSignalIdentityGateService,
  SIGNAL_FUTURE_SKEW_MS,
  SIGNAL_MAX_AGE_MS,
  SignalFutureException,
  SignalStaleException,
} from '../execution/orchestration/signal-identity.gate';
import { isExposureIncreasingOperation } from '../execution/orchestration/provider-operation-class';
import { ProviderOperationClass } from '../execution/interfaces/execution-authority';
import { AuditAction } from '../../common/enums/audit-action.enum';
import { AiExitSignal, AiExitResult } from './interfaces/ai-exit-signal.interface';
import { Trade, TradeCloseReason, TradeStatus } from '../execution/entities/trade.entity';
import { TradingSession, TradingSessionStatus } from '../execution/entities/trading-session.entity';

/**
 * AiExitOrchestratorService (Round 6 §10) — the serialized AI exit pipeline.
 *
 * Collaborators are mocked at the seam; the PIPELINE under test is the real
 * production code. Matrix:
 *   - structure failures → typed EXIT_INVALID (audited, no close attempt)
 *   - confidence below the entry-symmetric threshold → LOW_CONFIDENCE
 *   - no active session / session mismatch → SESSION_INACTIVE
 *   - identity gate rejection → SIGNAL_IDENTITY_REJECTED
 *   - duplicate delivery → DUPLICATE_RECOVERED from durable trade state
 *     (all targets CLOSED → recoveredAs EXIT_SUCCEEDED; never a re-close)
 *   - unknown tradeId → EXIT_TARGET_NOT_FOUND
 *   - no OPEN position on the instrument → NO_OPEN_POSITION (idempotent)
 *   - flatten-instrument closes EVERY open position on the instrument
 *   - one close failure among several → EXIT_PARTIAL (others still close)
 *   - every close fails → EXIT_FAILED (audited WARNING)
 *   - §10 SERIALIZATION: per-user exits run strictly one-at-a-time
 *
 * Round 7.1 (P1) additions:
 *   - composed: an active GLOBAL execution control never gates the exit
 *     pipeline — closes dispatch while the same state blocks new exposure
 *     (Gate-A exemption proven in execution-orchestrator.spec.ts)
 *   - cross-tenant: user A's exit signal naming user B's tradeId →
 *     EXIT_TARGET_NOT_FOUND (tenant-scoped target resolution, no close)
 *   - composed staleness: >120s-old generatedAt → SIGNAL_IDENTITY_REJECTED
 *     with NO target resolution and NO close; >30s future skew → same
 */

const USER = 'user-1';
const SIGNAL = 'exit-sig-1';

const session = (overrides: Partial<TradingSession> = {}): TradingSession =>
  ({
    id: 'session-1',
    userId: USER,
    status: TradingSessionStatus.ACTIVE,
    authorityGeneration: 1,
    ...overrides,
  }) as unknown as TradingSession;

const openTrade = (id: string, overrides: Partial<Trade> = {}): Trade =>
  ({
    id,
    userId: USER,
    instrument: 'EURUSD',
    status: TradeStatus.OPEN,
    ...overrides,
  }) as unknown as Trade;

const exitSignal = (overrides: Partial<AiExitSignal> = {}): AiExitSignal => ({
  signalId: SIGNAL,
  userId: USER,
  tradingSessionId: 'session-1',
  instrument: 'EURUSD',
  tradeId: null,
  confidenceScore: 0.8,
  generatedAt: new Date(),
  strategyCode: 'TREND_V1',
  modelVersion: '1.0.0',
  ...overrides,
});

describe('AiExitOrchestratorService — the §10 serialized AI exit pipeline', () => {
  let service: AiExitOrchestratorService;
  let auditService: { log: jest.Mock };
  let executionService: { closeTrade: jest.Mock; getActiveSession: jest.Mock };
  let executionReadService: { listOpenPositions: jest.Mock };
  let signalIdentityGate: { registerOrReuse: jest.Mock };

  const freshRegistration = () => ({ duplicate: false, generatedAt: new Date() });
  const duplicateRegistration = () => ({ duplicate: true, generatedAt: new Date() });

  beforeEach(() => {
    jest.clearAllMocks();
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    executionService = {
      closeTrade: jest.fn(),
      getActiveSession: jest.fn().mockResolvedValue(session()),
    };
    executionReadService = { listOpenPositions: jest.fn().mockResolvedValue([]) };
    signalIdentityGate = { registerOrReuse: jest.fn().mockResolvedValue(freshRegistration()) };
    service = new AiExitOrchestratorService(
      auditService as unknown as AuditService,
      executionService as unknown as ExecutionService,
      executionReadService as unknown as ExecutionReadService,
      signalIdentityGate as unknown as AiSignalIdentityGateService,
      // Round 7 (P1 metrics): the lazy MetricsService ModuleRef seam — the
      // stub's get() returns undefined, so every metrics call site no-ops.
      { get: jest.fn() } as unknown as ModuleRef,
    );
  });

  it('audits AI_EXIT_SIGNAL_RECEIVED for every delivery', async () => {
    await service.processExitSignal(exitSignal());
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.AI_EXIT_SIGNAL_RECEIVED }),
    );
  });

  // ── Gate 1: structure ────────────────────────────────────────────────────

  it('EXIT_INVALID + audited when the structure fails (no close attempt)', async () => {
    const result = await service.processExitSignal(exitSignal({ instrument: '' }));
    expect(result.outcome).toBe('EXIT_INVALID');
    expect(signalIdentityGate.registerOrReuse).not.toHaveBeenCalled();
    expect(executionService.closeTrade).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AI_EXIT_SIGNAL_IGNORED,
        metadata: expect.objectContaining({ failureCode: 'EXIT_INVALID' }),
      }),
    );
  });

  // ── Gate 2: confidence ───────────────────────────────────────────────────

  it('LOW_CONFIDENCE below the entry-symmetric threshold', async () => {
    const result = await service.processExitSignal(
      exitSignal({ confidenceScore: EXIT_CONFIDENCE_THRESHOLD - 0.01 }),
    );
    expect(result.outcome).toBe('LOW_CONFIDENCE');
    expect(executionService.closeTrade).not.toHaveBeenCalled();
  });

  it('EXIT_INVALID for a confidence outside 0–1', async () => {
    const result = await service.processExitSignal(exitSignal({ confidenceScore: 1.5 }));
    expect(result.outcome).toBe('EXIT_INVALID');
  });

  // ── Gate 3: session binding ──────────────────────────────────────────────

  it('SESSION_INACTIVE when no active session exists', async () => {
    executionService.getActiveSession.mockResolvedValue(null);
    const result = await service.processExitSignal(exitSignal());
    expect(result.outcome).toBe('SESSION_INACTIVE');
    expect(signalIdentityGate.registerOrReuse).not.toHaveBeenCalled();
  });

  it('SESSION_INACTIVE when the session reference is stale (mismatch)', async () => {
    const result = await service.processExitSignal(exitSignal({ tradingSessionId: 'session-OLD' }));
    expect(result.outcome).toBe('SESSION_INACTIVE');
    expect(result.reason).toContain('does not match');
  });

  // ── Gate 4: signal identity ──────────────────────────────────────────────

  it('SIGNAL_IDENTITY_REJECTED when the identity gate rejects (stale/conflict)', async () => {
    signalIdentityGate.registerOrReuse.mockRejectedValue(new Error('Signal is stale'));
    const result = await service.processExitSignal(exitSignal());
    expect(result.outcome).toBe('SIGNAL_IDENTITY_REJECTED');
    expect(executionService.closeTrade).not.toHaveBeenCalled();
  });

  it('Round 7.1 (P1): a >120s-old generatedAt is typed-rejected with NOTHING persisted or closed (no target resolution, no closeTrade)', async () => {
    // Composed with the REAL gate semantics: the generatedAt instant is past
    // the gate's SIGNAL_MAX_AGE_MS boundary and the (mocked) gate throws the
    // gate's own SignalStaleException — the orchestrator maps it to the
    // typed SIGNAL_IDENTITY_REJECTED outcome BEFORE any serialized work.
    const staleGeneratedAt = new Date(Date.now() - (SIGNAL_MAX_AGE_MS + 5_000));
    signalIdentityGate.registerOrReuse.mockImplementation(async () => {
      const age = Date.now() - staleGeneratedAt.getTime();
      throw new SignalStaleException(staleGeneratedAt, age);
    });

    const result = await service.processExitSignal(exitSignal({ generatedAt: staleGeneratedAt }));

    expect(result.outcome).toBe('SIGNAL_IDENTITY_REJECTED');
    expect(result.reason).toContain('stale');
    // Nothing persisted/closed: a stale decision NEVER reaches target
    // resolution or closeTrade.
    expect(executionReadService.listOpenPositions).not.toHaveBeenCalled();
    expect(executionService.closeTrade).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AI_EXIT_SIGNAL_IGNORED,
        metadata: expect.objectContaining({ failureCode: 'SIGNAL_IDENTITY_REJECTED' }),
      }),
    );
  });

  it('Round 7.1 (P1): a >30s future-skewed generatedAt is typed-rejected with NOTHING persisted or closed (no target resolution, no closeTrade)', async () => {
    // Future-dated exit decisions are exactly as untrustworthy as stale ones
    // (the gate's SIGNAL_FUTURE_SKEW_MS producer clock-skew tolerance).
    const futureGeneratedAt = new Date(Date.now() + (SIGNAL_FUTURE_SKEW_MS + 5_000));
    signalIdentityGate.registerOrReuse.mockImplementation(async () => {
      const skew = futureGeneratedAt.getTime() - Date.now();
      throw new SignalFutureException(futureGeneratedAt, skew);
    });

    const result = await service.processExitSignal(exitSignal({ generatedAt: futureGeneratedAt }));

    expect(result.outcome).toBe('SIGNAL_IDENTITY_REJECTED');
    expect(result.reason).toContain('future');
    expect(executionReadService.listOpenPositions).not.toHaveBeenCalled();
    expect(executionService.closeTrade).not.toHaveBeenCalled();
  });

  it('registers the EXIT material fields in the identity digest', async () => {
    await service.processExitSignal(exitSignal({ tradeId: 'trade-9' }));
    expect(signalIdentityGate.registerOrReuse).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        signalId: SIGNAL,
        materialFields: expect.objectContaining({
          kind: 'EXIT',
          instrument: 'EURUSD',
          tradeId: 'trade-9',
        }),
      }),
    );
  });

  // ── Gate 5: duplicate recovery ───────────────────────────────────────────

  it('DUPLICATE_RECOVERED (EXIT_SUCCEEDED) when every target is already CLOSED', async () => {
    signalIdentityGate.registerOrReuse.mockResolvedValue(duplicateRegistration());
    executionReadService.listOpenPositions.mockResolvedValue([]);
    // The targeted trade exists but is CLOSED (listOpenPositions only returns
    // OPEN rows — the duplicate recovery reports the durable outcome).
    const result = await service.processExitSignal(exitSignal());
    expect(result.outcome).toBe('DUPLICATE_RECOVERED');
    expect(result.recoveredAs).toBe('NO_OPEN_POSITION');
    expect(executionService.closeTrade).not.toHaveBeenCalled();
  });

  it('DUPLICATE_RECOVERED never re-closes when the first delivery already closed', async () => {
    signalIdentityGate.registerOrReuse.mockResolvedValue(duplicateRegistration());
    const result = await service.processExitSignal(exitSignal());
    expect(result.outcome).toBe('DUPLICATE_RECOVERED');
    expect(executionService.closeTrade).not.toHaveBeenCalled();
  });

  // ── Gate 6: target resolution ────────────────────────────────────────────

  it('EXIT_TARGET_NOT_FOUND for an unknown tradeId', async () => {
    executionReadService.listOpenPositions.mockResolvedValue([openTrade('trade-OTHER')]);
    const result = await service.processExitSignal(exitSignal({ tradeId: 'trade-MISSING' }));
    expect(result.outcome).toBe('EXIT_TARGET_NOT_FOUND');
    expect(executionService.closeTrade).not.toHaveBeenCalled();
  });

  it('NO_OPEN_POSITION when nothing is OPEN on the instrument (idempotent)', async () => {
    executionReadService.listOpenPositions.mockResolvedValue([
      openTrade('trade-GBP', { instrument: 'GBPUSD' }),
    ]);
    const result = await service.processExitSignal(exitSignal());
    expect(result.outcome).toBe('NO_OPEN_POSITION');
    expect(executionService.closeTrade).not.toHaveBeenCalled();
  });

  it('Round 7.1 (P1): cross-tenant exit — user A naming user B’s tradeId resolves to EXIT_TARGET_NOT_FOUND (tenant-scoped resolution, never a close)', async () => {
    // User A’s open positions ONLY: B’s trade id exists in the store but is
    // invisible to A’s tenant-scoped listOpenPositions read.
    executionReadService.listOpenPositions.mockResolvedValue([
      openTrade('trade-A1'),
      openTrade('trade-A2'),
    ]);

    const result = await service.processExitSignal(exitSignal({ tradeId: 'trade-B1' }));

    expect(result.outcome).toBe('EXIT_TARGET_NOT_FOUND');
    expect(result.reason).toContain('trade-B1');
    // The tenant-scoped read ran for the SIGNALING user only.
    expect(executionReadService.listOpenPositions).toHaveBeenCalledWith(USER);
    // No cross-tenant close was ever attempted (closeTrade additionally
    // re-proves ownership via findOne({ id, userId })).
    expect(executionService.closeTrade).not.toHaveBeenCalled();
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AI_EXIT_SIGNAL_IGNORED,
        metadata: expect.objectContaining({ failureCode: 'EXIT_TARGET_NOT_FOUND' }),
      }),
    );
  });

  // ── Gate 7: serialized closes ────────────────────────────────────────────

  it('closes EVERY open position on the instrument (flatten) with AI_CLOSE_SIGNAL', async () => {
    executionReadService.listOpenPositions.mockResolvedValue([
      openTrade('trade-1'),
      openTrade('trade-2'),
      openTrade('trade-3', { instrument: 'GBPUSD' }), // different instrument — untouched
    ]);
    executionService.closeTrade.mockImplementation(async (tradeId: string) =>
      openTrade(tradeId, { status: TradeStatus.CLOSED }),
    );

    const result = await service.processExitSignal(exitSignal());

    expect(result.outcome).toBe('EXIT_SUCCEEDED');
    expect(executionService.closeTrade).toHaveBeenCalledTimes(2);
    expect(executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      USER,
      TradeCloseReason.AI_CLOSE_SIGNAL,
    );
    expect(executionService.closeTrade).toHaveBeenCalledWith(
      'trade-2',
      USER,
      TradeCloseReason.AI_CLOSE_SIGNAL,
    );
    expect(result.trades.map((t) => t.tradeId).sort()).toEqual(['trade-1', 'trade-2']);
  });

  it('closes exactly the targeted tradeId', async () => {
    executionReadService.listOpenPositions.mockResolvedValue([
      openTrade('trade-1'),
      openTrade('trade-2'),
    ]);
    executionService.closeTrade.mockImplementation(async (tradeId: string) =>
      openTrade(tradeId, { status: TradeStatus.CLOSED }),
    );

    const result = await service.processExitSignal(exitSignal({ tradeId: 'trade-2' }));
    expect(result.outcome).toBe('EXIT_SUCCEEDED');
    expect(executionService.closeTrade).toHaveBeenCalledTimes(1);
    expect(executionService.closeTrade).toHaveBeenCalledWith(
      'trade-2',
      USER,
      TradeCloseReason.AI_CLOSE_SIGNAL,
    );
  });

  it('EXIT_PARTIAL when one close fails but the others de-risk', async () => {
    executionReadService.listOpenPositions.mockResolvedValue([
      openTrade('trade-OK'),
      openTrade('trade-BAD'),
    ]);
    executionService.closeTrade.mockImplementation(async (tradeId: string) => {
      if (tradeId === 'trade-BAD') throw new Error('provider refused the close');
      return openTrade(tradeId, { status: TradeStatus.CLOSED });
    });

    const result = await service.processExitSignal(exitSignal());

    expect(result.outcome).toBe('EXIT_PARTIAL');
    expect(executionService.closeTrade).toHaveBeenCalledTimes(2);
    const bad = result.trades.find((t) => t.tradeId === 'trade-BAD');
    expect(bad?.closed).toBe(false);
    expect(bad?.reason).toContain('provider refused');
  });

  it('EXIT_FAILED (audited WARNING) when every close fails', async () => {
    executionReadService.listOpenPositions.mockResolvedValue([openTrade('trade-1')]);
    executionService.closeTrade.mockRejectedValue(new Error('connection down'));

    const result = await service.processExitSignal(exitSignal());

    expect(result.outcome).toBe('EXIT_FAILED');
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AI_EXIT_SIGNAL_FAILED,
        metadata: expect.objectContaining({ outcome: 'EXIT_FAILED' }),
      }),
    );
  });

  it('audits AI_EXIT_SIGNAL_EXECUTED on success with per-trade results', async () => {
    executionReadService.listOpenPositions.mockResolvedValue([openTrade('trade-1')]);
    executionService.closeTrade.mockResolvedValue(
      openTrade('trade-1', { status: TradeStatus.CLOSED }),
    );

    await service.processExitSignal(exitSignal());

    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.AI_EXIT_SIGNAL_EXECUTED,
        metadata: expect.objectContaining({
          outcome: 'EXIT_SUCCEEDED',
          closedCount: 1,
          targetCount: 1,
        }),
      }),
    );
  });

  it('reports a dispatched-but-pending close honestly (not CLOSED)', async () => {
    executionReadService.listOpenPositions.mockResolvedValue([openTrade('trade-1')]);
    // closeTrade moved the trade to RECONCILIATION_PENDING (unknown outcome).
    executionService.closeTrade.mockResolvedValue(
      openTrade('trade-1', { status: TradeStatus.RECONCILIATION_PENDING }),
    );

    const result = await service.processExitSignal(exitSignal());

    expect(result.outcome).toBe('EXIT_PARTIAL');
    expect(result.trades[0].closed).toBe(false);
    expect(result.trades[0].reason).toContain('RECONCILIATION_PENDING');
  });

  it('Round 7.1 (P1): an active GLOBAL execution control never gates the exit pipeline — closes dispatch while the same control state blocks new exposure', async () => {
    // Composed representation of an active GLOBAL kill switch: exactly what
    // ExecutionControlService.checkExecutionPermission reports while a
    // GLOBAL control row is ACTIVE. The Gate-A exemption itself is proven at
    // the orchestrator boundary (execution-orchestrator.spec.ts, Round 7.1
    // (P1) Gate-A matrix); THIS test proves the EXIT pipeline’s own layer
    // dispatches its closes under that control state — the closeTrade seam
    // enforces Gate-A’s operation-aware contract via the production
    // classifier: CLOSE_POSITION is exempt, NEW_EXPOSURE would be blocked.
    const activeGlobalControl = {
      allowed: false,
      blockedBy: { scope: 'GLOBAL', scopeKey: null, reason: 'INCIDENT' },
    };
    // The control state blocks exposure-INCREASING operations …
    expect(
      !activeGlobalControl.allowed &&
        isExposureIncreasingOperation(ProviderOperationClass.NEW_EXPOSURE),
    ).toBe(true);
    // … but NOT the risk-reducing CLOSE class the exit pipeline dispatches.
    expect(
      !activeGlobalControl.allowed &&
        isExposureIncreasingOperation(ProviderOperationClass.CLOSE_POSITION),
    ).toBe(false);

    executionReadService.listOpenPositions.mockResolvedValue([
      openTrade('trade-1'),
      openTrade('trade-2'),
      openTrade('trade-GBP', { instrument: 'GBPUSD' }), // untouched instrument
    ]);
    executionService.closeTrade.mockImplementation(async (tradeId: string) =>
      openTrade(tradeId, { status: TradeStatus.CLOSED }),
    );

    const result = await service.processExitSignal(exitSignal());

    // The exit path DISPATCHED its closes while the kill switch was active.
    expect(result.outcome).toBe('EXIT_SUCCEEDED');
    expect(executionService.closeTrade).toHaveBeenCalledTimes(2);
    expect(executionService.closeTrade).toHaveBeenCalledWith(
      'trade-1',
      USER,
      TradeCloseReason.AI_CLOSE_SIGNAL,
    );
    expect(executionService.closeTrade).toHaveBeenCalledWith(
      'trade-2',
      USER,
      TradeCloseReason.AI_CLOSE_SIGNAL,
    );
  });

  // ── §10 SERIALIZATION ────────────────────────────────────────────────────

  it('serializes exits for one user strictly one-at-a-time (no overlapping closes)', async () => {
    executionReadService.listOpenPositions.mockResolvedValue([openTrade('trade-1')]);
    // Record each closeTrade execution window; a 15ms delay makes overlap
    // observable if two exits ever ran concurrently for the same user.
    const windows: Array<{ start: number; end: number }> = [];
    executionService.closeTrade.mockImplementation(async () => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 15));
      const end = Date.now();
      windows.push({ start, end });
      return openTrade('trade-1', { status: TradeStatus.CLOSED });
    });

    const results = await Promise.all([
      service.processExitSignal(exitSignal({ signalId: 'exit-A' })),
      service.processExitSignal(exitSignal({ signalId: 'exit-B' })),
      service.processExitSignal(exitSignal({ signalId: 'exit-C' })),
    ]);

    expect(results).toHaveLength(3);
    expect(windows).toHaveLength(3);
    // §10 serialization: sort by start; each window must start only AFTER
    // the previous one ended (strictly sequential, zero overlap).
    const ordered = [...windows].sort((a, b) => a.start - b.start);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i].start).toBeGreaterThanOrEqual(ordered[i - 1].end);
    }
  });

  it('a rejected exit never wedges the per-user chain (later exits proceed)', async () => {
    executionReadService.listOpenPositions
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValue([openTrade('trade-1')]);
    executionService.closeTrade.mockResolvedValue(
      openTrade('trade-1', { status: TradeStatus.CLOSED }),
    );

    const first = service.processExitSignal(exitSignal({ signalId: 'exit-A' }));
    await expect(first).rejects.toThrow('db hiccup');

    const second: AiExitResult = await service.processExitSignal(
      exitSignal({ signalId: 'exit-B' }),
    );
    expect(second.outcome).toBe('EXIT_SUCCEEDED');
  });

  it('different users proceed concurrently (no global lock)', async () => {
    const order: string[] = [];
    executionService.getActiveSession.mockImplementation(async (userId: string) => {
      order.push(`start:${userId}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${userId}`);
      return session({ id: `session-${userId}` });
    });

    await Promise.all([
      service.processExitSignal(
        exitSignal({ userId: 'user-A', tradingSessionId: 'session-user-A' }),
      ),
      service.processExitSignal(
        exitSignal({ userId: 'user-B', tradingSessionId: 'session-user-B' }),
      ),
    ]);

    // user-B started before user-A ended → concurrent across users.
    expect(order.indexOf('start:user-B')).toBeLessThan(order.indexOf('end:user-A'));
  });
});
