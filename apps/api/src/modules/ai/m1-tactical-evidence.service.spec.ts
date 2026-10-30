import * as fs from 'fs';
import * as path from 'path';
import type { DataSource } from 'typeorm';
import {
  M1TacticalEvidenceService,
  type M1TacticalDecisionInput,
} from './m1-tactical-evidence.service';

const MIGRATION = path.resolve(
  __dirname,
  '../../database/migrations/1792342000000-CreateM1TacticalDecisionStore.ts',
);

function input(changes: Partial<M1TacticalDecisionInput> = {}): M1TacticalDecisionInput {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    brokerConnectionId: '22222222-2222-4222-8222-222222222222',
    instrument: 'EURUSD',
    direction: 'BUY',
    route: 'M1_TREND_CONTINUATION',
    barTime: new Date('2026-10-18T12:29:00.000Z'),
    policyVersion: 'm1-tactical-v1',
    executionAuthority: 'NONE',
    candidate: { score: 0.71 },
    governance: { netExpectedR: 0.2 },
    blockers: ['SHADOW_PHASE'],
    ...changes,
  };
}

describe('M1 tactical decision migration contract', () => {
  it('creates an isolated decision table with the exact idempotency fence and safety fields', () => {
    expect(fs.existsSync(MIGRATION)).toBe(true);
    const source = fs.readFileSync(MIGRATION, 'utf8');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS trading.m1_tactical_decisions');
    for (const column of [
      'user_id',
      'broker_connection_id',
      'instrument',
      'direction',
      'route',
      'bar_time',
      'policy_version',
      'execution_authority',
      'candidate',
      'governance',
      'blockers',
      'signal_id',
      'trade_intent_id',
      'outcome_state',
      'outcome_reason',
      'outcome_observed_at',
      'created_at',
      'updated_at',
    ]) {
      expect(source).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(source.replace(/\s+/g, ' ')).toContain(
      'UNIQUE ( user_id, broker_connection_id, instrument, direction, route, bar_time, policy_version )',
    );
    expect(source).toContain('ix_m1_tactical_route_pair_side_time');
    expect(source).toContain('ix_m1_tactical_policy_time');
    expect(source).toContain('ix_m1_tactical_execution_link');
    expect(source).toContain("CHECK (execution_authority IN ('NONE', 'PAPER_ONLY_RESEARCH'))");
    expect(source).not.toContain("'DEMO'");
    expect(source).not.toContain("'LIVE'");
  });

  it('down migration drops only the M1 decision table', () => {
    const source = fs.readFileSync(MIGRATION, 'utf8');
    const down = source.slice(source.indexOf('async down'));
    expect(down).toContain('DROP TABLE IF EXISTS trading.m1_tactical_decisions');
    expect(down).not.toMatch(
      /DROP TABLE IF EXISTS trading\.(trades|trade_intents|trading_sessions)/,
    );
  });
});

describe('M1 M5 early-transition handoff evidence', () => {
  it('loads the latest durable M5 early-transition decision across the research source connection', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        instrument: 'USDCHF',
        direction: 'BUY',
        market_bar_time: '2026-10-29T17:05:00.000Z',
        evaluated_at: '2026-10-29T17:09:00.000Z',
        strategy_route: 'EARLY_TRANSITION',
        paper_admitted: true,
        paper_execution_eligible: true,
        event_risk: 'CLEAR',
        drift_state: 'NORMAL',
        net_expected_r: '0.252',
        ensemble_score: '0.61',
        consensus_passed: 7,
        consensus_required: 6,
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    await expect(
      service.loadLatestM5EarlyTransitionEvidence({
        userId: input().userId,
        instrument: 'usdchf',
        direction: 'BUY',
        asOf: new Date('2026-10-29T17:10:00.000Z'),
      }),
    ).resolves.toEqual({
      instrument: 'USDCHF',
      direction: 'BUY',
      marketBarTime: new Date('2026-10-29T17:05:00.000Z'),
      evaluatedAt: new Date('2026-10-29T17:09:00.000Z'),
      strategyRoute: 'EARLY_TRANSITION',
      paperAdmitted: true,
      paperExecutionEligible: true,
      eventRisk: 'CLEAR',
      driftState: 'NORMAL',
      netExpectedR: 0.252,
      ensembleScore: 0.61,
      consensusPassed: 7,
      consensusRequired: 6,
    });

    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain('FROM trading.ensemble_shadow_decisions');
    expect(String(sql)).toContain('user_id = $1');
    expect(String(sql)).not.toContain('broker_connection_id =');
    expect(String(sql)).toContain('strategyRoute');
    expect(params).toEqual([input().userId, 'USDCHF', 'BUY', '2026-10-29T17:10:00.000Z']);
  });

  it('returns null when no durable M5 early-transition decision exists', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    await expect(
      service.loadLatestM5EarlyTransitionEvidence({
        userId: input().userId,
        instrument: 'USDCHF',
        direction: 'BUY',
        asOf: new Date('2026-10-29T17:10:00.000Z'),
      }),
    ).resolves.toBeNull();
  });
});

