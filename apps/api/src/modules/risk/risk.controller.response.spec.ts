import { RiskController } from './risk.controller';
import { RiskService } from './risk.service';
import { RiskRejectionCode } from './interfaces/risk.interface';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('RiskController public response hardening', () => {
  it('does not expose legacy trade-count or position-count database fields as active profile limits', async () => {
    const riskService = {
      getOrCreateProfile: jest.fn().mockResolvedValue({
        id: 'profile-1',
        userId: USER_ID,
        killSwitchActive: false,
        maxDailyLossPercent: '5.00',
        maxDrawdownPercent: '10.00',
        maxOpenTrades: 3,
        maxDailyTrades: 10,
        maxPositionSizeLot: '0.1000',
      }),
    };

    const controller = new RiskController(riskService as unknown as RiskService);
    const response = await controller.getRiskProfile(USER_ID);

    expect(response).not.toHaveProperty('maxDailyTrades');
    expect(response).not.toHaveProperty('maxOpenTrades');
    expect(response).toMatchObject({
      maxDailyLossPercent: '5.00',
      maxDrawdownPercent: '10.00',
      maxPositionSizeLot: '0.1000',
    });
  });

  it('only exposes the risk suspension broker binding, never financial risk context', async () => {
    const riskService = {
      getOrCreateProfile: jest.fn().mockResolvedValue({
        maxDailyLossPercent: '5.00',
        maxDrawdownPercent: '10.00',
        maxPositionSizeLot: '4.00',
      }),
      hasBrokerConnection: jest.fn().mockResolvedValue(true),
      isKillSwitchActive: jest.fn().mockResolvedValue(false),
      getViolations: jest.fn().mockResolvedValue([
        {
          id: 'v-2',
          rejectionCode: RiskRejectionCode.MAX_DRAWDOWN_REACHED,
          rejectionReason: 'Drawdown 10.35% reached limit 10%',
          evaluatedAt: new Date('2026-11-09T21:00:00.000Z'),
          riskContext: {
            brokerConnectionId: 'old-ctrader-account',
            sessionId: 'private-session-id',
            brokerEquity: '613.49',
            sessionPeakEquity: '684.35',
          },
        },
      ]),
    };
    const result = await new RiskController(riskService as unknown as RiskService).getRiskStatus(USER_ID);
    expect(result.latestRiskSuspensionViolation).toMatchObject({
      brokerConnectionId: 'old-ctrader-account',
      rejectionCode: RiskRejectionCode.MAX_DRAWDOWN_REACHED,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('riskContext');
    expect(serialized).not.toContain('private-session-id');
    expect(serialized).not.toContain('sessionPeakEquity');
    expect(serialized).not.toContain('613.49');
  });

  it('removes userId, signalId, and riskContext from violation responses', async () => {
    const riskService = {
      getViolations: jest.fn().mockResolvedValue([
        {
          id: 'violation-1',
          userId: USER_ID,
          signalId: '22222222-2222-4222-8222-222222222222',
          rejectionCode: RiskRejectionCode.MAX_DAILY_TRADES,
          rejectionReason: 'Daily trade limit reached',
          riskContext: {
            brokerBalance: '10000.00',
            brokerEquity: '9800.00',
            proposedLotSize: '0.1000',
          },
          evaluatedAt: new Date('2026-08-28T21:00:00.000Z'),
        },
      ]),
    };

    const controller = new RiskController(riskService as unknown as RiskService);
    const response = await controller.getViolations(USER_ID, '10');

    expect(response).toEqual([
      {
        id: 'violation-1',
        rejectionCode: RiskRejectionCode.MAX_DAILY_TRADES,
        rejectionReason: 'Daily trade limit reached',
        evaluatedAt: new Date('2026-08-28T21:00:00.000Z'),
      },
    ]);

    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('riskContext');
    expect(serialized).not.toContain('signalId');
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('brokerBalance');
  });
});
