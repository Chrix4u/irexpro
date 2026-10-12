import { isAiDecisionExplorerView } from './ai-decision-explorer';

function baseDecision() {
  return {
    signalId: '11111111-1111-4111-8111-111111111111',
    outcome: 'RECEIVED',
    receivedAt: '2026-09-21T02:00:00.000Z',
    evidence: {
      instrument: 'EURUSD',
      direction: 'BUY',
      confidenceScore: 0.82,
      strategyCode: 'xgboost-mtf-trained-m1',
      modelVersion: 'mtf-xgboost-sixpair-test',
      timeframe: 'M1',
      marketRegime: 'trending',
      volatilityScore: 0.25,
      generatedAt: '2026-09-21T01:59:59.000Z',
    },
    agentContext: null,
    risk: {
      decision: 'UNKNOWN',
      rejectionCode: null,
      rejectionReason: null,
    },
    execution: null,
    timeline: [],
  };
}

function validContext() {
  return {
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
        availableAt: '2026-09-21T01:59:58.000Z',
        summary: 'High-impact USD CPI event is within the configured risk window.',
      },
    ],
    sourceState: 'AVAILABLE',
    evaluatedAt: '2026-09-21T01:59:59.500Z',
    advisoryOnly: true,
    executionAuthority: false,
  };
}

describe('isAiDecisionExplorerView Agent Council contract', () => {
  it('accepts historical decisions without an agent-context snapshot', () => {
    expect(
      isAiDecisionExplorerView({
        generatedAt: '2026-09-21T02:00:01.000Z',
        decisions: [baseDecision()],
      }),
    ).toBe(true);
  });

  it('accepts a strict advisory Agent Council snapshot', () => {
    expect(
      isAiDecisionExplorerView({
        generatedAt: '2026-09-21T02:00:01.000Z',
        decisions: [{ ...baseDecision(), agentContext: validContext() }],
      }),
    ).toBe(true);
  });

  it('rejects context that claims execution authority', () => {
    expect(
      isAiDecisionExplorerView({
        generatedAt: '2026-09-21T02:00:01.000Z',
        decisions: [
          {
            ...baseDecision(),
            agentContext: { ...validContext(), executionAuthority: true },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects unexpected provider metadata in the browser contract', () => {
    expect(
      isAiDecisionExplorerView({
        generatedAt: '2026-09-21T02:00:01.000Z',
        decisions: [
          {
            ...baseDecision(),
            agentContext: {
              ...validContext(),
              rawProviderPayload: 'must-not-cross-browser-boundary',
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it('rejects unavailable context that fabricates a blocking decision', () => {
    expect(
      isAiDecisionExplorerView({
        generatedAt: '2026-09-21T02:00:01.000Z',
        decisions: [
          {
            ...baseDecision(),
            agentContext: {
              ...validContext(),
              status: 'BLOCKED',
              sourceState: 'UNAVAILABLE',
              evidenceCount: 0,
              evidence: [],
            },
          },
        ],
      }),
    ).toBe(false);
  });

  it.each(['PROFIT_PROTECTION', 'STRATEGY_CUTOVER'])(
    'accepts %s execution close reasons emitted by the API',
    (closeReason) => {
      expect(
        isAiDecisionExplorerView({
          generatedAt: '2026-09-21T02:00:01.000Z',
          decisions: [
            {
              ...baseDecision(),
              execution: {
                tradeId: '22222222-2222-4222-8222-222222222222',
                status: 'CLOSED',
                openedAt: '2026-09-21T02:00:02.000Z',
                closedAt: '2026-09-21T02:10:00.000Z',
                closeReason,
              },
            },
          ],
        }),
      ).toBe(true);
    },
  );
});
