'use strict';
/**
 * V2 offline engine feature window — the bar-computable mirror of the S1
 * input snapshot (`m1-tactical-candidate.ts` l.110-167, component map §1).
 *
 * Research-only proxies, honestly labeled: the production snapshot is
 * built from broker M5/M30 quote streams; here the same statistics are
 * computed incrementally from the synthetic market's 5-minute bars, with
 * the M30 agreement proxied by a 6x-aggregated EMA trend. Every formula
 * below is a research-mirror definition, not a production constant.
 */

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * Create a rolling feature window for one instrument.
 * params: { pip, emaFast (12), emaSlow (48), atrPeriod (14), rsiPeriod
 * (14), lookback (20), warmupBars (100) }.
 */
function createFeatureWindow(params) {
  const p = params || {};
  const pip = finiteNumber(p.pip) && p.pip > 0 ? p.pip : 0.0001;
  const emaFastN = Number.isInteger(p.emaFast) && p.emaFast > 0 ? p.emaFast : 12;
  const emaSlowN = Number.isInteger(p.emaSlow) && p.emaSlow > 0 ? p.emaSlow : 48;
  const atrPeriod = Number.isInteger(p.atrPeriod) && p.atrPeriod > 0 ? p.atrPeriod : 14;
  const rsiPeriod = Number.isInteger(p.rsiPeriod) && p.rsiPeriod > 0 ? p.rsiPeriod : 14;
  const lookback = Number.isInteger(p.lookback) && p.lookback > 0 ? p.lookback : 20;
  const warmup = Number.isInteger(p.warmupBars) && p.warmupBars > 0 ? p.warmupBars : 100;

  const alphaFast = 2 / (emaFastN + 1);
  const alphaSlow = 2 / (emaSlowN + 1);
  const alphaAtr = 1 / atrPeriod;

  let emaFast = null;
  let emaSlow = null;
  let atr = null;
  let atrSlow = null;
  let barsSeen = 0;
  let lastClose = null;
  let prevEmaFast = null;

  const closes = [];       // rolling closes for momentum / efficiency
  const firstChanges = []; // RSI seed buffer
  let avgGain = null;      // Wilder RSI state
  let avgLoss = null;
  const m30closes = [];    // 6-bar aggregation for the M30 proxy
  let m30Ema = null;
  let m30EmaPrevForTrend = null;

  /**
   * Update with one bar; returns a frozen feature snapshot or null during
   * warmup. Snapshot fields match the S1 composite inputs.
   */
  function update(bar) {
    if (!bar || !finiteNumber(bar.close) || !finiteNumber(bar.high) || !finiteNumber(bar.low)) {
      throw new Error('FEATURE_BAR_INVALID');
    }
    barsSeen += 1;
    if (emaFast === null) {
      emaFast = bar.close;
      emaSlow = bar.close;
      atr = bar.high - bar.low;
      atrSlow = atr;
      avgGain = null;
      avgLoss = null;
    } else {
      const trueRange = Math.max(
        bar.high - bar.low,
        Math.abs(bar.high - lastClose),
        Math.abs(bar.low - lastClose),
      );
      atr += alphaAtr * (trueRange - atr);
      atrSlow += (1 / 500) * (atr - atrSlow);
      prevEmaFast = emaFast;
      emaFast += alphaFast * (bar.close - emaFast);
      emaSlow += alphaSlow * (bar.close - emaSlow);
      // RSI (Wilder): seed with the simple mean over the first period,
      // then smooth.
      const change = bar.close - lastClose;
      const gain = Math.max(0, change);
      const loss = Math.max(0, -change);
      if (avgGain === null) {
        firstChanges.push(change);
        if (firstChanges.length === rsiPeriod) {
          avgGain = firstChanges.reduce((s, v) => s + Math.max(0, v), 0) / rsiPeriod;
          avgLoss = firstChanges.reduce((s, v) => s + Math.max(0, -v), 0) / rsiPeriod;
        }
      } else {
        avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
        avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
      }
    }
    lastClose = bar.close;
    closes.push(bar.close);
    if (closes.length > lookback + 1) closes.shift();

    // M30 proxy: aggregate 6 five-minute closes.
    m30closes.push(bar.close);
    if (m30closes.length === 6) {
      const m30Close = m30closes.reduce((s, v) => s + v, 0) / 6;
      m30EmaPrevForTrend = m30Ema;
      m30Ema = m30Ema === null ? m30Close : m30Ema + (2 / 31) * (m30Close - m30Ema);
      m30closes.length = 0;
    }

    if (barsSeen < warmup) return null;

    const range = Math.max(bar.high - bar.low, 1e-12);
    const closeLocation = (bar.close - bar.low) / range;
    const upperWick = bar.high - Math.max(bar.open, bar.close);
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    const upperWickRatio = upperWick / range;
    const lowerWickRatio = lowerWick / range;

    // Momentum in ATR units.
    const momentum = (n) => (closes.length > n
      ? (bar.close - closes[closes.length - 1 - n]) / atr : 0);

    // Kaufman efficiency ratio over the lookback window.
    let er = 0;
    if (closes.length >= lookback) {
      const span = Math.abs(bar.close - closes[0]);
      let pathLen = 0;
      for (let i = 1; i < closes.length; i += 1) {
        pathLen += Math.abs(closes[i] - closes[i - 1]);
      }
      er = pathLen === 0 ? 0 : span / pathLen;
    }

    // Breakout beyond the prior 20-bar extremes, in ATR units.
    let breakoutUpAtr = 0;
    let breakoutDownAtr = 0;
    if (closes.length >= lookback) {
      const priorHigh = Math.max(...closes.slice(0, -1));
      const priorLow = Math.min(...closes.slice(0, -1));
      breakoutUpAtr = Math.max(0, (bar.close - priorHigh) / atr);
      breakoutDownAtr = Math.max(0, (priorLow - bar.close) / atr);
    }

    // Higher-timeframe agreement: +1 when the bar trend and the M30-proxy
    // trend share sign, else -1.
    const barTrendUp = emaFast > emaSlow;
    const m30TrendUp = m30Ema !== null && m30EmaPrevForTrend !== null
      ? m30Ema > m30EmaPrevForTrend : barTrendUp;
    const htfAgreement = barTrendUp === m30TrendUp ? 1 : -1;

    const rsi = (avgGain === null || avgGain + avgLoss === 0)
      ? 50 : 100 * avgGain / (avgGain + avgLoss);

    return Object.freeze({
      bar: barsSeen - 1,
      close: bar.close,
      ready: true,
      atr14: atr,
      atrSlow,
      emaFast,
      emaSlow,
      emaSeparationAtr: (emaFast - emaSlow) / atr,
      emaSlopeAtr: prevEmaFast === null ? 0 : (emaFast - prevEmaFast) / atr,
      momentum1Atr: momentum(1),
      momentum3Atr: momentum(3),
      momentum5Atr: momentum(5),
      efficiency5: clamp01(er),
      volatilityScore: clamp01(atr / (2 * atrSlow + 1e-12)),
      closeLocation,
      closePressure: (closeLocation - 0.5) * 2,
      wickPressure: lowerWickRatio - upperWickRatio,
      rsi14: rsi,
      rsiBias: (rsi - 50) / 25,
      breakoutUpAtr,
      breakoutDownAtr,
      htfAgreement,
      pip,
    });
  }

  return Object.freeze({ update });
}

module.exports = { createFeatureWindow };
