import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExecutionControlService } from './execution-control.service';
import {
  ExecutionControl,
  ExecutionControlScope,
  ExecutionControlStatus,
} from './entities/execution-control.entity';
import { ActivateExecutionControlDto } from './dto/activate-execution-control.dto';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';

/**
 * Sprint 50 — ExecutionControlService tests (emergency control plane).
 *
 * Directive §28: GLOBAL/PROVIDER/ACCOUNT(USER)/CONNECTION-level execution
 * disable. Directive §48: fail closed — an unreadable control store blocks
 * ALL execution.
 *
 * Architect correction A2: expire-and-reactivate lifecycle — an EXPIRED row
 * never blocks a future activation at the same (scope, scopeKey); concurrent
 * activations resolve to a single winner (23505 → ConflictException).
 */

const makeControl = (over: Partial<ExecutionControl> = {}): ExecutionControl =>
  ({
    id: 'ctl-1',
    scope: ExecutionControlScope.GLOBAL,
    scopeKey: null,
    reason: 'incident',
    activatedByUserId: 'admin-1',
    activatedAt: new Date(),
    expiresAt: null,
    status: ExecutionControlStatus.ACTIVE,
    ...over,
  }) as ExecutionControl;

describe('ExecutionControlService', () => {
  let service: ExecutionControlService;
  let controlRepo: {
    find: jest.Mock;
    findOne: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
  };
  let auditService: { log: jest.Mock };
  let eventBus: { publish: jest.Mock };

  beforeEach(async () => {
    controlRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockImplementation(async (c) => c),
      create: jest.fn().mockImplementation((c) => c),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    eventBus = { publish: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExecutionControlService,
        { provide: getRepositoryToken(ExecutionControl), useValue: controlRepo },
        { provide: AuditService, useValue: auditService },
        { provide: DomainEventBus, useValue: eventBus },
      ],
    }).compile();

    service = module.get(ExecutionControlService);
  });

  describe('permission checks — no active controls', () => {
    it('allows execution when no controls are active', async () => {
      controlRepo.find.mockResolvedValue([]);
      const result = await service.checkExecutionPermission({ userId: 'user-1' });
      expect(result.allowed).toBe(true);
      expect(result.blockedBy).toBeUndefined();
    });
  });

  describe('permission checks — cascade order (GLOBAL > PROVIDER > USER > CONNECTION)', () => {
    it('blocks EVERYTHING on a GLOBAL control', async () => {
      controlRepo.find.mockResolvedValue([makeControl({ scope: ExecutionControlScope.GLOBAL })]);

      const result = await service.checkExecutionPermission({ userId: 'user-1' });
      expect(result.allowed).toBe(false);
      expect(result.blockedBy?.scope).toBe(ExecutionControlScope.GLOBAL);
    });

    it('blocks only users of the affected PROVIDER', async () => {
      controlRepo.find.mockResolvedValue([
        makeControl({
          scope: ExecutionControlScope.PROVIDER,
          scopeKey: 'metatrader5',
          reason: 'MetaApi outage',
        }),
      ]);

      const blocked = await service.checkExecutionPermission({
        userId: 'user-1',
        brokerId: 'metatrader5',
      });
      expect(blocked.allowed).toBe(false);
      expect(blocked.blockedBy?.scopeKey).toBe('metatrader5');

      const unaffected = await service.checkExecutionPermission({
        userId: 'user-1',
        brokerId: 'oanda',
      });
      expect(unaffected.allowed).toBe(true);
    });

    it('blocks a single USER without affecting others', async () => {
      controlRepo.find.mockResolvedValue([
        makeControl({ scope: ExecutionControlScope.USER, scopeKey: 'user-42' }),
      ]);

      const blocked = await service.checkExecutionPermission({ userId: 'user-42' });
      expect(blocked.allowed).toBe(false);

      const other = await service.checkExecutionPermission({ userId: 'user-43' });
      expect(other.allowed).toBe(true);
    });

    it('blocks a single BROKER_CONNECTION', async () => {
      controlRepo.find.mockResolvedValue([
        makeControl({
          scope: ExecutionControlScope.BROKER_CONNECTION,
          scopeKey: 'conn-abc',
        }),
      ]);

      const blocked = await service.checkExecutionPermission({
        userId: 'user-1',
        brokerConnectionId: 'conn-abc',
      });
      expect(blocked.allowed).toBe(false);

      const other = await service.checkExecutionPermission({
        userId: 'user-1',
        brokerConnectionId: 'conn-xyz',
      });
      expect(other.allowed).toBe(true);
    });

    it('GLOBAL wins when both GLOBAL and USER controls are active', async () => {
      controlRepo.find.mockResolvedValue([
        makeControl({ id: 'ctl-user', scope: ExecutionControlScope.USER, scopeKey: 'user-1' }),
        makeControl({ id: 'ctl-global', scope: ExecutionControlScope.GLOBAL }),
      ]);

      const result = await service.checkExecutionPermission({ userId: 'user-1' });
      expect(result.allowed).toBe(false);
      expect(result.blockedBy?.scope).toBe(ExecutionControlScope.GLOBAL);
    });
  });

  describe('FAIL CLOSED — unreadable control store (Directive §48)', () => {
    it('blocks execution with a synthetic GLOBAL block when the store throws', async () => {
      controlRepo.find.mockRejectedValue(new Error('connection refused'));

      const result = await service.checkExecutionPermission({ userId: 'user-1' });
      expect(result.allowed).toBe(false);
      expect(result.blockedBy?.reason).toBe('EXECUTION_CONTROL_STORE_UNAVAILABLE');
    });

    it('assertExecutionAllowed throws ForbiddenException when the store throws', async () => {
      controlRepo.find.mockRejectedValue(new Error('db down'));

      await expect(service.assertExecutionAllowed({ userId: 'user-1' })).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('assertExecutionAllowed throws when a control blocks the user', async () => {
      controlRepo.find.mockResolvedValue([
        makeControl({ scope: ExecutionControlScope.USER, scopeKey: 'user-1' }),
      ]);

      await expect(service.assertExecutionAllowed({ userId: 'user-1' })).rejects.toThrow(
        /Execution blocked by emergency control/,
      );
    });

    it('assertExecutionAllowed resolves when nothing blocks', async () => {
      controlRepo.find.mockResolvedValue([]);
      await expect(
        service.assertExecutionAllowed({ userId: 'user-1', brokerId: 'metatrader5' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('expired controls are ignored', () => {
    it('does not block on an already-expired control', async () => {
      controlRepo.find.mockResolvedValue([
        makeControl({ expiresAt: new Date(Date.now() - 60_000) }),
      ]);

      const result = await service.checkExecutionPermission({ userId: 'user-1' });
      expect(result.allowed).toBe(true);
    });

    it('blocks on a not-yet-expired control', async () => {
      controlRepo.find.mockResolvedValue([
        makeControl({ expiresAt: new Date(Date.now() + 60_000) }),
      ]);

      const result = await service.checkExecutionPermission({ userId: 'user-1' });
      expect(result.allowed).toBe(false);
    });

    it('does not block on a control whose persisted status is EXPIRED', async () => {
      controlRepo.find.mockResolvedValue([makeControl({ status: ExecutionControlStatus.EXPIRED })]);

      const result = await service.checkExecutionPermission({ userId: 'user-1' });
      expect(result.allowed).toBe(true);
    });
  });

  describe('activateControl (admin operation)', () => {
    const baseDto = (
      over: Partial<ActivateExecutionControlDto> = {},
    ): ActivateExecutionControlDto =>
      ({
        scope: ExecutionControlScope.GLOBAL,
        reason: 'incident response',
        ...over,
      }) as ActivateExecutionControlDto;

    it('creates a GLOBAL control without a scope key and audits CRITICAL', async () => {
      const view = await service.activateControl(baseDto(), 'admin-1', '10.0.0.1');

      expect(view.scope).toBe(ExecutionControlScope.GLOBAL);
      expect(view.status).toBe(ExecutionControlStatus.ACTIVE);
      expect(view.scopeKey).toBeNull();
      expect(controlRepo.save).toHaveBeenCalledTimes(1);
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'CRITICAL' }),
      );
      expect(eventBus.publish).toHaveBeenCalledTimes(1);
    });

    it('creates a PROVIDER control with the brokerId as scope key', async () => {
      const view = await service.activateControl(
        baseDto({ scope: ExecutionControlScope.PROVIDER, scopeKey: 'metatrader5' }),
        'admin-1',
      );
      expect(view.scopeKey).toBe('metatrader5');
    });

    it('rejects non-GLOBAL activation without a scopeKey (fail closed)', async () => {
      await expect(
        service.activateControl(
          baseDto({ scope: ExecutionControlScope.USER, scopeKey: undefined }),
          'admin-1',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('rejects duplicate activation (idempotent conflict)', async () => {
      controlRepo.findOne.mockResolvedValue(makeControl());

      await expect(service.activateControl(baseDto(), 'admin-1')).rejects.toThrow(
        ConflictException,
      );
      expect(controlRepo.save).not.toHaveBeenCalled();
    });

    it('rejects duplicate activation when the existing control is ACTIVE with future expiry', async () => {
      controlRepo.findOne.mockResolvedValue(
        makeControl({ expiresAt: new Date(Date.now() + 60_000) }),
      );

      await expect(service.activateControl(baseDto(), 'admin-1')).rejects.toThrow(
        ConflictException,
      );
      expect(controlRepo.save).not.toHaveBeenCalled();
      expect(controlRepo.update).not.toHaveBeenCalled();
    });

    it('reactivates at the same scope after the prior control expired in time (A2)', async () => {
      controlRepo.findOne.mockResolvedValue(
        makeControl({
          id: 'ctl-old',
          expiresAt: new Date(Date.now() - 60_000),
        }),
      );

      const view = await service.activateControl(baseDto(), 'admin-1');

      expect(view.scope).toBe(ExecutionControlScope.GLOBAL);
      expect(controlRepo.update).toHaveBeenCalledWith(
        { id: 'ctl-old', status: ExecutionControlStatus.ACTIVE },
        { status: ExecutionControlStatus.EXPIRED },
      );
      expect(controlRepo.delete).not.toHaveBeenCalled();
      expect(controlRepo.save).toHaveBeenCalledTimes(1);
      expect(controlRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: ExecutionControlStatus.ACTIVE }),
      );
    });

    it('ignores a historical EXPIRED row during active-slot discovery (A2)', async () => {
      controlRepo.findOne.mockResolvedValue(
        makeControl({ id: 'ctl-old', status: ExecutionControlStatus.EXPIRED }),
      );

      const view = await service.activateControl(baseDto(), 'admin-1');

      expect(view.scope).toBe(ExecutionControlScope.GLOBAL);
      expect(controlRepo.update).not.toHaveBeenCalled();
      expect(controlRepo.save).toHaveBeenCalledTimes(1);
    });

    it('translates a concurrent-activation 23505 unique violation into ConflictException (A2)', async () => {
      controlRepo.findOne.mockResolvedValue(null);
      controlRepo.save.mockRejectedValue(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
        }),
      );

      await expect(service.activateControl(baseDto(), 'admin-1')).rejects.toThrow(
        ConflictException,
      );
      await expect(service.activateControl(baseDto(), 'admin-1')).rejects.toThrow(
        /concurrent activation/,
      );
    });

    it('propagates non-unique store failures from insert (fail closed, no swallow)', async () => {
      controlRepo.findOne.mockResolvedValue(null);
      controlRepo.save.mockRejectedValue(new Error('connection refused'));

      await expect(service.activateControl(baseDto(), 'admin-1')).rejects.toThrow(
        'connection refused',
      );
    });
  });

  describe('listActiveControls (admin inventory)', () => {
    it('lists only ACTIVE, unexpired controls — EXPIRED records are excluded', async () => {
      controlRepo.find.mockResolvedValue([
        makeControl({ id: 'ctl-a' }),
        makeControl({
          id: 'ctl-b',
          status: ExecutionControlStatus.EXPIRED,
        }),
        makeControl({ id: 'ctl-c', expiresAt: new Date(Date.now() - 1_000) }),
      ]);

      const views = await service.listActiveControls();
      expect(views.map((v) => v.id)).toEqual(['ctl-a']);
      expect(views.every((v) => v.status === ExecutionControlStatus.ACTIVE)).toBe(true);
    });
  });

  describe('listControlsIncludingExpired (admin inventory — G4)', () => {
    it('returns ALL rows with their effective status (ACTIVE and EXPIRED both present)', async () => {
      controlRepo.find.mockResolvedValue([
        makeControl({ id: 'ctl-live' }),
        makeControl({ id: 'ctl-old', status: ExecutionControlStatus.EXPIRED }),
      ]);

      const views = await service.listControlsIncludingExpired();
      expect(views.map((v) => v.id)).toEqual(['ctl-live', 'ctl-old']);
      expect(views.map((v) => v.status)).toEqual([
        ExecutionControlStatus.ACTIVE,
        ExecutionControlStatus.EXPIRED,
      ]);
    });

    it('reports EXPIRED for a persisted-ACTIVE row whose expiry has passed (effective status is honest)', async () => {
      controlRepo.find.mockResolvedValue([
        makeControl({
          id: 'ctl-stale',
          expiresAt: new Date(Date.now() - 60_000),
        }),
      ]);

      const views = await service.listControlsIncludingExpired();
      expect(views[0].status).toBe(ExecutionControlStatus.EXPIRED);
    });

    it('carries the full view shape (scope/scopeKey/reason/activatedBy/dates/status)', async () => {
      controlRepo.find.mockResolvedValue([makeControl({ id: 'ctl-full' })]);

      const [view] = await service.listControlsIncludingExpired();
      expect(view).toMatchObject({
        id: 'ctl-full',
        scope: ExecutionControlScope.GLOBAL,
        scopeKey: null,
        reason: 'incident',
        activatedByUserId: 'admin-1',
        status: ExecutionControlStatus.ACTIVE,
      });
      expect(view.activatedAt).toBeInstanceOf(Date);
      expect(view.expiresAt).toBeNull();
    });
  });

  describe('deactivateControl (admin operation)', () => {
    it('deletes the control row and audits the change', async () => {
      controlRepo.findOne.mockResolvedValue(makeControl());

      await service.deactivateControl('ctl-1', 'admin-1', '10.0.0.1');

      expect(controlRepo.delete).toHaveBeenCalledWith('ctl-1');
      expect(auditService.log).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'WARNING' }),
      );
      expect(eventBus.publish).toHaveBeenCalledTimes(1);
    });

    it('throws NotFound for unknown control ids', async () => {
      controlRepo.findOne.mockResolvedValue(null);
      await expect(service.deactivateControl('missing', 'admin-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('audit trail integrity (Directive §32)', () => {
    it('never includes secrets in audit metadata — only scope/reason identifiers', async () => {
      await service.activateControl(
        {
          scope: ExecutionControlScope.PROVIDER,
          scopeKey: 'metatrader5',
          reason: 'MetaApi degraded',
        } as ActivateExecutionControlDto,
        'admin-1',
      );

      const call = auditService.log.mock.calls[0][0];
      expect(call.metadata).toEqual({
        scope: ExecutionControlScope.PROVIDER,
        scopeKey: 'metatrader5',
        reason: 'MetaApi degraded',
        expiresAt: null,
      });
      expect(JSON.stringify(call.metadata)).not.toMatch(/token|secret|password|apiKey/i);
    });
  });
});
