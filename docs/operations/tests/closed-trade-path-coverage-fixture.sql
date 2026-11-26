-- Synthetic fixture ONLY. Use a newly created disposable database named
-- irexpro_path_coverage_fixture; never run against application data.
\set ON_ERROR_STOP on
SELECT current_database() = 'irexpro_path_coverage_fixture' AS fixture_database \gset
\if :fixture_database
\else
  \echo Refusing non-fixture database
  \quit
\endif
CREATE SCHEMA broker;
CREATE SCHEMA trading;
CREATE SCHEMA audit;
CREATE TABLE broker.broker_connections (id text PRIMARY KEY, user_id text, broker_id text, account_type text);
CREATE TABLE trading.trades (
 id text PRIMARY KEY, user_id text, broker_connection_id text, signal_id text,
 opened_at timestamptz, closed_at timestamptz, status text, external_position_id text,
 external_order_id text, instrument text, direction text, lot_size numeric, fill_price numeric,
 path_observation_count integer, max_favorable_pnl numeric, max_adverse_pnl numeric,
 profit_giveback numeric, path_last_observed_at timestamptz, exit_price numeric,
 realised_pnl numeric, commission numeric, swap numeric
);
CREATE TABLE trading.orders (
 trade_id text, user_id text, broker_connection_id text, order_kind text, status text,
 provider_order_id text, provider_position_id text, instrument text, direction text,
 filled_quantity numeric, avg_fill_price numeric
);
CREATE TABLE audit.audit_logs (
 id text PRIMARY KEY, resource_type text, resource_id text, action text,
 metadata jsonb, created_at timestamptz
);
INSERT INTO broker.broker_connections VALUES ('c','u','pepperstone-ctrader','DEMO');
INSERT INTO trading.trades
(id,user_id,broker_connection_id,signal_id,opened_at,status,external_order_id,instrument,direction,lot_size,fill_price)
VALUES
('ambiguous','u','c','s',now(),'OPEN','11','EURUSD','BUY',1,1.1),
('valid','u','c','s',now(),'OPEN','12','EURUSD','BUY',1,1.1),
('invalid','u','c','s',now(),'OPEN','13','EURUSD','BUY',1,1.1),
('cross-owner','other','c','s',now(),'OPEN','14','EURUSD','BUY',1,1.1),
('foreign-order','u','c','s',now(),'OPEN','15','EURUSD','BUY',1,1.1);
INSERT INTO trading.orders VALUES
('ambiguous','u','c','MARKET','FILLED','11','21','EURUSD','BUY',1,1.1),
('ambiguous','u','c','MARKET','FILLED','11','22','EURUSD','SELL',1,1.1),
('valid','u','c','MARKET','FILLED','12','23','EURUSD','BUY',1,1.1),
('invalid','u','c','MARKET','FILLED','13','0','EURUSD','BUY',1,1.1),
('cross-owner','other','c','MARKET','FILLED','14','24','EURUSD','BUY',1,1.1),
('foreign-order','other','c','MARKET','FILLED','15','25','EURUSD','BUY',1,1.1);

-- Closed-trade telemetry and settlement are independent evidence dimensions.
INSERT INTO trading.trades
(id,user_id,broker_connection_id,signal_id,opened_at,closed_at,status,
 external_position_id,instrument,direction,lot_size,fill_price,
 path_observation_count,max_favorable_pnl,max_adverse_pnl,profit_giveback,
 path_last_observed_at,exit_price,realised_pnl,commission,swap)
VALUES
('complete','u','c','s',now()-interval '1 hour',now()-interval '30 minutes','CLOSED',
 '31','EURUSD','BUY',1,1.1,5,20,-5,2,now()-interval '31 minutes',1.2,18,0,0),
('audit-only','u','c','s',now()-interval '1 hour',now()-interval '30 minutes','CLOSED',
 '32','EURUSD','BUY',1,1.1,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),
('partial','u','c','s',now()-interval '1 hour',now()-interval '10 minutes','CLOSED',
 '33','EURUSD','BUY',1,1.1,2,5,NULL,NULL,now()-interval '9 minutes',1.2,4,0,NULL),
('no-audit','u','c','s',now()-interval '1 hour',now()-interval '1 hour'+interval '2 seconds','CLOSED',
 '34','EURUSD','BUY',1,1.1,0,NULL,NULL,NULL,NULL,1.2,10,0,0);
INSERT INTO audit.audit_logs VALUES
('a-complete','Trade','complete','TRADE_CLOSED',
 '{"source":"SYNTHETIC","pathDiagnosticsSource":"DURABLE","pathDiagnostics":{}}',now()),
('a-only','Trade','audit-only','TRADE_CLOSED',
 '{"source":"SYNTHETIC","pathDiagnosticsSource":"AUDIT_ONLY","pathDiagnostics":{}}',now()),
('a-partial','Trade','partial','TRADE_CLOSED','{"source":"SYNTHETIC"}',now());
