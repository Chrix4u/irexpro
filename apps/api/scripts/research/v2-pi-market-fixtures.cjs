'use strict';
/**
 * V2 synthetic multi-symbol multi-timeframe market fixtures (PI-2,
 * directive 2026-11-28). Deterministic generator for the six research
 * pairs (EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF) producing M1
 * base bars aggregated — through the PI-1 ingestion contract — into
 * M5/M15/H1/H4 context series.
 *
 * Scenarios (pre-registered, machine-readable ground truth):
 *   PI_NULL                 — driftless random walk (null campaigns);
 *   PI_PLANTED_CONTINUATION — conditional drift edge: after a strong,
 *                              calm 12-minute run, the next 12 minutes
 *                              carry drift toward continuation with the
 *                              planted probability;
 *   PI_TREND_REGIMES        — regime switching (trend-up/down, range,
 *                              high-vol) with episode ground truth;
 *   PI_REVERSION            — OU pull to the anchor (reversal-dominant).
 *
 * Privacy: every fixture is fully synthetic — seeded PRNG output only, no
 * broker records, no real identifiers (PI-1 provenance SYNTHETIC_FIXTURE).
 * Research-only; never order authority.
 */

const { mulberry32, T0_EPOCH_SECONDS } = require('./v2-synthetic-market.cjs');
const {
  SUPPORTED_SYMBOLS,
  SYMBOL_SPECS,
  ingestBarSeries,
  aggregateTimeframe,
} = require('./v2-historical-data-contract.cjs');

const PI_SCENARIOS = Object.freeze([
  'PI_NULL', 'PI_PLANTED_CONTINUATION', 'PI_TREND_REGIMES', 'PI_REVERSION',
]);

/** Standard-normal quantile at 0.56 (planted continuation default). */
const Z_AT_056 = 0.1510;

const PLANTED_REGIME_DRIFT = Object.freeze({
  TREND_UP: 0.06, TREND_DOWN: -0.06, RANGE: 0.0, HIGH_VOL: 0.005,
});
const PLANTED_REGIME_VOL = Object.freeze({
  TREND_UP: 1.15, TREND_DOWN: 1.15, RANGE: 0.9, HIGH_VOL: 2.4,
});

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Generate one symbol's M1 log-price path with scenario dynamics.
 * Returns {bars, groundTruth} where groundTruth carries triggers and/or
 * regime episodes depending on the scenario.
 */
function generateSymbolM1({ symbol, seed, nBars, scenario, plantedContinuationProb, ouKappa }) {
  const spec = SYMBOL_SPECS[symbol];
  const rng = mulberry32(seed);
  const sigmaM1 = (spec.dailyVolPercent / 100) / Math.sqrt(1440);
  const sigma12 = Math.sqrt(12) * sigmaM1;
  const zPlanted = plantedContinuationProb >= 0.5
    ? Z_AT_056 + (plantedContinuationProb - 0.56) * 6.18 : Z_AT_056;
  const mu12 = zPlanted * sigma12;
  const driftPerBar = mu12 / 12;
  const logPrice0 = Math.log(spec.startPrice);
  let logPrice = logPrice0;
  const bars = [];
  const triggers = [];
  const regimeEpisodes = [];
  const returns = [];
  let edgeRemaining = 0;
  let edgeDir = 0;
  let regime = 'RANGE';
  let regimeStartBar = 0;
  let regimeRemaining = Math.max(50, Math.round(600 * rng()));

  for (let i = 0; i < nBars; i += 1) {
    const t = T0_EPOCH_SECONDS + i * 60;
    let drift = 0;
    let volMult = 1;
    if (scenario === 'PI_PLANTED_CONTINUATION') {
      if (edgeRemaining === 0 && i >= 12) {
        // Trigger uses only PAST bars (no future peek).
        const mom = returns.slice(-12).reduce((s, r) => s + r, 0);
        let vol2 = 0;
        for (const r of returns.slice(-12)) vol2 += r * r;
        const vol = Math.sqrt(vol2 / 12);
        if (Math.abs(mom) > 0.9 * sigma12 && vol < 1.1 * sigmaM1) {
          edgeDir = mom > 0 ? 1 : -1;
          edgeRemaining = 12;
          triggers.push({ bar: i, dir: edgeDir, t });
        }
      }
      if (edgeRemaining > 0) {
        drift = driftPerBar * edgeDir;
        edgeRemaining -= 1;
      }
    } else if (scenario === 'PI_TREND_REGIMES') {
      regimeRemaining -= 1;
      if (regimeRemaining <= 0) {
        const next = ['TREND_UP', 'TREND_DOWN', 'RANGE', 'HIGH_VOL'][Math.floor(rng() * 4)];
        regimeEpisodes.push({ fromBar: regimeStartBar, toBar: i - 1, label: regime });
        regime = next;
        regimeStartBar = i;
        regimeRemaining = Math.max(50, Math.round(600 * rng()));
      }
      drift = PLANTED_REGIME_DRIFT[regime] * sigmaM1;
      volMult = PLANTED_REGIME_VOL[regime];
    } else if (scenario === 'PI_REVERSION') {
      drift = -ouKappa * (logPrice - logPrice0);
    }
    const noise = gaussian(rng) * sigmaM1 * volMult;
    const r = drift + noise;
    const open = Math.exp(logPrice);
    const close = Math.exp(logPrice + r);
    const wickUp = Math.abs(gaussian(rng)) * sigmaM1 * volMult * 0.5;
    const wickDown = Math.abs(gaussian(rng)) * sigmaM1 * volMult * 0.5;
    const high = Math.max(open, close) * Math.exp(wickUp);
    const low = Math.min(open, close) * Math.exp(-wickDown);
    bars.push({
      t, open, high, low, close,
      spreadPips: scenario === 'PI_TREND_REGIMES' && regime === 'HIGH_VOL'
        ? spec.spreadPips * 1.5 : spec.spreadPips,
    });
    returns.push(r);
    logPrice += r;
  }
  if (scenario === 'PI_TREND_REGIMES') {
    regimeEpisodes.push({ fromBar: regimeStartBar, toBar: nBars - 1, label: regime });
  }
  return { bars, groundTruth: { triggers, regimeEpisodes } };
}

