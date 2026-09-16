import { ConflictException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Repository } from 'typeorm';
import { ExecutionConfirmationService } from './execution-confirmation.service';
import { ReconfirmationRequiredException } from './execution-confirmation.service';
import type { ExecutionConfirmation } from './entities/execution-confirmation.entity';
import type { RiskGrant } from './entities/risk-grant.entity';
import type { RiskProfile } from '../risk/entities/risk-profile.entity';
import type { FinalDispatchBoundary } from './orchestration/final-dispatch-boundary';
import type { ExecutionService } from './execution.service';
import { ExecutionConfirmationStatus, ExecutionMode } from './interfaces/execution-authority';
import type { RiskApprovalResult } from '../risk/interfaces/risk.interface';
import type { Trade } from './entities/trade.entity';
import { TradeStatus } from './entities/trade.entity';

/**
 * Round 7 (SEMI_AUTO confirm-path P0 fix) — the server-authoritative
 * confirmation surface matrix:
 *
 *   - confirm() drives the §18 fresh re-evaluation WITH the
 *     rebindConfirmationId option so the user's existing PENDING confirmation
 *     is RE-BOUND to the fresh grant (never revoked by the supersession).
 *   - expired / missing / consumed confirmations fail with typed 409s.
 *   - a fresh risk rejection NEVER reaches executeTrade (zero provider calls).
 *   - a material order change requires RECONFIRMATION (never a silent
 *     dispatch of the changed order).
 *   - an APPROVED, materially-unchanged evaluation dispatches through
 *     executeTrade with the SAME one-time confirmationId.
 */

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '99999999-9999-4999-8999-999999999999';
const SIGNAL = 'sig-confirm-001';
const SESSION = 'session-1';
const CONN = '33333333-3333-4333-8333-333333333333';

const confirmationRow = (overrides: Partial<ExecutionConfirmation> = {}): ExecutionConfirmation =>
  ({
    id: 'conf-1',
    userId: USER,
    sessionId: SESSION,
    sessionGeneration: 1,
    signalId: SIGNAL,
    brokerConnectionId: CONN,
    riskGrantId: 'grant-1',
    orderPayloadDigest: 'd'.repeat(64),
    instrument: 'EURUSD',
    direction: 'BUY',
    quantity: '0.05',
    stopLoss: '1.07500',
    takeProfit: '1.09500',
    expiresAt: new Date(Date.now() + 120_000),
    consumedAt: null,
    revokedAt: null,
    status: ExecutionConfirmationStatus.PENDING,
    createdAt: new Date(Date.now() - 5_000),
    updatedAt: new Date(Date.now() - 5_000),
    ...overrides,
  }) as ExecutionConfirmation;

const approvedDecision = (overrides: Partial<RiskApprovalResult> = {}): RiskApprovalResult =>
  ({
    decision: 'APPROVED',
    signalId: SIGNAL,
    validatedOrder: {
      instrument: 'EURUSD',
      direction: 'BUY',
      lotSize: '0.05',
      entryPrice: '0',
      stopLoss: '1.07500',
      takeProfit: '1.09500',
      idempotencyKey: `${USER}:${SIGNAL}`,
    },
    grantId: 'grant-2',
    sessionId: SESSION,
    sessionGeneration: 1,
    executionMode: ExecutionMode.SEMI_AUTO,
    brokerConnectionId: CONN,
    ...overrides,
  }) as RiskApprovalResult;

