import { Client } from 'pg';
import { VpsForexSignalCollectorService } from './vps-forex-signal-collector.service';

describe('PAPER post-loss evidence — real PostgreSQL', () => {
  const user = '11111111-1111-1111-1111-111111111111';
  const connection = '22222222-2222-2222-2222-222222222222';
  const loss = '33333333-3333-3333-3333-333333333333';
  const later = '44444444-4444-4444-4444-444444444444';
  const closedAt = '2026-10-12T07:01:12.000Z';
  const lineage = {
    signal_source: 'EXTERNAL_PROVIDER',
    external_provider_code: 'irexpro-multimodel-ensemble-v1',
  };
  let client: Client;

  beforeAll(async () => {
    client = new Client({
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    await client.connect();
    // Temporary tables stay on this connection and cannot disturb other suites.
    await client.query(`
      CREATE TEMP TABLE paper_intents (
        id uuid, user_id uuid, broker_connection_id uuid, instrument text,
        direction text, metadata jsonb, status text, signal_generated_at timestamptz, signal_id text
      );
      CREATE TEMP TABLE paper_trades (
        id uuid, trade_intent_id uuid, user_id uuid, broker_connection_id uuid,
        instrument text, direction text, external_order_id text,
        external_position_id text, status text, close_reason text,
        closed_at timestamptz, fill_price numeric, opened_at timestamptz
      );
      CREATE TEMP TABLE paper_states (connection_id uuid, state_version int, state jsonb);
      CREATE TEMP TABLE paper_connections (id uuid, user_id uuid, broker_id text, deleted_at timestamptz);
    `);
  });

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE paper_intents, paper_trades, paper_states, paper_connections');
    await client.query('INSERT INTO paper_connections VALUES ($1, $2, $3, NULL)', [
      connection,
      user,
      'paper-broker',
    ]);
    await client.query('INSERT INTO paper_states VALUES ($1, 1, $2::jsonb)', [
      connection,
      JSON.stringify({ version: 1, positions: [], closedTrades: [], orderStates: [] }),
    ]);
  });

  async function addTrade(
    id: string,
    options: {
      status?: string;
      intentStatus?: string;
      metadata?: Record<string, unknown>;
      generatedAt?: string;
      tradeUser?: string;
      tradeConnection?: string;
    } = {},
  ) {
    await client.query(
      `INSERT INTO paper_intents VALUES ($1,$2,$3,'USDCAD','SELL',$4::jsonb,$5,$6,$1::text)`,
      [
        id,
        user,
        connection,
        JSON.stringify({ ...lineage, ...options.metadata }),
        options.intentStatus ?? 'EXECUTED',
        options.generatedAt ?? '2026-10-12T07:00:00Z',
      ],
    );
    const status = options.status ?? 'CLOSED';
    await client.query(
      `INSERT INTO paper_trades VALUES
      ($1,$1,$2,$3,'USDCAD','SELL',$4,$4,$5,'STOP_LOSS_HIT',$6,1.37,$7)`,
      [
        id,
        options.tradeUser ?? user,
        options.tradeConnection ?? connection,
        id,
        status,
        status === 'CLOSED' ? closedAt : null,
        options.generatedAt ?? '2026-10-12T07:00:00Z',
      ],
    );
  }

  async function state() {
    const context = {
      dataSource: {
        query: async (sql: string, params: unknown[]) => {
          const scoped = sql
            .replaceAll('trading.trade_intents', 'pg_temp.paper_intents')
            .replaceAll('trading.trades', 'pg_temp.paper_trades')
            .replaceAll('broker.paper_broker_states', 'pg_temp.paper_states')
            .replaceAll('broker.broker_connections', 'pg_temp.paper_connections');
          return (await client.query(scoped, params)).rows;
        },
      },
      logger: {
        warn: (message: string) => {
          throw new Error(message);
        },
      },
    };
    return VpsForexSignalCollectorService.prototype['loadPaperPostLossEntryState'].call(
      context,
      user,
      connection,
      'USDCAD',
      'SELL',
    );
  }

  it('sees a durable SL before the trade reconciler marks the position CLOSED', async () => {
    await addTrade(loss, { status: 'OPEN' });
    await client.query(`UPDATE paper_states SET state = $1::jsonb`, [
      JSON.stringify({
        version: 1,
        orderStates: [[loss, { clientOrderId: 'sig-' + loss }]],
        positions: [],
        closedTrades: [
          {
            externalOrderId: loss,
            instrument: 'USDCAD',
            direction: 'SELL',
            closeReason: 'SL',
            closedAt,
          },
        ],
      }),
    ]);
    expect((await state()).lastClosedTrade).toMatchObject({
      id: loss,
      closeReason: 'STOP_LOSS_HIT',
      reconfirmed: false,
    });
  });

  it('does not let a rejected later intent release the stop-loss guard', async () => {
    await addTrade(loss);
    await addTrade(later, {
      status: 'REJECTED',
      intentStatus: 'REJECTED',
      generatedAt: '2026-10-12T07:05:00Z',
    });
    expect((await state()).lastClosedTrade?.reconfirmed).toBe(false);
  });

  it.each([
    {},
    {
      paper_post_loss_entry_guard_reason: 'DIRECTION_RECONFIRMED',
      paper_post_loss_entry_guard_last_trade_id: later,
    },
  ])('does not infer reconfirmation without evidence for this exact loss: %j', async (metadata) => {
    await addTrade(loss);
    await addTrade(later, { status: 'OPEN', generatedAt: '2026-10-12T07:05:00Z', metadata });
    expect((await state()).lastClosedTrade?.reconfirmed).toBe(false);
  });

  it('allows continued entries after a filled, recorded confirmation of the latest loss', async () => {
    await addTrade(loss);
    await addTrade(later, {
      status: 'OPEN',
      generatedAt: '2026-10-12T07:05:00Z',
      metadata: {
        paper_post_loss_entry_guard_reason: 'DIRECTION_RECONFIRMED',
        paper_post_loss_entry_guard_last_trade_id: loss,
      },
    });
    expect((await state()).lastClosedTrade?.reconfirmed).toBe(true);
  });

  it('does not treat a provider partial close as a fully closed position', async () => {
    await addTrade(loss, { status: 'OPEN' });
    await client.query(`UPDATE paper_states SET state = $1::jsonb`, [
      JSON.stringify({
        version: 1,
        orderStates: [[loss, { clientOrderId: 'sig-' + loss }]],
        positions: [{ positionId: loss, dedupeKey: 'sig-' + loss }],
        closedTrades: [
          {
            externalOrderId: loss,
            instrument: 'USDCAD',
            direction: 'SELL',
            closeReason: 'SL',
            closedAt,
          },
        ],
      }),
    ]);
    expect((await state()).lastClosedTrade).toBeNull();
  });

  it('does not borrow a trade owned by a different user or connection', async () => {
    await addTrade(loss, { tradeUser: later, tradeConnection: later });
    expect((await state()).lastClosedTrade).toBeNull();
  });

  it('holds when existing PAPER positions have lost their durable state', async () => {
    await addTrade(loss, { status: 'OPEN' });
    await client.query('DELETE FROM paper_states');
    expect((await state()).available).toBe(false);
  });

  it('holds when a CLOSED aggregate contradicts a surviving provider position', async () => {
    await addTrade(loss);
    await client.query('UPDATE paper_states SET state=$1::jsonb', [
      JSON.stringify({
        version: 1,
        orderStates: [[loss, { clientOrderId: 'sig-' + loss }]],
        positions: [{ positionId: loss, dedupeKey: 'sig-' + loss }],
        closedTrades: [
          {
            externalOrderId: loss,
            instrument: 'USDCAD',
            direction: 'SELL',
            closeReason: 'SL',
            closedAt,
          },
        ],
      }),
    ]);
    expect((await state()).available).toBe(false);
  });

  it('does not mistake a reused PAPER ID after a campaign reset for an old CLOSED position', async () => {
    await addTrade(loss);
    await addTrade(later, { status: 'OPEN', generatedAt: '2026-10-12T07:05:00Z' });
    await client.query(
      'UPDATE paper_trades SET external_order_id=$1, external_position_id=$1 WHERE id=$2',
      [loss, later],
    );
    await client.query('UPDATE paper_states SET state=$1::jsonb', [
      JSON.stringify({
        version: 1,
        closedTrades: [],
        orderStates: [[loss, { clientOrderId: 'sig-' + later }]],
        positions: [{ positionId: loss, dedupeKey: 'sig-' + later }],
      }),
    ]);
    expect((await state()).available).toBe(true);
    expect((await state()).lastClosedTrade?.id).toBe(loss);
  });

  it('attaches a reused provider close to its current immutable signal identity', async () => {
    await addTrade(later);
    await addTrade(loss, { status: 'OPEN', generatedAt: '2026-10-12T07:05:00Z' });
    await client.query(
      'UPDATE paper_trades SET external_order_id=$1, external_position_id=$1 WHERE id=$2',
      [later, loss],
    );
    await client.query('UPDATE paper_states SET state=$1::jsonb', [
      JSON.stringify({
        version: 1,
        positions: [],
        orderStates: [[later, { clientOrderId: 'sig-' + loss }]],
        closedTrades: [
          {
            externalOrderId: later,
            instrument: 'USDCAD',
            direction: 'SELL',
            closeReason: 'SL',
            closedAt: '2026-10-12T07:10:00Z',
          },
        ],
      }),
    ]);
    expect((await state()).lastClosedTrade?.id).toBe(loss);
  });
});
