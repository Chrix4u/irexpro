-- READ ONLY. Exactly one private scanner user and source-bound cTrader DEMO account.
-- No IDs/credentials are exported. Preserves original candidate SL and TP distances.
-- Does not assume mid-price OHLC is a side-specific broker high/low.
WITH candidate_ranked AS (
 SELECT
   d.instrument, d.direction, d.route, d.bar_time, d.evaluated_at,
   d.candidate, d.governance, d.blockers,
   ROW_NUMBER() OVER (
     PARTITION BY d.instrument, d.direction, d.route, d.bar_time
     ORDER BY d.evaluated_at, d.id
   ) AS same_bar_rank
 FROM trading.m1_tactical_decisions d
 JOIN broker.broker_connections b
   ON b.id=d.broker_connection_id AND b.user_id=d.user_id
   AND b.broker_id='ctrader' AND b.account_type='DEMO'
 WHERE d.user_id::text=:'scanner_user'
   AND d.broker_connection_id::text=:'source_id'
   AND d.instrument IN ('AUDUSD','EURUSD','GBPUSD')
   AND d.direction IN ('BUY','SELL')
   AND d.route IN (
     'M1_TREND_CONTINUATION','M1_CONFIRMED_REVERSAL','M1_EARLY_TRANSITION'
   )
   AND d.execution_authority='NONE'
   AND d.evaluated_at >= NOW()-INTERVAL '4 days'
   AND d.evaluated_at <= NOW()-INTERVAL '36 minutes'
),
candidates AS (
 SELECT
   instrument,direction,route,evaluated_at,bar_time,
   candidate->>'stopDistance' AS stop_distance_text,
   candidate->>'targetDistance' AS target_distance_text,
   governance->'multimodelEnsemble'->>'strategyRoute' AS planb_route,
   governance->'multimodelEnsemble'->>'paperAdmitted' AS paper_admitted,
   governance->'multimodelGovernance'->>'netExpectedR' AS predicted_net_r,
   governance->'multimodelEnsemble'->>'regime' AS regime_asof,
   governance->'genericGovernance'->>'driftState' AS drift_state_asof,
   governance->'genericGovernance'->>'estimatedExecutionCostR' AS estimated_cost_r_asof,
   COALESCE(governance->'multimodelEnsemble'->'reasons','[]'::jsonb) AS admission_reasons,
   blockers
 FROM candidate_ranked
 WHERE same_bar_rank=1
 -- Keep the most recent bounded cohort; ordering oldest first would
 -- silently omit the active session when historical rows fill the cap.
 ORDER BY evaluated_at DESC,instrument,direction,route
 LIMIT 4500
)
SELECT
 c.instrument,c.direction,c.route,c.planb_route,c.paper_admitted,
 c.evaluated_at AT TIME ZONE 'UTC' AS decision_time_utc,
 c.stop_distance_text AS stop_distance,
 c.target_distance_text AS target_distance,
 c.predicted_net_r,
 c.regime_asof,c.drift_state_asof,c.estimated_cost_r_asof,
 c.admission_reasons::text AS admission_reasons_json,
 c.blockers::text AS blockers_json,
 entry.bid_close AS entry_bid,
 entry.ask_close AS entry_ask,
 entry.last_quote_sample_at AT TIME ZONE 'UTC' AS entry_seen_utc,
 COALESCE(path.path,'[]'::jsonb)::text AS minute_path_json
FROM candidates c
JOIN LATERAL (
 SELECT q.bid_close, q.ask_close, q.last_quote_sample_at
 FROM market_data.provider_quote_candles q
 WHERE q.connection_id::text=:'source_id'
   AND q.instrument=c.instrument AND q.timeframe='M1'
   AND q.source='ctrader-broker-native'
   AND q.bucket_time < date_trunc('minute',c.evaluated_at)
   AND q.bucket_time >= date_trunc('minute',c.evaluated_at)-INTERVAL '3 minutes'
   AND q.last_quote_sample_at <= c.evaluated_at
   AND q.bid_close>0 AND q.ask_close>=q.bid_close
 ORDER BY q.bucket_time DESC
 LIMIT 1
) entry ON TRUE
LEFT JOIN LATERAL (
 SELECT jsonb_agg(jsonb_build_object(
   'minute',q.bucket_time AT TIME ZONE 'UTC',
   'first_seen',q.first_sample_at AT TIME ZONE 'UTC',
   'last_seen',q.last_quote_sample_at AT TIME ZONE 'UTC',
   'mid_high',q.high,'mid_low',q.low,
   'bid_close',q.bid_close,'ask_close',q.ask_close,
   'spread_close',q.spread_close,'sample_count',q.sample_count
 ) ORDER BY q.bucket_time) AS path
 FROM market_data.provider_quote_candles q
 WHERE q.connection_id::text=:'source_id'
   AND q.instrument=c.instrument AND q.timeframe='M1'
   AND q.source='ctrader-broker-native'
   AND q.bucket_time >= date_trunc('minute',c.evaluated_at)
   AND q.bucket_time < date_trunc('minute',c.evaluated_at)+INTERVAL '31 minutes'
   AND q.last_quote_sample_at>=q.bucket_time
   AND q.last_quote_sample_at<q.bucket_time+INTERVAL '1 minute'
   AND q.bid_close>0 AND q.ask_close>=q.bid_close
   AND q.high>=q.low AND q.high>0 AND q.low>0
) path ON TRUE
WHERE c.stop_distance_text ~ '^[0-9]+(\.[0-9]+)?$'
  AND c.target_distance_text ~ '^[0-9]+(\.[0-9]+)?$'
ORDER BY c.evaluated_at,c.instrument,c.direction,c.route;