describe('M1TacticalEvidenceService', () => {
  it('loads the latest user-scoped M1 decision state for the trading cockpit', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        instrument: 'EURUSD',
        direction: 'SELL',
        route: 'M1_TREND_CONTINUATION',
        bar_time: '2026-10-27T20:29:00.000Z',
        candidate: { confidence: 0.738 },
        governance: {
          netExpectedR: 0.2794,
          primaryEngineCode: 'irexpro-multimodel-ensemble-v1',
          m1TacticalRole: 'TIMING_SPECIALIST',
          multimodelEnsemble: {
            ensembleScore: 0.6979,
            strategyRoute: 'EARLY_TRANSITION',
            paperAdmitted: true,
          },
          multimodelGovernance: {
            netExpectedR: 0.318,
            paperExecutionEligible: true,
          },
          multimodelTrainedExpert: {
            state: 'CONFIRM',
            direction: 'SELL',
            ensembleConfidence: 0.79,
            longVotes: 0,
            shortVotes: 3,
          },
          multimodelAuthority: {
            executable: true,
            authorityPath: 'HIGH_CONVICTION_RESCUE',
            rescueVolumeCap: 0.2,
          },
        },
        blockers: ['DRIFT_OUT_OF_DISTRIBUTION', 'M1_PHASE_ROUTE_SHADOW'],
        execution_authority: 'NONE',
        outcome_state: null,
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    await expect(service.loadLatestDecisionStateForUser(input().userId)).resolves.toEqual({
      instrument: 'EURUSD',
      direction: 'SELL',
      route: 'M1_TREND_CONTINUATION',
      barTime: '2026-10-27T20:29:00.000Z',
      confidence: 0.738,
      netExpectedR: 0.2794,
      executionAuthority: 'NONE',
      blockers: ['DRIFT_OUT_OF_DISTRIBUTION', 'M1_PHASE_ROUTE_SHADOW'],
      outcomeState: null,
      primaryEngineCode: 'irexpro-multimodel-ensemble-v1',
      primaryConfidence: 0.6979,
      primaryNetExpectedR: 0.318,
      planBRoute: 'EARLY_TRANSITION',
      planBPaperAdmitted: true,
      multimodelExecutable: true,
      multimodelAuthorityPath: 'HIGH_CONVICTION_RESCUE',
      multimodelRescueVolumeCap: 0.2,
      trainedExpertState: 'CONFIRM',
      trainedExpertDirection: 'SELL',
      trainedExpertConfidence: 0.79,
      trainedExpertLongVotes: 0,
      trainedExpertShortVotes: 3,
      m1TacticalRole: 'TIMING_SPECIALIST',
      m1TimingRoute: 'M1_TREND_CONTINUATION',
    });
    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain('WHERE user_id = $1');
    expect(String(sql).replace(/\s+/g, ' ')).toContain('ORDER BY bar_time DESC');
    expect(String(sql)).toContain("execution_authority <> 'NONE'");
    expect(params).toEqual([input().userId]);
  });

  it('records an immutable decision identity using parameterized SQL and no semantic overwrite on conflict', async () => {
    const row = {
      id: '33333333-3333-4333-8333-333333333333',
      user_id: input().userId,
      broker_connection_id: input().brokerConnectionId,
      instrument: 'EURUSD',
      direction: 'BUY',
      route: 'M1_TREND_CONTINUATION',
      bar_time: input().barTime,
      policy_version: 'm1-tactical-v1',
      execution_authority: 'NONE',
      blockers: ['SHADOW_PHASE'],
      signal_id: null,
      trade_intent_id: null,
      outcome_state: null,
      outcome_observed_at: null,
      created_at: input().barTime,
      updated_at: input().barTime,
    };
    const query = jest.fn().mockResolvedValue([row]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const result = await service.recordDecision(input());

    expect(result.id).toBe(row.id);
    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain('INSERT INTO trading.m1_tactical_decisions');
    expect(String(sql)).toContain('ON CONFLICT');
    expect(String(sql)).toContain(
      'DO UPDATE SET updated_at = trading.m1_tactical_decisions.updated_at',
    );
    expect(String(sql)).not.toMatch(/DO UPDATE SET[\s\S]*candidate\s*=\s*EXCLUDED\.candidate/);
    expect(params).toHaveLength(12);
    expect(params[0]).toBe(input().userId);
    expect(params[1]).toBe(input().brokerConnectionId);
    expect(params[2]).toBe('EURUSD');
  });

  it('loads route/pair/side reliability from authoritative CLOSED trades with exact tenant/account isolation', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        route: 'M1_TREND_CONTINUATION',
        instrument: 'EURUSD',
        direction: 'BUY',
        policy_version: 'm1-tactical-v1',
        realised_pnl: '3.5',
        lot_size: '0.10',
        fill_price: '1.1000',
        stop_loss: '1.0990',
        risk_at_stop_account: '9.25',
        max_favorable_pnl: '8.00',
        profit_giveback: '11.50',
        closed_at: '2026-10-18T12:20:00.000Z',
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const evaluatedAt = new Date('2026-10-18T12:30:00.000Z');

    const result = await service.loadRoutePairSideEvidence({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      route: 'M1_TREND_CONTINUATION',
      instrument: 'eurusd',
      direction: 'BUY',
      currentPolicyVersion: 'm1-tactical-v1',
      compatiblePolicyVersions: ['m1-tactical-v1'],
      evaluatedAt,
    });

    expect(result).toEqual([
      expect.objectContaining({
        realisedPnl: 3.5,
        riskAtStop: 9.25,
        maxFavorablePnl: 8,
        profitGiveback: 11.5,
        policyVersion: 'm1-tactical-v1',
      }),
    ]);
    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain('d.user_id = $1');
    expect(normalized).toContain('d.broker_connection_id = $2');
    expect(normalized).toContain('d.route = $3');
    expect(normalized).toContain('d.instrument = $4');
    expect(normalized).toContain('d.direction = $5');
    expect(normalized).toContain('COALESCE(');
    expect(normalized).toContain('t.max_favorable_pnl');
    expect(normalized).toContain('reconstructed_path_v1');
    expect(normalized).toContain("t.status = 'CLOSED'");
    expect(normalized).toContain('t.realised_pnl <> 0');
    expect(normalized).toContain("t.closed_at > ($7::timestamptz - interval '7 days')");
    expect(normalized).toContain('d.policy_version = ANY($6::text[])');
    expect(normalized).toContain('ORDER BY (d.policy_version = $8) DESC, t.closed_at DESC');
    expect(normalized).toContain('LIMIT 20');
    expect(params).toEqual([
      input().userId,
      input().brokerConnectionId,
      'M1_TREND_CONTINUATION',
      'EURUSD',
      'BUY',
      ['m1-tactical-v1'],
      evaluatedAt.toISOString(),
      'm1-tactical-v1',
    ]);
  });

  it('loads a recent exact pair-side fast-stop brake only from PAPER M1 stop-outs', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        closed_at: '2026-10-18T12:28:30.000Z',
        duration_minutes: '0.75',
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const evaluatedAt = new Date('2026-10-18T12:30:00.000Z');

    const result = await service.loadFastStopRegimeBrake({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      instrument: 'usdjpy',
      direction: 'SELL',
      evaluatedAt,
    });

    expect(result).toMatchObject({
      active: true,
      reason: 'RECENT_FAST_STOP',
      latestFastStopDurationMinutes: 0.75,
      latestFastStopClosedAt: new Date('2026-10-18T12:28:30.000Z'),
      cooldownMinutes: 5,
      maxStopDurationMinutes: 2,
    });
    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain('t.user_id = $1');
    expect(normalized).toContain('t.broker_connection_id = $2');
    expect(normalized).toContain('t.instrument = $3');
    expect(normalized).toContain('t.direction = $4');
    expect(normalized).toContain(
      "ti.strategy_code IN ('external-irexpro-m1-tactical', 'external-irexpro-multimodel-ensemble')",
    );
    expect(normalized).toContain("ti.timeframe = 'M1'");
    expect(normalized).toContain("ti.metadata ->> 'external_provider_paper_only' = 'true'");
    expect(normalized).toContain("t.close_reason = 'STOP_LOSS_HIT'");
    expect(normalized).toContain(
      "t.closed_at > ($5::timestamptz - ($6::double precision * interval '1 second'))",
    );
    expect(normalized).toContain('EXTRACT(EPOCH FROM (t.closed_at - t.opened_at)) <= $7');
    expect(normalized).toContain('ORDER BY t.closed_at DESC');
    expect(normalized).toContain('LIMIT 1');
    expect(params).toEqual([
      input().userId,
      input().brokerConnectionId,
      'USDJPY',
      'SELL',
      evaluatedAt.toISOString(),
      300,
      120,
    ]);
  });

  it('returns a clear fast-stop brake when no qualifying stop-out exists', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    await expect(
      service.loadFastStopRegimeBrake({
        userId: input().userId,
        brokerConnectionId: input().brokerConnectionId,
        instrument: 'EURUSD',
        direction: 'BUY',
        evaluatedAt: new Date('2026-10-18T12:30:00.000Z'),
      }),
    ).resolves.toMatchObject({
      active: false,
      reason: 'CLEAR',
      latestFastStopClosedAt: null,
      latestFastStopDurationMinutes: null,
    });
  });

  it('activates an exact Plan-B pair-side-route loss-streak brake after three recent closed losses', async () => {
    const query = jest.fn().mockResolvedValue([
      { realised_pnl: '-12.10', closed_at: '2026-10-28T23:17:12.746Z' },
      { realised_pnl: '-12.35', closed_at: '2026-10-28T13:41:46.604Z' },
      { realised_pnl: '-8.98', closed_at: '2026-10-28T12:04:30.666Z' },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const evaluatedAt = new Date('2026-10-28T23:23:00.000Z');
    const result =
      (await (service as any).loadMultimodelLossStreakBrake?.({
        userId: input().userId,
        brokerConnectionId: input().brokerConnectionId,
        instrument: 'eurusd',
        direction: 'SELL',
        strategyRoute: 'CONFIRMED_REVERSAL',
        evaluatedAt,
      })) ?? null;
    expect(result).toMatchObject({
      artifact: 'm1-multimodel-loss-streak-brake-v1',
      active: true,
      reason: 'RECENT_MULTIMODEL_LOSS_STREAK',
      strategyRoute: 'CONFIRMED_REVERSAL',
      recentClosedTrades: 3,
      recentLosses: 3,
      recentWins: 0,
      cumulativeRealisedPnl: -33.43,
      cooldownHours: 12,
    });
    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain('t.user_id = $1');
    expect(normalized).toContain('t.broker_connection_id = $2');
    expect(normalized).toContain('t.instrument = $3');
    expect(normalized).toContain('t.direction = $4');
    expect(normalized).toContain("d.governance -> 'multimodelEnsemble' ->> 'strategyRoute' = $5");
    expect(normalized).toContain("ti.strategy_code = 'external-irexpro-multimodel-ensemble'");
    expect(normalized).toContain("ti.timeframe = 'M1'");
    expect(normalized).toContain("t.status = 'CLOSED'");
    expect(normalized).toContain("t.closed_at > ($6::timestamptz - interval '24 hours')");
    expect(normalized).toContain('ORDER BY t.closed_at DESC');
    expect(normalized).toContain('LIMIT 8');
    expect(params).toEqual([
      input().userId,
      input().brokerConnectionId,
      'EURUSD',
      'SELL',
      'CONFIRMED_REVERSAL',
      evaluatedAt.toISOString(),
    ]);
  });

  it('activates the exact pair-side-route brake when recent payoff is negative despite interspersed wins', async () => {
    const query = jest.fn().mockResolvedValue([
      { realised_pnl: '-8.00', closed_at: '2026-10-30T08:00:00.000Z' },
      { realised_pnl: '2.00', closed_at: '2026-10-30T07:00:00.000Z' },
      { realised_pnl: '-7.00', closed_at: '2026-10-30T06:00:00.000Z' },
      { realised_pnl: '1.50', closed_at: '2026-10-30T05:00:00.000Z' },
      { realised_pnl: '-6.00', closed_at: '2026-10-30T04:00:00.000Z' },
      { realised_pnl: '2.50', closed_at: '2026-10-30T03:00:00.000Z' },
      { realised_pnl: '-5.00', closed_at: '2026-10-30T02:00:00.000Z' },
      { realised_pnl: '1.00', closed_at: '2026-10-30T01:00:00.000Z' },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const result = await service.loadMultimodelLossStreakBrake({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      instrument: 'EURUSD',
      direction: 'SELL',
      strategyRoute: 'TREND_CONTINUATION',
      evaluatedAt: new Date('2026-10-30T08:05:00.000Z'),
    });

    expect(result).toMatchObject({
      active: true,
      reason: 'RECENT_NEGATIVE_PAYOFF',
      recentClosedTrades: 8,
      recentLosses: 4,
      recentWins: 4,
      cumulativeRealisedPnl: -19,
      negativePayoff: true,
    });
    expect(result.profitFactor).toBeCloseTo(7 / 26, 8);
    expect(String(query.mock.calls[0]![0]).replace(/\s+/g, ' ')).toContain('LIMIT 8');
  });

  it('keeps a mixed but profitable exact sleeve clear', async () => {
    const query = jest.fn().mockResolvedValue([
      { realised_pnl: '6.00', closed_at: '2026-10-30T08:00:00.000Z' },
      { realised_pnl: '-3.00', closed_at: '2026-10-30T07:00:00.000Z' },
      { realised_pnl: '5.00', closed_at: '2026-10-30T06:00:00.000Z' },
      { realised_pnl: '-2.00', closed_at: '2026-10-30T05:00:00.000Z' },
      { realised_pnl: '4.00', closed_at: '2026-10-30T04:00:00.000Z' },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    await expect(
      service.loadMultimodelLossStreakBrake({
        userId: input().userId,
        brokerConnectionId: input().brokerConnectionId,
        instrument: 'AUDUSD',
        direction: 'BUY',
        strategyRoute: 'TREND_CONTINUATION',
        evaluatedAt: new Date('2026-10-30T08:05:00.000Z'),
      }),
    ).resolves.toMatchObject({ active: false, reason: 'CLEAR', negativePayoff: false });
  });

  it('requires at least five mixed outcomes and expires negative-payoff suspension after cooldown', async () => {
    const rows = [
      { realised_pnl: '-8.00', closed_at: '2026-10-29T18:00:00.000Z' },
      { realised_pnl: '1.00', closed_at: '2026-10-29T17:00:00.000Z' },
      { realised_pnl: '-7.00', closed_at: '2026-10-29T16:00:00.000Z' },
      { realised_pnl: '1.00', closed_at: '2026-10-29T15:00:00.000Z' },
      { realised_pnl: '-6.00', closed_at: '2026-10-29T14:00:00.000Z' },
    ];
    const query = jest.fn().mockResolvedValue(rows);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const expired = await service.loadMultimodelLossStreakBrake({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      instrument: 'EURUSD',
      direction: 'SELL',
      strategyRoute: 'TREND_CONTINUATION',
      evaluatedAt: new Date('2026-10-30T07:00:01.000Z'),
    });
    expect(expired).toMatchObject({ active: false, reason: 'CLEAR', negativePayoff: true });

    query.mockResolvedValue(rows.slice(0, 4));
    const sparse = await service.loadMultimodelLossStreakBrake({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      instrument: 'EURUSD',
      direction: 'SELL',
      strategyRoute: 'TREND_CONTINUATION',
      evaluatedAt: new Date('2026-10-29T18:05:00.000Z'),
    });
    expect(sparse).toMatchObject({ active: false, reason: 'CLEAR', negativePayoff: false });
  });

  it('marks signal/trade-intent linkage without changing decision identity', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'decision-1' }]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    await service.markExecutionLink(
      'decision-1',
      'signal-1',
      '44444444-4444-4444-8444-444444444444',
    );

    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain('UPDATE trading.m1_tactical_decisions');
    expect(String(sql)).toContain('signal_id = COALESCE(signal_id, $2)');
    expect(String(sql)).toContain('trade_intent_id = COALESCE(trade_intent_id, $3)');
    expect(params).toEqual(['decision-1', 'signal-1', '44444444-4444-4444-8444-444444444444']);
  });

  it('never downgrades EXECUTION_SUCCEEDED with a later duplicate outcome', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    await service.markOutcomeState(
      'decision-1',
      'SIGNAL_INVALID',
      new Date('2026-10-19T11:53:10.000Z'),
      'duplicate payload mismatch',
    );

    const [sql] = query.mock.calls[0]!;
    expect(String(sql)).toContain("outcome_state IS DISTINCT FROM 'EXECUTION_SUCCEEDED'");
  });

  it('persists terminal outcome reason together with outcome state', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'decision-1' }]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const observedAt = new Date('2026-10-18T12:31:00.000Z');

    await service.markOutcomeState(
      'decision-1',
      'RISK_REJECTED',
      observedAt,
      'risk gate rejected test candidate',
    );

    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain('outcome_reason = $4');
    expect(params).toEqual([
      'decision-1',
      'RISK_REJECTED',
      observedAt.toISOString(),
      'risk gate rejected test candidate',
    ]);
  });

  it('computes outcome metrics from authoritative closed trades rather than stored decision PnL', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        closed_trades: 5,
        wins: 3,
        losses: 2,
        realised_pnl: '12.5',
        gross_profit: '20',
        gross_loss: '7.5',
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const result = await service.loadOutcomeMetrics({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      route: 'M1_TREND_CONTINUATION',
      policyVersion: 'm1-tactical-v1',
      from: new Date('2026-10-11T00:00:00.000Z'),
      to: new Date('2026-10-18T23:59:59.000Z'),
    });

    expect(result).toMatchObject({
      closedTrades: 5,
      wins: 3,
      losses: 2,
      realisedPnl: 12.5,
      profitFactor: 20 / 7.5,
    });
    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('JOIN trading.trades t');
    expect(sql).toContain('t.realised_pnl');
    expect(sql).not.toContain('d.realised_pnl');
  });
});

