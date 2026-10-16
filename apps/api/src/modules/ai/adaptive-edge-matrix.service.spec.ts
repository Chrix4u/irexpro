import { DataSource } from 'typeorm';
import {
  AdaptiveEdgeMatrixService,
  buildAdaptiveEdgeEvidence,
  type AdaptiveEdgeEvidenceRequest,
  type AdaptiveEdgeOutcomeRow,
} from './adaptive-edge-matrix.service';

const request: AdaptiveEdgeEvidenceRequest = {
  userId: '00000000-0000-4000-8000-000000000001',
  brokerConnectionId: '11111111-1111-4111-8111-111111111111',
  instrument: 'EURUSD',
  direction: 'BUY',
  session: 'LONDON',
  state: 'TREND_HEALTHY',
  strategyRoute: 'TREND_CONTINUATION',
  decisionPolicyVersion: 'policy-v1',
  evidenceClass: 'QUALIFICATION',
  evaluatedAt: new Date('2026-10-15T12:00:00.000Z'),
};

function row(overrides: Partial<AdaptiveEdgeOutcomeRow> = {}): AdaptiveEdgeOutcomeRow {
  return {
    instrument: 'EURUSD',
    direction: 'BUY',
    strategy_route: 'TREND_CONTINUATION',
    adaptive_state: 'TREND_HEALTHY',
    adaptive_session: 'LONDON',
    adaptive_tagged: true,
    signal_generated_at: new Date('2026-10-15T09:55:00.000Z'),
    confidence_score: '0.70',
    realised_pnl: '50',
    risk_amount: '100',
    session_opening_balance: '10000',
    execution_cost_r: '0.15',
    max_favorable_pnl: '80',
    max_adverse_pnl: '-25',
    profit_giveback: '30',
    closed_at: new Date('2026-10-15T10:00:00.000Z'),
    ...overrides,
  };
}

function losingRow(index: number): AdaptiveEdgeOutcomeRow {
  return row({
    realised_pnl: '-50',
    closed_at: new Date(Date.parse('2026-10-13T08:00:00Z') + index * 300_000),
  });
}

describe('AdaptiveEdgeMatrixService', () => {
  it('queries only same-policy PAPER evidence strictly before evaluatedAt', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new AdaptiveEdgeMatrixService({ query } as unknown as DataSource);

    const evidence = await service.getEvidence(request);

    expect(evidence.available).toBe(true);
    expect(evidence.maturity).toBe('SPARSE');
    expect(evidence.canUpsize).toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('ti.signal_generated_at < $3');
    expect(sql).toContain('t.closed_at < $3');
    expect(sql).toContain("ti.metadata->>'decision_policy_version' = $4");
    expect(sql).toContain("ti.metadata->>'external_provider_paper_only' = 'true'");
    expect(sql).toContain("main_strategy_qualification_evidence");
    expect(sql).toContain('= $6');
    expect(params).toEqual([
      request.userId,
      request.brokerConnectionId,
      request.evaluatedAt,
      request.decisionPolicyVersion,
      request.strategyRoute,
      request.evidenceClass,
    ]);
  });

  it('defensively excludes outcomes at or after evaluatedAt from pure evidence aggregation', () => {
    const past = row({ closed_at: new Date('2026-10-15T11:55:00.000Z') });
    const future = row({
      realised_pnl: '500',
      closed_at: new Date('2026-10-15T12:05:00.000Z'),
    });

    const evidence = buildAdaptiveEdgeEvidence([past, future], request);

    expect(evidence.prospectiveSamples).toBe(1);
    expect(evidence.averageRealizedR).toBeCloseTo(0.5, 8);
  });

  it('shrinks sparse exact-cell expectancy toward broader pair/session evidence', () => {
    const exact = [
      row({ realised_pnl: '100' }),
      row({ realised_pnl: '100', closed_at: new Date('2026-10-15T10:05:00Z') }),
    ];
    const prior = Array.from({ length: 12 }, (_, index) =>
      row({
        adaptive_tagged: false,
        adaptive_state: null,
        realised_pnl: '-20',
        closed_at: new Date(Date.parse('2026-10-14T08:00:00Z') + index * 300_000),
      }),
    );

    const evidence = buildAdaptiveEdgeEvidence([...exact, ...prior], request);

    expect(evidence.prospectiveSamples).toBe(2);
    expect(evidence.priorSamples).toBe(12);
    expect(evidence.averageRealizedR).toBeCloseTo(1, 8);
    expect(evidence.smoothedExpectedR).toBeLessThan(1);
    expect(evidence.smoothedExpectedR).toBeGreaterThan(-0.2);
    expect(evidence.maturity).toBe('SPARSE');
    expect(evidence.canUpsize).toBe(false);
  });

  it('matures a populated positive prospective cell with both wins and losses', () => {
    const rows = Array.from({ length: 24 }, (_, index) =>
      index < 18
        ? row({
            closed_at: new Date(Date.parse('2026-10-13T08:00:00Z') + index * 300_000),
          })
        : losingRow(index),
    );

    const evidence = buildAdaptiveEdgeEvidence(rows, request);

    expect(evidence.maturity).toBe('MATURE');
    expect(evidence.prospectiveSamples).toBe(24);
    expect(evidence.wins).toBe(18);
    expect(evidence.losses).toBe(6);
    expect(evidence.profitFactor).toBeCloseTo(3, 8);
    expect(evidence.smoothedExpectedR).toBeGreaterThan(0);
    expect(evidence.maxDrawdown).not.toBeNull();
    expect(evidence.maxDrawdown!).toBeLessThanOrEqual(0.12);
    expect(evidence.canUpsize).toBe(true);
  });

  it('degrades mature evidence when the recent resolved window deteriorates', () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      index < 20
        ? row({
            closed_at: new Date(Date.parse('2026-10-13T08:00:00Z') + index * 300_000),
          })
        : losingRow(index),
    );

    const evidence = buildAdaptiveEdgeEvidence(rows, request);

    expect(evidence.maturity).toBe('DEGRADED');
    expect(evidence.recentStatus).toBe('DEGRADED');
    expect(evidence.recentDegradation).toBe(true);
    expect(evidence.canUpsize).toBe(false);
    expect(evidence.reasons).toContain('RECENT_EDGE_DEGRADED');
  });

  it('isolates research from qualification evidence through an explicit cohort filter', async () => {
    const query = jest.fn().mockResolvedValue([row()]);
    const service = new AdaptiveEdgeMatrixService({ query } as unknown as DataSource);

    await service.getEvidence({ ...request, evidenceClass: 'RESEARCH' });

    const [sql] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("main_strategy_qualification_evidence");
    expect(sql).toContain('= $6');
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[5]).toBe('RESEARCH');
  });

  it('fails closed to explicit unavailable evidence on database error', async () => {
    const service = new AdaptiveEdgeMatrixService({
      query: jest.fn().mockRejectedValue(new Error('db unavailable')),
    } as unknown as DataSource);

    const evidence = await service.getEvidence(request);

    expect(evidence.available).toBe(false);
    expect(evidence.maturity).toBe('SPARSE');
    expect(evidence.canUpsize).toBe(false);
    expect(evidence.prospectiveSamples).toBe(0);
    expect(evidence.reasons).toContain('ADAPTIVE_EVIDENCE_UNAVAILABLE');
  });
});