describe('ExecutionConfirmationService (Round 7 SEMI_AUTO confirm-path)', () => {
  let service: ExecutionConfirmationService;
  let confirmationRepo: { findOne: jest.Mock; find: jest.Mock };
  let riskGrantRepo: { find: jest.Mock };
  let riskService: { validateProposedTrade: jest.Mock };
  // (kept for future matrix rows that need the rejection shape)
  let executionService: { executeTrade: jest.Mock };

  const buildService = (): void => {
    const moduleRef = {
      get: jest.fn().mockReturnValue(riskService),
    } as unknown as ModuleRef;
    service = new ExecutionConfirmationService(
      confirmationRepo as unknown as Repository<ExecutionConfirmation>,
      riskGrantRepo as unknown as Repository<RiskGrant>,
      {} as Repository<RiskProfile>,
      {} as FinalDispatchBoundary,
      executionService as unknown as ExecutionService,
      moduleRef,
    );
  };

  beforeEach(() => {
    confirmationRepo = {
      findOne: jest.fn().mockResolvedValue(confirmationRow()),
      find: jest.fn().mockResolvedValue([]),
    };
    riskGrantRepo = { find: jest.fn().mockResolvedValue([]) };
    riskService = { validateProposedTrade: jest.fn().mockResolvedValue(approvedDecision()) };
    executionService = {
      executeTrade: jest.fn().mockResolvedValue({
        id: 'trade-1',
        status: TradeStatus.PENDING,
      } as Trade),
    };
    buildService();
  });

  describe('listPending() — Round 7 P1 expiry hygiene', () => {
    it('never lists a PENDING confirmation whose window has already passed (dead proposals are not actionable)', async () => {
      const liveRow = confirmationRow(); // live window
      const deadRow = confirmationRow({
        id: 'conf-expired',
        expiresAt: new Date(Date.now() - 1),
      });
      // The mock REPOSITORY honors the where-clause exactly like the real
      // store would (status = PENDING AND expiresAt > now).
      confirmationRepo.find.mockImplementation(
        async (opts?: { where?: { status?: unknown; expiresAt?: { value?: Date } } }) => {
          const cutoff = opts?.where?.expiresAt?.value;
          const rows = [liveRow, deadRow];
          return cutoff instanceof Date
            ? rows.filter((row) => row.expiresAt.getTime() > cutoff.getTime())
            : rows;
        },
      );
      riskGrantRepo.find.mockResolvedValue([]);

      const views = await service.listPending(USER);
      // The query carried the expiry predicate (MoreThan(now)).
      const findArg = confirmationRepo.find.mock.calls[0][0] as {
        where: { status: unknown; expiresAt: { value: Date } };
      };
      expect(findArg.where.status).toBe(ExecutionConfirmationStatus.PENDING);
      expect(findArg.where.expiresAt.value instanceof Date).toBe(true);
      // Only the live-window row is actionable.
      expect(views).toHaveLength(1);
      expect(views[0]!.id).toBe('conf-1');
    });

    it('an empty pending set returns [] without a grant lookup', async () => {
      confirmationRepo.find.mockResolvedValue([]);
      const views = await service.listPending(USER);
      expect(views).toEqual([]);
      expect(riskGrantRepo.find).not.toHaveBeenCalled();
    });
  });

  describe('confirm()', () => {
    it('drives the fresh §18 evaluation WITH rebindConfirmationId — the confirmation survives the supersession (P0 fix)', async () => {
      await service.confirm(USER, 'conf-1');

      expect(riskService.validateProposedTrade).toHaveBeenCalledTimes(1);
      const [calledUserId, calledTrade, calledOptions] =
        riskService.validateProposedTrade.mock.calls[0];
      expect(calledUserId).toBe(USER);
      expect(calledTrade).toMatchObject({
        signalId: SIGNAL,
        instrument: 'EURUSD',
        direction: 'BUY',
        entryPrice: '0', // MARKET sentinel — current-quote semantics
        sessionId: SESSION,
        sessionGeneration: 1,
        executionMode: ExecutionMode.SEMI_AUTO,
        brokerConnectionId: CONN,
      });
      // THE P0 FIX: the re-bind option is passed through.
      expect(calledOptions).toEqual({ rebindConfirmationId: 'conf-1' });
    });

    it('dispatches an APPROVED, materially-unchanged evaluation with the SAME one-time confirmationId', async () => {
      const result = await service.confirm(USER, 'conf-1');

      expect(executionService.executeTrade).toHaveBeenCalledTimes(1);
      const [userId, decision, confirmationId] = executionService.executeTrade.mock.calls[0];
      expect(userId).toBe(USER);
      expect(decision.decision).toBe('APPROVED');
      expect(confirmationId).toBe('conf-1');
      expect(result).toEqual({
        confirmationId: 'conf-1',
        status: 'CONSUMED',
        tradeId: 'trade-1',
        tradeStatus: 'PENDING',
      });
    });

    it('fails with a typed 409 when the confirmation does not exist for this user', async () => {
      confirmationRepo.findOne.mockResolvedValue(null);
      await expect(service.confirm(USER, 'missing')).rejects.toBeInstanceOf(ConflictException);
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('fails with a typed 409 when the confirmation window has expired — never a stale authorization', async () => {
      confirmationRepo.findOne.mockResolvedValue(
        confirmationRow({ expiresAt: new Date(Date.now() - 1) }),
      );
      await expect(service.confirm(USER, 'conf-1')).rejects.toBeInstanceOf(ConflictException);
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('a fresh risk rejection NEVER reaches executeTrade (zero provider calls)', async () => {
      riskService.validateProposedTrade.mockResolvedValue({
        ...approvedDecision(),
        decision: 'REJECTED',
        rejectionCode: 'MAX_POSITION_SIZE',
        rejectionReason: 'too big',
      });
      await expect(service.confirm(USER, 'conf-1')).rejects.toBeInstanceOf(ConflictException);
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('a changed material order fact requires RECONFIRMATION — the changed order is never silently dispatched', async () => {
      riskService.validateProposedTrade.mockResolvedValue(
        approvedDecision({
          validatedOrder: {
            ...approvedDecision().validatedOrder,
            lotSize: '0.02', // risk cap shrank the order
          },
        }),
      );
      await expect(service.confirm(USER, 'conf-1')).rejects.toBeInstanceOf(
        ReconfirmationRequiredException,
      );
      expect(executionService.executeTrade).not.toHaveBeenCalled();
    });

    it('propagates execution failures verbatim (the confirmation stays PENDING for an honest retry)', async () => {
      executionService.executeTrade.mockRejectedValue(new Error('provider unavailable'));
      await expect(service.confirm(USER, 'conf-1')).rejects.toThrow('provider unavailable');
    });

    it("never exposes another user's confirmation (tenant-scoped lookup)", async () => {
      confirmationRepo.findOne.mockImplementation(async ({ where }) => {
        // The production repo scopes by { id, userId, status } — mirror it.
        if (where.userId === OTHER_USER) return null;
        return confirmationRow();
      });
      await expect(service.confirm(OTHER_USER, 'conf-1')).rejects.toBeInstanceOf(ConflictException);
      expect(riskService.validateProposedTrade).not.toHaveBeenCalled();
    });
  });
});