describe('M1TacticalEvidenceService rescue evidence', () => {
  it('loads only authoritative OPEN M1 PAPER positions for the exact tenant/account/instrument', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        trade_id: 'trade-1',
        trade_intent_id: 'intent-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        opened_at: '2026-10-18T12:00:00.000Z',
        decision_id: 'decision-old',
        route: 'M1_TREND_CONTINUATION',
        policy_version: 'm1-tactical-v1',
        original_net_expected_r: '0.22',
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const rows = await service.loadOpenPaperPositions({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      instrument: 'eurusd',
    });

    expect(rows).toEqual([
      expect.objectContaining({
        tradeId: 'trade-1',
        direction: 'BUY',
        route: 'M1_TREND_CONTINUATION',
        originalNetExpectedR: 0.22,
      }),
    ]);
    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain('t.user_id = $1');
    expect(normalized).toContain('t.broker_connection_id = $2');
    expect(normalized).toContain('t.instrument = $3');
    expect(normalized).toContain("t.status = 'OPEN'");
    expect(normalized).toContain(
      "ti.strategy_code IN ('external-irexpro-m1-tactical', 'external-irexpro-multimodel-ensemble')",
    );
    expect(normalized).toContain("ti.timeframe = 'M1'");
    expect(normalized).toContain("ti.metadata ->> 'external_provider_paper_only' = 'true'");
    expect(params).toEqual([input().userId, input().brokerConnectionId, 'EURUSD']);
  });

  it('loads all open iRexPro PAPER entry exposure across M1 and M5 with durable USD stop-risk evidence', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        instrument: 'EURUSD',
        direction: 'SELL',
        lot_size: '0.1000',
        fill_price: '1.12221',
        stop_loss: '1.12271',
      },
      {
        instrument: 'USDJPY',
        direction: 'BUY',
        lot_size: '0.1000',
        fill_price: '157.00000',
        stop_loss: '156.95000',
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    await expect(
      service.loadOpenPaperRiskPositions({
        userId: input().userId,
        brokerConnectionId: input().brokerConnectionId,
      }),
    ).resolves.toEqual([
      { instrument: 'EURUSD', direction: 'SELL', lotSize: 0.1, riskAtStop: expect.closeTo(5, 6) },
      {
        instrument: 'USDJPY',
        direction: 'BUY',
        lotSize: 0.1,
        riskAtStop: expect.closeTo(3.184713, 5),
      },
    ]);
    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).not.toContain('t.instrument = $3');
    expect(normalized).toContain("t.status = 'OPEN'");
    expect(normalized).toContain('t.lot_size');
    expect(normalized).toContain('t.fill_price');
    expect(normalized).toContain('t.stop_loss');
    expect(normalized).toContain("ti.strategy_code LIKE 'external-irexpro-%'");
    expect(normalized).toContain("ti.timeframe IN ('M1', 'M5')");
    expect(normalized).toContain("ti.metadata ->> 'external_provider_paper_only' = 'true'");
    expect(params).toEqual([input().userId, input().brokerConnectionId]);
  });

  it('checks active same-side M1 intent identity before another execution is submitted', async () => {
    const query = jest.fn().mockResolvedValue([{ exists: true }]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const exists = await service.hasActiveM1Intent({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      instrument: 'eurusd',
      direction: 'BUY',
    });

    expect(exists).toBe(true);
    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain(
      "ti.strategy_code IN ('external-irexpro-m1-tactical', 'external-irexpro-multimodel-ensemble')",
    );
    expect(normalized).toContain("ti.status = 'CREATED'");
    expect(normalized).toContain("ti.status = 'EXECUTED' AND t.status = 'OPEN'");
    expect(params).toEqual([input().userId, input().brokerConnectionId, 'EURUSD', 'BUY']);
  });

  it('checks active opposite M1 intent identity without treating historical closed intents as duplicates', async () => {
    const query = jest.fn().mockResolvedValue([{ exists: true }]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const exists = await service.hasActiveOppositeM1Intent({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      instrument: 'eurusd',
      direction: 'SELL',
    });

    expect(exists).toBe(true);
    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain('ti.user_id = $1');
    expect(normalized).toContain('ti.broker_connection_id = $2');
    expect(normalized).toContain('ti.instrument = $3');
    expect(normalized).toContain('ti.direction = $4');
    expect(normalized).toContain(
      "ti.strategy_code IN ('external-irexpro-m1-tactical', 'external-irexpro-multimodel-ensemble')",
    );
    expect(normalized).toContain("ti.timeframe = 'M1'");
    expect(normalized).toContain("ti.status = 'CREATED'");
    expect(normalized).toContain("ti.status = 'EXECUTED' AND t.status = 'OPEN'");
    expect(params).toEqual([input().userId, input().brokerConnectionId, 'EURUSD', 'SELL']);
  });

  it('persists a rescue observation inside decision governance without creating financial truth', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const rescue = {
      eligible: true,
      reason: 'SHADOW_RESCUE_CANDIDATE' as const,
      originalInvalidated: true,
      originalNetExpectedR: -0.1,
      oppositeNetExpectedR: 0.45,
      edgeDelta: 0.55,
      executionAuthority: 'NONE' as const,
      modifiesExecution: false as const,
    };

    await service.markRescueObservation('decision-current', {
      openTradeId: 'trade-1',
      openDecisionId: 'decision-old',
      observedAt: new Date('2026-10-18T12:31:00.000Z'),
      rescue,
    });

    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain("jsonb_set(governance, '{failedMoveRescue}'");
    expect(String(sql)).not.toContain('realised_pnl');
    expect(params[0]).toBe('decision-current');
    expect(JSON.parse(params[1])).toMatchObject({
      openTradeId: 'trade-1',
      openDecisionId: 'decision-old',
      rescue: expect.objectContaining({ executionAuthority: 'NONE', modifiesExecution: false }),
    });
  });

  it('loads mature drift counterfactuals with reliability-only blockers while excluding substantive hard blockers', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: 'decision-drift-1',
        instrument: 'EURUSD',
        direction: 'SELL',
        route: 'M1_TREND_CONTINUATION',
        evaluated_at: '2026-10-19T10:55:00.000Z',
        candidate: { stopDistance: 0.0005, targetDistance: 0.0008 },
        governance: {
          genericGovernance: {
            driftState: 'OUT_OF_DISTRIBUTION',
            estimatedExecutionCostR: 0.0625,
            driftDiagnostics: ['extensionAtr:HARD_HIGH'],
          },
        },
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const asOf = new Date('2026-10-19T11:11:00.000Z');

    const result = await service.loadPendingDriftCounterfactuals({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      instrument: 'EURUSD',
      asOf,
      policyVersion: 'm1-tactical-v1',
    });

    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain("route <> 'ABSTAIN'");
    expect(normalized).toContain("execution_authority = 'NONE'");
    expect(normalized).toContain('jsonb_array_elements_text(blockers)');
    expect(normalized).toContain(
      "blocker.value !~ '^M1_(SHADOW_|MEANINGFUL_SCOUT_|TIERED_SCOUT_)?RELIABILITY_'",
    );
    expect(normalized).toMatch(
      /blocker\.value NOT IN\s*\(\s*'DRIFT_OUT_OF_DISTRIBUTION', 'DRIFT_STRESSED', 'M1_PHASE_SHADOW', 'M1_PHASE_ROUTE_SHADOW'\s*\)/,
    );
    expect(normalized).toContain(
      'blockers @> \'["DRIFT_OUT_OF_DISTRIBUTION"]\'::jsonb OR blockers @> \'["DRIFT_STRESSED"]\'::jsonb',
    );
    expect(normalized).toContain("governance -> 'driftCounterfactual15m' IS NULL");
    expect(normalized).toContain("evaluated_at <= ($4::timestamptz - interval '16 minutes')");
    expect(normalized).toContain('policy_version = $5');
    expect(normalized).toContain('ORDER BY evaluated_at DESC');
    expect(params).toEqual([
      input().userId,
      input().brokerConnectionId,
      'EURUSD',
      asOf.toISOString(),
      'm1-tactical-v1',
    ]);
    expect(result).toEqual([
      expect.objectContaining({
        id: 'decision-drift-1',
        instrument: 'EURUSD',
        direction: 'SELL',
        route: 'M1_TREND_CONTINUATION',
        evaluatedAt: new Date('2026-10-19T10:55:00.000Z'),
        stopDistance: 0.0005,
        targetDistance: 0.0008,
        estimatedExecutionCostR: 0.0625,
        driftState: 'OUT_OF_DISTRIBUTION',
        driftDiagnostics: ['extensionAtr:HARD_HIGH'],
      }),
    ]);
  });

  it('settles the 15-minute drift counterfactual idempotently inside governance only', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const observation = {
      artifact: 'm1-drift-counterfactual-15m-v1' as const,
      modifiesExecution: false as const,
      source: 'COMPLETED_M1_OHLC' as const,
      horizonBars: 15 as const,
      outcome: 'MTM' as const,
      entryBarOpenTime: '2026-10-19T10:55:00.000Z',
      observedAt: '2026-10-19T11:11:00.000Z',
      terminalBarOpenTime: '2026-10-19T11:10:00.000Z',
      entryPrice: 1.1,
      stopLoss: 1.1005,
      takeProfit: 1.0992,
      terminalPrice: 1.0997,
      estimatedExecutionCostR: 0.0625,
      grossRMultiple: 0.6,
      netRMultiple: 0.5375,
    };

    await service.markDriftCounterfactual15m('decision-drift-1', observation);

    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain("jsonb_set(governance, '{driftCounterfactual15m}'");
    expect(normalized).toContain("governance -> 'driftCounterfactual15m' IS NULL");
    expect(normalized).not.toContain('signal_id =');
    expect(normalized).not.toContain('trade_intent_id =');
    expect(normalized).not.toContain('outcome_state =');
    expect(params[0]).toBe('decision-drift-1');
    expect(JSON.parse(params[1])).toEqual(observation);
  });
});

