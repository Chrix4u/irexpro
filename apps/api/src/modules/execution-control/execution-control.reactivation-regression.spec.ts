import { ConflictException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { DomainEventBus } from '../events/event-bus.service';
import { ActivateExecutionControlDto } from './dto/activate-execution-control.dto';
import {
  ExecutionControl,
  ExecutionControlScope,
  ExecutionControlStatus,
} from './entities/execution-control.entity';
import { ExecutionControlService } from './execution-control.service';

function control(overrides: Partial<ExecutionControl> = {}): ExecutionControl {
  return {
    id: 'active-b',
    scope: ExecutionControlScope.GLOBAL,
    scopeKey: null,
    reason: 'incident',
    activatedByUserId: 'admin-1',
    activatedAt: new Date('2026-09-07T08:00:00.000Z'),
    expiresAt: new Date('2026-09-07T08:01:00.000Z'),
    status: ExecutionControlStatus.ACTIVE,
    ...overrides,
  } as ExecutionControl;
}

function makeHarness() {
  const repo = {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn(),
    save: jest.fn().mockImplementation(async (value) => ({ id: 'new-c', ...value })),
    create: jest.fn().mockImplementation((value) => value),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  // Round 6 (#14): activate/deactivate wrap the fact + shared-revision bump in
  // repo.manager.transaction — the mock EM delegates back to this repo.
  (repo as unknown as { manager: unknown }).manager = {
    transaction: jest
      .fn()
      .mockImplementation(async (cb: (em: unknown) => Promise<unknown>) =>
        cb({ getRepository: () => repo }),
      ),
  };
  const audit = { log: jest.fn().mockResolvedValue(undefined) };
  const events = { publish: jest.fn() };

  const service = new ExecutionControlService(
    repo as unknown as Repository<ExecutionControl>,
    audit as unknown as AuditService,
    events as unknown as DomainEventBus,
    // Round 6 (#14): the shared control-plane revision seam (mocked).
    { bumpExecutionControlRevision: jest.fn().mockResolvedValue(1) } as never,
    // Round 7 (P1 metrics): the lazy MetricsService ModuleRef seam — the
    // stub's get() returns undefined, so every metrics call site no-ops.
    { get: jest.fn() } as unknown as ModuleRef,
  );

  return { service, repo, audit, events };
}

const globalDto: ActivateExecutionControlDto = {
  scope: ExecutionControlScope.GLOBAL,
  reason: 'replacement',
};

describe('ExecutionControlService multi-cycle reactivation regression', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('discovers the persisted ACTIVE row and ignores older EXPIRED history', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T08:02:00.000Z'));
    const { service, repo } = makeHarness();
    const historicalA = control({
      id: 'expired-a',
      status: ExecutionControlStatus.EXPIRED,
      activatedAt: new Date('2026-09-07T07:00:00.000Z'),
      expiresAt: new Date('2026-09-07T07:01:00.000Z'),
    });
    const expiredActiveB = control({ id: 'active-b' });

    repo.findOne.mockImplementation(async (options: { where?: Record<string, unknown> }) => {
      if (options.where?.status === ExecutionControlStatus.ACTIVE) return expiredActiveB;
      return historicalA;
    });

    await expect(service.activateControl(globalDto, 'admin-1')).resolves.toEqual(
      expect.objectContaining({ id: 'new-c', scope: ExecutionControlScope.GLOBAL }),
    );

    expect(repo.findOne).toHaveBeenCalledWith({
      where: {
        scope: ExecutionControlScope.GLOBAL,
        scopeKey: null,
        status: ExecutionControlStatus.ACTIVE,
      },
      order: { activatedAt: 'DESC' },
    });
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'active-b', status: ExecutionControlStatus.ACTIVE },
      { status: ExecutionControlStatus.EXPIRED },
    );
    expect(repo.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'expired-a' }),
      expect.anything(),
    );
  });

  it('treats a lost retire race as benign and still attempts replacement insert', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T08:02:00.000Z'));
    const { service, repo } = makeHarness();
    repo.findOne.mockResolvedValue(control());
    repo.update.mockResolvedValue({ affected: 0 });

    await expect(service.activateControl(globalDto, 'admin-1')).resolves.toEqual(
      expect.objectContaining({ id: 'new-c' }),
    );
    expect(repo.save).toHaveBeenCalledTimes(1);
  });

  it('keeps an unexpired ACTIVE row authoritative and rejects replacement before insert', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T08:00:30.000Z'));
    const { service, repo } = makeHarness();
    repo.findOne.mockResolvedValue(control());

    await expect(service.activateControl(globalDto, 'admin-1')).rejects.toThrow(ConflictException);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('preserves the partial unique index as the final concurrent single-winner backstop', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-07T08:02:00.000Z'));
    const { service, repo } = makeHarness();
    repo.findOne.mockResolvedValue(control());
    repo.save.mockRejectedValue(
      Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      }),
    );

    await expect(service.activateControl(globalDto, 'admin-1')).rejects.toThrow(
      /concurrent activation/,
    );
    expect(repo.update).toHaveBeenCalledWith(
      { id: 'active-b', status: ExecutionControlStatus.ACTIVE },
      { status: ExecutionControlStatus.EXPIRED },
    );
  });
});
