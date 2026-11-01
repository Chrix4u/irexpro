import { PATH_METADATA } from '@nestjs/common/constants';
import { TradingReportsController } from './trading-reports.controller';
import type { ProfitProtectionExitQualityService } from './profit-protection-exit-quality.service';

const USER_ID = '11111111-1111-4111-8111-111111111111';

describe('TradingReportsController', () => {
  it('uses the dedicated trading/reports route and forwards the authenticated user id', async () => {
    const getReport = jest.fn().mockResolvedValue({ total: 0 });
    const controller = new TradingReportsController({ getReport } as unknown as ProfitProtectionExitQualityService);

    const result = await controller.getProfitProtectionExitQuality(USER_ID, {
      brokerConnectionId: '22222222-2222-4222-8222-222222222222',
      instrument: 'eurusd',
      direction: 'SELL',
      strategyRoute: 'CONFIRMED_REVERSAL',
      outcome: 'TP_FIRST',
      smallProfitOnly: 'true',
      page: '2',
      pageSize: '50',
    });

    expect(Reflect.getMetadata(PATH_METADATA, TradingReportsController)).toBe('trading/reports');
    expect(getReport).toHaveBeenCalledTimes(1);
    expect(getReport).toHaveBeenCalledWith(USER_ID, {
      brokerConnectionId: '22222222-2222-4222-8222-222222222222',
      from: undefined,
      to: undefined,
      instrument: 'eurusd',
      direction: 'SELL',
      strategyRoute: 'CONFIRMED_REVERSAL',
      outcome: 'TP_FIRST',
      smallProfitOnly: true,
      page: 2,
      pageSize: 50,
    });
    expect(result).toEqual({ total: 0 });
  });

  it('does not treat arbitrary strings as truthy booleans and leaves invalid numbers for service defaults', async () => {
    const getReport = jest.fn().mockResolvedValue({ total: 0 });
    const controller = new TradingReportsController({ getReport } as unknown as ProfitProtectionExitQualityService);

    await controller.getProfitProtectionExitQuality(USER_ID, {
      smallProfitOnly: 'false',
      page: 'not-a-number',
      pageSize: '',
    });

    expect(getReport).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      smallProfitOnly: false,
      page: undefined,
      pageSize: undefined,
    }));
  });
});