describe('M1TacticalEvidenceService shadow episode evidence', () => {
  it('loads only mature independent SHADOW episode leaders from governance-clean chronology', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: 'decision-leader-1',
        instrument: 'EURUSD',
        direction: 'BUY',
        route: 'M1_EARLY_TRANSITION',
        bar_time: '2026-10-21T10:00:00.000Z',
        evaluated_at: '2026-10-21T10:00:30.000Z',
        policy_version: 'm1-tactical-v1',
        candidate: { stopDistance: 0.0005, targetDistance: 0.0008 },
        governance: {
          genericGovernance: {
            estimatedExecutionCostR: 0.0625,
            executionCostSource: 'PAPER_SIMULATION_SPREAD',
          },
          rolloutPhase: 'SHADOW',
        },
      },
      {
        id: 'decision-leader-2',
        instrument: 'EURUSD',
        direction: 'BUY',
        route: 'M1_EARLY_TRANSITION',
        bar_time: '2026-10-21T10:07:00.000Z',
        evaluated_at: '2026-10-21T10:07:30.000Z',
        policy_version: 'm1-tactical-v1',
        candidate: { stopDistance: 0.0006, targetDistance: 0.0009 },
        governance: {
          genericGovernance: {
            estimatedExecutionCostR: 0.05,
            executionCostSource: 'BROKER_OBSERVED_P90',
          },
          rolloutPhase: 'SHADOW',
        },
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const asOf = new Date('2026-10-21T10:30:00.000Z');

    const result = await service.loadMatureShadowEpisodeLeaders({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      instrument: 'eurusd',
      policyVersion: 'm1-tactical-v1',
      asOf,
    });

    expect(result).toEqual([
      expect.objectContaining({
        id: 'decision-leader-1',
        route: 'M1_EARLY_TRANSITION',
        instrument: 'EURUSD',
        direction: 'BUY',
        policyVersion: 'm1-tactical-v1',
        stopDistance: 0.0005,
        targetDistance: 0.0008,
        estimatedExecutionCostR: 0.0625,
        executionCostSource: 'PAPER_SIMULATION_SPREAD',
        rolloutPhase: 'SHADOW',
      }),
      expect.objectContaining({ id: 'decision-leader-2', stopDistance: 0.0006 }),
    ]);

    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain("route <> 'ABSTAIN'");
    expect(normalized).toContain("execution_authority = 'NONE'");
    expect(normalized).toContain("governance ->> 'shadowOutcomeEligible' = 'true'");
    expect(normalized).toContain("OR blockers = '[]'::jsonb");
    expect(normalized).toContain(`OR blockers = '["M1_PHASE_SHADOW"]'::jsonb`);
    expect(normalized).toContain('LAG(bar_time) OVER');
    expect(normalized).toContain(
      'PARTITION BY user_id, broker_connection_id, instrument, direction, route, policy_version',
    );
    expect(normalized).toContain("bar_time - previous_bar_time > interval '5 minutes'");
    expect(normalized).toContain("governance -> 'shadowOutcome15mV1' IS NULL");
    expect(normalized).toContain("evaluated_at <= ($5::timestamptz - interval '16 minutes')");
    expect(normalized).toContain('policy_version = $4');
    expect(normalized).toContain('instrument = $3');
    expect(params).toEqual([
      input().userId,
      input().brokerConnectionId,
      'EURUSD',
      'm1-tactical-v1',
      asOf.toISOString(),
    ]);
  });

  it('persists shadowOutcome15mV1 idempotently without writing real execution outcome fields', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const outcome = {
      artifact: 'm1-shadow-outcome-15m-v1' as const,
      modifiesExecution: false as const,
      episodeLeaderDecisionId: 'decision-leader-1',
      episodeStartBarTime: '2026-10-21T10:00:00.000Z',
      route: 'M1_EARLY_TRANSITION' as const,
      instrument: 'EURUSD',
      direction: 'BUY' as const,
      policyVersion: 'm1-tactical-v1',
      source: 'COMPLETED_M1_OHLC' as const,
      executionCostSource: 'PAPER_SIMULATION_SPREAD',
      rolloutPhase: 'SHADOW',
      outcome: 'TP' as const,
      entryBarOpenTime: '2026-10-21T10:01:00.000Z',
      observedAt: '2026-10-21T10:16:00.000Z',
      terminalBarOpenTime: '2026-10-21T10:04:00.000Z',
      entryPrice: 1.1,
      stopLoss: 1.0995,
      takeProfit: 1.1008,
      terminalPrice: 1.1008,
      estimatedExecutionCostR: 0.0625,
      grossRMultiple: 1.6,
      netRMultiple: 1.5375,
    };

    await service.markShadowOutcome15mV1('decision-leader-1', outcome);
    await service.markShadowOutcome15mV1('decision-leader-1', outcome);

    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, params] of query.mock.calls) {
      const normalized = String(sql).replace(/\s+/g, ' ');
      expect(normalized).toContain("jsonb_set(governance, '{shadowOutcome15mV1}'");
      expect(normalized).toContain("governance -> 'shadowOutcome15mV1' IS NULL");
      expect(normalized).not.toContain('outcome_state =');
      expect(normalized).not.toContain('outcome_reason =');
      expect(normalized).not.toContain('signal_id =');
      expect(normalized).not.toContain('trade_intent_id =');
      expect(params[0]).toBe('decision-leader-1');
      expect(JSON.parse(params[1])).toMatchObject({
        artifact: 'm1-shadow-outcome-15m-v1',
        modifiesExecution: false,
        outcome: 'TP',
      });
    }
  });
});

