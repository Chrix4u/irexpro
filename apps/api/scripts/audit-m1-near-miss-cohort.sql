-- Read-only research: quote-verified M1 near-miss outcomes (last 6 hours).
-- Run: psql -X -v ON_ERROR_STOP=1 -f apps/api/scripts/audit-m1-near-miss-cohort.sql
-- Requires an explicitly configured, authorized, READ-ONLY database connection.
--
-- This is NOT an approval to place trades. 20-minute calendar-bin leaders
-- are less repetitive than per-minute scans, but are NOT independent samples
-- across adjacent bins, directions, pairs, or correlated markets.
-- All prices are broker-native OHLC mid/proxies, NOT fills. The historical
-- costR is an estimated spread cost and may omit commission, financing,
-- stop slippage, exchange-rate conversion, and partial-fill costs.
-- Stress rows show how easily that assumption can change the conclusion.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH eligible AS (
  SELECT
    t.id,
    t.broker_connection_id,
    t.instrument,
    t.direction,
    t.route,
    t.bar_time,
    t.evaluated_at,
    (t.governance ->> 'netExpectedR')::numeric AS m1_model_net_r,
    (t.governance -> 'multimodelGovernance' ->> 'netExpectedR')::numeric AS planb_model_net_r,
    t.governance -> 'multimodelEnsemble' ->> 'paperAdmitted' AS planb_admitted,
    (t.governance -> 'genericGovernance' ->> 'estimatedExecutionCostR')::numeric AS spread_cost_r,
    (t.candidate ->> 'stopDistance')::numeric AS stop_distance,
    (t.candidate ->> 'targetDistance')::numeric AS target_distance,
    row_number() OVER (
      PARTITION BY
        t.broker_connection_id, t.instrument, t.direction, t.route,
        floor(extract(epoch FROM t.bar_time) / 1200)
      ORDER BY t.bar_time, t.evaluated_at, t.id
    ) AS bin_rank
  FROM trading.m1_tactical_decisions t
  JOIN broker.broker_connections b
    ON b.id = t.broker_connection_id AND b.user_id = t.user_id
  WHERE
    b.broker_id = 'ctrader'
    AND b.account_type = 'DEMO'
    AND t.evaluated_at >= now() - interval '6 hours'
    AND t.evaluated_at < now() - interval '25 minutes'
    AND t.route <> 'ABSTAIN'
    AND t.execution_authority = 'NONE'
    -- The filter is frozen strictly from *decision-time* records.
    AND t.governance ->> 'netExpectedR' ~ '^-?[0-9.]+$'
    AND (t.governance ->> 'netExpectedR')::numeric >= 0.08
    AND t.governance -> 'genericGovernance' ->> 'estimatedExecutionCostR' ~ '^[0-9.]+$'
    AND t.candidate ->> 'stopDistance' ~ '^[0-9.]+$'
    AND t.candidate ->> 'targetDistance' ~ '^[0-9.]+$'
    AND (t.candidate ->> 'stopDistance')::numeric > 0
    AND (t.candidate ->> 'targetDistance')::numeric > 0
),
leaders AS (
  SELECT * FROM eligible WHERE bin_rank = 1
),
paths AS (
  SELECT d.*, q.bars_observed, q.first_bar_time, q.last_bar_time,
    q.first_open, q.last_close, q.first_target_time, q.first_stop_time
  FROM leaders d
  LEFT JOIN LATERAL (
    WITH candles AS (
      SELECT
        bucket_time,
        open, high, low, close,
        first_value(open) OVER (ORDER BY bucket_time) AS entry
      FROM market_data.provider_quote_candles c
      WHERE
        c.connection_id = d.broker_connection_id
        AND c.instrument = d.instrument
        AND c.timeframe = 'M1'
        AND c.source = 'ctrader-broker-native'
        AND c.positive_quote_sample_count > 0
        AND c.last_quote_sample_at >= c.bucket_time
        AND c.last_quote_sample_at < c.bucket_time + interval '1 minute'
        AND c.bucket_time >= d.evaluated_at + interval '1 minute'
        AND c.bucket_time < d.evaluated_at + interval '16 minutes'
    )
    SELECT
      count(*) AS bars_observed,
      min(bucket_time) AS first_bar_time,
      max(bucket_time) AS last_bar_time,
      (array_agg(open ORDER BY bucket_time))[1] AS first_open,
      (array_agg(close ORDER BY bucket_time DESC))[1] AS last_close,
      min(bucket_time) FILTER (
        WHERE CASE
          WHEN d.direction = 'BUY' THEN high >= entry + d.target_distance
          ELSE low <= entry - d.target_distance
        END
      ) AS first_target_time,
      min(bucket_time) FILTER (
        WHERE CASE
          WHEN d.direction = 'BUY' THEN low <= entry - d.stop_distance
          ELSE high >= entry + d.stop_distance
        END
      ) AS first_stop_time
    FROM candles
  ) q ON true
),
graded AS (
  SELECT
    route,
    m1_model_net_r,
    planb_model_net_r,
    planb_admitted,
    CASE
      WHEN bars_observed <> 15
        OR first_bar_time <> evaluated_at + interval '1 minute'
        OR last_bar_time <> evaluated_at + interval '15 minutes'
        OR first_open IS NULL
        OR first_open <= 0 THEN 'DATA_GAP'
      WHEN first_target_time IS NOT NULL
        AND first_target_time = first_stop_time THEN 'AMBIGUOUS_SAME_MINUTE'
      WHEN first_target_time IS NOT NULL
        AND (first_stop_time IS NULL OR first_target_time < first_stop_time) THEN 'TP_FIRST'
      WHEN first_stop_time IS NOT NULL
        AND (first_target_time IS NULL OR first_stop_time < first_target_time) THEN 'SL_FIRST'
      ELSE 'MTM_15M'
    END AS outcome,
    CASE
      WHEN bars_observed <> 15
        OR first_bar_time <> evaluated_at + interval '1 minute'
        OR last_bar_time <> evaluated_at + interval '15 minutes'
        OR first_open IS NULL
        OR first_open <= 0
        OR first_target_time = first_stop_time THEN NULL
      WHEN first_target_time IS NOT NULL
        AND (first_stop_time IS NULL OR first_target_time < first_stop_time)
        THEN target_distance / stop_distance - spread_cost_r
      WHEN first_stop_time IS NOT NULL
        AND (first_target_time IS NULL OR first_stop_time < first_target_time)
        THEN -1 - spread_cost_r
      ELSE
        (CASE WHEN direction = 'BUY' THEN 1 ELSE -1 END)
        * (last_close - first_open) / stop_distance - spread_cost_r
    END AS spread_adjusted_r_proxy
  FROM paths
)
SELECT
  route,
  count(*) AS binned_near_misses,
  count(*) FILTER (WHERE outcome = 'TP_FIRST') AS tp_first,
  count(*) FILTER (WHERE outcome = 'SL_FIRST') AS sl_first,
  count(*) FILTER (WHERE outcome = 'AMBIGUOUS_SAME_MINUTE') AS ambiguous,
  count(*) FILTER (WHERE outcome = 'MTM_15M') AS mark_to_market,
  count(*) FILTER (WHERE outcome = 'DATA_GAP') AS data_gaps,
  count(*) FILTER (WHERE planb_admitted = 'true') AS planb_admitted_at_decision,
  round(avg(m1_model_net_r), 3) AS mean_predicted_m1_net_r,
  round(avg(planb_model_net_r), 3) AS mean_predicted_planb_net_r,
  round(avg(spread_adjusted_r_proxy), 3) AS mean_spread_adjusted_proxy_r,
  -- Additional hypothetical transaction costs are explicitly stress assumptions.
  round(avg(spread_adjusted_r_proxy - 0.10), 3) AS mean_with_extra_010r_cost,
  round(avg(spread_adjusted_r_proxy - 0.20), 3) AS mean_with_extra_020r_cost,
  count(*) FILTER (WHERE spread_adjusted_r_proxy > 0) AS positive_proxy_outcomes
FROM graded
GROUP BY route
ORDER BY binned_near_misses DESC;

COMMIT;
