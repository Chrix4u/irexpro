'use strict';
/**
 * V2 deterministic synthetic market generator (P2-1). Produces 5-minute
 * OHLC bar paths with pre-registered, planted parameters and machine-
 * readable ground truth:
 *
 *   EDGE_ZERO      — driftless noise (null campaigns);
 *   PLANTED_DRIFT  — known drift per bar in sigma units (edge recovery);
 *   REVERSION      — OU pull to anchor (win-truncation scenarios);
 *   TREND_REGIMES  — regime switching with reversal ground truth.
 *
 * Deterministic: every path is a pure function of (seed, config); the only
 * randomness is the seeded mulberry32 PRNG. Research-only: synthetic data
 * for framework validation, never broker evidence, never order authority.
 */

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

const SUPPORTED_INSTRUMENTS = Object.freeze(['EURUSD', 'GBPUSD']);
const INSTRUMENT_SPECS = Object.freeze({
  EURUSD: Object.freeze({ pip: 0.0001, contractSize: 100000, quote: 'USD', startPrice: 1.12 }),
  GBPUSD: Object.freeze({ pip: 0.0001, contractSize: 100000, quote: 'USD', startPrice: 1.34 }),
});

const SYNTHETIC_SCENARIOS = Object.freeze([
  'EDGE_ZERO', 'PLANTED_DRIFT', 'REVERSION', 'TREND_REGIMES',
]);

/** Fixed deterministic epoch start (2026-11-30T00:00:00Z Monday open). */
const T0_EPOCH_SECONDS = 1794019200;

/** mulberry32 PRNG — deterministic, seedable, no global state. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box-Muller gaussian from the uniform PRNG. */
function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Generate one market path. Config: { seed, instrument, nBars,
 * scenario, barSeconds (default 300), plantedDriftPerBarSigma (default
 * 0.06), ouKappa (default 0.02), trendRegimeMeanBars (default 600),
 * dailyVolPercent (default 0.55), spreadPips (default 0.8) }.
 */
