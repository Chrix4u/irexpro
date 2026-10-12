import {
  VpsForexScannerDiagnostics,
  deriveVpsForexScannerDiagnostic,
} from './vps-forex-scanner-diagnostics';

const baseStatus = {
  configured: true,
  enabled: true,
  state: 'ACTIVE',
  activePaperSession: true,
  marketDataAuthority: 'TWELVE_DATA',
  providerCooldownReason: null,
  marketCache: {
    cachedInstrumentCount: 6,
    latestObservedAt: '2026-10-12T18:00:00.000Z',
    latestQuoteObservedAt: '2026-10-12T18:00:01.000Z',
  },
  lastEvaluatedAt: '2026-10-12T18:00:02.000Z',
  lastEvaluatedInstrument: 'EURUSD',
  lastEvaluatedDirection: 'BUY' as const,
  lastEvaluationQualified: true,
  lastEvaluationReason: 'QUALIFYING_SETUP',
  lastEnsembleDecision: {
    evaluatedAt: '2026-10-12T18:00:03.000Z',
    instrument: 'EURUSD',
    direction: 'BUY' as const,
    paperAdmitted: true,
    reasons: [],
    governance: {
      paperExecutionEligible: true,
      paperExecutionBlockers: [],
    },
  },
};

describe('VPS forex scanner diagnostics', () => {
  it('prioritizes current market-data unavailability over stale prior model evidence', () => {
    const diagnostic = deriveVpsForexScannerDiagnostic({
      ...baseStatus,
      state: 'WAITING_FOR_MARKET_DATA',
      marketDataAuthority: 'NONE',
      marketCache: {
        cachedInstrumentCount: 2,
        latestObservedAt: null,
        latestQuoteObservedAt: null,
      },
    });

    expect(diagnostic.reason).toBe('WAITING_FOR_MARKET_DATA');
    expect(diagnostic.cachedPairs).toBe(2);
    expect(diagnostic.configuredPairs).toBe(6);
    expect(diagnostic.blockers).toEqual([]);
  });

  it('reports a fresh no-setup evaluation instead of a stale earlier ensemble decision', () => {
    const diagnostic = deriveVpsForexScannerDiagnostic({
      ...baseStatus,
      lastEvaluatedAt: '2026-10-12T18:05:02.000Z',
      lastEvaluationQualified: false,
      lastEvaluationReason: 'NO_QUALIFYING_SETUP',
      lastEnsembleDecision: {
        ...baseStatus.lastEnsembleDecision,
        evaluatedAt: '2026-10-12T18:00:03.000Z',
      },
    });

    expect(diagnostic.reason).toBe('NO_QUALIFYING_SETUP');
    expect(diagnostic.blockers).toEqual([]);
  });

  it('surfaces structured PAPER governance and post-loss blockers without raw provider errors', () => {
    const diagnostic = deriveVpsForexScannerDiagnostic({
      ...baseStatus,
      lastEnsembleDecision: {
        ...baseStatus.lastEnsembleDecision,
        governance: {
          paperExecutionEligible: false,
          paperExecutionBlockers: [
            'EXECUTION_SPREAD_EVIDENCE_UNAVAILABLE',
            'PAPER_POST_LOSS_FRESH_CONFIRMATION_REQUIRED',
            42,
          ],
        },
      },
      providerError: 'secret-provider-message',
      apiKey: 'must-not-leak',
    } as typeof baseStatus & Record<string, unknown>);

    expect(diagnostic.reason).toBe('PAPER_GOVERNANCE_BLOCKED');
    expect(diagnostic.blockers).toEqual([
      'EXECUTION_SPREAD_EVIDENCE_UNAVAILABLE',
      'PAPER_POST_LOSS_FRESH_CONFIRMATION_REQUIRED',
    ]);
    expect(JSON.stringify(diagnostic)).not.toContain('secret-provider-message');
    expect(JSON.stringify(diagnostic)).not.toContain('must-not-leak');
  });

  it('keeps at most 12 distinct owner-visible observed evaluations and exposes none to non-owners', () => {
    const diagnostics = new VpsForexScannerDiagnostics();

    for (let index = 0; index < 14; index += 1) {
      const minute = String(index).padStart(2, '0');
      diagnostics.observe(
        {
          ...baseStatus,
          lastEvaluatedAt: `2026-10-12T18:${minute}:02.000Z`,
          lastEnsembleDecision: {
            ...baseStatus.lastEnsembleDecision,
            evaluatedAt: `2026-10-12T18:${minute}:03.000Z`,
          },
        },
        true,
      );
    }

    const duplicate = diagnostics.observe(
      {
        ...baseStatus,
        lastEvaluatedAt: '2026-10-12T18:13:02.000Z',
        lastEnsembleDecision: {
          ...baseStatus.lastEnsembleDecision,
          evaluatedAt: '2026-10-12T18:13:03.000Z',
        },
      },
      true,
    );
    expect(duplicate.recentObservedCycles).toHaveLength(12);
    expect(duplicate.recentObservedCycles[0]?.evaluatedAt).toBe('2026-10-12T18:13:02.000Z');
    expect(duplicate.recentObservedCycles.at(-1)?.evaluatedAt).toBe(
      '2026-10-12T18:02:02.000Z',
    );

    const nonOwner = diagnostics.observe(
      {
        ...baseStatus,
        configured: false,
        state: 'WAITING_FOR_CONFIGURATION',
      },
      false,
    );
    expect(nonOwner.reason).toBe('WAITING_FOR_CONFIGURATION');
    expect(nonOwner.recentObservedCycles).toEqual([]);
  });
});
