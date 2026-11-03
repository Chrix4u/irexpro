-- ============================================================================
-- zai-expectancy-decomposition.sql
-- Part of the z.ai independent model/productivity review (2026-11-03).
-- Branch: zai/model-productivity-review-20261102
--
-- Purpose: reproduce every quantitative claim in ZAI_REVIEW_REPORT.md §2.1/§2.2
-- and the companion scenario model directly from the staging database.
-- READ-ONLY. Run with psql against the staging DB as a superadmin/read user.
--
-- Conventions:
--   * trading.trades realised_pnl / commission / swap are decimal strings.
--   * Per-trade risk-at-stop: exact value when sizing inputs were persisted
--     (capital_allocations.sizing_inputs -> finalRiskAtStop); otherwise a
--     documented pip-value approximation is used (see §0 note). Treat
--     approximation-backed R values as estimates.
--   * PAPER rows have commission = 0 and swap = 0 by construction
--     (paper-broker.adapter.ts:2746-2747) — do NOT interpret their
--     realised_pnl as net of real-world costs.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- §0. Cohort definition (matches the brief's aggregate: 588 closed trades)
-- ---------------------------------------------------------------------------
-- WITH cohort AS (
--   SELECT t.*
--   FROM trading.trades t
--   WHERE t.status = 'CLOSED'
--     AND t.realised_pnl IS NOT NULL
--     -- scope to the same staging user / cTrader family connection under review:
--     -- AND t.user_id = $1
-- )
-- Approximation note (used in R-normalized sections):
--   pip_size   = 0.0001 for EURUSD/GBPUSD/AUDUSD/USDCHF, 0.01 for USDJPY/USDCAD
--   pip_value  = pip_size * contract_size(100k) per lot, quote-converted; for a
--   review-grade decomposition the stop-distance R proxy below is sufficient:
--   risk_units ≈ |fill_price - stop_loss| / pip_size  (stop distance in pips)
--   R          = realised_pnl / (stop_pips * pip_value_per_lot * lot_size)
-- When capital_allocations.sizing_inputs.finalRiskAtStop is present, prefer it.

-- ---------------------------------------------------------------------------
-- §1. Headline aggregate (expectancy decomposition)
-- ---------------------------------------------------------------------------
WITH cohort AS (
  SELECT t.*
  FROM trading.trades t
  WHERE t.status = 'CLOSED' AND t.realised_pnl IS NOT NULL
),
seg AS (
  SELECT
    COUNT(*)                                                        AS n_closed,
    COUNT(*) FILTER (WHERE realised_pnl::numeric > 0)               AS wins,
    COUNT(*) FILTER (WHERE realised_pnl::numeric < 0)               AS losses,
    COUNT(*) FILTER (WHERE realised_pnl::numeric = 0)               AS flats,
    SUM(realised_pnl::numeric) FILTER (WHERE realised_pnl::numeric > 0)  AS gross_win,
    SUM(realised_pnl::numeric) FILTER (WHERE realised_pnl::numeric < 0)  AS gross_loss,
    SUM(realised_pnl::numeric)                                      AS net,
    SUM(commission::numeric)                                        AS commission_total,
    SUM(swap::numeric)                                              AS swap_total
  FROM cohort
)
SELECT
  n_closed, wins, losses, flats,
  ROUND(gross_win, 2)                                        AS gross_win,
  ROUND(gross_loss, 2)                                       AS gross_loss,
  ROUND(net, 2)                                              AS net,
  ROUND(wins::numeric / NULLIF(wins + losses, 0), 4)         AS win_rate_resolved,
  ROUND(gross_win / NULLIF(gross_loss, 0), 4)                AS profit_factor,
  ROUND(gross_win / NULLIF(wins, 0), 4)                      AS avg_win,
  ROUND(ABS(gross_loss) / NULLIF(losses, 0), 4)              AS avg_loss,
  ROUND((gross_win / NULLIF(wins, 0)) /
        NULLIF(ABS(gross_loss) / NULLIF(losses, 0), 0), 4)   AS realized_payoff,
  ROUND(net / NULLIF(wins + losses, 0), 4)                   AS expectancy_per_trade,
  ROUND(1 / (1 + (gross_win / NULLIF(wins, 0)) /
        NULLIF(ABS(gross_loss) / NULLIF(losses, 0), 0)), 4)  AS breakeven_win_rate,
  commission_total, swap_total
FROM seg;

-- Expected staging result (from the brief): 588 / 271 / 313 / 4,
-- +1420.85 / -1761.82 / -340.97, PF ~0.81, avg_win ~5.2430, avg_loss ~5.6288.

-- ---------------------------------------------------------------------------
-- §2. Segmentation by close reason (exit autopsy foundation)
--     close_reason enum: STOP_LOSS_HIT | TAKE_PROFIT_HIT | MANUAL_CLOSE |
--     AI_CLOSE_SIGNAL | PROFIT_PROTECTION | KILL_SWITCH_FORCE_CLOSE |
--     BROKER_CLOSE | STRATEGY_CUTOVER | RECONCILIATION  (trade.entity.ts:24-34)
--     Known lossiness: DEMO time-stop closes arrive as AI_CLOSE_SIGNAL
--     (reconciliation-resolution.service.ts:214) and provider MANUAL/SYSTEM as
--     BROKER_CLOSE — segment with that in mind.
-- ---------------------------------------------------------------------------
WITH cohort AS (
  SELECT * FROM trading.trades
  WHERE status = 'CLOSED' AND realised_pnl IS NOT NULL
)
SELECT
  close_reason,
  COUNT(*)                                                      AS n,
  ROUND(SUM(realised_pnl::numeric), 2)                          AS net,
  ROUND(AVG(realised_pnl::numeric) FILTER (WHERE realised_pnl::numeric > 0), 4) AS avg_win,
  ROUND(AVG(realised_pnl::numeric) FILTER (WHERE realised_pnl::numeric < 0), 4) AS avg_loss,
  ROUND(AVG(NULLIF(max_favorable_pnl::numeric, 0)), 4)          AS avg_mfe,
  ROUND(AVG(NULLIF(max_adverse_pnl::numeric, 0)), 4)            AS avg_mae,
  ROUND(AVG(NULLIF(profit_giveback::numeric, 0)), 4)            AS avg_giveback,
  ROUND(SUM(commission::numeric), 2)                            AS commission,
  ROUND(SUM(swap::numeric), 2)                                  AS swap
FROM cohort
GROUP BY close_reason
ORDER BY net ASC;

-- ---------------------------------------------------------------------------
-- §3. MAE/MFE-based win-truncation audit
--     How much right tail is being harvested by protection exits?
--     MFE is in account units; normalize by the trade's stop distance (pips)
--     times pip value per lot to get MFE-in-R. Uses the approximation above;
--     prefer sizing_inputs where available.
-- ---------------------------------------------------------------------------
WITH cohort AS (
  SELECT
    t.*,
    ABS(t.fill_price::numeric - t.stop_loss::numeric)
      / CASE t.instrument
          WHEN 'USDJPY' THEN 0.01 WHEN 'USDCAD' THEN 0.01
          ELSE 0.0001 END                                            AS stop_pips
  FROM trading.trades t
  WHERE t.status = 'CLOSED' AND t.realised_pnl IS NOT NULL
),
r AS (
  SELECT *,
    max_favorable_pnl::numeric / NULLIF(stop_pips * 10 * lot_size::numeric, 0) AS mfe_r
  FROM cohort
)
SELECT
  width_bucket(mfe_r, ARRAY[0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.6, 2.0, 4.0, 100.0]) AS mfe_bucket,
  COUNT(*)                                                          AS n,
  ROUND(AVG(realised_pnl::numeric), 4)                              AS avg_realised,
  ROUND(AVG(mfe_r), 4)                                              AS avg_mfe_r,
  ROUND(AVG(profit_giveback::numeric / NULLIF(stop_pips * 10 * lot_size::numeric, 0)), 4) AS avg_giveback_r,
  COUNT(*) FILTER (WHERE close_reason = 'PROFIT_PROTECTION')        AS n_profit_protected
FROM r
WHERE mfe_r IS NOT NULL
GROUP BY 1
ORDER BY 1;

-- ---------------------------------------------------------------------------
-- §4. Cost-drag distribution (validates report §2.2 / P2)
--     costR proxy = 1.25 * spread_at_entry_pips / stop_pips
--     (spread evidence per decision lives in the ensemble ledger; for executed
--     trades use the session's P90 spread via provider_quote_candles if joined
--     by (instrument, opened_at), else the paper fixed spec.)
-- ---------------------------------------------------------------------------
WITH cohort AS (
  SELECT
    t.*,
    ABS(t.fill_price::numeric - t.stop_loss::numeric)
      / CASE t.instrument WHEN 'USDJPY' THEN 0.01 WHEN 'USDCAD' THEN 0.01
          ELSE 0.0001 END                                              AS stop_pips
  FROM trading.trades t
  WHERE t.status = 'CLOSED' AND t.realised_pnl IS NOT NULL
)
SELECT
  instrument,
  COUNT(*)                                                   AS n,
  ROUND(AVG(stop_pips), 2)                                   AS avg_stop_pips,
  ROUND((1.25 * 1.0) / NULLIF(AVG(stop_pips), 0), 4)         AS cost_r_at_1pip_spread,
  ROUND((1.25 * 1.2) / NULLIF(AVG(stop_pips), 0), 4)         AS cost_r_at_1_2pip_spread,
  ROUND(AVG(realised_pnl::numeric), 4)                       AS avg_realised
FROM cohort
GROUP BY instrument
ORDER BY cost_r_at_1pip_spread DESC;
