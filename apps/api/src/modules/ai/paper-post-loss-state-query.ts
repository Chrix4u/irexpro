/** Owner-scoped broker closure truth, including the reconciliation delay. */
export const PAPER_POST_LOSS_STATE_QUERY = `
  WITH owned_connection AS (
    SELECT id FROM broker.broker_connections
    WHERE user_id = $1 AND id = $2 AND broker_id = 'paper-broker'
      AND deleted_at IS NULL
  ), scoped_trades AS (
    SELECT t.*, 'sig-' || ti.signal_id AS client_order_id
    FROM trading.trade_intents ti
    JOIN trading.trades t ON t.trade_intent_id = ti.id
    WHERE ti.user_id = $1 AND ti.broker_connection_id = $2
      AND t.user_id = $1 AND t.broker_connection_id = $2
      AND ti.instrument = $3 AND ti.direction = $4
      AND t.instrument = $3 AND t.direction = $4
      AND ti.metadata->>'signal_source' = 'EXTERNAL_PROVIDER'
      AND ti.metadata->>'external_provider_code' = $5
  ), provider_state AS (
    SELECT ps.state,
      ps.state_version = 1 AND ps.state->>'version' = '1'
        AND jsonb_typeof(ps.state->'positions') = 'array'
        AND jsonb_typeof(ps.state->'closedTrades') = 'array'
        AND jsonb_typeof(ps.state->'orderStates') = 'array' AS valid
    FROM broker.paper_broker_states ps
    JOIN owned_connection oc ON oc.id = ps.connection_id
  ), provider_order_identity AS (
    SELECT order_state->>0 AS external_order_id,
      order_state->1->>'clientOrderId' AS client_order_id
    FROM provider_state ps
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN ps.valid THEN ps.state->'orderStates' ELSE '[]'::jsonb END
    ) AS order_state
    WHERE jsonb_typeof(order_state) = 'array'
      AND jsonb_array_length(order_state) >= 2
      AND NULLIF(order_state->>0, '') IS NOT NULL
      AND NULLIF(order_state->1->>'clientOrderId', '') IS NOT NULL
  ), provider_positions AS (
    SELECT position->>'positionId' AS external_position_id,
      COALESCE(NULLIF(position->>'dedupeKey', ''), poi.client_order_id) AS client_order_id
    FROM provider_state ps
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN ps.valid THEN ps.state->'positions' ELSE '[]'::jsonb END
    ) AS position
    LEFT JOIN provider_order_identity poi
      ON poi.external_order_id = position->>'positionId'
    WHERE NULLIF(position->>'positionId', '') IS NOT NULL
  ), provider_closes AS (
    SELECT DISTINCT ON (poi.client_order_id)
      event->>'externalOrderId' AS external_order_id,
      poi.client_order_id,
      CASE event->>'closeReason'
        WHEN 'SL' THEN 'STOP_LOSS_HIT'
        WHEN 'TP' THEN 'TAKE_PROFIT_HIT'
        WHEN 'PROFIT_LOCK' THEN 'PROFIT_PROTECTION'
        ELSE event->>'closeReason'
      END AS close_reason,
      (event->>'closedAt')::timestamptz AS closed_at
    FROM provider_state ps
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN ps.valid THEN ps.state->'closedTrades' ELSE '[]'::jsonb END
    ) AS event
    JOIN provider_order_identity poi ON poi.external_order_id = event->>'externalOrderId'
    WHERE event->>'instrument' = $3 AND event->>'direction' = $4
      AND event->>'closedAt' IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM provider_positions position
        WHERE position.client_order_id = poi.client_order_id
      )
    ORDER BY poi.client_order_id, (event->>'closedAt')::timestamptz DESC
  ), latest_closed AS (
    SELECT t.id, COALESCE(pc.close_reason, t.close_reason::text) AS close_reason,
      COALESCE(pc.closed_at, t.closed_at) AS closed_at
    FROM scoped_trades t
    LEFT JOIN provider_closes pc ON pc.client_order_id = t.client_order_id
    WHERE pc.closed_at IS NOT NULL OR (t.status = 'CLOSED' AND t.closed_at IS NOT NULL)
    ORDER BY COALESCE(pc.closed_at, t.closed_at) DESC, t.id DESC
    LIMIT 1
  )
  SELECT
    EXISTS (SELECT 1 FROM owned_connection)
      AND (EXISTS (SELECT 1 FROM provider_state WHERE valid)
        OR NOT EXISTS (SELECT 1 FROM scoped_trades))
      AND NOT EXISTS (
        SELECT 1 FROM scoped_trades t
        JOIN provider_positions position ON position.client_order_id = t.client_order_id
        WHERE t.status = 'CLOSED'
      ) AS paper_post_loss_state_available,
    lc.id AS trade_id, lc.close_reason, lc.closed_at,
    CASE WHEN lc.close_reason IN ('STOP_LOSS_HIT', 'SL') THEN EXISTS (
      SELECT 1 FROM trading.trade_intents ti2
      JOIN trading.trades t2 ON t2.trade_intent_id = ti2.id
      WHERE ti2.user_id = $1 AND ti2.broker_connection_id = $2
        AND t2.user_id = $1 AND t2.broker_connection_id = $2
        AND ti2.instrument = $3 AND ti2.direction = $4
        AND t2.instrument = $3 AND t2.direction = $4
        AND ti2.metadata->>'signal_source' = 'EXTERNAL_PROVIDER'
        AND ti2.metadata->>'external_provider_code' = $5
        AND ti2.status = 'EXECUTED' AND t2.status IN ('OPEN', 'CLOSED')
        AND t2.fill_price > 0 AND t2.external_order_id IS NOT NULL
        AND t2.opened_at > lc.closed_at
        AND ti2.signal_generated_at > lc.closed_at
        AND ti2.metadata->>'paper_post_loss_entry_guard_reason'
          IN ('DIRECTION_RECONFIRMED', 'MULTI_EVIDENCE_RECONFIRMED')
        AND ti2.metadata->>'paper_post_loss_entry_guard_last_trade_id' = lc.id::text
    ) ELSE false END AS reconfirmed
  FROM (SELECT 1) anchor LEFT JOIN latest_closed lc ON true
`;
