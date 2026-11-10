import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CTRADER_FAMILY_BROKER_IDS } from '../broker/registry/broker-catalog';
import {
  assessDemoDrawdownAfterExit,
  DEMO_DRAWDOWN_EXIT_AUDIT_ARTIFACT,
  type AfterExitQuoteBar,
} from './demo-drawdown-exit-outcome';

interface AccountRow {
  broker_connection_id: string;
  broker_id: string;
  account_currency: string;
}
interface GuardCloseRow {
  id: string;
  instrument: string;
  direction: 'BUY' | 'SELL';
  closed_at: Date | string;
  stop_loss: string;
  take_profit: string;
  realised_pnl: string;
  commission: string;
  swap: string;
  strategy_route: string | null;
  current_r: string | null;
}

/** Read-only user-scoped evidence, NEVER an execution or stop-amendment service. */
@Injectable()
export class DemoDrawdownExitAuditService {
  constructor(private readonly dataSource: DataSource) {}

  async getUserRetrospective(userId: string) {
    const accounts = (await this.dataSource.query(
      `SELECT b.id AS broker_connection_id, b.broker_id, b.account_currency
       FROM broker.broker_connections b
       JOIN trading.trading_sessions s
         ON s.broker_connection_id = b.id AND s.user_id = b.user_id
       WHERE b.user_id = $1 AND b.account_type = 'DEMO'
         AND b.status = 'CONNECTED' AND b.broker_id = ANY($2::text[])
         AND s.execution_mode = 'FULL_AUTO'
         AND s.started_at >= NOW() - interval '30 days'
       ORDER BY (s.ended_at IS NULL) DESC, s.started_at DESC LIMIT 1`,
      [userId, [...CTRADER_FAMILY_BROKER_IDS]],
    )) as AccountRow[];

    const account = accounts[0];
    const base = {
      artifact: DEMO_DRAWDOWN_EXIT_AUDIT_ARTIFACT,
      executionAuthority: 'NONE' as const,
      modifiesExecution: false as const,
      broker: account?.broker_id ?? null,
      accountCurrency: account?.account_currency ?? null,
      lookbackDays: 14,
      observationHorizonMinutes: 60,
      caveat:
        'Observed broker-native bid/ask one-minute closes after actual guard exits; cannot reproduce intrabar stop/TP ordering, liquidity, broker fill or counterfactual order behavior.',
    };
    if (!account)
      return { ...base, inspected: 0, stopFirst: 0, tpFirst: 0, insufficient: 0, trades: [] };

    const rows = (await this.dataSource.query(
      `WITH eligible AS (
       SELECT DISTINCT ON (t.id)
         t.id, t.instrument, t.direction, t.closed_at,
         t.stop_loss, t.take_profit, t.realised_pnl, t.commission, t.swap,
         ti.metadata->>'multimodel_plan_b_route' AS strategy_route, o.current_r
       FROM trading.trades t
       JOIN broker.broker_connections b
         ON b.id = t.broker_connection_id AND b.user_id = t.user_id
       JOIN trading.trade_intents ti
         ON ti.id = t.trade_intent_id AND ti.user_id = t.user_id
       JOIN trading.post_entry_shadow_observations o
         ON o.trade_id = t.id AND o.user_id = t.user_id
         AND o.execution_broker_connection_id = t.broker_connection_id
       WHERE t.user_id = $1 AND t.broker_connection_id = $2::uuid
         AND t.account_currency = $3 AND b.account_type = 'DEMO'
         AND t.status = 'CLOSED'
         AND t.closed_at >= NOW() - interval '14 days'
         AND t.closed_at <= NOW() - interval '60 minutes'
         AND t.stop_loss IS NOT NULL AND t.take_profit IS NOT NULL
         AND t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL AND t.swap IS NOT NULL
         AND o.artifact = $4 AND o.action = 'CLOSE_DEMO'
       ORDER BY t.id, o.created_at DESC
       ) SELECT * FROM eligible ORDER BY closed_at DESC LIMIT 24`,
      [
        userId,
        account.broker_connection_id,
        account.account_currency,
        'plan-b-v89-demo-5m-drawdown-guard-v1',
      ],
    )) as GuardCloseRow[];

    const trades = [];
    for (const row of rows) {
      const quotes = (await this.dataSource.query(
        `SELECT bucket_time, source, bid_close, ask_close,
           sample_count, positive_quote_sample_count, last_quote_sample_at
         FROM market_data.provider_quote_candles
         WHERE connection_id = $1::uuid AND instrument = $2 AND timeframe = 'M1'
           AND bucket_time >= date_trunc('minute', $3::timestamptz)
           AND bucket_time < $3::timestamptz + interval '60 minutes'
         ORDER BY bucket_time ASC LIMIT 65`,
        [account.broker_connection_id, row.instrument, row.closed_at],
      )) as AfterExitQuoteBar[];
      const assessment = assessDemoDrawdownAfterExit(
        {
          instrument: row.instrument,
          direction: row.direction,
          closedAt: new Date(row.closed_at),
          stopLoss: Number(row.stop_loss),
          takeProfit: Number(row.take_profit),
        },
        quotes,
      );
      const net = Number(row.realised_pnl) + Number(row.commission) + Number(row.swap);
      trades.push({
        instrument: row.instrument,
        direction: row.direction,
        strategyRoute: row.strategy_route,
        closedAt: new Date(row.closed_at).toISOString(),
        actualNetPnl: Number.isFinite(net) ? Math.round(net * 100) / 100 : null,
        guardCheckpointR: row.current_r == null ? null : Number(row.current_r),
        ...assessment,
      });
    }
    // No automatic promotion: not a randomized control group or fill simulator.
    return {
      ...base,
      inspected: trades.length,
      stopFirst: trades.filter((t) => t.classification === 'ORIGINAL_SL_CROSSED_FIRST').length,
      tpFirst: trades.filter((t) => t.classification === 'ORIGINAL_TP_CROSSED_FIRST').length,
      insufficient: trades.filter((t) =>
        ['INSUFFICIENT_QUOTE_COVERAGE', 'INVALID_TRADE', 'AWAITING_FULL_HORIZON'].includes(
          t.classification,
        ),
      ).length,
      trades,
    };
  }
}
