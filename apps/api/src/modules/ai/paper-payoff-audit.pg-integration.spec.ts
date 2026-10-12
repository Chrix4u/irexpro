import { Client } from 'pg';
import * as helpers from './paper-payoff-shadow-audit';
import { PAPER_MARKET_SPECS } from '../broker/services/paper-market-spec';

// Operational entry point intentionally exports CommonJS for deployment and tests.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { runPaperPayoffAudit } = require('../../../scripts/audit-paper-payoff-shadow.cjs');

describe('PAPER payoff audit — real PostgreSQL', () => {
  const user = '11111111-1111-1111-1111-111111111111';
  const connection = '22222222-2222-2222-2222-222222222222';
  const trade = '33333333-3333-3333-3333-333333333333';
  const order = '44444444-4444-4444-4444-444444444444';
  const other = '55555555-5555-5555-5555-555555555555';
  let client: Client;
  const metadata = {
    signal_source: 'EXTERNAL_PROVIDER',
    external_provider_code: 'irexpro-multimodel-ensemble-v1',
    paper_execution_route: 'NORMAL_PAPER',
    paper_research_throughput: false,
    decision_policy_version: 'p1',
    execution_cost_model_version: 'c1',
    plan_b_ensemble_strategy_route: 'TREND_CONTINUATION',
    market_data_bar_time: '2026-10-12T01:00:00Z',
  };

  beforeAll(async () => {
    client = new Client({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    await client.connect();
    await client.query(`
      CREATE TEMP TABLE audit_connections (id uuid, user_id uuid, broker_id text,
        deleted_at timestamptz, account_currency text);
      CREATE TEMP TABLE audit_intents (id uuid, user_id uuid, broker_connection_id uuid,
        instrument text, direction text, metadata jsonb, status text,
        signal_generated_at timestamptz, stop_loss numeric, take_profit numeric, model_version text);
      CREATE TEMP TABLE audit_trades (id uuid, trade_intent_id uuid, order_id uuid,
        user_id uuid, broker_connection_id uuid, instrument text, direction text,
        lot_size numeric, fill_price numeric, stop_loss numeric, take_profit numeric,
        exit_price numeric, realised_pnl numeric, commission numeric, swap numeric,
        trailing_stop_pips numeric, external_order_id text, external_position_id text,
        status text, close_reason text, opened_at timestamptz, closed_at timestamptz,
        account_currency text);
      CREATE TEMP TABLE audit_orders (id uuid, user_id uuid, broker_connection_id uuid,
        trade_id uuid, instrument text, direction text, status text, filled_quantity numeric,
        avg_fill_price numeric);
      CREATE TEMP TABLE audit_states (connection_id uuid, state jsonb);
      CREATE TEMP TABLE audit_shadows (id uuid, user_id uuid, broker_connection_id uuid,
        instrument text, direction text, engine_code text, model_version text,
        entry_price numeric, market_bar_time timestamptz, evaluated_at timestamptz,
        execution_authority text, components jsonb);
    `);
  });

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE audit_connections, audit_intents, audit_trades,
      audit_orders, audit_states, audit_shadows`);
    await client.query('INSERT INTO audit_connections VALUES ($1,$2,$3,NULL,$4)', [
      connection,
      user,
      'paper-broker',
      'USD',
    ]);
    await client.query(
      `INSERT INTO audit_intents VALUES
      ($1,$2,$3,'EURUSD','BUY',$4::jsonb,'EXECUTED','2026-10-12T01:05:00Z',1.099,1.102,'m1')`,
      [trade, user, connection, JSON.stringify(metadata)],
    );
    await client.query(
      `INSERT INTO audit_trades VALUES
      ($1,$1,$2,$3,$4,'EURUSD','BUY',0.1,1.1,1.099,1.102,1.1002,2,0,0,NULL,
        'provider-1',NULL,'CLOSED','PROFIT_PROTECTION','2026-10-12T01:05:00Z','2026-10-12T01:10:00Z','USD')`,
      [trade, order, user, connection],
    );
    await client.query(
      `INSERT INTO audit_orders VALUES ($1,$2,$3,$4,'EURUSD','BUY','FILLED',0.1,1.1)`,
      [order, user, connection, trade],
    );
    await client.query(`INSERT INTO audit_states VALUES ($1,$2::jsonb)`, [
      connection,
      JSON.stringify({ closedTrades: [], positions: [] }),
    ]);
    await client.query(
      `INSERT INTO audit_shadows VALUES
      ($1,$2,$3,'EURUSD','BUY','irexpro-multimodel-ensemble-v1','p1',1.1,
        '2026-10-12T01:00:00Z','2026-10-12T01:05:00Z','PAPER_ONLY',$4::jsonb)`,
      [
        trade,
        user,
        connection,
        JSON.stringify({
          stopLoss: 1.099,
          strategyRoute: 'TREND_CONTINUATION',
          paperPostLossEntryGuard: { reason: 'NO_PREVIOUS_CLOSE' },
          governance: {
            costModelVersion: 'c1',
            executionSpreadEvidenceValid: true,
            executionSpreadEvidence: { spreadPrice: 0.00001 },
          },
        }),
      ],
    );
  });

  function audit(connectionId = connection) {
    const scopedClient = {
      query: (sql: string, params: unknown[]) =>
        client.query(
          sql
            .replaceAll('broker.broker_connections', 'pg_temp.audit_connections')
            .replaceAll('broker.paper_broker_states', 'pg_temp.audit_states')
            .replaceAll('trading.trade_intents', 'pg_temp.audit_intents')
            .replaceAll('trading.trades', 'pg_temp.audit_trades')
            .replaceAll('trading.orders', 'pg_temp.audit_orders')
            .replaceAll('trading.ensemble_shadow_decisions', 'pg_temp.audit_shadows'),
          params,
        ),
    };
    return runPaperPayoffAudit({
      client: scopedClient,
      helpers,
      paperMarketSpecs: PAPER_MARKET_SPECS,
      userId: user,
      connectionId,
      since: '2026-10-11T00:00:00Z',
    });
  }

  it('executes the complete audit SQL and links only proven fills to the matching shadow bar', async () => {
    const report = await audit();
    expect(report.realised[0].totals.reportedRealisedPnl).toBe(2);
    expect(report.realised[0].payoff.meanRealisedR).toBeCloseTo(0.2);
    expect(report.exitShadows[0].cohort.executionRoute).toBe('NORMAL_PAPER');
    expect(report.activity.executedTrades).toBe(1);
    expect(report.activity.decisions).toBe(1);
  });

  it('does not read the outcomes of an unowned or non-PAPER connection', async () => {
    await expect(audit(other)).rejects.toThrow('PAPER_SCOPE_UNAVAILABLE');
    await client.query("UPDATE audit_connections SET broker_id='metaapi'");
    await expect(audit()).rejects.toThrow('PAPER_SCOPE_UNAVAILABLE');
  });

  it('refuses R reconstruction when the entry order belongs to another user', async () => {
    await client.query('UPDATE audit_orders SET user_id=$1', [other]);
    const report = await audit();
    expect(report.realised[0].totals.reportedRealisedPnl).toBe(2);
    expect(report.realised[0].payoff.eligibleTrades).toBe(0);
  });

  it('labels filled partial closes as unproven full-size realised R', async () => {
    await client.query(
      `INSERT INTO audit_orders VALUES
      ($1,$2,$3,$4,'EURUSD','SELL','FILLED',0.05,1.1002)`,
      [other, user, connection, trade],
    );
    const report = await audit();
    expect(report.realised[0].payoff.eligibleTrades).toBe(0);
    expect(report.realised[0].totals.reportedRealisedPnl).toBe(2);
  });

  it('does not classify rejected or pending trade records as executed shadow links', async () => {
    await client.query("UPDATE audit_trades SET status='PENDING'");
    const report = await audit();
    expect(report.realised).toEqual([]);
    expect(report.exitShadows[0].cohort.executionRoute).toBe('SHADOW_UNLINKED');
  });

  it('preserves the immutable trade currency when the connection currency differs', async () => {
    await client.query("UPDATE audit_trades SET account_currency='EUR'");
    const report = await audit();
    expect(report.realised[0].cohort.accountCurrency).toBe('EUR');
    expect(report.realised[0].payoff.eligibleTrades).toBe(0);
  });

  it('refuses R for a single breakeven partial close with a remaining provider position', async () => {
    await client.query('UPDATE audit_trades SET exit_price=fill_price, realised_pnl=0');
    await client.query('UPDATE audit_states SET state=$1::jsonb', [
      JSON.stringify({
        positions: [{ positionId: 'provider-1' }],
        closedTrades: [{ externalOrderId: 'provider-1', lotSize: '0.05' }],
      }),
    ]);
    const report = await audit();
    expect(report.realised[0].payoff.eligibleTrades).toBe(0);
  });

  it('refuses R when neither provider order nor position identity is known', async () => {
    await client.query('UPDATE audit_trades SET external_order_id=NULL, external_position_id=NULL');
    const report = await audit();
    expect(report.realised[0].payoff.eligibleTrades).toBe(0);
  });
});
