import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InternalSignalDto } from './internal-signal.dto';

function validPayload() {
  return {
    signalId: 'sig-001',
    userId: '11111111-1111-4111-8111-111111111111',
    tradingSessionId: '22222222-2222-4222-8222-222222222222',
    brokerConnectionId: '33333333-3333-4333-8333-333333333333',
    instrument: 'EURUSD',
    direction: 'BUY',
    confidenceScore: 0.82,
    suggestedEntryPrice: 1.1,
    suggestedStopLoss: 1.09,
    suggestedTakeProfit: 1.12,
    suggestedVolume: 0.01,
    timeframe: 'M1',
    strategyCode: 'xgboost-mtf-trained-m1',
    generatedAt: '2026-09-21T02:00:00.000Z',
    modelVersion: 'mtf-xgboost-sixpair-test',
    agentContext: {
      version: 'agent-council-v1',
      status: 'BLOCKED',
      consensusDirection: 'NEUTRAL',
      weightedSupport: 0,
      weightedOpposition: 0,
      disagreementScore: 0,
      evidenceCount: 1,
      rejectedCount: 0,
      evidence: [
        {
          source: 'MACRO_NEWS',
          sourceId: 'macro-event:abc',
          stance: 'BLOCK',
          confidence: 1,
          credibility: 1,
          verifiedSources: 1,
          availableAt: '2026-09-21T01:59:59.000Z',
          summary: 'High-impact USD CPI event is within the configured risk window.',
        },
      ],
      sourceState: 'AVAILABLE',
      evaluatedAt: '2026-09-21T02:00:00.500Z',
      advisoryOnly: true,
      executionAuthority: false,
    },
  };
}

async function validatePayload(payload: Record<string, unknown>) {
  return validate(plainToInstance(InternalSignalDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('InternalSignalDto agent context', () => {
  it('accepts the strict advisory Agent Council snapshot', async () => {
    await expect(validatePayload(validPayload())).resolves.toHaveLength(0);
  });

  it('rejects nested provider metadata outside the explicit contract', async () => {
    const payload = validPayload();
    payload.agentContext.evidence[0] = {
      ...payload.agentContext.evidence[0],
      rawProviderPayload: 'must-not-cross-boundary',
    } as typeof payload.agentContext.evidence[0];

    const errors = await validatePayload(payload);

    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toContain('rawProviderPayload');
  });

  it('rejects any attempt to grant context execution authority', async () => {
    const payload = validPayload();
    payload.agentContext.executionAuthority = true as false;

    const errors = await validatePayload(payload);

    expect(errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(errors)).toContain('executionAuthority');
  });

  it('allows a null context for historical or context-unavailable candidates', async () => {
    const payload = validPayload();
    payload.agentContext = null as unknown as typeof payload.agentContext;

    await expect(validatePayload(payload)).resolves.toHaveLength(0);
  });
});
