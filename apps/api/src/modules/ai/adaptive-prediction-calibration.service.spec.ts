import { DataSource } from 'typeorm';
import {
  AdaptivePredictionCalibrationService,
  applyAdaptivePredictionCalibrationAuthority,
  buildAdaptivePredictionCalibration,
  type AdaptivePredictionCalibrationRequest,
  type AdaptivePredictionOutcomeRow,
} from './adaptive-prediction-calibration.service';

const evaluatedAt = new Date('2026-10-16T03:00:00.000Z');
const request: AdaptivePredictionCalibrationRequest = {
  userId: 'user-1',
  brokerConnectionId: 'conn-1',
  instrument: 'EURUSD',
  direction: 'BUY',
  session: 'LONDON',
  state: 'TREND_HEALTHY',
  strategyRoute: 'TREND_CONTINUATION',
  decisionPolicyVersions: ['policy-before-calibration', 'policy-calibration-v1'],
  evaluatedAt,
  rawConfidence: 0.67,
  rawNetExpectedR: 0.1,
};

function outcome(
  index: number,
  status: 'WIN' | 'LOSS',
  netR: number,
  overrides: Partial<AdaptivePredictionOutcomeRow> = {},
): AdaptivePredictionOutcomeRow {
  return {
    instrument: 'EURUSD',
    direction: 'BUY',
    strategy_route: 'TREND_CONTINUATION',
    adaptive_state: 'TREND_HEALTHY',
    legacy_regime: 'TREND_HEALTHY',
    adaptive_session: 'LONDON',
    evaluated_at: new Date(Date.parse('2026-10-15T08:00:00.000Z') + index * 5 * 60_000),
    outcome_status: status,
    outcome_net_r: netR,
    ...overrides,
  };
}

