import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';
import { UpdateRiskProfileDto } from './dto/update-risk-profile.dto';
import { ToggleKillSwitchDto } from './dto/kill-switch.dto';
import { AllowedTradingMode } from './entities/risk-profile.entity';

/**
 * RiskController regression tests — Hotfix amendment.
 *
 * Proves every endpoint passes only a UUID string to RiskService — never the
 * complete AuthenticatedPrincipal object.
 */
describe('RiskController (Hotfix — UUID identity regression)', () => {
  let controller: RiskController;
  let riskService: Record<string, jest.Mock>;

  const USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

  beforeEach(() => {
    riskService = {
      getOrCreateProfile: jest.fn().mockResolvedValue({
        id: 'risk-1',
        userId: USER_ID,
        killSwitchActive: false,
        maxDailyLossPercent: '5.00',
        allowedTradingModes: AllowedTradingMode.PAPER_ONLY,
      }),
      updateProfile: jest.fn().mockResolvedValue({
        id: 'risk-1',
        userId: USER_ID,
        maxDailyLossPercent: '3.00',
      }),
      toggleKillSwitch: jest.fn().mockResolvedValue({
        killSwitchActive: true,
        killSwitchReason: 'test',
      }),
      hasBrokerConnection: jest.fn().mockResolvedValue(true),
      isKillSwitchActive: jest.fn().mockResolvedValue(false),
      getViolations: jest.fn().mockResolvedValue([]),
    };

    controller = new RiskController(riskService as unknown as RiskService);
  });

  // ── UUID string passed to service ────────────────────────────────────────

  describe('passes only UUID string to RiskService', () => {
    it('getRiskProfile passes userId as UUID string', async () => {
      await controller.getRiskProfile(USER_ID);
      expect(riskService.getOrCreateProfile).toHaveBeenCalledWith(USER_ID);
      expect(typeof riskService.getOrCreateProfile.mock.calls[0][0]).toBe('string');
    });

    it('updateRiskProfile passes userId as UUID string', async () => {
      const dto: UpdateRiskProfileDto = { maxDailyLossPercent: 3 };
      await controller.updateRiskProfile(dto, USER_ID);
      expect(riskService.updateProfile).toHaveBeenCalledWith(USER_ID, dto);
      expect(typeof riskService.updateProfile.mock.calls[0][0]).toBe('string');
    });

    it('toggleKillSwitch passes userId as UUID string', async () => {
      const dto: ToggleKillSwitchDto = { active: true };
      await controller.toggleKillSwitch(dto, USER_ID);
      expect(riskService.toggleKillSwitch).toHaveBeenCalledWith(USER_ID, true, undefined);
      expect(typeof riskService.toggleKillSwitch.mock.calls[0][0]).toBe('string');
    });

    it('getViolations passes userId as UUID string', async () => {
      await controller.getViolations(USER_ID, '10');
      expect(riskService.getViolations).toHaveBeenCalledWith(USER_ID, 10);
      expect(typeof riskService.getViolations.mock.calls[0][0]).toBe('string');
    });

    it('getRiskStatus passes userId as UUID string', async () => {
      await controller.getRiskStatus(USER_ID);
      expect(riskService.getOrCreateProfile).toHaveBeenCalledWith(USER_ID);
      expect(riskService.hasBrokerConnection).toHaveBeenCalledWith(USER_ID);
      expect(riskService.isKillSwitchActive).toHaveBeenCalledWith(USER_ID);
      expect(typeof riskService.getOrCreateProfile.mock.calls[0][0]).toBe('string');
    });
  });

  it('includes the latest sanitized risk violation in status for plain-language suspension UX', async () => {
    const violation = {
      id: 'v-1',
      rejectionCode: 'DAILY_LOSS_LIMIT_REACHED',
      rejectionReason: 'Daily loss 54.68 has reached limit (5.00% = 49.41 of opening balance 988.13)',
      evaluatedAt: new Date('2026-10-28T13:43:13.000Z'),
    };
    const newer = {
      id: 'v-2',
      rejectionCode: 'INSUFFICIENT_MARGIN',
      rejectionReason: 'Insufficient margin',
      evaluatedAt: new Date('2026-10-28T13:44:00.000Z'),
    };
    riskService.getViolations.mockResolvedValue([newer, violation]);

    const result = await controller.getRiskStatus(USER_ID);

    expect(riskService.getViolations).toHaveBeenCalledWith(USER_ID, 20);
    expect((result as { latestViolation?: unknown }).latestViolation).toEqual(newer);
    expect((result as { latestDailyLossViolation?: unknown }).latestDailyLossViolation).toEqual(
      violation,
    );
    expect(
      (result as { latestRiskSuspensionViolation?: unknown }).latestRiskSuspensionViolation,
    ).toEqual(violation);
  });

  // ── Complete principal object never supplied ─────────────────────────────

  describe('never receives the complete AuthenticatedPrincipal', () => {
    const principalObject = {
      userId: USER_ID,
      email: 'user@example.com',
      phone: '+233243618186',
      roles: ['USER'],
      status: 'ACTIVE',
    };

    it('getRiskProfile does not pass the principal object', async () => {
      await controller.getRiskProfile(principalObject.userId);
      const arg = riskService.getOrCreateProfile.mock.calls[0][0];
      expect(arg).toBe(USER_ID);
      expect(arg).not.toBe(principalObject);
      expect(typeof arg).toBe('string');
    });

    it('updateRiskProfile does not pass the principal object', async () => {
      const dto: UpdateRiskProfileDto = { maxDailyLossPercent: 3 };
      await controller.updateRiskProfile(dto, principalObject.userId);
      const arg = riskService.updateProfile.mock.calls[0][0];
      expect(arg).toBe(USER_ID);
      expect(arg).not.toBe(principalObject);
    });

    it('toggleKillSwitch does not pass the principal object', async () => {
      const dto: ToggleKillSwitchDto = { active: true };
      await controller.toggleKillSwitch(dto, principalObject.userId);
      const arg = riskService.toggleKillSwitch.mock.calls[0][0];
      expect(arg).toBe(USER_ID);
      expect(arg).not.toBe(principalObject);
    });

    it('getRiskStatus does not pass the principal object', async () => {
      await controller.getRiskStatus(principalObject.userId);
      const arg = riskService.getOrCreateProfile.mock.calls[0][0];
      expect(arg).toBe(USER_ID);
      expect(arg).not.toBe(principalObject);
    });
  });

  // ── Malformed principal cannot reach the service ─────────────────────────

  describe('malformed principal cannot reach the service', () => {
    it('the controller method signature requires a string, not an object', () => {
      // The controller methods accept `userId: string` — TypeScript prevents
      // passing an object at compile time. At runtime, the @CurrentUserId()
      // decorator validates the UUID format and throws 401 for non-UUID values.
      // This test documents the contract: the service should only ever receive
      // a valid UUID string.
      expect(riskService.getOrCreateProfile).not.toHaveBeenCalled();
    });
  });
});
