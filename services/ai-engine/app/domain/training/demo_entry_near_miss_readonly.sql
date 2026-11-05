-- PRIVATE RESEARCH ONLY. No write, broker order, model, or risk operation.
-- Requires psql parameter :scanner_user with existing scanner user's UUID.
-- Includes ONLY non-ABSTAIN Plan-B-admitted DEMO signals that were denied
-- order authority. Includes price quotes observed before decision and 5m/15m
-- after; never assumes broker would have filled, or hit its original TP/SL.
-- Historical samples may have been scored under different earlier policies.
WITH ranked AS (
  SELECT
    d.user_id, d.instrument, d.direction, d.route, d.bar_time,
    d.evaluated_at, d.governance, d.blockers,
    ROW_NUMBER() OVER (
      PARTITION BY d.user_id, d.instrument, d.direction, d.route, d.bar_time
      ORDER BY d.evaluated_at ASC, d.id ASC
    ) AS same_bar_rank
  FROM trading.m1_tactical_decisions d
  JOIN broker.broker_connections bc
    ON bc.id = d.broker_connection_id
    AND bc.user_id = d.user_id
    AND bc.broker_id = 'ctrader'
    AND bc.account_type = 'DEMO'
  WHERE d.user_id::text = :'scanner_user'
    AND d.evaluated_at >= NOW() - INTERVAL '35 days'
    AND d.evaluated_at < NOW() - INTERVAL '20 minutes'
    AND d.instrument IN ('AUDUSD', 'EURUSD', 'GBPUSD')
    AND d.route IN (
      'M1_TREND_CONTINUATION', 'M1_EARLY_TRANSITION',
      'M1_CONFIRMED_REVERSAL'
    )
    AND d.direction IN ('BUY', 'SELL')
    AND d.execution_authority = 'NONE'
    AND d.governance->'multimodelEnsemble'->>'paperAdmitted' = 'true'
    AND d.governance->'multimodelAuthority'->>'primaryEngineCode'
      = 'irexpro-multimodel-ensemble-v1'
),
cohort AS (
  SELECT * FROM ranked WHERE same_bar_rank = 1
)
SELECT
  c.instrument, c.direction, c.route AS m1_route,
  c.governance->'multimodelEnsemble'->>'strategyRoute' AS planb_route,
  c.governance->'genericGovernance'->>'driftState' AS drift_state,
  COALESCE(
    c.governance->'demoPrimaryOnlyProbation'->>'chosenAuthorityPath', 'UNKNOWN'
  ) AS chosen_authority_path,
  COALESCE(c.blockers,'[]'::jsonb)::text AS blockers_json,
  c.evaluated_at AT TIME ZONE 'UTC' AS decision_time_utc,
  c.bar_time AT TIME ZONE 'UTC' AS signal_bar_time_utc,
  entry_quote.bid_close AS entry_bid,
  entry_quote.ask_close AS entry_ask,
  entry_quote.last_quote_sample_at AT TIME ZONE 'UTC' AS entry_seen_utc,
  plus5.bid_close AS future_bid_5m,
  plus5.ask_close AS future_ask_5m,
  plus5.last_quote_sample_at AT TIME ZONE 'UTC' AS future_seen_5m_utc,
  plus15.bid_close AS future_bid_15m,
  plus15.ask_close AS future_ask_15m,
  plus15.last_quote_sample_at AT TIME ZONE 'UTC' AS future_seen_15m_utc
FROM cohort c
JOIN LATERAL (
  SELECT q.bid_close,q.ask_close,q.last_quote_sample_at
  FROM market_data.provider_quote_candles q
  WHERE q.instrument = c.instrument AND q.timeframe='M1'
    AND q.source = 'ctrader-broker-native'
    AND q.bucket_time < date_trunc('minute', c.evaluated_at)
    AND q.bucket_time >= date_trunc('minute',c.evaluated_at) - INTERVAL '3 minutes'
    AND q.last_quote_sample_at <= c.evaluated_at
    AND q.bid_close > 0 AND q.ask_close >= q.bid_close
  ORDER BY q.bucket_time DESC LIMIT 1
) entry_quote ON TRUE
JOIN LATERAL (
  SELECT q.bid_close,q.ask_close,q.last_quote_sample_at
  FROM market_data.provider_quote_candles q
  WHERE q.instrument = c.instrument AND q.timeframe='M1'
    AND q.source = 'ctrader-broker-native'
    AND q.bucket_time >= c.evaluated_at + INTERVAL '5 minutes'
    AND q.bucket_time <= c.evaluated_at + INTERVAL '8 minutes'
    AND q.last_quote_sample_at >= c.evaluated_at + INTERVAL '5 minutes'
    AND q.bid_close > 0 AND q.ask_close >= q.bid_close
  ORDER BY q.bucket_time ASC LIMIT 1
) plus5 ON TRUE
JOIN LATERAL (
  SELECT q.bid_close,q.ask_close,q.last_quote_sample_at
  FROM market_data.provider_quote_candles q
  WHERE q.instrument = c.instrument AND q.timeframe='M1'
    AND q.source = 'ctrader-broker-native'
    AND q.bucket_time >= c.evaluated_at + INTERVAL '15 minutes'
    AND q.bucket_time <= c.evaluated_at + INTERVAL '18 minutes'
    AND q.last_quote_sample_at >= c.evaluated_at + INTERVAL '15 minutes'
    AND q.bid_close > 0 AND q.ask_close >= q.bid_close
  ORDER BY q.bucket_time ASC LIMIT 1
) plus15 ON TRUE
ORDER BY c.evaluated_at, c.instrument, c.route, c.direction;