describe('adaptive prediction calibration', () => {
  it('corrects materially overconfident predictions downward from resolved outcomes', () => {
    const rows = Array.from({ length: 24 }, (_, i) =>
      i % 4 === 0 ? outcome(i, 'WIN', 1.15) : outcome(i, 'LOSS', -1.1),
    );
    const result = buildAdaptivePredictionCalibration(rows, request);

    expect(result.authoritative).toBe(true);
    expect(result.samples).toBe(24);
    expect(result.wins).toBe(6);
    expect(result.losses).toBe(18);
    expect(result.calibratedWinProbability).toBeLessThan(request.rawConfidence);
    expect(result.calibratedNetExpectedR).toBeLessThan(0);
    expect(result.blockRecommended).toBe(true);
    expect(result.rescueEligible).toBe(false);
  });

  it('uses collecting evidence to recalibrate and down-rank without hard-vetoing execution', () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      i % 3 === 0 ? outcome(i, 'WIN', 1.15) : outcome(i, 'LOSS', -1.1),
    );
    const result = buildAdaptivePredictionCalibration(rows, request);

    expect(result.authoritative).toBe(true);
    expect(result.maturity).toBe('COLLECTING');
    expect(result.calibratedWinProbability).toBeLessThan(request.rawConfidence);
    expect(result.calibratedNetExpectedR).toBeLessThan(0);
    expect(result.blockRecommended).toBe(false);
    expect(result.rescueEligible).toBe(false);
  });

  it('does not let sparse outcomes modify execution authority', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      outcome(i, i % 2 === 0 ? 'WIN' : 'LOSS', i % 2 === 0 ? 1.1 : -1.1),
    );
    const result = buildAdaptivePredictionCalibration(rows, request);

    expect(result.authoritative).toBe(false);
    expect(result.maturity).toBe('SPARSE');
    expect(result.calibratedWinProbability).toBe(request.rawConfidence);
    expect(result.calibratedNetExpectedR).toBe(request.rawNetExpectedR);
    expect(result.blockRecommended).toBe(false);
    expect(result.rescueEligible).toBe(false);
  });

  it('can rescue only mature positive counterfactual evidence', () => {
    const rows = Array.from({ length: 24 }, (_, i) =>
      i % 3 === 2 ? outcome(i, 'LOSS', -1.0) : outcome(i, 'WIN', 1.1),
    );
    const result = buildAdaptivePredictionCalibration(rows, {
      ...request,
      rawConfidence: 0.6,
      rawNetExpectedR: 0.04,
    });

    expect(result.maturity).toBe('MATURE');
    expect(result.profitFactor).toBeGreaterThanOrEqual(1.15);
    expect(result.calibratedNetExpectedR).toBeGreaterThanOrEqual(0.12);
    expect(result.rescueEligible).toBe(true);
    expect(result.blockRecommended).toBe(false);
  });

  it('collapses overlapping outcome horizons before calibration evidence can mature', () => {
    const rows = Array.from({ length: 24 }, (_, i) => {
      const evaluated = new Date(Date.parse('2026-10-15T08:00:00.000Z') + i * 5 * 60_000);
      return outcome(i, i % 3 === 2 ? 'LOSS' : 'WIN', i % 3 === 2 ? -1 : 1.1, {
        evaluated_at: evaluated,
        outcome_resolved_at: new Date(evaluated.getTime() + 60 * 60_000),
      });
    });

    const result = buildAdaptivePredictionCalibration(rows, {
      ...request,
      rawConfidence: 0.6,
      rawNetExpectedR: 0.04,
    });

    expect(result.samples).toBe(1);
    expect(result.authoritative).toBe(false);
    expect(result.maturity).toBe('SPARSE');
    expect(result.rescueEligible).toBe(false);
  });

  it('defensively excludes outcomes that were not resolved before the current decision', () => {
    const historical = Array.from({ length: 12 }, (_, i) => outcome(i, 'LOSS', -1));
    const future = outcome(99, 'WIN', 5, {
      evaluated_at: new Date('2026-10-16T03:05:00.000Z'),
    });
    const result = buildAdaptivePredictionCalibration([...historical, future], request);

    expect(result.samples).toBe(12);
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(12);
  });

  it('queries both accepted and rejected prospective decisions without an admitted-only filter', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new AdaptivePredictionCalibrationService({ query } as unknown as DataSource);
    await service.getCalibration(request);

    const sql = String(query.mock.calls[0]?.[0] ?? '');
    expect(sql).toContain("components ? 'outcome'");
    expect(sql).toContain('model_version = ANY($4::text[])');
    expect(sql).toContain('evaluated_at < $5');
    expect(sql).toContain("components->'outcome'->>'version' = $6");
    expect(sql).not.toContain('admitted = true');
    expect(sql).not.toContain('paperExecutionEligible');
    expect(query.mock.calls[0]?.[1]).toEqual([
      'user-1',
      'conn-1',
      'irexpro-multimodel-ensemble-v1',
      ['policy-before-calibration', 'policy-calibration-v1'],
      evaluatedAt,
      'm5-first-hit-72bar-side-aware-v4',
    ]);
  });

  it('single-flights historical rows across candidate routes and directions at the exact same as-of', async () => {
    let release!: (rows: AdaptivePredictionOutcomeRow[]) => void;
    const pending = new Promise<AdaptivePredictionOutcomeRow[]>((resolve) => {
      release = resolve;
    });
    const query = jest.fn().mockReturnValue(pending);
    const service = new AdaptivePredictionCalibrationService({ query } as unknown as DataSource);
    const alternative = {
      ...request,
      instrument: 'USDJPY',
      direction: 'SELL' as const,
      strategyRoute: 'CONFIRMED_REVERSAL',
      rawConfidence: 0.81,
      rawNetExpectedR: 0.25,
      decisionPolicyVersions: [...request.decisionPolicyVersions].reverse(),
    };
    const first = service.getCalibration(request);
    const second = service.getCalibration(alternative);
    expect(query).toHaveBeenCalledTimes(1);
    release([]);
    const [a,b] = await Promise.all([first,second]);
    expect(a.rawConfidence).toBe(0.67);
    expect(b.rawConfidence).toBe(0.81);
    expect(b.rawNetExpectedR).toBe(0.25);
    expect(a.authoritative).toBe(false);
    expect(b.authoritative).toBe(false);

    await service.getCalibration({
      ...alternative, direction: 'BUY', rawConfidence: 0.52,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('never shares history across broker accounts, policy sets, or decision-time cutoffs', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new AdaptivePredictionCalibrationService({ query } as unknown as DataSource);
    await service.getCalibration(request);
    await service.getCalibration({ ...request, brokerConnectionId: 'another-demo' });
    await service.getCalibration({ ...request, userId: 'another-owner' });
    await service.getCalibration({
      ...request, decisionPolicyVersions: ['different-training-policy'],
    });
    await service.getCalibration({
      ...request, evaluatedAt: new Date(request.evaluatedAt.getTime() + 1),
    });
    expect(query).toHaveBeenCalledTimes(5);
  });

  it('evicts failed historical reads, retaining unavailable rather than fabricated evidence', async () => {
    const query = jest.fn()
      .mockRejectedValueOnce(new Error('historical database request failed'))
      .mockResolvedValueOnce([]);
    const service = new AdaptivePredictionCalibrationService({ query } as unknown as DataSource);
    const [a,b] = await Promise.all([
      service.getCalibration(request),
      service.getCalibration({ ...request, instrument: 'AUDUSD' }),
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(a.available).toBe(false);
    expect(b.available).toBe(false);
    await service.getCalibration({ ...request, instrument: 'GBPUSD' });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('adds a calibration veto when mature resolved evidence contradicts the raw prediction', () => {
    const calibration = buildAdaptivePredictionCalibration(
      [
        ...Array.from({ length: 5 }, (_, i) => outcome(i, 'WIN', 1.15)),
        ...Array.from({ length: 10 }, (_, i) => outcome(i + 5, 'LOSS', -1.1)),
      ],
      request,
    );
    const authority = applyAdaptivePredictionCalibrationAuthority({
      calibration,
      rawConfidence: request.rawConfidence,
      rawNetExpectedR: request.rawNetExpectedR,
      paperExecutionBlockers: [],
      allowResearchRescue: true,
    });

    expect(authority.blockExecution).toBe(true);
    expect(authority.effectivePaperExecutionBlockers).toContain(
      'ADAPTIVE_CALIBRATION_NEGATIVE_EDGE',
    );
    expect(authority.effectiveNetExpectedR).toBeLessThan(0);
  });

  it('rescues only the net-R blocker and preserves every other safety blocker', () => {
    const rows = Array.from({ length: 24 }, (_, i) =>
      i % 3 === 2 ? outcome(i, 'LOSS', -1.0) : outcome(i, 'WIN', 1.1),
    );
    const calibration = buildAdaptivePredictionCalibration(rows, {
      ...request,
      rawConfidence: 0.6,
      rawNetExpectedR: 0.04,
    });
    const authority = applyAdaptivePredictionCalibrationAuthority({
      calibration,
      rawConfidence: 0.6,
      rawNetExpectedR: 0.04,
      paperExecutionBlockers: [
        'ENSEMBLE_NOT_PAPER_ADMITTED',
        'PAPER_NET_EXPECTED_R',
        'DRIFT_OUT_OF_DISTRIBUTION',
      ],
      allowResearchRescue: true,
    });

    expect(authority.rescueApplied).toBe(true);
    expect(authority.effectivePaperExecutionBlockers).not.toContain('PAPER_NET_EXPECTED_R');
    expect(authority.effectivePaperExecutionBlockers).toContain('ENSEMBLE_NOT_PAPER_ADMITTED');
    expect(authority.effectivePaperExecutionBlockers).toContain('DRIFT_OUT_OF_DISTRIBUTION');
    expect(authority.effectiveNetExpectedR).toBe(calibration.calibratedNetExpectedR);
    expect(authority.effectiveConfidence).toBe(calibration.calibratedWinProbability);
  });

  it('does not hard-veto a raw-positive pair from broad route-wide calibration evidence', () => {
    const winIndexes = new Set([0, 1, 2, 16, 20]);
    const calibration = buildAdaptivePredictionCalibration(
      Array.from({ length: 24 }, (_, i) =>
        winIndexes.has(i)
          ? outcome(i, 'WIN', 1.0, { instrument: 'GBPUSD', direction: 'SELL' })
          : outcome(i, 'LOSS', -1.1, { instrument: 'GBPUSD', direction: 'SELL' }),
      ),
      { ...request, rawConfidence: 0.68, rawNetExpectedR: 0.18 },
    );
    const authority = applyAdaptivePredictionCalibrationAuthority({
      calibration,
      rawConfidence: 0.68,
      rawNetExpectedR: 0.18,
      paperExecutionBlockers: [],
      allowResearchRescue: true,
    });

    expect(calibration.sourceLevel).toBe('ROUTE');
    expect(calibration.maturity).toBe('MATURE');
    expect(calibration.calibratedNetExpectedR).toBeLessThan(0);
    expect(calibration.blockRecommended).toBe(false);
    expect(authority.blockExecution).toBe(false);
    expect(authority.effectiveConfidence).toBe(0.68);
    expect(authority.effectiveNetExpectedR).toBe(0.18);
    expect(authority.effectivePaperExecutionBlockers).not.toContain(
      'ADAPTIVE_CALIBRATION_NEGATIVE_EDGE',
    );
  });

  it('does not rescue a raw-negative pair from broad route-wide calibration evidence', () => {
    const calibration = buildAdaptivePredictionCalibration(
      Array.from({ length: 24 }, (_, i) =>
        i % 3 === 2
          ? outcome(i, 'LOSS', -1.0, { instrument: 'GBPUSD', direction: 'SELL' })
          : outcome(i, 'WIN', 1.1, { instrument: 'GBPUSD', direction: 'SELL' }),
      ),
      { ...request, rawConfidence: 0.6, rawNetExpectedR: -0.05 },
    );
    const authority = applyAdaptivePredictionCalibrationAuthority({
      calibration,
      rawConfidence: 0.6,
      rawNetExpectedR: -0.05,
      paperExecutionBlockers: ['PAPER_NET_EXPECTED_R'],
      allowResearchRescue: true,
    });

    expect(calibration.sourceLevel).toBe('ROUTE');
    expect(calibration.maturity).toBe('MATURE');
    expect(calibration.rescueEligible).toBe(false);
    expect(authority.rescueApplied).toBe(false);
    expect(authority.effectiveConfidence).toBe(0.6);
    expect(authority.effectiveNetExpectedR).toBe(-0.05);
    expect(authority.effectivePaperExecutionBlockers).toContain('PAPER_NET_EXPECTED_R');
  });

  it('never rescues from sparse calibration evidence', () => {
    const calibration = buildAdaptivePredictionCalibration(
      Array.from({ length: 6 }, (_, i) => outcome(i, 'WIN', 1.2)),
      { ...request, rawNetExpectedR: 0.04 },
    );
    const authority = applyAdaptivePredictionCalibrationAuthority({
      calibration,
      rawConfidence: request.rawConfidence,
      rawNetExpectedR: 0.04,
      paperExecutionBlockers: ['PAPER_NET_EXPECTED_R'],
      allowResearchRescue: true,
    });

    expect(authority.rescueApplied).toBe(false);
    expect(authority.effectiveNetExpectedR).toBe(0.04);
    expect(authority.effectivePaperExecutionBlockers).toEqual(['PAPER_NET_EXPECTED_R']);
  });
});
