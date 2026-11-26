-- Read-only operator diagnostic. No broker calls, order actions, or financial writes.
-- Run on the authorized database with psql -X -v ON_ERROR_STOP=1.
-- Output is aggregate only; no user/account/position identifiers.
-- Scope: Pepperstone cTrader DEMO, AI-origin trades opened in the last 48 hours.
-- An exact stored order/position link establishes an identity discrepancy;
-- it does not by itself prove that a live broker snapshot contained the position.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '15s';
SET LOCAL lock_timeout = '2s';

WITH cohort AS (
  SELECT t.*
  FROM trading.trades t
  JOIN broker.broker_connections b ON b.id = t.broker_connection_id
  WHERE b.broker_id = 'pepperstone-ctrader'
    AND b.account_type = 'DEMO'
    AND t.signal_id IS NOT NULL
    AND t.opened_at >= now() - interval '48 hours'
    AND t.status IN ('OPEN', 'CLOSED', 'RECONCILIATION_PENDING')
), evidence AS (
  SELECT t.*,
         o.exact_count, o.native_ref,
         CASE
           WHEN t.external_position_id IS NOT NULL THEN 'NATIVE_POSITION_STORED'
           WHEN o.exact_count = 1 AND o.native_ref <> t.external_order_id
             THEN 'EXACT_LINK_DISTINCT_FROM_ORDER'
           WHEN o.exact_count = 1 THEN 'EXACT_LINK_SAME_AS_ORDER'
           WHEN o.exact_count > 1 THEN 'AMBIGUOUS_LINK'
           WHEN t.external_order_id IS NOT NULL THEN 'ORDER_ONLY_NO_EXACT_LINK'
           ELSE 'NO_REFERENCE'
         END AS identity_class,
         CASE
           WHEN coalesce(t.path_observation_count, 0) <= 0
             AND t.max_favorable_pnl IS NULL AND t.max_adverse_pnl IS NULL
             AND t.profit_giveback IS NULL THEN 'NO_MEASURED_PATH'
           WHEN coalesce(t.path_observation_count, 0) > 0
             AND t.max_favorable_pnl IS NOT NULL AND t.max_adverse_pnl IS NOT NULL
             AND t.profit_giveback IS NOT NULL THEN 'SAMPLES_AND_ALL_METRICS'
           ELSE 'PARTIAL_PATH_EVIDENCE'
         END AS path_class
  FROM cohort t
  LEFT JOIN LATERAL (
    SELECT count(*) AS exact_count, min(o.provider_position_id) AS native_ref
    FROM trading.orders o
    WHERE o.trade_id = t.id AND o.user_id = t.user_id
      AND o.broker_connection_id = t.broker_connection_id
      AND o.order_kind = 'MARKET' AND o.status = 'FILLED'
      AND o.provider_order_id = t.external_order_id
      AND o.provider_position_id ~ '^[1-9][0-9]*$'
      AND o.instrument = t.instrument AND o.direction = t.direction
      AND o.filled_quantity = t.lot_size AND o.avg_fill_price = t.fill_price
  ) o ON true
)
SELECT status, identity_class, path_class, count(*) AS trades,
       count(*) FILTER (
         WHERE status = 'CLOSED' AND
           (exit_price IS NULL OR realised_pnl IS NULL OR commission IS NULL OR swap IS NULL)
       ) AS pending_settlements,
       count(*) FILTER (
         WHERE status = 'CLOSED' AND closed_at < now() - interval '15 minutes' AND
           (exit_price IS NULL OR realised_pnl IS NULL OR commission IS NULL OR swap IS NULL)
       ) AS pending_over_15_minutes,
       count(*) FILTER (
         WHERE status = 'CLOSED' AND closed_at IS NOT NULL
           AND closed_at - opened_at < interval '5 seconds'
       ) AS closed_under_5_seconds,
       count(*) FILTER (
         WHERE path_last_observed_at IS NOT NULL AND closed_at IS NOT NULL
           AND path_last_observed_at > closed_at
       ) AS samples_after_recorded_close
FROM evidence
GROUP BY status, identity_class, path_class
ORDER BY status, identity_class, path_class;

-- Compare the closure audit's recorded path with the current durable columns.
-- An absent audit is kept separate from an audit with no recorded path.
WITH cohort AS (
  SELECT t.*
  FROM trading.trades t
  JOIN broker.broker_connections b ON b.id = t.broker_connection_id
  WHERE b.broker_id = 'pepperstone-ctrader'
    AND b.account_type = 'DEMO'
    AND t.signal_id IS NOT NULL
    AND t.status = 'CLOSED'
    AND t.opened_at >= now() - interval '48 hours'
)
SELECT coalesce(a.source, 'NO_CLOSURE_AUDIT') AS closure_source,
       coalesce(a.path_source, 'UNSPECIFIED') AS audit_path_source,
       count(*) AS trades,
       count(*) FILTER (WHERE a.has_path) AS closure_audit_with_path,
       count(*) FILTER (WHERE coalesce(t.path_observation_count, 0) > 0)
         AS durable_samples_present,
       count(*) FILTER (WHERE a.has_path AND coalesce(t.path_observation_count, 0) <= 0)
         AS audit_path_but_no_durable_samples,
       count(*) FILTER (WHERE t.exit_price IS NULL) AS missing_exit,
       count(*) FILTER (WHERE t.realised_pnl IS NULL) AS missing_pnl,
       count(*) FILTER (WHERE t.commission IS NULL) AS missing_commission,
       count(*) FILTER (WHERE t.swap IS NULL) AS missing_swap
FROM cohort t
LEFT JOIN LATERAL (
  SELECT coalesce(metadata->>'source', 'UNSPECIFIED') AS source,
         metadata->>'pathDiagnosticsSource' AS path_source,
         jsonb_typeof(metadata->'pathDiagnostics') = 'object' AS has_path
  FROM audit.audit_logs
  WHERE resource_type = 'Trade' AND resource_id = t.id::text
    AND action = 'TRADE_CLOSED'
  ORDER BY created_at DESC, id DESC LIMIT 1
) a ON true
GROUP BY 1, 2
ORDER BY 1, 2;

ROLLBACK;
