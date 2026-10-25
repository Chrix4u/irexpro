import { BadRequestException } from '@nestjs/common';
import { ExternalSignalPerformanceController } from './external-signal-performance.controller';
import { ExternalSignalPerformanceService } from './external-signal-performance.service';

describe('ExternalSignalPerformanceController', () => {
  it('uses the authenticated user scope and normalized provider code', async () => {
    const getProviderPerformance = jest.fn().mockResolvedValue({ demoReviewEligible: false });
    const controller = new ExternalSignalPerformanceController({
      getProviderPerformance,
    } as unknown as ExternalSignalPerformanceService);
    await controller.getPerformance('user-1', '  tradingview-relay  ');
    expect(getProviderPerformance).toHaveBeenCalledWith('user-1', 'tradingview-relay');
  });

  it('rejects malformed provider codes', async () => {
    const controller = new ExternalSignalPerformanceController({
      getProviderPerformance: jest.fn(),
    } as unknown as ExternalSignalPerformanceService);
    await expect(controller.getPerformance('user-1', '../bad provider')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

it('routes participation diagnostics through authenticated user scope', async () => {
  const getPaperParticipationDiagnostics = jest.fn().mockResolvedValue({
    state: 'NO_QUALIFIED_OPPORTUNITY',
  });
  const controller = new ExternalSignalPerformanceController({
    getPaperParticipationDiagnostics,
  } as unknown as ExternalSignalPerformanceService);

  await controller.getParticipation('user-7', '  irexpro-multimodel-ensemble-v1  ');

  expect(getPaperParticipationDiagnostics).toHaveBeenCalledWith(
    'user-7',
    'irexpro-multimodel-ensemble-v1',
  );
});

it('rejects malformed provider codes for participation diagnostics', async () => {
  const controller = new ExternalSignalPerformanceController({
    getPaperParticipationDiagnostics: jest.fn(),
  } as unknown as ExternalSignalPerformanceService);

  await expect(controller.getParticipation('user-7', '../bad provider')).rejects.toBeInstanceOf(
    BadRequestException,
  );
});
