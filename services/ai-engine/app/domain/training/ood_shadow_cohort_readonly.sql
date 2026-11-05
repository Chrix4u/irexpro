-- RESEARCH ONLY. psql -X --csv -v scanner_user="$VPS_FOREX_SCANNER_USER_ID" \
-- -f services/ai-engine/app/domain/training/ood_shadow_cohort_readonly.sql > /tmp/irexpro-ood-shadow-cohort.csv
--
-- No brokerage identifiers, user IDs, signal IDs, or private credentials exported.
-- Predictions/features were persisted at decision time; quote snapshots were
-- recorded separately by the provider. Entry is the latest fully observed
-- quote BEFORE the decision (never after it), and the 15-minute outcome is
-- the earliest provider quote 15-18 minutes AFTER decision time.
-- This is a spread-inclusive *proxy*, NOT confirmed broker execution/commission.
-- No write statements or new trade authority are possible.

WITH observed AS (
  SELECT d.user_id, d.instrument, d.route, d.direction, d.bar_time,
         d.evaluated_at, d.candidate,
         d.governance->'genericGovernance'->'driftDiagnostics' AS diagnostics,
         ROW_NUMBER() OVER (
           PARTITION BY d.user_id, d.instrument, d.route, d.direction, d.bar_time
           ORDER BY d.evaluated_at ASC, d.id ASC
         ) AS observation_rank
  FROM trading.m1_tactical_decisions d
  JOIN broker.broker_connections bc
    ON bc.id = d.broker_connection_id AND bc.user_id = d.user_id
   AND bc.broker_id = 'ctrader' AND bc.account_type = 'DEMO'
  WHERE d.user_id::text = :'scanner_user'
    AND d.evaluated_at >= NOW() - INTERVAL '35 days'
    AND d.evaluated_at < NOW() - INTERVAL '20 minutes'
    AND d.route IN ('M1_TREND_CONTINUATION', 'M1_EARLY_TRANSITION')
    AND d.instrument IN ('AUDUSD', 'GBPUSD', 'EURUSD')
    AND d.governance->'genericGovernance'->>'driftState' = 'OUT_OF_DISTRIBUTION'
    AND d.candidate->>'entry' IS NOT NULL
    AND d.candidate->>'stopDistance' IS NOT NULL
    AND d.candidate->>'confidence' IS NOT NULL
),
unique_decisions AS (
  SELECT * FROM observed WHERE observation_rank = 1
)
SELECT
  d.instrument, d.route, d.direction,
  d.evaluated_at AT TIME ZONE 'UTC' AS decision_time_utc,
  d.bar_time AT TIME ZONE 'UTC' AS signal_bar_time_utc,
  d.candidate->>'confidence' AS confidence,
  d.candidate->>'score' AS score,
  d.candidate->>'directionQuality' AS direction_quality,
  d.candidate->>'atr' AS atr,
  d.candidate->>'breakoutAtr' AS breakout_atr,
  d.candidate->>'alignedEmaSeparationAtr' AS aligned_ema_separation_atr,
  d.candidate->>'alignedEmaSlopeAtr' AS aligned_ema_slope_atr,
  d.candidate->>'alignedHigherTimeframeAgreement' AS higher_timeframe_agreement,
  d.candidate->>'alignedMomentum1Atr' AS momentum_1_atr,
  d.candidate->>'alignedMomentum3Atr' AS momentum_3_atr,
  d.candidate->>'alignedMomentum5Atr' AS momentum_5_atr,
  d.candidate->>'alignedM5Momentum1Atr' AS m5_momentum_1_atr,
  d.candidate->>'alignedM5Momentum3Atr' AS m5_momentum_3_atr,
  d.candidate->>'alignedM30DirectionalEfficiency' AS m30_efficiency,
  d.candidate->>'alignedM30MomentumAtr' AS m30_momentum_atr,
  d.candidate->>'alignedM5DirectionalRun' AS m5_directional_run,
  d.candidate->>'alignedM5BodyPressure3' AS m5_body_pressure,
  d.candidate->>'m5BodyExpansionRatio' AS m5_body_expansion,
  d.candidate->>'stopDistance' AS stop_distance,
  COALESCE(d.diagnostics, '[]'::jsonb)::text AS diagnostics_json,
  start_quote.bid_close::text AS entry_bid,
  start_quote.ask_close::text AS entry_ask,
  end_quote.bid_close::text AS future_bid_15m,
  end_quote.ask_close::text AS future_ask_15m,
  start_quote.last_quote_sample_at AT TIME ZONE 'UTC' AS entry_observed_at_utc,
  end_quote.last_quote_sample_at AT TIME ZONE 'UTC' AS future_observed_at_utc,
  start_quote.source AS entry_quote_source,
  end_quote.source AS future_quote_source
FROM unique_decisions d
JOIN LATERAL (
  SELECT c.bid_close, c.ask_close, c.last_quote_sample_at, c.source
  FROM market_data.provider_quote_candles c
  WHERE c.instrument = d.instrument AND c.timeframe = 'M1'
    AND c.bucket_time < date_trunc('minute', d.evaluated_at)
    AND c.bucket_time >= date_trunc('minute', d.evaluated_at) - INTERVAL '3 minutes'
    AND c.last_quote_sample_at <= d.evaluated_at
    AND c.bid_close > 0 AND c.ask_close >= c.bid_close
    AND c.last_quote_sample_at IS NOT NULL
  ORDER BY c.bucket_time DESC
  LIMIT 1
) start_quote ON TRUE
JOIN LATERAL (
  SELECT c.bid_close, c.ask_close, c.last_quote_sample_at, c.source
  FROM market_data.provider_quote_candles c
  WHERE c.instrument = d.instrument AND c.timeframe = 'M1'
    AND c.bucket_time >= d.evaluated_at + INTERVAL '15 minutes'
    AND c.bucket_time <= d.evaluated_at + INTERVAL '18 minutes'
    AND c.bid_close > 0 AND c.ask_close >= c.bid_close
    AND c.last_quote_sample_at >= d.evaluated_at + INTERVAL '15 minutes'
  ORDER BY c.bucket_time ASC
  LIMIT 1
) end_quote ON TRUE
ORDER BY d.evaluated_at ASC, d.instrument ASC, d.route ASC, d.direction ASC;
