import {
  buildPaperParticipationDiagnostics,
  classifyPaperParticipationBlocker,
} from './paper-participation-diagnostics';

describe('PAPER participation diagnostics', () => {
  const now = new Date('2026-10-26T09:00:00.000Z');

  it.each([
    ['EVENT_RISK_HIGH_IMPACT_BLOCK', 'HARD_SAFETY'],
    ['EXECUTION_SPREAD_UNAVAILABLE', 'HARD_SAFETY'],
    ['PAPER_POST_LOSS_DIRECTION_NOT_RECONFIRMED', 'HARD_SAFETY'],
    ['ADAPTIVE_CURRENCY_CONCENTRATION_BLOCKED', 'CAPACITY'],
    ['ENSEMBLE_NOT_PAPER_ADMITTED', 'EVIDENCE_QUALITY'],
    ['DRIFT_OUT_OF_DISTRIBUTION', 'EVIDENCE_QUALITY'],
    ['M1_TIERED_SCOUT_RELIABILITY_WEAK_PROVISIONAL_EXPECTANCY', 'EVIDENCE_QUALITY'],
    ['M1_PHASE_ROUTE_SHADOW', 'ROUTE_POLICY'],
    ['M1_ROUTE_NOT_ELIGIBLE', 'ROUTE_POLICY'],
    ['SOMETHING_NEW', 'UNKNOWN'],
  ] as const)('classifies %s as %s', (blocker, expected) => {
    expect(classifyPaperParticipationBlocker(blocker)).toBe(expected);
  });

  it('reports an executable opportunity ahead of idle status', () => {
    const result = buildPaperParticipationDiagnostics({
      now,
      lastTradeAt: new Date('2026-10-26T07:00:00.000Z'),
      targetWindowMinutes: 30,
      m5: {
        latestScanAt: new Date('2026-10-26T08:59:00.000Z'),
        evaluatedCandidates: 12,
        executableWinners: 1,
        bestInstrument: 'GBPUSD',
        bestDirection: 'SELL',
        bestNetExpectedR: 0.18,
        blockers: [],
      },
      m5RecentBlockers: [],
      m1Decisions: [],
    });

    expect(result.state).toBe('EXECUTABLE_OPPORTUNITY');
    expect(result.minutesSinceLastTrade).toBe(120);
    expect(result.m5.executableWinners).toBe(1);
  });

  it('reports a recent trade without pretending another trade was required', () => {
    const result = buildPaperParticipationDiagnostics({
      now,
      lastTradeAt: new Date('2026-10-26T08:42:00.000Z'),
      targetWindowMinutes: 30,
      m5: null,
      m5RecentBlockers: [],
      m1Decisions: [],
    });

    expect(result.state).toBe('RECENT_TRADE');
    expect(result.minutesSinceLastTrade).toBe(18);
  });

  it('reports qualified-but-blocked M1 evidence and aggregates blocker classes', () => {
    const result = buildPaperParticipationDiagnostics({
      now,
      lastTradeAt: new Date('2026-10-26T07:00:00.000Z'),
      targetWindowMinutes: 30,
      m5: null,
      m5RecentBlockers: ['DRIFT_OUT_OF_DISTRIBUTION', 'DRIFT_OUT_OF_DISTRIBUTION'],
      m1Decisions: [
        {
          evaluatedAt: new Date('2026-10-26T08:58:00.000Z'),
          route: 'M1_EARLY_TRANSITION',
          executionAuthority: 'NONE',
          blockers: ['M1_TIERED_SCOUT_RELIABILITY_INSUFFICIENT_PROVISIONAL_EVIDENCE'],
        },
        {
          evaluatedAt: new Date('2026-10-26T08:59:00.000Z'),
          route: 'ABSTAIN',
          executionAuthority: 'NONE',
          blockers: ['M1_ROUTE_NOT_ELIGIBLE'],
        },
      ],
    });

    expect(result.state).toBe('QUALIFIED_BUT_BLOCKED');
    expect(result.m1.routeQualifiedDecisions).toBe(1);
    expect(result.m1.executableDecisions).toBe(0);
    expect(result.topBlockers[0]).toEqual({
      blocker: 'DRIFT_OUT_OF_DISTRIBUTION',
      category: 'EVIDENCE_QUALITY',
      count: 2,
    });
  });

  it('returns no recent evidence instead of a false healthy state', () => {
    const result = buildPaperParticipationDiagnostics({
      now,
      lastTradeAt: null,
      targetWindowMinutes: 30,
      m5: null,
      m5RecentBlockers: [],
      m1Decisions: [],
    });

    expect(result.state).toBe('NO_RECENT_EVIDENCE');
    expect(result.minutesSinceLastTrade).toBeNull();
  });

  it('ignores an invalid future last-trade timestamp', () => {
    const result = buildPaperParticipationDiagnostics({
      now,
      lastTradeAt: new Date('2026-10-26T09:01:00.000Z'),
      targetWindowMinutes: 30,
      m5: {
        latestScanAt: now,
        evaluatedCandidates: 12,
        executableWinners: 0,
        bestInstrument: null,
        bestDirection: null,
        bestNetExpectedR: null,
        blockers: [],
      },
      m5RecentBlockers: [],
      m1Decisions: [],
    });

    expect(result.minutesSinceLastTrade).toBeNull();
    expect(result.state).toBe('NO_QUALIFIED_OPPORTUNITY');
  });
});
