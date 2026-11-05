-- Research only: no IDs output, no order path, provider quote proxy not net broker returns.
WITH ranked AS (
  SELECT d.instrument, d.direction, d.route, d.evaluated_at, d.bar_time,
    COALESCE(d.governance->'multimodelEnsemble'->'reasons','[]'::jsonb) AS reasons,
    COALESCE(d.governance->'multimodelEnsemble'->>'strategyRoute','UNKNOWN') AS planb_route,
    COALESCE(d.governance->'multimodelEnsemble'->>'paperAdmitted','false') AS paper_admitted,
    ROW_NUMBER() OVER (PARTITION BY d.instrument,d.direction,d.route,d.bar_time ORDER BY d.evaluated_at,d.id) AS rn
  FROM trading.m1_tactical_decisions d
  JOIN broker.broker_connections b ON b.id=d.broker_connection_id AND b.user_id=d.user_id AND b.account_type='DEMO' AND b.broker_id='ctrader'
  WHERE d.user_id::text = :'scanner_user'
    AND d.broker_connection_id::text = :'source_id'
    AND d.evaluated_at >= NOW()-INTERVAL '35 days'
    AND d.evaluated_at < NOW()-INTERVAL '20 minutes'
    AND d.route <> 'ABSTAIN'
    AND d.direction IN ('BUY','SELL')
    AND d.instrument IN ('AUDUSD','GBPUSD','EURUSD')
    AND d.execution_authority='NONE'
)
SELECT d.instrument,d.direction,d.route,d.planb_route,d.paper_admitted,
       d.reasons::text AS admission_reasons_json,
       d.evaluated_at AT TIME ZONE 'UTC' AS decision_time_utc,
       entry.bid_close AS entry_bid, entry.ask_close AS entry_ask,
       future.bid_close AS future_bid, future.ask_close AS future_ask,
       entry.last_quote_sample_at AT TIME ZONE 'UTC' AS entry_seen_utc,
       future.last_quote_sample_at AT TIME ZONE 'UTC' AS future_seen_utc
FROM ranked d
JOIN LATERAL (
 SELECT q.bid_close,q.ask_close,q.last_quote_sample_at
 FROM market_data.provider_quote_candles q
 WHERE q.connection_id::text=:'source_id' AND q.instrument=d.instrument AND q.timeframe='M1'
 AND q.source='ctrader-broker-native'
 AND q.bucket_time < DATE_TRUNC('minute',d.evaluated_at)
 AND q.bucket_time >= DATE_TRUNC('minute',d.evaluated_at)-INTERVAL '3 minutes'
 AND q.last_quote_sample_at <= d.evaluated_at
 AND q.bid_close>0 AND q.ask_close>=q.bid_close
 ORDER BY q.bucket_time DESC LIMIT 1
) entry ON TRUE
JOIN LATERAL (
 SELECT q.bid_close,q.ask_close,q.last_quote_sample_at
 FROM market_data.provider_quote_candles q
 WHERE q.connection_id::text=:'source_id' AND q.instrument=d.instrument AND q.timeframe='M1'
 AND q.source='ctrader-broker-native'
 AND q.bucket_time >= d.evaluated_at + INTERVAL '15 minutes'
 AND q.bucket_time <= d.evaluated_at + INTERVAL '18 minutes'
 AND q.last_quote_sample_at >= d.evaluated_at + INTERVAL '15 minutes'
 AND q.bid_close>0 AND q.ask_close>=q.bid_close
 ORDER BY q.bucket_time ASC LIMIT 1
) future ON TRUE
WHERE d.rn=1
ORDER BY d.evaluated_at ASC,d.instrument,d.route,d.direction;
