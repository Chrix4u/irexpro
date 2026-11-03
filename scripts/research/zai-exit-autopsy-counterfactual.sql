-- ============================================================================
-- zai-exit-autopsy-counterfactual.sql
-- Part of the z.ai independent model/productivity review (2026-11-03).
-- Branch: zai/model-productivity-review-20261102
--
-- Purpose: answer the review brief's workstream — "Analyze profit-protection
-- exits: after an early protected close, replay whether price later reached
-- the original TP, the original SL, or neither."
--
-- Source tables:
--   trading.trades                          (close_reason, original SL/TP, P&L, MAE/MFE)
--   trading.post_entry_shadow_observations  (artifact 'profit-protection-counterfactual-v1',
--     written by apps/api/src/modules/ai/profit-protection-counterfactual.service.ts:
--     state = outcome, reason ∈ {TP_FIRST, SL_FIRST, NEITHER_4H, AMBIGUOUS_SAME_M1, DATA_GAP},
--     response JSONB carries original_take_profit, original_stop_loss,
--     realised_pnl, actual_exit_r, strategy_route, checkpoint_minutes = 240)
--
-- READ-ONLY.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §1. Counterfactual outcome distribution for profit-protected closes
-- ---------------------------------------------------------------------------
SELECT
  o.reason                                   AS counterfactual_outcome,  -- TP_FIRST / SL_FIRST / NEITHER_4H / AMBIGUOUS_SAME_M1 / DATA_GAP
  COUNT(*)                                   AS n,
  ROUND(AVG((o.response->>'realised_pnl')::numeric), 4)     AS avg_realised_pnl,
  ROUND(AVG((o.response->>'actual_exit_r')::numeric), 4)    AS avg_actual_exit_r,
  ROUND(AVG(((o.response->>'original_take_profit')::numeric
           - (o.response->>'original_stop_loss')::numeric) / NULLIF(ABS(
               (o.response->>'original_take_profit')::numeric
             - (o.response->>'original_stop_loss')::numeric), 0)), 4) AS sanity_ratio
FROM trading.post_entry_shadow_observations o
WHERE o.artifact = 'profit-protection-counterfactual-v1'
  AND o.state = 'outcome'
GROUP BY o.reason
ORDER BY n DESC;

-- ---------------------------------------------------------------------------
-- §2. Counterfactual joined back to the trade (route/instrument/side cohorts)
--     Sanity: the trade's realised P&L at the protected exit vs what the
--     original TP would have delivered (needs the TP fill assumption: exact
--     TP price, i.e. optimistic boundary) and the original SL (pessimistic).
-- ---------------------------------------------------------------------------
WITH pp AS (
  SELECT o.trade_id,
         o.reason,
         (o.response->>'original_take_profit')::numeric AS orig_tp,
         (o.response->>'original_stop_loss')::numeric   AS orig_sl,
         (o.response->>'realised_pnl')::numeric         AS realised_at_protect,
         (o.response->>'actual_exit_r')::numeric        AS actual_exit_r,
         o.response->>'strategy_route'                  AS strategy_route
  FROM trading.post_entry_shadow_observations o
  WHERE o.artifact = 'profit-protection-counterfactual-v1'
    AND o.state = 'outcome'
)
SELECT
  t.instrument,
  t.direction,
  pp.strategy_route,
  pp.reason                                  AS counterfactual_outcome,
  COUNT(*)                                   AS n,
  ROUND(AVG(pp.realised_at_protect), 4)      AS avg_realised_at_protect,
  ROUND(AVG(t.realised_pnl::numeric), 4)     AS avg_trade_realised_pnl,
  ROUND(AVG(t.max_favorable_pnl::numeric), 4) AS avg_mfe_at_protect,
  ROUND(AVG(t.max_adverse_pnl::numeric), 4)  AS avg_mae_at_protect,
  ROUND(AVG(t.profit_giveback::numeric), 4)  AS avg_giveback_at_protect
FROM trading.trades t
JOIN pp ON pp.trade_id = t.id
WHERE t.status = 'CLOSED'
GROUP BY t.instrument, t.direction, pp.strategy_route, pp.reason
ORDER BY t.instrument, pp.strategy_route, pp.reason;

-- ---------------------------------------------------------------------------
-- §3. "Gave back too early?" — the P1 evidence query.
--     For TP_FIRST outcomes: the original TP was reached AFTER the protected
--     close, i.e. the retention ladder harvested a winner that would have paid
--     in full. Report the distribution of (TP distance − protected exit) in R
--     to size the opportunity that P1's partial-scale-out + ATR-trail recovers.
-- ---------------------------------------------------------------------------
WITH pp AS (
  SELECT o.trade_id,
         o.reason,
         (o.response->>'realised_pnl')::numeric AS realised_at_protect,
         (o.response->>'actual_exit_r')::numeric AS actual_exit_r
  FROM trading.post_entry_shadow_observations o
  WHERE o.artifact = 'profit-protection-counterfactual-v1' AND o.state = 'outcome'
),
tp_first AS (
  SELECT pp.*, t.stop_loss::numeric AS sl, t.fill_price::numeric AS entry, t.direction
  FROM pp
  JOIN trading.trades t ON t.id = pp.trade_id
  WHERE pp.reason = 'TP_FIRST'
)
SELECT
  COUNT(*)                                                     AS n_tp_first,
  ROUND(AVG(tp_first.actual_exit_r), 4)                        AS avg_r_harvested,
  -- R actually captured at the protected exit vs 1.6R design (M1) / 1.667R (M5)
  ROUND(AVG(1.6 - tp_first.actual_exit_r), 4)                  AS avg_r_left_on_table_vs_m1_design,
  -- How far the protected exit sat below the peak it saw:
  ROUND(AVG(t.max_favorable_pnl::numeric /
        NULLIF(ABS(t.fill_price::numeric - t.stop_loss::numeric) * 10 * t.lot_size::numeric, 0)
        - tp_first.actual_exit_r), 4)                          AS avg_giveback_r
FROM tp_first tp
JOIN trading.trades t ON t.id = tp.trade_id;

-- ---------------------------------------------------------------------------
-- §4. SL_FIRST / NEITHER_4H: was the early close also loss-avoiding?
--     If SL_FIRST dominates, protection exits are paying for themselves;
--     if NEITHER_4H dominates, the ladder is mostly noise-trading winners.
-- ---------------------------------------------------------------------------
SELECT
  o.reason,
  COUNT(*)                                                     AS n,
  ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1)           AS pct
FROM trading.post_entry_shadow_observations o
WHERE o.artifact = 'profit-protection-counterfactual-v1' AND o.state = 'outcome'
GROUP BY o.reason
ORDER BY pct DESC;
