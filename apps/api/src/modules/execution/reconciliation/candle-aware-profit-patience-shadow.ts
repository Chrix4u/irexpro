/**
 * As-of, broker-native M1/M5 analysis for an ALREADY-OPEN DEMO trade at
 * the instant its profit lock requests a close. Research-only: this module
 * neither sends nor delays a broker order and cannot authorize LIVE trading.
 * Any later execution experiment MUST obtain ACK for a fee-positive broker
 * stop BEFORE a bounded 180s hold and independently prove net benefit.
 */
export const CANDLE_AWARE_EXIT_SHADOW_ARTIFACT =
  'irexpro-candle-aware-profit-protection-exit-shadow-v1' as const;

export interface CompletedProfitExitCandle {
  startedAt: Date;
  timeframeMinutes: 1 | 5;
  open: number;
  high: number;
  low: number;
  close: number;
  brokerNativeSampleCount: number;
  // Stored canonical M5 or a bounded, strict aggregation of five COMPLETE
  // source-matched broker-native M1 bars. Derived M5 is not an independent
  // provider feed and never substitutes for the separate trained expert.
  provenance?: 'STORED_BROKER_NATIVE_M5' | 'COMPOSED_FROM_BROKER_NATIVE_M1';
}

/**
 * Construct the latest CLOSED, UTC-aligned M5 bar from five individually
 * completed and as-of-approved broker-native M1 bars. The DB caller must
 * already enforce the original INSERT, most recent UPDATE and last quote
 * timestamps <= decision time for each M1 row. No current forming bar,
 * missing minute, duplicate minute, or provider-less sample is accepted.
 *
 * This solves late M5 materialization without claiming that today's final
 * mutable historical candles were known at earlier decision timestamps.
 */
export function composeAsOfNativeM5FromFiveM1(
  asOf: Date,
  completedAsOfNativeM1: CompletedProfitExitCandle[],
): CompletedProfitExitCandle | null {
  const asOfMillis=asOf.getTime();
  if (!Number.isFinite(asOfMillis)) return null;
  // At 12:15:05, the latest fully closed M5 is 12:10–12:15;
  // at 12:14:59, the latest fully closed M5 is 12:05–12:10.
  const end=Math.floor(asOfMillis/300_000)*300_000;
  const start=end-300_000;
  const relevant=completedAsOfNativeM1.filter(b=>
    b.startedAt instanceof Date && Number.isFinite(b.startedAt.getTime()) &&
    b.startedAt.getTime()>=start && b.startedAt.getTime()<end,
  ).sort((a,b)=>a.startedAt.getTime()-b.startedAt.getTime());
  if(relevant.length!==5) return null;
  let samples=0;
  for(let i=0;i<5;i++) {
    const b=relevant[i]!;
    if(b.timeframeMinutes!==1 || b.startedAt.getTime()!==start+i*60_000 ||
       b.startedAt.getTime()+60_000>asOfMillis ||
       !Number.isSafeInteger(b.brokerNativeSampleCount) ||
       b.brokerNativeSampleCount<1 ||
       ![b.open,b.high,b.low,b.close].every(Number.isFinite) ||
       b.low<=0 || b.low>Math.min(b.open,b.close) ||
       b.high<Math.max(b.open,b.close)) return null;
    samples+=b.brokerNativeSampleCount;
  }
  if(!Number.isSafeInteger(samples) || samples<5) return null;
  return {
    startedAt:new Date(start),timeframeMinutes:5,
    open:relevant[0]!.open,close:relevant[4]!.close,
    high:Math.max(...relevant.map(b=>b.high)),
    low:Math.min(...relevant.map(b=>b.low)),
    brokerNativeSampleCount:samples,
    provenance:'COMPOSED_FROM_BROKER_NATIVE_M1',
  };
}

export type CandleAwareExitReason =
  | 'UNVERIFIED_SCOPE'
  | 'INVALID_RISK_OR_PRICE'
  | 'NOT_MATURE_PROFIT'
  | 'TOO_MUCH_GIVEBACK'
  | 'NO_AS_OF_M1_OR_M5'
  | 'CANDLE_NOT_BROKER_NATIVE_OR_FRESH'
  | 'M1_REVERSAL_OR_WEAK_STRUCTURE'
  | 'M5_OPPOSES_TRADE'
  | 'SAME_DIRECTION_PULLBACK_CANDIDATE';

export interface CandleAwareExitShadowDecision {
  artifact: typeof CANDLE_AWARE_EXIT_SHADOW_ARTIFACT;
  mode: 'SHADOW_ONLY';
  reason: CandleAwareExitReason;
  wouldResearchProtectedGrace: boolean;
  maxGraceSeconds: 180;
  needsBrokerAcknowledgedPositiveStop: true;
  noTradeAuthority: true;
  changesLiveExit: false;
  asOf: string;
  m1CompletedBars: number;
  m5Aligned: boolean | null;
  grossGivebackFraction: number | null;
}

