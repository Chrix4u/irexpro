import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { OnboardingService } from './onboarding.service';
import { UpdateMyProfileDto } from './dto/update-my-profile.dto';
import { AuditService } from '../audit/audit.service';

/**
 * UsersController identity-contract tests — Hotfix amendment.
 * Proves every endpoint passes only a UUID string — never the principal object.
 */
describe('UsersController (Hotfix — UUID identity contract)', () => {
  let controller: UsersController;
  let usersService: Record<string, jest.Mock>;
  let onboardingService: Record<string, jest.Mock>;
  let auditService: Record<string, jest.Mock>;

  const USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  beforeEach(() => {
    usersService = {
      findById: jest.fn().mockResolvedValue({ id: USER_ID }),
      updateMyProfile: jest.fn().mockResolvedValue({ id: USER_ID }),
      findAll: jest.fn().mockResolvedValue({ users: [], total: 0 }),
    };
    onboardingService = {
      getOnboardingStatus: jest.fn().mockResolvedValue({
        profileCompleted: false,
        riskProfileCompleted: false,
        brokerConnected: false,
        brokerConnectionStatus: 'NONE',
        canStartTrading: false,
        missingSteps: ['PROFILE'],
        nextStep: 'PROFILE',
      }),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };

    controller = new UsersController(
      usersService as unknown as UsersService,
      onboardingService as unknown as OnboardingService,
      auditService as unknown as AuditService,
    );
  });

  it('getMe passes UUID string to findById', async () => {
    await controller.getMe(USER_ID);
    expect(usersService.findById).toHaveBeenCalledWith(USER_ID);
    expect(typeof usersService.findById.mock.calls[0][0]).toBe('string');
  });

  it('updateMe passes UUID string to updateMyProfile', async () => {
    const dto: UpdateMyProfileDto = {
      firstName: 'John',
      timezone: 'Africa/Accra',
    };
    await controller.updateMe(USER_ID, dto);
    expect(usersService.updateMyProfile).toHaveBeenCalledWith(USER_ID, dto);
    expect(typeof usersService.updateMyProfile.mock.calls[0][0]).toBe('string');
  });

  it('getOnboardingStatus passes UUID string to onboardingService', async () => {
    await controller.getOnboardingStatus(USER_ID);
    expect(onboardingService.getOnboardingStatus).toHaveBeenCalledWith(USER_ID);
    expect(typeof onboardingService.getOnboardingStatus.mock.calls[0][0]).toBe('string');
  });

  it('audit log for updateMe uses userId (not the principal object)', async () => {
    const dto: UpdateMyProfileDto = { firstName: 'Jane' };
    await controller.updateMe(USER_ID, dto);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: USER_ID }),
    );
  });
});
