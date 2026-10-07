import { Reflector } from '@nestjs/core';
import { PerformanceFeesController } from './performance-fees.controller';
import { PerformanceFeeService } from './services/performance-fee.service';
import { PerformanceFeeSimulationService } from './services/performance-fee-simulation.service';
import { ROLES_KEY } from '../../common/constants/roles.constants';
import { RoleName } from '../users/entities/role.entity';
import { BillingFrequency } from './entities/performance-fee-policy.entity';
import { LedgerEntryType } from './entities/performance-fee-ledger-entry.entity';

/**
 * Access-control + scoping tests for the performance fee endpoints.
 *
 * Hotfix: controller methods now accept `@CurrentUserId() userId: string`
 * instead of `@CurrentUser() user: User`. Tests pass UUID strings directly.
 *
 * - me/summary must be scoped to the authenticated user's own id.
 * - All admin endpoints must require ADMIN or SUPER_ADMIN via @Roles metadata
 *   (enforced at runtime by the global JwtAuthGuard + RolesGuard).
 */
describe('PerformanceFeesController', () => {
  let controller: PerformanceFeesController;
  let svc: jest.Mocked<PerformanceFeeService>;
  let simulation: jest.Mocked<PerformanceFeeSimulationService>;
  const reflector = new Reflector();

  const normalUserId = 'user-123';
  const adminId = 'admin-1';

  beforeEach(() => {
    svc = {
      getPolicies: jest.fn(),
      createPolicy: jest.fn(),
      deactivatePolicy: jest.fn(),
      getUserSummary: jest.fn(),
      getAssessments: jest.fn(),
      calculateAssessment: jest.fn(),
      invoiceAssessment: jest.fn(),
      recordLedgerEntry: jest.fn(),
    } as unknown as jest.Mocked<PerformanceFeeService>;

    simulation = {
      getUserSimulation: jest.fn(),
      refresh: jest.fn(),
      settleTestCharge: jest.fn(),
    } as unknown as jest.Mocked<PerformanceFeeSimulationService>;

    controller = new PerformanceFeesController(svc, simulation);
  });

  describe('me/summary scoping', () => {
    it('returns only the authenticated user\u2019s own summary', async () => {
      svc.getUserSummary.mockResolvedValue({ performance: null, assessments: [] });
      await controller.getMyPerformanceSummary(normalUserId);
      // Must be called with the JWT user's OWN id — no way to pass another user's id
      expect(svc.getUserSummary).toHaveBeenCalledWith('user-123');
    });
  });

  describe('PAPER/DEMO simulation scoping', () => {
    it('uses only the authenticated user id for simulation reads and writes', async () => {
      simulation.getUserSimulation.mockResolvedValue({
        mode: 'TEST_ONLY',
        paymentEnabled: false,
        accounts: [],
      });
      simulation.refresh.mockResolvedValue({} as never);
      simulation.settleTestCharge.mockResolvedValue({} as never);

      await controller.getMySimulation(normalUserId);
      await controller.refreshMySimulation(normalUserId, '11111111-1111-4111-8111-111111111111');
      await controller.settleMySimulationCharge(
        normalUserId,
        '22222222-2222-4222-8222-222222222222',
      );

      expect(simulation.getUserSimulation).toHaveBeenCalledWith(normalUserId);
      expect(simulation.refresh).toHaveBeenCalledWith(
        normalUserId,
        '11111111-1111-4111-8111-111111111111',
      );
      expect(simulation.settleTestCharge).toHaveBeenCalledWith(
        normalUserId,
        '22222222-2222-4222-8222-222222222222',
      );
    });

    it.each(['getMySimulation', 'refreshMySimulation', 'settleMySimulationCharge'] as const)(
      '%s has no admin role restriction',
      (method) => {
        expect(
          reflector.get<RoleName[]>(ROLES_KEY, controller[method] as unknown as () => void),
        ).toBeUndefined();
      },
    );
  });

  describe('calculate uses the admin actor id', () => {
    it('passes the authenticated admin id as the actor', async () => {
      svc.calculateAssessment.mockResolvedValue({} as never);
      await controller.calculateAssessment(
        {
          userId: 'target-user',
          currency: 'USD',
          periodStart: '2026-01-01T00:00:00Z',
          periodEnd: '2026-01-31T00:00:00Z',
        },
        adminId,
      );
      const args = svc.calculateAssessment.mock.calls[0];
      expect(args[0]).toBe('target-user'); // target user
      expect(args[5]).toBe('admin-1'); // actor admin id
    });
  });

  describe('RBAC metadata — admin-only endpoints', () => {
    const adminEndpoints: Array<keyof PerformanceFeesController> = [
      'getPolicies',
      'createPolicy',
      'deactivatePolicy',
      'getAssessments',
      'calculateAssessment',
      'invoiceAssessment',
      'createLedgerEntry',
    ];

    it.each(adminEndpoints)('%s requires ADMIN or SUPER_ADMIN', (method) => {
      const roles = reflector.get<RoleName[]>(
        ROLES_KEY,
        controller[method] as unknown as () => void,
      );
      expect(roles).toBeDefined();
      expect(roles).toEqual(expect.arrayContaining([RoleName.ADMIN, RoleName.SUPER_ADMIN]));
    });

    it('me/summary has NO @Roles restriction (any authenticated user, own data only)', () => {
      const roles = reflector.get<RoleName[]>(
        ROLES_KEY,
        controller.getMyPerformanceSummary as unknown as () => void,
      );
      expect(roles).toBeUndefined();
    });
  });

  describe('createPolicy / createLedgerEntry pass admin actor id', () => {
    it('createPolicy uses the authenticated admin id', async () => {
      svc.createPolicy.mockResolvedValue({} as never);
      await controller.createPolicy(
        { name: 'P', feePercent: 20, billingFrequency: BillingFrequency.MONTHLY },
        adminId,
      );
      expect(svc.createPolicy).toHaveBeenCalledWith(expect.anything(), 'admin-1');
    });

    it('createLedgerEntry uses the authenticated admin id', async () => {
      svc.recordLedgerEntry.mockResolvedValue({} as never);
      await controller.createLedgerEntry(
        {
          userId: 'target-user',
          entryType: LedgerEntryType.REALISED_TRADE_PROFIT,
          currency: 'USD',
          amount: '100000',
          occurredAt: '2026-01-15T00:00:00Z',
        },
        adminId,
      );
      expect(svc.recordLedgerEntry).toHaveBeenCalledWith(expect.anything(), 'admin-1');
    });
  });
});
