import { ConfigService } from '@nestjs/config';
import type { AiSignalService } from './ai-signal.service';
import type { MacroEventRiskService } from './macro-event-risk.service';
import type { M1TacticalEvidenceService } from './m1-tactical-evidence.service';
import type { M1TacticalMarketDataService } from './m1-tactical-market-data.service';
import { M1TacticalSchedulerService } from './m1-tactical-scheduler.service';
import type { AllocationService } from '../execution/services/allocation.service';

function serviceFor(
  allocatedCapital: number,
  positions: Array<{ instrument: string; direction: 'BUY' | 'SELL'; riskAtStop: number | null }>,
) {
  const evidence = {
    loadOpenPaperRiskPositions: jest.fn().mockResolvedValue(positions),
  } as unknown as M1TacticalEvidenceService;
  const allocation = {
    getUserCapitalAllocationState: jest.fn().mockResolvedValue({
      hasAllocation: true,
      allocatedCapital: String(allocatedCapital),
    }),
  } as unknown as AllocationService;

  return new M1TacticalSchedulerService(
    {} as ConfigService,
    {} as M1TacticalMarketDataService,
    {} as MacroEventRiskService,
    evidence,
    {} as AiSignalService,
    undefined,
    undefined,
    undefined,
    allocation,
  );
}

const candidate = {
  instrument: 'EURUSD',
  direction: 'SELL',
  entry: 1.1222,
  stopLoss: 1.1227,
} as any;

describe('M1 currency exposure respects the executable PAPER product floor', () => {
  it('blocks a 0.10 scout when exposure requires a sub-minimum reduction', async () => {
    const service = serviceFor(1000, [
      { instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 18 },
    ]);

    await expect(
      (service as any).resolveM1CurrencyExposureGuard('user-1', 'conn-1', candidate, 0.1),
    ).resolves.toMatchObject({
      allowed: false,
      volumeCap: 0,
      decision: { capacity: 'REDUCED' },
    });
  });

  it('reduces a larger scout only to the real 0.10 PAPER floor when that clears exposure', async () => {
    const service = serviceFor(1000, [
      { instrument: 'GBPUSD', direction: 'SELL', riskAtStop: 14 },
    ]);

    await expect(
      (service as any).resolveM1CurrencyExposureGuard('user-1', 'conn-1', candidate, 0.2),
    ).resolves.toMatchObject({
      allowed: true,
      volumeCap: 0.1,
      decision: { capacity: 'CLEAR' },
    });
  });
});
