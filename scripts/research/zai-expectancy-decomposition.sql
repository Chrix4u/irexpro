-- z.ai expectancy decomposition — independently corrected against staging 2026-11-03.
-- READ ONLY. Run only against an explicitly selected staging database.
-- Monetary aggregates MUST remain separate by account_currency.
-- realised_pnl is the recorded P&L before the separately recorded commission.
-- Reconciled net = realised_pnl - ABS(commission) + swap, consistent with
-- execution-read.service.ts. Never subtract an assumed spread a second time.
-- WARNING: these cohorts mix PAPER/DEMO policies and are not model attribution.
-- No identifiers, account rows or execution operations are returned.

-- 1. Reproducible currency-isolated headline, including economic net after fees.
WITH cohort AS (
  SELECT account_currency, realised_pnl::numeric AS gross_pnl,
    ABS(COALESCE(commission,0)::numeric) AS commission_cost,
    COALESCE(swap,0)::numeric AS swap_credit,
    realised_pnl::numeric - ABS(COALESCE(commission,0)::numeric)
      + COALESCE(swap,0)::numeric AS net_pnl
  FROM trading.trades
  WHERE status='CLOSED' AND realised_pnl IS NOT NULL
), summary AS (
  SELECT account_currency,COUNT(*) AS n_closed,
    COUNT(*) FILTER(WHERE gross_pnl>0) AS wins,
    COUNT(*) FILTER(WHERE gross_pnl<0) AS losses,
    COUNT(*) FILTER(WHERE gross_pnl=0) AS flats,
    SUM(gross_pnl) FILTER(WHERE gross_pnl>0) AS gross_win,
    SUM(gross_pnl) FILTER(WHERE gross_pnl<0) AS gross_loss,
    SUM(gross_pnl) AS recorded_realised,
    SUM(commission_cost) AS commission_cost,
    SUM(swap_credit) AS swap_credit,
    SUM(net_pnl) AS net_after_fees,
    SUM(net_pnl) FILTER(WHERE net_pnl>0) AS net_winnings,
    SUM(net_pnl) FILTER(WHERE net_pnl<0) AS net_losses
  FROM cohort GROUP BY account_currency
)
SELECT account_currency,n_closed,wins,losses,flats,
  ROUND(COALESCE(gross_win,0),2) AS gross_wins,
  ROUND(COALESCE(gross_loss,0),2) AS gross_losses,
  ROUND(recorded_realised,2) AS recorded_realised,
  ROUND(commission_cost,2) AS commission_cost,
  ROUND(swap_credit,2) AS swap_credit,
  ROUND(net_after_fees,2) AS net_after_fees,
  ROUND(wins::numeric/NULLIF(n_closed,0),4) AS win_rate_all,
  ROUND(wins::numeric/NULLIF(wins+losses,0),4) AS win_rate_resolved,
  ROUND(gross_win/NULLIF(ABS(gross_loss),0),4) AS realised_profit_factor_before_fees,
  ROUND(net_winnings/NULLIF(ABS(net_losses),0),4) AS economic_profit_factor_after_fees,
  ROUND(gross_win/NULLIF(wins,0),4) AS avg_gross_win,
  ROUND(ABS(gross_loss)/NULLIF(losses,0),4) AS avg_gross_loss,
  ROUND(net_after_fees/NULLIF(n_closed,0),4) AS economic_expectancy_per_trade
FROM summary ORDER BY account_currency;

-- 2. Exit reasons by currency, with gross and commission-aware net separate.
SELECT account_currency,close_reason,
  COUNT(*) AS trades,
  COUNT(*) FILTER(WHERE realised_pnl>0) AS gross_wins,
  COUNT(*) FILTER(WHERE realised_pnl<0) AS gross_losses,
  ROUND(SUM(realised_pnl),2) AS realised_before_fees,
  ROUND(SUM(ABS(COALESCE(commission,0))),2) AS commission_cost,
  ROUND(SUM(COALESCE(swap,0)),2) AS swap_credit,
  ROUND(SUM(realised_pnl-ABS(COALESCE(commission,0))+COALESCE(swap,0)),2) AS net_after_fees,
  ROUND(AVG(max_favorable_pnl),2) AS avg_mfe_account_units,
  ROUND(AVG(max_adverse_pnl),2) AS avg_mae_account_units,
  ROUND(AVG(profit_giveback),2) AS avg_giveback_account_units
FROM trading.trades WHERE status='CLOSED' AND realised_pnl IS NOT NULL
GROUP BY account_currency,close_reason ORDER BY account_currency,net_after_fees;

-- 3. Instrument × side × close-reason segmentation; no currency mixing.
SELECT account_currency,instrument,direction,close_reason,
  COUNT(*) AS trades,
  COUNT(*) FILTER(WHERE realised_pnl>0) AS gross_wins,
  COUNT(*) FILTER(WHERE realised_pnl<0) AS gross_losses,
  ROUND(SUM(realised_pnl-ABS(COALESCE(commission,0))+COALESCE(swap,0)),2) AS net_after_fees
FROM trading.trades WHERE status='CLOSED' AND realised_pnl IS NOT NULL
GROUP BY account_currency,instrument,direction,close_reason
ORDER BY account_currency,net_after_fees ASC;

-- 4. Stop/spread GEOMETRY ONLY, a rough pip-space cost sensitivity.
-- Not broker P90 execution cost, not R-based performance and not qualification.
-- Crucial correction: USDCAD pip = 0.0001 (only JPY here uses 0.01).
-- The trade stop may reflect later management; do not treat as an entry snapshot.
WITH stops AS (
 SELECT account_currency,instrument,
  ABS(fill_price-stop_loss) /
    CASE WHEN instrument='USDJPY' THEN 0.01 ELSE 0.0001 END AS stop_pips
 FROM trading.trades WHERE status='CLOSED' AND realised_pnl IS NOT NULL
 AND fill_price IS NOT NULL AND stop_loss IS NOT NULL
), sample AS (
 SELECT account_currency,instrument,stop_pips,
 CASE WHEN instrument IN ('GBPUSD','USDCAD','USDCHF') THEN 1.2 ELSE 1.0 END
   AS paper_assumed_spread_pips
 FROM stops WHERE stop_pips>0
)
SELECT account_currency,instrument,COUNT(*) AS n,
 ROUND(AVG(stop_pips),2) AS avg_stop_pips,
 ROUND((percentile_cont(0.5) WITHIN GROUP(ORDER BY stop_pips))::numeric,2)
   AS median_stop_pips,
 ROUND(AVG(1.25*paper_assumed_spread_pips/NULLIF(stop_pips,0)),4)
   AS avg_assumed_cost_r,
 ROUND((percentile_cont(0.9) WITHIN GROUP
   (ORDER BY 1.25*paper_assumed_spread_pips/NULLIF(stop_pips,0)))::numeric,4)
   AS p90_assumed_cost_r
FROM sample GROUP BY account_currency,instrument
ORDER BY account_currency,instrument;

-- 5. Actual MFE/MAE per exit reason in the SAME account currency units.
-- Avoid converting account P&L to R via unverified per-pip dollar assumptions.
SELECT account_currency,close_reason,COUNT(*) AS n,
 ROUND(AVG(max_favorable_pnl),2) AS avg_mfe,
 ROUND(AVG(max_adverse_pnl),2) AS avg_mae,
 ROUND(AVG(profit_giveback),2) AS avg_giveback
FROM trading.trades
WHERE status='CLOSED' AND realised_pnl IS NOT NULL
GROUP BY account_currency,close_reason
ORDER BY account_currency,close_reason;