/**
 * Generate the full multi-symbol multi-timeframe fixture.
 * Config: { seed (family base), symbols, days (default 50), scenario,
 * plantedContinuationProb (default 0.56), ouKappa (default 0.02) }.
 */
function generatePiFixture(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('PI_FIXTURE_INPUT_REQUIRED');
  }
  const {
    seed, symbols = [...SUPPORTED_SYMBOLS], days = 50,
    scenario, plantedContinuationProb = 0.56, ouKappa = 0.02,
  } = config;
  if (!Number.isInteger(seed) || seed <= 0) {
    throw new Error('PI_FIXTURE_SEED_INVALID');
  }
  if (!Number.isInteger(days) || days < 1) {
    throw new Error('PI_FIXTURE_DAYS_INVALID');
  }
  if (!PI_SCENARIOS.includes(scenario)) {
    throw new Error(`PI_FIXTURE_SCENARIO_UNKNOWN:${String(scenario)}`);
  }
  if (!(symbols.length > 0 && symbols.every((s) => SUPPORTED_SYMBOLS.includes(s)))) {
    throw new Error('PI_FIXTURE_SYMBOLS_INVALID');
  }
  if (!(plantedContinuationProb > 0.5 && plantedContinuationProb < 0.9)) {
    throw new Error('PI_FIXTURE_PLANTED_PROB_INVALID');
  }
  const nBars = days * 1440;
  const symbolsOut = {};
  for (let s = 0; s < symbols.length; s += 1) {
    const symbol = symbols[s];
    const symbolSeed = seed + 101 * s;
    const { bars, groundTruth } = generateSymbolM1({
      symbol, seed: symbolSeed, nBars, scenario,
      plantedContinuationProb, ouKappa,
    });
    const m1 = ingestBarSeries({ symbol, timeframe: 'M1', bars, sourceTag: 'SYNTHETIC_FIXTURE' });
    const m5 = aggregateTimeframe(m1, 'M5');
    const m15 = aggregateTimeframe(m1, 'M15');
    const h1 = aggregateTimeframe(m1, 'H1');
    const h4 = aggregateTimeframe(m1, 'H4');
    symbolsOut[symbol] = Object.freeze({
      M1: m1, M5: m5, M15: m15, H1: h1, H4: h4,
      groundTruth: Object.freeze({
        triggers: Object.freeze(groundTruth.triggers.map(Object.freeze)),
        regimeEpisodes: Object.freeze(groundTruth.regimeEpisodes.map(Object.freeze)),
      }),
    });
  }
  return Object.freeze({
    scenario,
    seed,
    symbols: Object.freeze([...symbols]),
    days,
    nBarsPerSymbol: nBars,
    plantedContinuationProb: scenario === 'PI_PLANTED_CONTINUATION'
      ? plantedContinuationProb : null,
    t0: T0_EPOCH_SECONDS,
    series: Object.freeze(symbolsOut),
  });
}

/**
 * Empirical planted-edge check (acceptance for PI-2): on the planted
 * fixture, measure the realized continuation rate at trigger bars — the
 * fraction of trigger events whose following 12-M1-bar move continues the
 * trigger direction. On PI_NULL this returns the null rate (~0.5) using
 * all sampled bars as triggers, proving zero planted edge.
 */
function measureContinuationRate(fixture, symbol, { sampleEvery = 12 } = {}) {
  const sym = fixture.series[symbol];
  if (!sym) {
    throw new Error(`PI_FIXTURE_SYMBOL_MISSING:${String(symbol)}`);
  }
  const bars = sym.M1.bars;
  const isPlanted = fixture.scenario === 'PI_PLANTED_CONTINUATION';
  const triggerSet = new Set(
    isPlanted ? sym.groundTruth.triggers.map((t) => t.bar) : [],
  );
  let matched = 0;
  let total = 0;
  const step = isPlanted ? 1 : sampleEvery;
  for (let i = 0; i + 12 < bars.length; i += step) {
    if (isPlanted && !triggerSet.has(i)) continue;
    const triggerDir = isPlanted
      ? sym.groundTruth.triggers.find((t) => t.bar === i).dir
      : (Math.log(bars[i].close) - Math.log(bars[Math.max(0, i - 12)].close) > 0 ? 1 : -1);
    const fwd = Math.log(bars[i + 12].close) - Math.log(bars[i].close);
    if (Math.sign(fwd) === triggerDir) matched += 1;
    total += 1;
  }
  if (total < 30) {
    return Object.freeze({ rate: null, total, refused: 'PI_RATE_INSUFFICIENT_SAMPLE' });
  }
  return Object.freeze({ rate: matched / total, total, matched });
}

module.exports = {
  PI_SCENARIOS,
  PLANTED_REGIME_DRIFT,
  PLANTED_REGIME_VOL,
  generatePiFixture,
  measureContinuationRate,
};
