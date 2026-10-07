import { EnsembleSleeveEvidence } from './ensemble-governance';

export const ENSEMBLE_OUTCOME_MODEL_VERSION = 'm5-first-hit-72bar-net-r-path-v3';
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

export interface EnsembleProfitProtectionCounterfactual {
  code:
    | 'CLOSE_LOCK_050_GIVEBACK_040'
    | 'CLOSE_LOCK_075_GIVEBACK_050'
    | 'CLOSE_LOCK_100_GIVEBACK_050';
  activationThresholdR: number;
  givebackTriggerR: number;
  activated: boolean;
  activationAt: string | null;
  exitedEarly: boolean;
  exitAt: string | null;
  grossR: number;
  netR: number;
  deltaNetRVsBase: number;
}

export interface EnsemblePostEntryTelemetry {
  maxFavorableR: number;
  maxAdverseR: number;
  maxCloseGivebackR: number;
  peakFavorableAt: string | null;
  reachedHalfR: boolean;
  reachedOneR: boolean;
  gaveBackHalfRToLoss: boolean;
  gaveBackOneRToLoss: boolean;
  profitProtectionCounterfactuals: EnsembleProfitProtectionCounterfactual[];
  methodology: 'COMPLETED_M5_BARS_BEFORE_EXIT_CONSERVATIVE_V1';
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
  postEntryTelemetry: EnsemblePostEntryTelemetry | null;
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

  let maxFavorableR = 0;
  let maxAdverseR = 0;
  let maxCloseGivebackR = 0;
  let peakFavorableAt: string | null = null;
  let maxCompletedCloseR = 0;
  const protectionTrackers = [
    {
      code: 'CLOSE_LOCK_050_GIVEBACK_040' as const,
      activationThresholdR: 0.5,
      givebackTriggerR: 0.4,
      activated: false,
      activationAt: null as string | null,
      exitedEarly: false,
      exitAt: null as string | null,
      grossR: null as number | null,
    },
    {
      code: 'CLOSE_LOCK_075_GIVEBACK_050' as const,
      activationThresholdR: 0.75,
      givebackTriggerR: 0.5,
      activated: false,
      activationAt: null as string | null,
      exitedEarly: false,
      exitAt: null as string | null,
      grossR: null as number | null,
    },
    {
      code: 'CLOSE_LOCK_100_GIVEBACK_050' as const,
      activationThresholdR: 1,
      givebackTriggerR: 0.5,
      activated: false,
      activationAt: null as string | null,
      exitedEarly: false,
      exitAt: null as string | null,
      grossR: null as number | null,
    },
  ];

  const updateCompletedBarPath = (candle: (typeof future)[number]) => {
    const favorablePrice = decision.direction === 'BUY' ? candle.high! : candle.low!;
    const adversePrice = decision.direction === 'BUY' ? candle.low! : candle.high!;
    const favorableR = directionalR(decision.direction, entry, favorablePrice, riskDistance);
    const adverseR = directionalR(decision.direction, entry, adversePrice, riskDistance);
    const closeR = directionalR(decision.direction, entry, candle.close!, riskDistance);
    if (favorableR > maxFavorableR) {
      maxFavorableR = favorableR;
      peakFavorableAt = candle.timestamp.toISOString();
    }
    maxAdverseR = Math.min(maxAdverseR, adverseR);
    maxCloseGivebackR = Math.max(maxCloseGivebackR, maxFavorableR - closeR);
    maxCompletedCloseR = Math.max(maxCompletedCloseR, closeR);

    for (const tracker of protectionTrackers) {
      if (tracker.exitedEarly) continue;
      if (!tracker.activated && maxCompletedCloseR >= tracker.activationThresholdR) {
        tracker.activated = true;
        tracker.activationAt = candle.timestamp.toISOString();
      }
      if (tracker.activated && maxCompletedCloseR - closeR >= tracker.givebackTriggerR) {
        tracker.exitedEarly = true;
        tracker.exitAt = candle.timestamp.toISOString();
        // Conservative close-bar counterfactual: assume exit at the observed
        // completed-bar close, never at an unobserved trailing-stop fill.
        tracker.grossR = closeR;
      }
    }
  };

