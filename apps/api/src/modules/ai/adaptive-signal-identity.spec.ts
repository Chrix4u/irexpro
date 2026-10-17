import { AiSignalService } from './ai-signal.service';
import type { AiSignalCandidate } from './interfaces/ai-signal-candidate.interface';
import {
  INTERNAL_ADAPTIVE_STRATEGY_CODE,
  materializeAdaptiveSignalIdentity,
} from './adaptive-signal-identity';

const adaptiveCandidate = (overrides: Partial<AiSignalCandidate> = {}): AiSignalCandidate => ({
  signalId: '4f3ae8e5-a38f-5727-b1bf-2f75b1653aef',
  userId: 'user-1',
  tradingSessionId: 'session-1',
  brokerConnectionId: 'paper-conn-1',
  instrument: 'AUDUSD',
  direction: 'SELL',
  confidenceScore: 0.6,
  suggestedEntryPrice: 0.65031,
  suggestedStopLoss: 0.65112,
  suggestedTakeProfit: 0.64896,
  suggestedVolume: 0.09,
  timeframe: 'M5',
  strategyCode: INTERNAL_ADAPTIVE_STRATEGY_CODE,
  marketRegime: 'TREND_HEALTHY',
  volatilityScore: 0.41,
  generatedAt: new Date('2026-10-16T08:20:00.000Z'),
  modelVersion:
    'external-provider/irexpro-multimodel-ensemble-v1/paper-research-throughput-v10-evidence-backed-acceleration',
  metadata: {
    signal_source: 'EXTERNAL_PROVIDER',
    external_provider_code: 'irexpro-multimodel-ensemble-v1',
    external_provider_paper_only: true,
    production_eligible: false,
  },
  ...overrides,
});

describe('adaptive material signal identity', () => {
  it('produces the same deterministic execution id for an identical retry and preserves producer provenance', () => {
    const first = materializeAdaptiveSignalIdentity(adaptiveCandidate());
    const retry = materializeAdaptiveSignalIdentity(adaptiveCandidate());

    expect(first.signalId).toBe(retry.signalId);
    expect(first.signalId).not.toBe('4f3ae8e5-a38f-5727-b1bf-2f75b1653aef');
    expect(first.metadata).toMatchObject({
      producer_signal_id: '4f3ae8e5-a38f-5727-b1bf-2f75b1653aef',
      signal_identity_scheme: 'adaptive-material-v1',
    });
  });

  it('produces a new execution id when a material stop changes on the same producer opportunity', () => {
    const original = materializeAdaptiveSignalIdentity(adaptiveCandidate());
    const revised = materializeAdaptiveSignalIdentity(
      adaptiveCandidate({ suggestedStopLoss: 0.65128 }),
    );

    expect(revised.signalId).not.toBe(original.signalId);
  });

  it('produces a new execution id when the requested lot upper bound changes on the same producer opportunity', () => {
    const original = materializeAdaptiveSignalIdentity(adaptiveCandidate());
    const revised = materializeAdaptiveSignalIdentity(adaptiveCandidate({ suggestedVolume: 0.14 }));

    expect(revised.signalId).not.toBe(original.signalId);
  });

  it('does not rewrite signal ids from other strategies', () => {
    const candidate = adaptiveCandidate({
      signalId: 'external-client-id-1',
      strategyCode: 'TREND_V1',
      metadata: {},
    });

    const result = materializeAdaptiveSignalIdentity(candidate);

    expect(result).toBe(candidate);
    expect(result.signalId).toBe('external-client-id-1');
  });

  it('normalizes the internal adaptive id before StrategyOrchestrator receives the candidate', async () => {
    const processSignal = jest.fn().mockImplementation(async (candidate: AiSignalCandidate) => ({
      outcome: 'RISK_REJECTED' as const,
      signalId: candidate.signalId,
      reason: 'test boundary',
    }));
    const service = new AiSignalService(
      { processSignal } as never,
      { processExitSignal: jest.fn() } as never,
      { log: jest.fn().mockResolvedValue(undefined) } as never,
      { publish: jest.fn() } as never,
    );

    const producer = adaptiveCandidate();
    const result = await service.receiveSignal(producer);

    expect(processSignal).toHaveBeenCalledTimes(1);
    const forwarded = processSignal.mock.calls[0]![0] as AiSignalCandidate;
    expect(forwarded.signalId).not.toBe(producer.signalId);
    expect(forwarded.metadata).toMatchObject({
      producer_signal_id: producer.signalId,
      signal_identity_scheme: 'adaptive-material-v1',
    });
    expect(result.signalId).toBe(forwarded.signalId);
  });
});
