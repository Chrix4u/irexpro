import { PerformanceFeesController } from './performance-fees.controller';
import { PerformanceFeeService } from './services/performance-fee.service';
import { PerformanceFeeSimulationService } from './services/performance-fee-simulation.service';
import { BillingFrequency } from './entities/performance-fee-policy.entity';
import { LedgerEntryType } from './entities/performance-fee-ledger-entry.entity';

/**
 * PerformanceFeesController identity-contract tests — Hotfix amendment.
 */
describe('PerformanceFeesController (Hotfix — UUID identity contract)', () => {
  let controller: PerformanceFeesController;
  let svc: Record<string, jest.Mock>;

  const USER_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const ADMIN_ID = 'f5e4d3c2-b1a0-9876-5432-10fedcba9876';

  beforeEach(() => {
    svc = {
      getPolicies: jest.fn().mockResolvedValue([]),
      createPolicy: jest.fn().mockResolvedValue({}),
      deactivatePolicy: jest.fn().mockResolvedValue({}),
      getUserSummary: jest.fn().mockResolvedValue({}),
      getAssessments: jest.fn().mockResolvedValue([]),
      calculateAssessment: jest.fn().mockResolvedValue({}),
      invoiceAssessment: jest.fn().mockResolvedValue({}),
      recordLedgerEntry: jest.fn().mockResolvedValue({}),
    };
    controller = new PerformanceFeesController(
      svc as unknown as PerformanceFeeService,
      {
        getUserSimulation: jest.fn(),
        refresh: jest.fn(),
        settleTestCharge: jest.fn(),
      } as unknown as PerformanceFeeSimulationService,
    );
  });

  it('getMyPerformanceSummary passes UUID string', async () => {
    await controller.getMyPerformanceSummary(USER_ID);
    expect(svc.getUserSummary).toHaveBeenCalledWith(USER_ID);
    expect(typeof svc.getUserSummary.mock.calls[0][0]).toBe('string');
  });

  it('createPolicy passes admin UUID string', async () => {
    await controller.createPolicy(
      { name: 'P', feePercent: 20, billingFrequency: BillingFrequency.MONTHLY },
      ADMIN_ID,
    );
    expect(svc.createPolicy).toHaveBeenCalledWith(expect.anything(), ADMIN_ID);
    expect(typeof svc.createPolicy.mock.calls[0][1]).toBe('string');
  });

  it('calculateAssessment passes admin UUID string', async () => {
    await controller.calculateAssessment(
      {
        userId: USER_ID,
        currency: 'USD',
        periodStart: '2026-01-01T00:00:00Z',
        periodEnd: '2026-01-31T00:00:00Z',
      },
      ADMIN_ID,
    );
    expect(svc.calculateAssessment).toHaveBeenCalledWith(
      USER_ID,
      null,
      'USD',
      expect.any(Date),
      expect.any(Date),
      ADMIN_ID,
    );
    expect(typeof svc.calculateAssessment.mock.calls[0][5]).toBe('string');
  });

  it('invoiceAssessment passes admin UUID string', async () => {
    await controller.invoiceAssessment('assess-1', ADMIN_ID);
    expect(svc.invoiceAssessment).toHaveBeenCalledWith('assess-1', ADMIN_ID);
    expect(typeof svc.invoiceAssessment.mock.calls[0][1]).toBe('string');
  });

  it('createLedgerEntry passes admin UUID string', async () => {
    await controller.createLedgerEntry(
      {
        userId: USER_ID,
        entryType: LedgerEntryType.REALISED_TRADE_PROFIT,
        currency: 'USD',
        amount: '100',
        occurredAt: '2026-01-15T00:00:00Z',
      },
      ADMIN_ID,
    );
    expect(svc.recordLedgerEntry).toHaveBeenCalledWith(expect.anything(), ADMIN_ID);
    expect(typeof svc.recordLedgerEntry.mock.calls[0][1]).toBe('string');
  });
});