describe('M1TacticalEvidenceService shadow outcome metrics', () => {
  it('counts all episode outcomes but excludes ambiguous and data-gap observations from P&L metrics', async () => {
    const rows = [
      ['2026-10-21T10:16:00.000Z', 'TP', 1.5],
      ['2026-10-21T10:26:00.000Z', 'SL', -1],
      ['2026-10-21T10:36:00.000Z', 'MTM', 0.25],
      ['2026-10-21T10:46:00.000Z', 'AMBIGUOUS', null],
      ['2026-10-21T10:51:00.000Z', 'TP', null],
      ['2026-10-21T10:56:00.000Z', 'UNOBSERVABLE_DATA_GAP', null],
    ].map(([evaluated_at, outcome, netRMultiple], index) => ({
      id: `leader-${index + 1}`,
      evaluated_at,
      shadow_outcome: {
        artifact: 'm1-shadow-outcome-15m-v1',
        outcome,
        netRMultiple,
      },
    }));
    const query = jest.fn().mockResolvedValue(rows);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const result = await service.loadShadowOutcomeMetrics({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      route: 'M1_EARLY_TRANSITION',
      instrument: 'eurusd',
      direction: 'BUY',
      policyVersion: 'm1-tactical-v1',
      from: new Date('2026-10-21T10:00:00.000Z'),
      to: new Date('2026-10-21T11:00:00.000Z'),
    });

    expect(result).toEqual({
      totalEpisodeLeaders: 6,
      evaluableEpisodes: 3,
      ambiguousEpisodes: 1,
      unobservableEpisodes: 1,
      positiveEpisodes: 2,
      negativeEpisodes: 1,
      flatEpisodes: 0,
      cumulativeNetR: 0.75,
      averageNetR: 0.25,
      grossPositiveR: 1.75,
      grossNegativeR: 1,
      profitFactor: 1.75,
      maximumDrawdownR: 1,
    });

    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain("governance -> 'shadowOutcome15mV1' AS shadow_outcome");
    expect(normalized).toContain("governance -> 'shadowOutcome15mV1' ->> 'artifact' = $9");
    expect(normalized).toContain('user_id = $1');
    expect(normalized).toContain('broker_connection_id = $2');
    expect(normalized).toContain('($3::text IS NULL OR route = $3)');
    expect(normalized).toContain('($4::text IS NULL OR instrument = $4)');
    expect(normalized).toContain('($5::text IS NULL OR direction = $5)');
    expect(normalized).toContain('($6::text IS NULL OR policy_version = $6)');
    expect(normalized).toContain('evaluated_at >= $7::timestamptz');
    expect(normalized).toContain('evaluated_at <= $8::timestamptz');
    expect(normalized).toContain('ORDER BY evaluated_at ASC');
    expect(params).toEqual([
      input().userId,
      input().brokerConnectionId,
      'M1_EARLY_TRANSITION',
      'EURUSD',
      'BUY',
      'm1-tactical-v1',
      '2026-10-21T10:00:00.000Z',
      '2026-10-21T11:00:00.000Z',
      'm1-shadow-outcome-15m-v1',
    ]);
  });

  it('uses the existing infinity convention when positive R has no negative denominator', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: 'leader-win',
        evaluated_at: '2026-10-21T10:16:00.000Z',
        shadow_outcome: {
          artifact: 'm1-shadow-outcome-15m-v1',
          outcome: 'TP',
          netRMultiple: 1.2,
        },
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    const result = await service.loadShadowOutcomeMetrics({
      userId: input().userId,
      brokerConnectionId: input().brokerConnectionId,
      from: new Date('2026-10-21T10:00:00.000Z'),
      to: new Date('2026-10-21T11:00:00.000Z'),
    });

    expect(result.profitFactor).toBe(Number.POSITIVE_INFINITY);
    expect(result.maximumDrawdownR).toBe(0);
  });
});

