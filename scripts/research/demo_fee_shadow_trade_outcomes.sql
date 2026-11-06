-- Strictly READ ONLY. The hypothetical cTrader DEMO fee rejection is recorded
-- on the causal M1 decision linked to the actual cTrader broker trade.
-- Never infer profit from rejected/no-trade signals.
BEGIN READ ONLY;
WITH active_demo_scope AS (
  SELECT DISTINCT ON (ts.user_id)
    ts.user_id, ts.broker_connection_id, ts.started_at
  FROM trading.trading_sessions ts
  JOIN broker.broker_connections b
    ON b.id=ts.broker_connection_id AND b.user_id=ts.user_id
  WHERE ts.status='ACTIVE' AND ts.execution_mode='FULL_AUTO'
    AND b.broker_id='ctrader' AND b.account_type='DEMO'
  ORDER BY ts.user_id, ts.authority_generation DESC, ts.started_at DESC
), candidate_and_fill AS (
  SELECT d.instrument, d.evaluated_at,
         d.governance->'demoBrokerCommissionGate'->>'shadowReason' AS hypothetical_fee_reason,
         (d.governance->'demoBrokerCommissionGate'->>'shadowWouldHaveBlocked')::boolean AS would_have_been_fee_vetoed,
         tr.status, tr.close_reason, tr.account_currency,
         tr.realised_pnl, tr.commission, tr.swap,
         CASE WHEN tr.status='CLOSED'
             AND tr.realised_pnl IS NOT NULL
             AND tr.commission IS NOT NULL
             AND tr.swap IS NOT NULL
              THEN tr.realised_pnl - abs(tr.commission) + tr.swap
             ELSE NULL END AS after_cost_net
  FROM trading.m1_tactical_decisions d
  JOIN active_demo_scope s
    ON d.user_id=s.user_id AND d.broker_connection_id=s.broker_connection_id
  LEFT JOIN LATERAL (
    SELECT t.*
    FROM trading.trades t
    WHERE t.trade_intent_id=d.trade_intent_id
      AND t.user_id=d.user_id
      AND t.broker_connection_id=d.broker_connection_id
      AND t.instrument=d.instrument
    ORDER BY t.opened_at DESC NULLS LAST, t.created_at DESC
    LIMIT 1
  ) tr ON TRUE
  WHERE d.evaluated_at >= GREATEST(s.started_at, NOW() - INTERVAL '14 days')
    AND d.governance->'demoBrokerCommissionGate'->>'shadowOnly'='true'
    AND d.governance->'demoBrokerCommissionGate'->>'selectedPrimary'='true'
)
SELECT instrument,
       CASE WHEN would_have_been_fee_vetoed
              THEN 'PREVIOUS_FEE_VETO_WOULD_BLOCK'
            ELSE 'PREVIOUS_FEE_GATE_WOULD_ALLOW' END AS historical_fee_verdict,
       COUNT(*) AS model_decisions,
       COUNT(*) FILTER (WHERE status IS NOT NULL) AS broker_trades_linked,
       COUNT(*) FILTER (WHERE status='OPEN') AS still_open,
       COUNT(*) FILTER (WHERE status='CLOSED') AS closed_trades,
       COUNT(*) FILTER (WHERE status='CLOSED' AND after_cost_net IS NULL) AS incomplete_cost_records,
       COUNT(after_cost_net) AS verified_net_outcomes,
       COUNT(*) FILTER (WHERE after_cost_net > 0) AS profitable_after_fees,
       COUNT(*) FILTER (WHERE after_cost_net < 0) AS losing_after_fees,
       ROUND(SUM(after_cost_net)::numeric,2) AS actual_net_pnl,
       ROUND(SUM(ABS(commission)) FILTER (WHERE after_cost_net IS NOT NULL)::numeric,2) AS actual_commission,
       MIN(account_currency) AS currency
FROM candidate_and_fill
GROUP BY instrument,would_have_been_fee_vetoed
ORDER BY instrument,historical_fee_verdict;
COMMIT;