export function evaluateCandleAwareProfitExitShadow(input: {
  brokerId: string;
  accountType: string;
  direction: 'BUY' | 'SELL';
  asOf: Date;
  openedAt: Date;
  entryPrice: number;
  currentPrice: number;
  originalStopPrice: number;
  takeProfitPrice: number;
  grossCurrentPnl: number;
  grossPeakPnl: number;
  initialRiskPnl: number;
  conservativeEstimatedCosts: number | null;
  lastTwoCompletedM1: CompletedProfitExitCandle[];
  lastCompletedM5: CompletedProfitExitCandle | null;
}): CandleAwareExitShadowDecision {
  const reject = (reason: CandleAwareExitReason, m5Aligned: boolean | null = null): CandleAwareExitShadowDecision => ({
    artifact: CANDLE_AWARE_EXIT_SHADOW_ARTIFACT,
    mode: 'SHADOW_ONLY',
    reason,
    wouldResearchProtectedGrace: reason === 'SAME_DIRECTION_PULLBACK_CANDIDATE',
    maxGraceSeconds: 180,
    needsBrokerAcknowledgedPositiveStop: true,
    noTradeAuthority: true,
    changesLiveExit: false,
    asOf: Number.isFinite(input.asOf.getTime()) ? input.asOf.toISOString() : 'INVALID',
    m1CompletedBars: input.lastTwoCompletedM1.length,
    m5Aligned,
    grossGivebackFraction: Number.isFinite(input.grossPeakPnl) && input.grossPeakPnl > 0 && Number.isFinite(input.grossCurrentPnl)
      ? Math.max(0, input.grossPeakPnl - input.grossCurrentPnl) / input.grossPeakPnl
      : null,
  });
  if (input.brokerId !== 'pepperstone-ctrader' || input.accountType !== 'DEMO')
    return reject('UNVERIFIED_SCOPE');
  const nums = [input.asOf.getTime(), input.openedAt.getTime(), input.entryPrice,
    input.currentPrice, input.originalStopPrice, input.takeProfitPrice,
    input.grossCurrentPnl, input.grossPeakPnl, input.initialRiskPnl];
  if (nums.some(n => !Number.isFinite(n)) ||
      input.entryPrice <= 0 || input.currentPrice <= 0 ||
      input.originalStopPrice <= 0 || input.takeProfitPrice <= 0 ||
      input.initialRiskPnl <= 0 || input.grossPeakPnl <= 0 ||
      (input.direction === 'SELL'
        ? !(input.takeProfitPrice < input.currentPrice && input.currentPrice < input.entryPrice && input.entryPrice < input.originalStopPrice)
        : !(input.originalStopPrice < input.entryPrice && input.entryPrice < input.currentPrice && input.currentPrice < input.takeProfitPrice)))
    return reject('INVALID_RISK_OR_PRICE');
  const ageSeconds = (input.asOf.getTime() - input.openedAt.getTime()) / 1000;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 60 || ageSeconds > 900 ||
      input.grossPeakPnl < input.initialRiskPnl * 0.4 ||
      input.grossCurrentPnl <= 0 ||
      input.conservativeEstimatedCosts === null ||
      !Number.isFinite(input.conservativeEstimatedCosts) || input.conservativeEstimatedCosts <= 0 ||
      input.grossCurrentPnl - input.conservativeEstimatedCosts < input.initialRiskPnl * 0.1)
    return reject('NOT_MATURE_PROFIT');
  if ((input.grossPeakPnl - input.grossCurrentPnl) / input.grossPeakPnl > 0.4)
    return reject('TOO_MUCH_GIVEBACK');

  const bars = [...input.lastTwoCompletedM1].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  const m5 = input.lastCompletedM5;
  if (bars.length !== 2 || !m5) return reject('NO_AS_OF_M1_OR_M5');
  const valid = (bar: CompletedProfitExitCandle, tf: 1 | 5, maxAgeSec: number) => {
    const closedAt = bar.startedAt.getTime() + tf * 60_000;
    const ageSec = (input.asOf.getTime() - closedAt) / 1000;
    return bar.timeframeMinutes === tf &&
      [bar.startedAt.getTime(),bar.open,bar.high,bar.low,bar.close].every(Number.isFinite) &&
      bar.brokerNativeSampleCount >= 1 &&
      bar.low > 0 && bar.low <= Math.min(bar.open,bar.close) &&
      bar.high >= Math.max(bar.open,bar.close) &&
      ageSec >= 0 && ageSec <= maxAgeSec;
  };
  if (!bars.every(b => valid(b,1,140)) || !valid(m5,5,330) ||
      bars[1]!.startedAt.getTime() - bars[0]!.startedAt.getTime() !== 60_000 ||
      (input.asOf.getTime() - (bars[1]!.startedAt.getTime() + 60_000)) / 1000 > 65)
    return reject('CANDLE_NOT_BROKER_NATIVE_OR_FRESH');

  const alignedBody = (open: number, close: number) =>
    input.direction === 'SELL' ? open - close : close - open;
  const priorBody = alignedBody(bars[0]!.open,bars[0]!.close);
  const latestBody = alignedBody(bars[1]!.open,bars[1]!.close);
  const m5Body = alignedBody(m5.open,m5.close);
  const m5Range = m5.high-m5.low;
  const m5Aligned = m5Range > 0 && m5Body > 0 && m5Body / m5Range >= 0.25;
  if (!m5Aligned) return reject('M5_OPPOSES_TRADE', false);
  const latestRange = bars[1]!.high - bars[1]!.low;
  const latestNotMaterialReversal = latestBody >= -Math.max(latestRange*0.12, input.entryPrice * 0.000002);
  const priorMaterialContinuation = priorBody > 0 &&
    priorBody >= (bars[0]!.high - bars[0]!.low) * 0.2;
  const twoClosesNonAdverse = input.direction === 'SELL'
    ? bars[1]!.close <= bars[0]!.close + Math.max(latestRange*0.12, input.entryPrice*0.000002)
    : bars[1]!.close >= bars[0]!.close - Math.max(latestRange*0.12, input.entryPrice*0.000002);
  if (!priorMaterialContinuation || !latestNotMaterialReversal || !twoClosesNonAdverse)
    return reject('M1_REVERSAL_OR_WEAK_STRUCTURE', true);
  return reject('SAME_DIRECTION_PULLBACK_CANDIDATE',true);
}
