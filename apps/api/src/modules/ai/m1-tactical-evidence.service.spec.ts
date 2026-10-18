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