function generateMarketPath(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('SYNTHETIC_INPUT_REQUIRED');
  }
  const {
    seed, instrument = 'EURUSD', nBars, scenario,
    barSeconds = 300, plantedDriftPerBarSigma = 0.06,
    ouKappa = 0.02, trendRegimeMeanBars = 600,
    dailyVolPercent = 0.55, spreadPips = 0.8,
  } = config;
  if (!Number.isInteger(seed) || seed <= 0) {
    throw new Error('SYNTHETIC_SEED_INVALID');
  }
  if (!Number.isInteger(nBars) || nBars < 200) {
    throw new Error('SYNTHETIC_N_BARS_INVALID');
  }
  if (!SYNTHETIC_SCENARIOS.includes(scenario)) {
    throw new Error(`SYNTHETIC_SCENARIO_UNKNOWN:${String(scenario)}`);
  }
  const spec = INSTRUMENT_SPECS[instrument];
  if (!spec) {
    throw new Error(`SYNTHETIC_INSTRUMENT_UNSUPPORTED:${String(instrument)}`);
  }
  if (!finiteNumber(plantedDriftPerBarSigma) || Math.abs(plantedDriftPerBarSigma) > 0.5) {
    throw new Error('SYNTHETIC_DRIFT_INVALID');
  }
  if (!finiteNumber(ouKappa) || ouKappa <= 0 || ouKappa > 0.5) {
    throw new Error('SYNTHETIC_OU_KAPPA_INVALID');
  }

  const rng = mulberry32(seed);
  const sigmaBar = (dailyVolPercent / 100) / Math.sqrt(86400 / barSeconds);
  const anchorLog = Math.log(spec.startPrice);
  let logPrice = anchorLog;
  const bars = [];
  const regimeEpisodes = [];
  const reversalPoints = [];

  // Regime process for TREND_REGIMES.
  const REGIMES = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'HIGH_VOL'];
  const driftOf = { TREND_UP: 0.08, TREND_DOWN: -0.08, RANGE: 0.0, HIGH_VOL: 0.01 };
  const volOf = { TREND_UP: 1.15, TREND_DOWN: 1.15, RANGE: 0.9, HIGH_VOL: 2.6 };
  let regime = 'RANGE';
  let regimeStartBar = 0;
  let regimeRemaining = Math.max(50, Math.round(trendRegimeMeanBars * rng()));

  for (let i = 0; i < nBars; i += 1) {
    const t = T0_EPOCH_SECONDS + i * barSeconds;
    let drift = 0;
    let volMult = 1;
    if (scenario === 'PLANTED_DRIFT') {
      drift = plantedDriftPerBarSigma * sigmaBar;
    } else if (scenario === 'REVERSION') {
      drift = -ouKappa * (logPrice - anchorLog);
    } else if (scenario === 'TREND_REGIMES') {
      regimeRemaining -= 1;
      if (regimeRemaining <= 0) {
        const next = REGIMES[Math.floor(rng() * REGIMES.length)];
        reversalPoints.push({
          bar: i,
          from: regime,
          to: next,
          directional: (regime === 'TREND_UP' && next !== 'TREND_UP') ||
            (regime === 'TREND_DOWN' && next !== 'TREND_DOWN'),
        });
        regimeEpisodes.push({ fromBar: regimeStartBar, toBar: i - 1, label: regime });
        regime = next;
        regimeStartBar = i;
        regimeRemaining = Math.max(50, Math.round(trendRegimeMeanBars * rng()));
      }
      drift = driftOf[regime] * sigmaBar;
      volMult = volOf[regime];
    }
    // EDGE_ZERO: drift 0, volMult 1.

    const noise = gaussian(rng) * sigmaBar * volMult;
    const r = drift + noise;
    const open = Math.exp(logPrice);
    const close = Math.exp(logPrice + r);
    const wickUp = Math.abs(gaussian(rng)) * sigmaBar * volMult * 0.5;
    const wickDown = Math.abs(gaussian(rng)) * sigmaBar * volMult * 0.5;
    const high = Math.max(open, close) * Math.exp(wickUp);
    const low = Math.min(open, close) * Math.exp(-wickDown);
    const effSpread = scenario === 'TREND_REGIMES' && regime === 'HIGH_VOL'
      ? spreadPips * 1.5 : spreadPips;
    bars.push({
      t, i, open, high, low, close, spreadPips: effSpread,
    });
    logPrice += r;
  }
  if (scenario === 'TREND_REGIMES') {
    regimeEpisodes.push({ fromBar: regimeStartBar, toBar: nBars - 1, label: regime });
  }

  return Object.freeze({
    instrument,
    scenario,
    seed,
    nBars,
    barSeconds,
    t0: T0_EPOCH_SECONDS,
    spec: Object.freeze({ ...spec }),
    bars: Object.freeze(bars.map((b) => Object.freeze(b))),
    groundTruth: Object.freeze({
      regimeEpisodes: Object.freeze(regimeEpisodes.map((e) => Object.freeze(e))),
      reversalPoints: Object.freeze(reversalPoints.map((p) => Object.freeze(p))),
      plantedParameters: Object.freeze({
        scenario,
        dailyVolPercent,
        sigmaBar,
        plantedDriftPerBarSigma: scenario === 'PLANTED_DRIFT' ? plantedDriftPerBarSigma : null,
        ouKappa: scenario === 'REVERSION' ? ouKappa : null,
        trendRegimeMeanBars: scenario === 'TREND_REGIMES' ? trendRegimeMeanBars : null,
        spreadPips,
      }),
    }),
  });
}

/**
 * P2-1 acceptance: recover the planted per-bar drift from a realized path
 * and z-score it against the null of pure noise. Returns {realized,
 * planted, z} so tests can pin recovery within 3 sigma.
 */
function recoverPlantedDrift(path) {
  if (!path || !Array.isArray(path.bars) || path.bars.length < 200) {
    throw new Error('SYNTHETIC_PATH_REQUIRED');
  }
  const logs = path.bars.map((b) => Math.log(b.close));
  const n = logs.length - 1;
  const totalLog = logs[n] - logs[0];
  const realized = totalLog / n;
  const sigmaBar = path.groundTruth.plantedParameters.sigmaBar;
  const planted = path.groundTruth.plantedParameters.plantedDriftPerBarSigma === null
    ? 0 : path.groundTruth.plantedParameters.plantedDriftPerBarSigma * sigmaBar;
  const z = (realized - planted) / (sigmaBar / Math.sqrt(n));
  return Object.freeze({ realized, planted, z, n });
}

module.exports = {
  SYNTHETIC_SCENARIOS,
  SUPPORTED_INSTRUMENTS,
  INSTRUMENT_SPECS,
  T0_EPOCH_SECONDS,
  generateMarketPath,
  recoverPlantedDrift,
  mulberry32,
};
