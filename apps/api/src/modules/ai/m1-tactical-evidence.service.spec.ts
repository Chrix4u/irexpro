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

describe('M1TacticalEvidenceService', () => {
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
      expect.objectContaining({ realisedPnl: 3.5, policyVersion: 'm1-tactical-v1' }),
    ]);
    const [sql, params] = query.mock.calls[0]!;
    const normalized = String(sql).replace(/\s+/g, ' ');
    expect(normalized).toContain('d.user_id = $1');
    expect(normalized).toContain('d.broker_connection_id = $2');
    expect(normalized).toContain('d.route = $3');
    expect(normalized).toContain('d.instrument = $4');
    expect(normalized).toContain('d.direction = $5');
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
    expect(normalized).toContain("ti.strategy_code = 'external-irexpro-m1-tactical'");
    expect(normalized).toContain("ti.timeframe = 'M1'");
    expect(normalized).toContain("ti.metadata ->> 'external_provider_paper_only' = 'true'");
    expect(params).toEqual([input().userId, input().brokerConnectionId, 'EURUSD']);
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
    expect(normalized).toContain("ti.strategy_code = 'external-irexpro-m1-tactical'");
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

  it('loads only mature decisions whose sole blocker is drift and whose counterfactual is unsettled', async () => {
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
    expect(normalized).toContain('jsonb_array_length(blockers) = 1');
    expect(normalized).toContain(
      'blockers <@ \'["DRIFT_OUT_OF_DISTRIBUTION","DRIFT_STRESSED"]\'::jsonb',
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
