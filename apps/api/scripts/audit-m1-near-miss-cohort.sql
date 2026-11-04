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
-- Prior p90 broker fees use at most the 40 most recent CLOSED trades before
-- each decision: same DEMO connection, instrument, and account currency.
-- Under five original risk-allocation samples means UNKNOWN, not zero cost.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';

WITH eligible AS (
  SELECT
    t.id,
    t.broker_connection_id,
    b.account_currency AS account_currency,
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
    q.distinct_bars_observed, q.first_open, q.last_close, q.first_target_time, q.first_stop_time,
    fees.prior_fee_samples, fees.prior_p90_fee_r
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
      count(DISTINCT bucket_time) AS distinct_bars_observed,
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
  LEFT JOIN LATERAL (
    SELECT count(*) AS prior_fee_samples,
      percentile_cont(0.9) WITHIN GROUP (ORDER BY fee_r) AS prior_p90_fee_r
    FROM (
      SELECT (abs(h.commission) + greatest(0, -coalesce(h.swap, 0))) /
        nullif(coalesce(
          CASE WHEN a.sizing_inputs ->> 'finalRiskAtStop' ~ '^[0-9]+([.][0-9]+)?$'
            THEN (a.sizing_inputs ->> 'finalRiskAtStop')::numeric END,
          CASE WHEN a.sizing_inputs ->> 'riskAmount' ~ '^[0-9]+([.][0-9]+)?$'
            THEN (a.sizing_inputs ->> 'riskAmount')::numeric END
        ), 0) AS fee_r
      FROM trading.trades h
      LEFT JOIN LATERAL (
        SELECT sizing_inputs FROM trading.capital_allocations ca
        WHERE ca.trade_intent_id = h.trade_intent_id
        ORDER BY ca.created_at DESC LIMIT 1
      ) a ON true
      WHERE h.broker_connection_id = d.broker_connection_id
        AND h.instrument = d.instrument
        AND h.account_currency = d.account_currency
        AND h.status = 'CLOSED'
        AND h.commission IS NOT NULL
        AND h.closed_at < d.evaluated_at
        AND h.closed_at >= d.evaluated_at - interval '21 days'
      ORDER BY h.closed_at DESC LIMIT 40
    ) historic
    WHERE fee_r IS NOT NULL AND fee_r >= 0
  ) fees ON true
),
graded AS (
  SELECT
    route,
    m1_model_net_r,
    planb_model_net_r,
    planb_admitted,
    prior_fee_samples,
    CASE WHEN prior_fee_samples >= 5 THEN prior_p90_fee_r ELSE NULL END AS prior_p90_fee_r,
    CASE
      WHEN bars_observed <> 15
        OR distinct_bars_observed <> 15
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
        OR distinct_bars_observed <> 15
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
  CASE WHEN grouping(planb_admitted) = 1
    THEN 'ALL'
    ELSE coalesce(planb_admitted, 'UNKNOWN')
  END AS planb_admission_at_decision,
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
  round(avg(spread_adjusted_r_proxy) FILTER (
    WHERE prior_fee_samples >= 5 AND prior_p90_fee_r IS NOT NULL
  ), 3) AS mean_spread_proxy_on_fee_evaluable_subset,
  count(*) FILTER (WHERE prior_fee_samples >= 5 AND prior_p90_fee_r IS NOT NULL) AS episodes_with_causal_fee_evidence,
  round(avg(prior_p90_fee_r)::numeric, 3) AS mean_causal_p90_fee_r,
  round(avg(spread_adjusted_r_proxy - prior_p90_fee_r)::numeric, 3) AS mean_with_causal_p90_fees,
  count(*) FILTER (
    WHERE prior_fee_samples >= 5 AND prior_p90_fee_r IS NOT NULL
      AND spread_adjusted_r_proxy > prior_p90_fee_r
  ) AS positive_with_causal_p90_fees,
  -- Additional hypothetical transaction costs are explicitly stress assumptions.
  round(avg(spread_adjusted_r_proxy - 0.10), 3) AS mean_with_extra_010r_cost,
  round(avg(spread_adjusted_r_proxy - 0.20), 3) AS mean_with_extra_020r_cost,
  count(*) FILTER (WHERE spread_adjusted_r_proxy > 0) AS positive_proxy_outcomes
FROM graded
GROUP BY GROUPING SETS ((route), (route, planb_admitted))
ORDER BY route, grouping(planb_admitted) DESC, binned_near_misses DESC;

COMMIT;
