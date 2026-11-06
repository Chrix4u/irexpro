-- RESEARCH ONLY: extended 14-day, 16-minute fixed UTC bin sampling.
-- Preserve quoted original stop/target and all fail-closed ambiguity.
-- No outcome, risk score, admission status or predicted return can
-- influence which sample is selected from each time bucket.
-- Older broker-native closed M1 bars lack the observed last-quote
-- timestamp. For an already COMPLETE minute only, use 59.999 sec
-- as a CANDLE-END PROXY, never as a fabricated live tick timestamp.
-- Preserve this provenance in every sample; cannot infer exact fills.
-- Extended candidate technical features are whitelisted as-of-decision
-- numeric fields; no future price/path field is a predictive input.
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
   AND d.evaluated_at >= NOW()-INTERVAL '14 days'
   AND d.evaluated_at <= NOW()-INTERVAL '36 minutes'
), eligible_bar_leaders AS (
 -- Anchor each pair to a fixed 16-minute UTC bucket and keep the
 -- earliest valid candidate per pair/bucket, regardless of its model
 -- score, hindsight label, side or route. Python subsequently applies
 -- its >15-minute as-of independent de-overlap rule.
 -- The fixed bin is a precommitted sampling policy, not an optimization.
 SELECT *, ROW_NUMBER() OVER (
   PARTITION BY instrument, FLOOR(EXTRACT(EPOCH FROM evaluated_at)/960)::bigint
   ORDER BY evaluated_at, direction, route
 ) AS pair_bucket_rank
 FROM candidate_ranked
 WHERE same_bar_rank=1
   AND candidate->>'stopDistance' ~ '^[0-9]+(\.[0-9]+)?$'
   AND candidate->>'targetDistance' ~ '^[0-9]+(\.[0-9]+)?$'
), candidates AS (
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
   candidate->>'alignedEmaSeparationAtr' AS aligned_ema_sep_atr,
   candidate->>'alignedEmaSlopeAtr' AS aligned_ema_slope_atr,
   candidate->>'alignedM5Momentum3Atr' AS aligned_m5_momentum3_atr,
   candidate->>'alignedMomentum3Atr' AS aligned_momentum3_atr,
   candidate->>'alignedM30DirectionalEfficiency' AS aligned_m30_efficiency,
   candidate->>'alignedHigherTimeframeAgreement' AS aligned_higher_timeframe_agreement,
   candidate->>'alignedM5DirectionalRun' AS aligned_m5_directional_run,
   candidate->>'m5BodyExpansionRatio' AS m5_body_expansion_ratio,
   candidate->>'score' AS candidate_score,
   candidate->>'confidence' AS candidate_confidence,
   candidate->>'directionQuality' AS candidate_direction_quality,
   candidate->>'breakoutAtr' AS breakout_atr,
   candidate->>'grossExpectedR' AS gross_expected_r,
   candidate->>'atr' AS atr_raw,
   governance->'multimodelEnsemble'->>'directionQuality' AS ensemble_direction_quality,
   governance->'multimodelEnsemble'->>'tradeQuality' AS ensemble_trade_quality,
   governance->'multimodelEnsemble'->>'exitQuality' AS ensemble_exit_quality,
   governance->'multimodelEnsemble'->>'metaProbability' AS ensemble_meta_probability,
   governance->'multimodelEnsemble'->>'ensembleScore' AS ensemble_score,
   governance->'multimodelEnsemble'->>'sessionQuality' AS ensemble_session_quality,
   governance->'multimodelEnsemble'->>'pairSideQuality' AS ensemble_pair_side_quality,
   COALESCE(governance->'multimodelEnsemble'->'reasons','[]'::jsonb) AS admission_reasons,
   blockers
 FROM eligible_bar_leaders
 WHERE pair_bucket_rank=1
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
 c.aligned_ema_sep_atr,c.aligned_ema_slope_atr,
 c.aligned_m5_momentum3_atr,c.aligned_momentum3_atr,
 c.aligned_m30_efficiency,c.aligned_higher_timeframe_agreement,
 c.aligned_m5_directional_run,c.m5_body_expansion_ratio,
 c.candidate_score,c.candidate_confidence,c.candidate_direction_quality,
 c.breakout_atr,c.gross_expected_r,c.atr_raw,
 c.ensemble_direction_quality,c.ensemble_trade_quality,c.ensemble_exit_quality,
 c.ensemble_meta_probability,c.ensemble_score,c.ensemble_session_quality,
 c.ensemble_pair_side_quality,
 c.admission_reasons::text AS admission_reasons_json,
 c.blockers::text AS blockers_json,
 entry.bid_close AS entry_bid,
 entry.ask_close AS entry_ask,
 entry.effective_quote_timestamp AT TIME ZONE 'UTC' AS entry_seen_utc,
 entry.entry_quote_timestamp_basis,
 COALESCE(path.path,'[]'::jsonb)::text AS minute_path_json
FROM candidates c
JOIN LATERAL (
 SELECT q.bid_close, q.ask_close,
   COALESCE(q.last_quote_sample_at, q.bucket_time + INTERVAL '59.999 seconds')
     AS effective_quote_timestamp,
   CASE WHEN q.last_quote_sample_at IS NULL
     THEN 'COMPLETED_CANDLE_END_PROXY'
     ELSE 'OBSERVED_LAST_QUOTE' END AS entry_quote_timestamp_basis
 FROM market_data.provider_quote_candles q
 WHERE q.connection_id::text=:'source_id'
   AND q.instrument=c.instrument AND q.timeframe='M1'
   AND q.source='ctrader-broker-native'
   AND q.bucket_time < date_trunc('minute',c.evaluated_at)
   AND q.bucket_time >= date_trunc('minute',c.evaluated_at)-INTERVAL '3 minutes'
   AND (
     (q.last_quote_sample_at IS NOT NULL
      AND q.last_quote_sample_at<=c.evaluated_at)
     OR
     (q.last_quote_sample_at IS NULL
      AND q.bucket_time + INTERVAL '1 minute' <= c.evaluated_at
      AND q.first_sample_at>=q.bucket_time
      AND q.first_sample_at<q.bucket_time + INTERVAL '1 minute'
      AND q.sample_count>0)
   )
   AND q.bid_close>0 AND q.ask_close>=q.bid_close
 ORDER BY q.bucket_time DESC
 LIMIT 1
) entry ON TRUE
LEFT JOIN LATERAL (
 SELECT jsonb_agg(jsonb_build_object(
   'minute',q.bucket_time AT TIME ZONE 'UTC',
   'first_seen',q.first_sample_at AT TIME ZONE 'UTC',
   'last_seen',COALESCE(q.last_quote_sample_at,
     q.bucket_time + INTERVAL '59.999 seconds') AT TIME ZONE 'UTC',
   'quote_timestamp_basis', CASE WHEN q.last_quote_sample_at IS NULL
     THEN 'COMPLETED_CANDLE_END_PROXY' ELSE 'OBSERVED_LAST_QUOTE' END,
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
   AND (
     (q.last_quote_sample_at>=q.bucket_time
      AND q.last_quote_sample_at<q.bucket_time+INTERVAL '1 minute')
     OR
     (q.last_quote_sample_at IS NULL AND q.sample_count>0
      AND q.first_sample_at>=q.bucket_time
      AND q.first_sample_at<q.bucket_time+INTERVAL '1 minute')
   )
   AND q.bid_close>0 AND q.ask_close>=q.bid_close
   AND q.high>=q.low AND q.high>0 AND q.low>0
) path ON TRUE
WHERE c.stop_distance_text ~ '^[0-9]+(\.[0-9]+)?$'
  AND c.target_distance_text ~ '^[0-9]+(\.[0-9]+)?$'
ORDER BY c.evaluated_at,c.instrument,c.direction,c.route;
