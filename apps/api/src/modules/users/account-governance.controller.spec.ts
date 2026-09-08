import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../../common/constants/roles.constants';
import { RoleName } from './entities/role.entity';
import { AccountAppealDecision, AccountAppealStatus } from './entities/account-appeal.entity';
import { AccountStatusAction } from './dto/update-account-status.dto';
import { AccountGovernanceController } from './account-governance.controller';
import { AccountGovernanceService } from './account-governance.service';

describe('AccountGovernanceController', () => {
  const reflector = new Reflector();
  let controller: AccountGovernanceController;
  let service: jest.Mocked<AccountGovernanceService>;

  beforeEach(() => {
    service = {
      submitAppeal: jest.fn(),
      listAppeals: jest.fn(),
      resolveAppeal: jest.fn(),
      applyAdminAction: jest.fn(),
    } as unknown as jest.Mocked<AccountGovernanceService>;
    controller = new AccountGovernanceController(service);
  });

  it('passes only the supplied public request and request metadata to the public service method', async () => {
    service.submitAppeal.mockResolvedValue({ message: 'generic receipt' });
    const dto = {
      identifier: 'user@example.com',
      reason: 'Please review this account because I cannot access it at the moment.',
    };

    await controller.submitAppeal(dto, '198.51.100.10', 'test-agent');

    expect(service.submitAppeal).toHaveBeenCalledWith(dto, {
      ipAddress: '198.51.100.10',
      userAgent: 'test-agent',
    });
  });

  it('scopes every privileged mutation to the authenticated admin id', async () => {
    service.resolveAppeal.mockResolvedValue({} as never);
    service.applyAdminAction.mockResolvedValue({} as never);

    await controller.resolveAppeal(
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      { decision: AccountAppealDecision.REACTIVATE },
    );
    await controller.updateAccountStatus(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      { action: AccountStatusAction.DEACTIVATE, reason: 'Policy review' },
    );

    expect(service.resolveAppeal).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      { decision: AccountAppealDecision.REACTIVATE },
    );
    expect(service.applyAdminAction).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      '33333333-3333-4333-8333-333333333333',
      { action: AccountStatusAction.DEACTIVATE, reason: 'Policy review' },
    );
  });

  it('has an explicit public marker only on appeal submission', () => {
    expect(reflector.get(IS_PUBLIC_KEY, controller.submitAppeal)).toBe(true);
    expect(reflector.get(IS_PUBLIC_KEY, controller.listAppeals)).toBeUndefined();
    expect(reflector.get(IS_PUBLIC_KEY, controller.resolveAppeal)).toBeUndefined();
    expect(reflector.get(IS_PUBLIC_KEY, controller.updateAccountStatus)).toBeUndefined();
  });

  it.each<keyof AccountGovernanceController>([
    'listAppeals',
    'resolveAppeal',
    'updateAccountStatus',
  ])('%s requires ADMIN or SUPER_ADMIN metadata', (method) => {
    const roles = reflector.get<RoleName[]>(ROLES_KEY, controller[method] as unknown as () => void);
    expect(roles).toEqual(expect.arrayContaining([RoleName.ADMIN, RoleName.SUPER_ADMIN]));
  });

  it('passes the validated queue status and pagination contract through unchanged', async () => {
    service.listAppeals.mockResolvedValue({
      items: [],
      page: 2,
      limit: 10,
      total: 0,
      totalPages: 0,
    });

    await controller.listAppeals({
      status: AccountAppealStatus.PENDING,
      page: 2,
      limit: 10,
    });

    expect(service.listAppeals).toHaveBeenCalledWith(AccountAppealStatus.PENDING, 2, 10);
  });
});