  const telemetry = (
    status: EnsembleShadowOutcome['status'],
    baseGrossR: number,
  ): EnsemblePostEntryTelemetry => ({
    maxFavorableR,
    maxAdverseR,
    maxCloseGivebackR,
    peakFavorableAt,
    reachedHalfR: maxFavorableR >= 0.5,
    reachedOneR: maxFavorableR >= 1,
    gaveBackHalfRToLoss: status === 'LOSS' && maxFavorableR >= 0.5,
    gaveBackOneRToLoss: status === 'LOSS' && maxFavorableR >= 1,
    profitProtectionCounterfactuals: protectionTrackers.map((tracker) => {
      const grossR = tracker.grossR ?? baseGrossR;
      const netR = grossR - costR;
      const baseNetR = baseGrossR - costR;
      return {
        code: tracker.code,
        activationThresholdR: tracker.activationThresholdR,
        givebackTriggerR: tracker.givebackTriggerR,
        activated: tracker.activated,
        activationAt: tracker.activationAt,
        exitedEarly: tracker.exitedEarly,
        exitAt: tracker.exitAt,
        grossR,
        netR,
        deltaNetRVsBase: netR - baseNetR,
      };
    }),
    methodology: 'COMPLETED_M5_BARS_BEFORE_EXIT_CONSERVATIVE_V1',
  });

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
        postEntryTelemetry: null,
      };
    }

    if (stopTouched || targetTouched) {
      const exitPrice = targetTouched ? target : stop;
      const grossR = directionalR(decision.direction, entry, exitPrice, riskDistance);
      // Do not use the full exit-bar high/low for path telemetry: without tick
      // ordering we cannot know whether that excursion occurred before exit.
      if (targetTouched && grossR > maxFavorableR) {
        maxFavorableR = grossR;
        peakFavorableAt = candle.timestamp.toISOString();
      }
      if (stopTouched) {
        maxAdverseR = Math.min(maxAdverseR, grossR);
        maxCloseGivebackR = Math.max(maxCloseGivebackR, maxFavorableR - grossR);
      }
      const status: EnsembleShadowOutcome['status'] = targetTouched ? 'WIN' : 'LOSS';
      return {
        version: ENSEMBLE_OUTCOME_MODEL_VERSION,
        status,
        resolvedAt: candle.timestamp.toISOString(),
        barsObserved: index + 1,
        exitPrice,
        grossR,
        netR: grossR - costR,
        reason: targetTouched ? 'TAKE_PROFIT_HIT' : 'STOP_LOSS_HIT',
        postEntryTelemetry: telemetry(status, grossR),
      };
    }

    updateCompletedBarPath(candle);
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
    postEntryTelemetry: telemetry('EXPIRED', grossR),
  };
}

export interface EnsembleOutcomeEpisodeObservation {
  evaluatedAt: Date | string;
  outcome: EnsembleShadowOutcome | null;
}

export function collapseEnsembleOutcomeEpisodes(
  observations: EnsembleOutcomeEpisodeObservation[],
): EnsembleShadowOutcome[] {
  const valid = observations
    .map((observation) => ({
      evaluatedAt: new Date(observation.evaluatedAt),
      outcome: observation.outcome,
      resolvedAt: observation.outcome ? new Date(observation.outcome.resolvedAt) : null,
    }))
    .filter(
      (
        observation,
      ): observation is {
        evaluatedAt: Date;
        outcome: EnsembleShadowOutcome;
        resolvedAt: Date;
      } =>
        observation.outcome != null &&
        observation.resolvedAt != null &&
        Number.isFinite(observation.evaluatedAt.getTime()) &&
        Number.isFinite(observation.resolvedAt.getTime()) &&
        observation.resolvedAt.getTime() >= observation.evaluatedAt.getTime(),
    )
    .sort((a, b) => a.evaluatedAt.getTime() - b.evaluatedAt.getTime());

  const episodes: EnsembleShadowOutcome[] = [];
  let activeEpisodeEnd = Number.NEGATIVE_INFINITY;
  for (const observation of valid) {
    const evaluatedAt = observation.evaluatedAt.getTime();
    const resolvedAt = observation.resolvedAt.getTime();
    if (evaluatedAt > activeEpisodeEnd) {
      episodes.push(observation.outcome);
      activeEpisodeEnd = resolvedAt;
      continue;
    }
    activeEpisodeEnd = Math.max(activeEpisodeEnd, resolvedAt);
  }
  return episodes;
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
