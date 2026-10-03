import { EnsembleSleeveEvidence } from './ensemble-governance';

export const ENSEMBLE_OUTCOME_MODEL_VERSION = 'm5-first-hit-72bar-net-r-v1';
export const ENSEMBLE_OUTCOME_HORIZON_BARS = 72;

export interface EnsembleShadowCandle {
  timestamp: Date | string;
  high: string | number;
  low: string | number;
  close: string | number;
}

export interface EnsembleShadowDecisionGeometry {
  direction: 'BUY' | 'SELL';
  marketBarTime: Date | string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  estimatedExecutionCostR: number;
}

export interface EnsembleShadowOutcome {
  version: typeof ENSEMBLE_OUTCOME_MODEL_VERSION;
  status: 'WIN' | 'LOSS' | 'EXPIRED' | 'AMBIGUOUS';
  resolvedAt: string;
  barsObserved: number;
  exitPrice: number | null;
  grossR: number | null;
  netR: number | null;
  reason: 'TAKE_PROFIT_HIT' | 'STOP_LOSS_HIT' | 'HORIZON_EXPIRED' | 'SAME_BAR_SL_TP';
}

function finiteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function directionalR(
  direction: 'BUY' | 'SELL',
  entry: number,
  exit: number,
  riskDistance: number,
): number {
  const delta = direction === 'BUY' ? exit - entry : entry - exit;
  return delta / riskDistance;
}

export function resolveEnsembleShadowOutcome(
  decision: EnsembleShadowDecisionGeometry,
  candles: EnsembleShadowCandle[],
  horizonBars = ENSEMBLE_OUTCOME_HORIZON_BARS,
): EnsembleShadowOutcome | null {
  const marketBarTime = new Date(decision.marketBarTime);
  const entry = finiteNumber(decision.entryPrice);
  const stop = finiteNumber(decision.stopLoss);
  const target = finiteNumber(decision.takeProfit);
  const costR = finiteNumber(decision.estimatedExecutionCostR) ?? 0;
  if (
    !Number.isFinite(marketBarTime.getTime()) ||
    entry == null ||
    stop == null ||
    target == null ||
    horizonBars < 1
  ) {
    return null;
  }

  const riskDistance = Math.abs(entry - stop);
  if (riskDistance <= 0) return null;

  const future = candles
    .map((candle) => ({
      timestamp: new Date(candle.timestamp),
      high: finiteNumber(candle.high),
      low: finiteNumber(candle.low),
      close: finiteNumber(candle.close),
    }))
    .filter(
      (candle) =>
        Number.isFinite(candle.timestamp.getTime()) &&
        candle.timestamp.getTime() > marketBarTime.getTime() &&
        candle.high != null &&
        candle.low != null &&
        candle.close != null,
    )
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
    .slice(0, horizonBars);

  for (let index = 0; index < future.length; index += 1) {
    const candle = future[index]!;
    const stopTouched = decision.direction === 'BUY' ? candle.low! <= stop : candle.high! >= stop;
    const targetTouched =
      decision.direction === 'BUY' ? candle.high! >= target : candle.low! <= target;

    if (stopTouched && targetTouched) {
      return {
        version: ENSEMBLE_OUTCOME_MODEL_VERSION,
        status: 'AMBIGUOUS',
        resolvedAt: candle.timestamp.toISOString(),
        barsObserved: index + 1,
        exitPrice: null,
        grossR: null,
        netR: null,
        reason: 'SAME_BAR_SL_TP',
      };
    }

    if (stopTouched || targetTouched) {
      const exitPrice = targetTouched ? target : stop;
      const grossR = directionalR(decision.direction, entry, exitPrice, riskDistance);
      return {
        version: ENSEMBLE_OUTCOME_MODEL_VERSION,
        status: targetTouched ? 'WIN' : 'LOSS',
        resolvedAt: candle.timestamp.toISOString(),
        barsObserved: index + 1,
        exitPrice,
        grossR,
        netR: grossR - costR,
        reason: targetTouched ? 'TAKE_PROFIT_HIT' : 'STOP_LOSS_HIT',
      };
    }
  }

  if (future.length < horizonBars) return null;

  const last = future[future.length - 1]!;
  const grossR = directionalR(decision.direction, entry, last.close!, riskDistance);
  return {
    version: ENSEMBLE_OUTCOME_MODEL_VERSION,
    status: 'EXPIRED',
    resolvedAt: last.timestamp.toISOString(),
    barsObserved: future.length,
    exitPrice: last.close!,
    grossR,
    netR: grossR - costR,
    reason: 'HORIZON_EXPIRED',
  };
}

function isoWeekKey(value: string): string {
  const date = new Date(value);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function summarizeEnsembleSleeveOutcomes(
  outcomes: EnsembleShadowOutcome[],
): EnsembleSleeveEvidence {
  const resolved = outcomes.filter(
    (outcome) =>
      outcome.status !== 'AMBIGUOUS' && outcome.netR != null && Number.isFinite(outcome.netR),
  );
  const returns = resolved.map((outcome) => outcome.netR as number);
  const grossProfit = returns.filter((value) => value > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(returns.filter((value) => value < 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;

  let sharpe: number | null = null;
  if (returns.length >= 2) {
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance =
      returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    const sd = Math.sqrt(variance);
    sharpe = sd > 0 ? (Math.sqrt(returns.length) * mean) / sd : null;
  }

  // Normalized risk equity: 100 units, 1R = 1 unit. This is a sleeve-health
  // diagnostic, not a substitute for authoritative PAPER account drawdown.
  let equity = 100;
  let peak = 100;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity += value;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  const weekly = new Map<string, number>();
  for (const outcome of resolved) {
    const key = isoWeekKey(outcome.resolvedAt);
    weekly.set(key, (weekly.get(key) ?? 0) + (outcome.netR as number));
  }
  const positiveWindowFraction =
    weekly.size > 0 ? [...weekly.values()].filter((value) => value > 0).length / weekly.size : null;

  return {
    closedTrades: resolved.length,
    profitFactor,
    sharpe,
    maxDrawdown: resolved.length ? maxDrawdown : null,
    positiveWindowFraction,
  };
}
