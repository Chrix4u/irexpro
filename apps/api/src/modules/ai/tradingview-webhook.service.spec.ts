import { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import { TradingViewWebhookService } from './tradingview-webhook.service';
import { AiSignalService } from './ai-signal.service';
import { ExecutionService } from '../execution/execution.service';

const dto = () => ({
  eventId: 'tv-event-1',
  instrument: 'USDJPY',
  direction: 'BUY' as const,
  confidence: 0.72,
  entryPrice: 157.4,
  stopLoss: 157.2,
  takeProfit: 157.8,
  suggestedVolume: 0.01,
  timeframe: 'M5',
  strategy: 'ema-rsi-v1',
  marketRegime: 'TRENDING' as const,
  volatilityScore: 0.4,
  generatedAt: new Date().toISOString(),
});

describe('TradingViewWebhookService', () => {
  it('binds user/session/broker server-side and emits the normal PAPER-only external candidate', async () => {
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'RISK_REJECTED', signalId: 'x' });
    const service = new TradingViewWebhookService(
      {
        get: jest.fn((key: string) => (key === 'tradingViewWebhook.userId' ? 'user-1' : undefined)),
      } as unknown as ConfigService,
      { receiveSignal } as unknown as AiSignalService,
      {
        getActiveSession: jest
          .fn()
          .mockResolvedValue({ id: 'session-1', brokerConnectionId: 'conn-1' }),
      } as unknown as ExecutionService,
    );
    await service.receive(dto());
    expect(receiveSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        tradingSessionId: 'session-1',
        brokerConnectionId: 'conn-1',
        instrument: 'USDJPY',
        marketRegime: 'TRENDING',
        volatilityScore: 0.4,
        modelVersion: 'external-provider/tradingview/paper-only-v1',
        metadata: expect.objectContaining({
          signal_source: 'EXTERNAL_PROVIDER',
          external_provider_code: 'tradingview',
          external_provider_paper_only: true,
          production_eligible: false,
        }),
      }),
    );
  });

  it('uses deterministic signal identity for TradingView retries', async () => {
    const receiveSignal = jest.fn().mockResolvedValue({ outcome: 'RISK_REJECTED', signalId: 'x' });
    const execution = {
      getActiveSession: jest
        .fn()
        .mockResolvedValue({ id: 'session-1', brokerConnectionId: 'conn-1' }),
    } as unknown as ExecutionService;
    const config = { get: jest.fn(() => 'user-1') } as unknown as ConfigService;
    const service = new TradingViewWebhookService(
      config,
      { receiveSignal } as unknown as AiSignalService,
      execution,
    );
    await service.receive(dto());
    const first = receiveSignal.mock.calls[0][0].signalId;
    receiveSignal.mockClear();
    await service.receive(dto());
    const second = receiveSignal.mock.calls[0][0].signalId;
    expect(second).toBe(first);
  });

  it('fails closed without an active PAPER session binding', async () => {
    const service = new TradingViewWebhookService(
      { get: jest.fn(() => 'user-1') } as unknown as ConfigService,
      { receiveSignal: jest.fn() } as unknown as AiSignalService,
      { getActiveSession: jest.fn().mockResolvedValue(null) } as unknown as ExecutionService,
    );
    await expect(service.receive(dto())).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