describe('M1TacticalEvidenceService shadow episode fail-closed mapping', () => {
  it('excludes an episode leader when estimated execution cost R is missing', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: 'decision-missing-cost',
        instrument: 'EURUSD',
        direction: 'BUY',
        route: 'M1_EARLY_TRANSITION',
        bar_time: '2026-10-21T10:00:00.000Z',
        evaluated_at: '2026-10-21T10:00:30.000Z',
        policy_version: 'm1-tactical-v1',
        candidate: { stopDistance: 0.0005, targetDistance: 0.0008 },
        governance: {
          genericGovernance: { executionCostSource: 'BROKER_OBSERVED_P90' },
          rolloutPhase: 'SHADOW',
        },
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);

    await expect(
      service.loadMatureShadowEpisodeLeaders({
        userId: input().userId,
        brokerConnectionId: input().brokerConnectionId,
        instrument: 'EURUSD',
        policyVersion: 'm1-tactical-v1',
        asOf: new Date('2026-10-21T10:30:00.000Z'),
      }),
    ).resolves.toEqual([]);
  });
});

describe('M1TacticalEvidenceService causal shadow pair-side outcomes', () => {
  it('loads only causal exact-route pair-side outcomes for the active policy window', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        observed_at: '2026-10-23T18:40:00.000Z',
        net_r_multiple: '0.55',
      },
      {
        observed_at: '2026-10-23T17:20:00.000Z',
        net_r_multiple: '-0.20',
      },
    ]);
    const service = new M1TacticalEvidenceService({ query } as unknown as DataSource);
    const evaluatedAt = new Date('2026-10-23T19:00:00.000Z');

    await expect(
      service.loadShadowPairSideOutcomes({
        userId: input().userId,
        brokerConnectionId: input().brokerConnectionId,
        route: 'M1_EARLY_TRANSITION',
        instrument: 'usdjpy',
        direction: 'BUY',
        policyVersion: 'm1-tactical-v3-shadow-outcomes',
        evaluatedAt,
      }),
    ).resolves.toEqual([
      { observedAt: new Date('2026-10-23T18:40:00.000Z'), netR: 0.55 },
      { observedAt: new Date('2026-10-23T17:20:00.000Z'), netR: -0.2 },
    ]);

    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain('route = $3');
    expect(normalized).toContain('instrument = $4');
    expect(normalized).toContain('direction = $5');
    expect(normalized).toContain('policy_version = $6');
    expect(normalized).toContain("governance -> 'shadowOutcome15mV1' ->> 'artifact' = $7");
    expect(normalized).toContain(
      "(governance -> 'shadowOutcome15mV1' ->> 'observedAt')::timestamptz <= $8::timestamptz",
    );
    expect(normalized).toContain("evaluated_at >= ($8::timestamptz - interval '7 days')");
    expect(normalized).toContain('ORDER BY observed_at DESC');
    expect(normalized).toContain('LIMIT 20');
    expect(params).toEqual([
      input().userId,
      input().brokerConnectionId,
      'M1_EARLY_TRANSITION',
      'USDJPY',
      'BUY',
      'm1-tactical-v3-shadow-outcomes',
      'm1-shadow-outcome-15m-v1',
      evaluatedAt.toISOString(),
    ]);
  });
});
