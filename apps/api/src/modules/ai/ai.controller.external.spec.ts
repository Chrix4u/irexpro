import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiController } from './ai.controller';
import { AiSignalService } from './ai-signal.service';
import { ExternalProviderSignalDto } from './dto/external-provider-signal.dto';

function makeDto(overrides: Partial<ExternalProviderSignalDto> = {}): ExternalProviderSignalDto {
  const generatedAt = new Date(Date.now() - 5_000).toISOString();
  return {
    externalSignalId: 'tv-alert-001',
    providerCode: 'tradingview-relay',
    strategyCode: 'trend-breakout-v3',
    userId: '00000000-0000-4000-8000-000000000001',
    tradingSessionId: '00000000-0000-4000-8000-000000000002',
    brokerConnectionId: '00000000-0000-4000-8000-000000000003',
    instrument: 'EURUSD',
    direction: 'BUY',
    confidenceScore: 0.72,
    suggestedStopLoss: 1.075,
    suggestedTakeProfit: 1.095,
    suggestedVolume: 0.01,
    timeframe: 'M5',
    marketRegime: 'TRENDING',
    volatilityScore: 0.4,
    generatedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    sourceReference: 'alert-42',
    ...overrides,
  };
}

describe('AiController — external provider intake', () => {
  let receiveSignal: jest.Mock;
  let controller: AiController;

  beforeEach(() => {
    receiveSignal = jest.fn().mockResolvedValue({
      outcome: 'RISK_REJECTED',
      signalId: 'ignored-by-test',
      reason: 'paper evidence only',
    });
    const aiSignalService = { receiveSignal } as unknown as AiSignalService;
    const config = { get: jest.fn() } as unknown as ConfigService;
    controller = new AiController(aiSignalService, config);
  });

  it('maps a provider event into a forced PAPER-only candidate and never bypasses AiSignalService', async () => {
    const dto = makeDto();
    await controller.receiveExternalSignal(dto);

    expect(receiveSignal).toHaveBeenCalledTimes(1);
    const candidate = receiveSignal.mock.calls[0][0];
    expect(candidate.signalId).toMatch(/^[0-9a-f-]{36}$/);
    expect(candidate.strategyCode).toBe('external-tradingview-relay-trend-breakout-v3');
    expect(candidate.modelVersion).toBe('external-provider/tradingview-relay/paper-only-v1');
    expect(candidate.marketRegime).toBe('TRENDING');
    expect(candidate.volatilityScore).toBe(0.4);
    expect(candidate.metadata).toEqual(
      expect.objectContaining({
        signal_source: 'EXTERNAL_PROVIDER',
        external_provider_code: 'tradingview-relay',
        external_provider_paper_only: true,
        production_eligible: false,
        source_reference: 'alert-42',
      }),
    );
    expect((controller as any).executionService).toBeUndefined();
  });

  it('uses a stable signal identity for a provider retry of the same event', async () => {
    const dto = makeDto();
    await controller.receiveExternalSignal(dto);
    const first = receiveSignal.mock.calls[0][0].signalId;
    receiveSignal.mockClear();
    await controller.receiveExternalSignal(
      makeDto({
        externalSignalId: dto.externalSignalId,
        providerCode: dto.providerCode,
      }),
    );
    const second = receiveSignal.mock.calls[0][0].signalId;
    expect(second).toBe(first);
  });

  it('rejects a stale provider event before it reaches the signal pipeline', async () => {
    const dto = makeDto({ generatedAt: new Date(Date.now() - 121_000).toISOString() });
    await expect(controller.receiveExternalSignal(dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(receiveSignal).not.toHaveBeenCalled();
  });

  it('rejects an expired event before it reaches the signal pipeline', async () => {
    const dto = makeDto({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    await expect(controller.receiveExternalSignal(dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(receiveSignal).not.toHaveBeenCalled();
  });

  it('rejects excessive future timestamp skew', async () => {
    const dto = makeDto({ generatedAt: new Date(Date.now() + 31_000).toISOString() });
    await expect(controller.receiveExternalSignal(dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(receiveSignal).not.toHaveBeenCalled();
  });
});
