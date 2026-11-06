-- Forecast-economics DEMO shadow experiment: read-only broker-fill outcomes.
-- Never infer profitability from unfilled intents, research-only decisions,
-- open positions, or executions missing recorded commission/swap.
BEGIN READ ONLY;

WITH active_demo_scope AS (
  SELECT DISTINCT ON (s.user_id)
    s.user_id, s.broker_connection_id, s.started_at
  FROM trading.trading_sessions s
  JOIN broker.broker_connections b
    ON b.id=s.broker_connection_id AND b.user_id=s.user_id
  WHERE s.status='ACTIVE' AND s.execution_mode='FULL_AUTO'
    AND b.broker_id='ctrader' AND b.account_type='DEMO'
  ORDER BY s.user_id, s.authority_generation DESC, s.started_at DESC
), broker_entries AS (
  SELECT d.instrument, d.direction, d.evaluated_at,
    d.governance->'multimodelAuthority'->>'authorityPath' AS authority_path,
    d.governance->'multimodelAuthority'->'forecastEconomicsShadow' AS forecast_shadow,
    d.governance->'multimodelGovernance'->>'netExpectedR' AS forecast_net_r,
    t.status, t.realised_pnl, t.commission, t.swap, t.account_currency,
    CASE WHEN t.status='CLOSED'
      AND t.realised_pnl IS NOT NULL AND t.commission IS NOT NULL AND t.swap IS NOT NULL
      THEN t.realised_pnl - ABS(t.commission) + t.swap ELSE NULL END AS verified_net
  FROM trading.m1_tactical_decisions d
  JOIN active_demo_scope s
    ON s.user_id=d.user_id AND s.broker_connection_id=d.broker_connection_id
  LEFT JOIN LATERAL (
    SELECT tr.*
    FROM trading.trades tr
    WHERE tr.user_id=d.user_id AND tr.broker_connection_id=d.broker_connection_id
      AND tr.trade_intent_id=d.trade_intent_id AND tr.instrument=d.instrument
    ORDER BY tr.opened_at DESC NULLS LAST, tr.created_at DESC LIMIT 1
  ) t ON TRUE
  WHERE d.evaluated_at >= GREATEST(s.started_at, NOW()-INTERVAL '14 days')
    AND d.execution_authority='BROKER_NATIVE'
    AND d.trade_intent_id IS NOT NULL
    AND d.instrument IN ('AUDUSD','EURUSD','GBPUSD')
    AND d.governance->'multimodelAuthority'->>'authorityPath'
      IN ('FORECAST_SHADOW_CONSENSUS','PRIMARY_PLAN_B','HIGH_CONVICTION_RESCUE')
)
SELECT instrument, direction, authority_path, MIN(account_currency) AS account_currency,
  COUNT(*)::int AS authorized_intents,
  COUNT(*) FILTER (WHERE status IS NULL)::int AS no_broker_fill,
  COUNT(*) FILTER (WHERE status='OPEN')::int AS open_trades,
  COUNT(*) FILTER (WHERE status='CLOSED')::int AS closed_trades,
  COUNT(*) FILTER (WHERE status='CLOSED' AND verified_net IS NULL)::int
    AS missing_net_fee_outcomes,
  COUNT(verified_net)::int AS verified_closed_outcomes,
  COUNT(*) FILTER (WHERE verified_net > 0)::int AS net_wins,
  COUNT(*) FILTER (WHERE verified_net < 0)::int AS net_losses,
  ROUND(SUM(verified_net)::numeric,2) AS verified_net_pnl,
  ROUND(SUM(ABS(commission)) FILTER (WHERE verified_net IS NOT NULL)::numeric,2)
    AS verified_commissions,
  ROUND((
    SUM(verified_net) FILTER (WHERE verified_net > 0) /
    NULLIF(ABS(SUM(verified_net) FILTER (WHERE verified_net < 0)),0)
  )::numeric,3) AS realised_net_profit_factor,
  COUNT(*) FILTER (
    WHERE forecast_shadow->>'activated'='true'
  )::int AS forecast_veto_shadow_admitted
FROM broker_entries
GROUP BY instrument, direction, authority_path
ORDER BY instrument, direction, authority_path;
COMMIT;
