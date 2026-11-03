-- z.ai exit autopsy — corrected to actual staging observation schema, 2026-11-03.
-- READ ONLY. Outcomes are stored in o.state, NOT in o.reason. The latter is
-- 'ORIGINAL_BARRIER_REPLAY'; no row has state='outcome'.
-- Replay follows ORIGINAL TP/SL for 240 minutes after protected exit.
-- It is a hindsight barrier counterfactual, NOT a simulated partial-exit or
-- trailing-stop policy and NOT evidence to promote execution behavior.
-- Ambiguous bars and data gaps are excluded from payoff comparisons.
-- All R estimates are within-trade normalized. Costs, slippage, swap,
-- latency and execution of hypothetical hold are not fully represented.

-- 1. Outcome distribution, by account currency. No USD/EUR mixing.
SELECT t.account_currency AS currency,o.state AS counterfactual_outcome,
 COUNT(*) AS n,
 ROUND(AVG((o.response->>'realised_pnl')::numeric),4) AS avg_protected_exit_pnl,
 ROUND(AVG((o.response->>'actual_exit_r')::numeric),4) AS avg_protected_exit_r
FROM trading.post_entry_shadow_observations o
JOIN trading.trades t ON t.id=o.trade_id
WHERE o.artifact='profit-protection-counterfactual-v1'
  AND o.checkpoint_minutes=240
  AND t.status='CLOSED' AND t.close_reason='PROFIT_PROTECTION'
GROUP BY t.account_currency,o.state ORDER BY currency,n DESC;

-- 2. Route and outcome breakdown: compare the original TP/SL barrier with
-- the actual protected close. A positive delta describes idealized full
-- hold-to-first-barrier upside; NOT a trade-management strategy result.
WITH pp AS (
 SELECT o.state,o.response->>'strategy_route' AS route,
  t.account_currency AS currency,t.instrument,t.direction,
  (o.response->>'realised_pnl')::numeric AS actual_pnl,
  (o.response->>'actual_exit_r')::numeric AS actual_r,
  ABS((o.response->>'original_take_profit')::numeric-t.fill_price) /
    NULLIF(ABS(t.fill_price-(o.response->>'original_stop_loss')::numeric),0)
    AS original_target_r
 FROM trading.post_entry_shadow_observations o
 JOIN trading.trades t ON t.id=o.trade_id
 WHERE o.artifact='profit-protection-counterfactual-v1'
  AND o.checkpoint_minutes=240 AND t.status='CLOSED'
  AND t.close_reason='PROFIT_PROTECTION'
)
SELECT currency,route,state,COUNT(*) AS n,
 ROUND(AVG(actual_pnl),3) AS avg_actual_pnl,
 ROUND(AVG(actual_r),4) AS avg_actual_exit_r,
 ROUND(AVG(original_target_r),4) AS avg_original_tp_r,
 ROUND(AVG(CASE WHEN state='TP_FIRST' THEN original_target_r-actual_r
   WHEN state='SL_FIRST' THEN -1-actual_r ELSE NULL END),4)
   AS hypothetical_hold_delta_r
FROM pp GROUP BY currency,route,state
ORDER BY currency,route,state;

-- 3. The SMALL PROFIT review cohort (positive gross exit <= 6 currency units).
-- Route-specific sign differences are essential: do not aggregate these into
-- a single universal profit-lock policy.
WITH pp AS (
 SELECT o.state,o.response->>'strategy_route' AS route,
  t.account_currency AS currency,
  (o.response->>'realised_pnl')::numeric AS actual_pnl,
  (o.response->>'actual_exit_r')::numeric AS actual_r,
  ABS((o.response->>'original_take_profit')::numeric-t.fill_price) /
    NULLIF(ABS(t.fill_price-(o.response->>'original_stop_loss')::numeric),0)
    AS original_target_r
 FROM trading.post_entry_shadow_observations o
 JOIN trading.trades t ON t.id=o.trade_id
 WHERE o.artifact='profit-protection-counterfactual-v1'
  AND o.checkpoint_minutes=240 AND t.close_reason='PROFIT_PROTECTION'
)
SELECT currency,route,COUNT(*) AS n,
 COUNT(*) FILTER(WHERE state='TP_FIRST') AS n_tp_first,
 COUNT(*) FILTER(WHERE state='SL_FIRST') AS n_sl_first,
 COUNT(*) FILTER(WHERE state NOT IN ('TP_FIRST','SL_FIRST')) AS n_unresolved,
 ROUND(AVG(actual_r),4) AS avg_actual_exit_r,
 ROUND(AVG(CASE WHEN state='TP_FIRST' THEN original_target_r-actual_r
   WHEN state='SL_FIRST' THEN -1-actual_r ELSE NULL END),4)
   AS hypothetical_hold_delta_r
FROM pp WHERE actual_pnl>0 AND actual_pnl<=6
GROUP BY currency,route ORDER BY currency,route;

-- 4. Exit-R conditional diagnostic (not a true MFE conditional trajectory).
-- A policy-grid backtest must replay intra-trade OHLC + position state before
-- any partial scale-out, fixed plateau or ATR trail can be parameterized.
WITH pp AS (
 SELECT o.state,o.response->>'strategy_route' AS route,
 (o.response->>'actual_exit_r')::numeric AS actual_r,
 ABS((o.response->>'original_take_profit')::numeric-t.fill_price) /
   NULLIF(ABS(t.fill_price-(o.response->>'original_stop_loss')::numeric),0)
   AS original_target_r
 FROM trading.post_entry_shadow_observations o
 JOIN trading.trades t ON t.id=o.trade_id
 WHERE o.artifact='profit-protection-counterfactual-v1'
   AND o.checkpoint_minutes=240 AND t.close_reason='PROFIT_PROTECTION'
), bucketed AS (
 SELECT *,CASE WHEN actual_r<0.25 THEN 1
  WHEN actual_r<0.5 THEN 2 WHEN actual_r<0.75 THEN 3
  WHEN actual_r<1 THEN 4 WHEN actual_r<1.5 THEN 5 ELSE 6 END AS exit_r_bin
 FROM pp
)
SELECT route,exit_r_bin,COUNT(*) AS n,
 COUNT(*) FILTER(WHERE state='TP_FIRST') AS tp_first,
 COUNT(*) FILTER(WHERE state='SL_FIRST') AS sl_first,
 COUNT(*) FILTER(WHERE state NOT IN ('TP_FIRST','SL_FIRST')) AS unresolved,
 ROUND(AVG(CASE WHEN state='TP_FIRST' THEN original_target_r-actual_r
   WHEN state='SL_FIRST' THEN -1-actual_r ELSE NULL END),4)
   AS hypothetical_hold_delta_r
FROM bucketed GROUP BY route,exit_r_bin ORDER BY route,exit_r_bin;
