-- Plan-B extended/healthy regime comparison, recorded DEMO M1 timing only.
-- Broker-native point-in-time samples, fully separate from execution.
-- No permissions, orders, broker writes, or trading state modifications.
WITH decisions AS (
 SELECT d.instrument,d.direction,d.route,d.evaluated_at,d.broker_connection_id,
   d.candidate,d.governance->'multimodelEnsemble' plan_b,
   d.governance->'multimodelGovernance' model,
   ROW_NUMBER() OVER (
     PARTITION BY d.broker_connection_id,d.instrument,d.direction,d.bar_time
     ORDER BY d.evaluated_at,d.id
   ) rn
 FROM trading.m1_tactical_decisions d
 JOIN broker.broker_connections b
   ON b.id=d.broker_connection_id AND b.user_id=d.user_id
  AND b.broker_id='ctrader' AND b.account_type='DEMO'
 WHERE d.user_id=:'scanner_user'::uuid
   AND d.instrument IN ('AUDUSD','EURUSD','GBPUSD')
   AND d.route='M1_TREND_CONTINUATION'
   AND d.governance->'routeDecision'->>'eligible'='true'
   AND d.governance->'routeDecision'->>'reason'='TREND_STRUCTURE_ALIGNED'
   AND d.governance->'multimodelGovernance'->>'driftState'='NORMAL'
   AND d.governance->'multimodelEnsemble'->>'regime' IN ('TREND_EXTENDED','TREND_HEALTHY')
   AND d.evaluated_at > now()-interval '96 hours'
   AND d.evaluated_at <= now()-interval '19 minutes'
), eligible AS (
 SELECT * FROM decisions WHERE rn=1
)
SELECT d.instrument,d.direction,d.route,
  d.evaluated_at AS decision_time_utc,
  d.plan_b->>'regime' AS plan_b_regime,
  d.plan_b->>'paperAdmitted' AS plan_b_paper_admitted,
  (d.candidate->>'entry')::numeric AS proposed_entry,
  (d.candidate->>'stopLoss')::numeric AS stop_loss,
  (d.candidate->>'takeProfit')::numeric AS take_profit,
  (d.candidate->>'alignedM5')::numeric AS aligned_m5,
  (d.candidate->>'alignedM15')::numeric AS aligned_m15,
  (d.candidate->>'alignedH1')::numeric AS aligned_h1,
  (d.candidate->>'alignedH4')::numeric AS aligned_h4,
  COALESCE((d.model->'executionSpreadEvidence'->>'spreadPrice')::numeric,0) AS decision_spread,
  e.bid_close AS entry_bid,e.ask_close AS entry_ask,
  e.last_quote_sample_at AS entry_quote_at,
  'ctrader-broker-native' AS entry_quote_source,
  f.bid_close AS future_bid,f.ask_close AS future_ask,
  f.last_quote_sample_at AS future_quote_at,
  'ctrader-broker-native' AS future_quote_source,
  path.min_low AS possible_low,path.max_high AS possible_high,
  path.bar_count AS path_m1_bars,
  lifecycle.first_target_close_at,
  lifecycle.first_stop_close_at,
  lifecycle.first_possible_mid_stop_at,
  lifecycle.last_observed_m1_bar_at
FROM eligible d
JOIN LATERAL (
 SELECT bid_close,ask_close,last_quote_sample_at FROM market_data.provider_quote_candles q
 WHERE q.connection_id=d.broker_connection_id AND q.instrument=d.instrument AND q.timeframe='M1'
   AND q.source='ctrader-broker-native'
   AND q.positive_quote_sample_count>0
   AND q.bid_close>0 AND q.ask_close>=q.bid_close
   AND q.bucket_time>=date_trunc('minute',d.evaluated_at)-interval '2 minutes'
   AND q.bucket_time<date_trunc('minute',d.evaluated_at)
   AND q.last_quote_sample_at<=d.evaluated_at
 ORDER BY q.bucket_time DESC LIMIT 1
) e ON TRUE
JOIN LATERAL (
 SELECT bid_close,ask_close,last_quote_sample_at FROM market_data.provider_quote_candles q
 WHERE q.connection_id=d.broker_connection_id AND q.instrument=d.instrument AND q.timeframe='M1'
   AND q.source='ctrader-broker-native'
   AND q.positive_quote_sample_count>0
   AND q.bid_close>0 AND q.ask_close>=q.bid_close
   AND q.bucket_time>=d.evaluated_at+interval '15 minutes'
   AND q.bucket_time<=d.evaluated_at+interval '17 minutes'
   AND q.last_quote_sample_at>=d.evaluated_at+interval '15 minutes'
 ORDER BY q.bucket_time ASC LIMIT 1
) f ON TRUE
JOIN LATERAL (
 SELECT min(q.low) min_low,max(q.high) max_high,count(*) bar_count
 FROM market_data.provider_quote_candles q
 WHERE q.connection_id=d.broker_connection_id AND q.instrument=d.instrument AND q.timeframe='M1'
   AND q.source='ctrader-broker-native'
   AND q.bucket_time>=date_trunc('minute',d.evaluated_at)
   AND q.bucket_time<date_trunc('minute',d.evaluated_at)+interval '15 minutes'
) path ON TRUE
JOIN LATERAL (
 SELECT
   MIN(q.bucket_time) FILTER (WHERE
     (d.direction='BUY' AND q.bid_close>=(d.candidate->>'takeProfit')::numeric)
     OR (d.direction='SELL' AND q.ask_close<=(d.candidate->>'takeProfit')::numeric)
   ) AS first_target_close_at,
   MIN(q.bucket_time) FILTER (WHERE
     (d.direction='BUY' AND q.bid_close<=(d.candidate->>'stopLoss')::numeric)
     OR (d.direction='SELL' AND q.ask_close>=(d.candidate->>'stopLoss')::numeric)
   ) AS first_stop_close_at,
   MIN(q.bucket_time) FILTER (WHERE
     (d.direction='BUY' AND q.low<=(d.candidate->>'stopLoss')::numeric)
     OR (d.direction='SELL' AND q.high>=(d.candidate->>'stopLoss')::numeric)
   ) AS first_possible_mid_stop_at,
   MAX(q.bucket_time) AS last_observed_m1_bar_at
 FROM market_data.provider_quote_candles q
 WHERE q.connection_id=d.broker_connection_id AND q.instrument=d.instrument
   AND q.timeframe='M1' AND q.source='ctrader-broker-native'
   AND q.positive_quote_sample_count>0 AND q.bid_close>0
   AND q.ask_close>=q.bid_close
   AND q.bucket_time>=date_trunc('minute',d.evaluated_at)
   AND q.bucket_time<=LEAST(
     date_trunc('minute',now())-interval '1 minute',
     date_trunc('minute',d.evaluated_at)+interval '60 minutes'
   )
) lifecycle ON TRUE
ORDER BY d.evaluated_at,d.instrument,d.direction;
