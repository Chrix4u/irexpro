'use strict';
/**
 * V2 paired-engine simulator (P2-2). Evaluates the Champion-shaped policy
 * and the Challenger policy on IDENTICAL synthetic paths with IDENTICAL
 * costs, registering every settled trade into the shared attribution
 * ledger (R5) under separate research engine identities.
 *
 * Execution model (no look-ahead):
 *   - decisions are made on bar close t;
 *   - market entries/exits fill at bar t+1 open, price = open +/- half
 *     spread +/- seeded slippage, commission per lot per side;
 *   - hard stops and targets fill intra-bar at their level with adverse
 *     slippage (stop first when both are touched — conservative);
 *   - swap accrues per overnight held (288 five-minute bars);
 *   - open positions are force-closed at the path end (HORIZON_CLOSE).
 *
 * Deterministic given the market path and seeds. Research-only.
 */

const {
  createFeatureWindow,
} = require('./v2-engine-features.cjs');
const { createEnginePolicy } = require('./v2-intelligence-engine.cjs');
const { createAttributionLedger, defineEngineIdentity } = require('./v2-challenger-attribution.cjs');
const { mulberry32 } = require('./v2-synthetic-market.cjs');

const finiteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

const DEFAULT_COST_MODEL = Object.freeze({
  // Calibrated to the broker evidence window (statement-09): implied
  // round-turn cost ~0.6-1.0 pip per lot on the observed deals.
  spreadPips: 0.8,
  commissionUsdPerLotPerSide: 3.0,
  slippagePips: 0.1,
  swapUsdPerLotPerNight: -0.55,
  pipValueUsdPerLot: 10,
});

const PAIRED_SIMULATOR_REFUSALS = Object.freeze([
  'PAIRED_MARKET_REQUIRED', 'PAIRED_COST_MODEL_INVALID',
  'PAIRED_STARTING_BALANCE_INVALID', 'PAIRED_LEVERAGE_INVALID',
]);

/**
 * Run one paired replay. config: { market (generateMarketPath output),
 * startingBalanceUsd (default 50000), leverage (default 30),
 * costModel (partial override of DEFAULT_COST_MODEL),
 * slippageSeed (default market.seed),
 * challengerExitPreset, challengerEntryGate, challengerConfidenceFloor
 * (EXPERIMENTAL ablation arms only; defaults = the frozen pre-registered
 * challenger policy) }.
 */
function runPairedReplay(config) {
  const market = config && config.market;
  if (!market || !Array.isArray(market.bars) || market.bars.length < 200) {
    throw new Error('PAIRED_MARKET_REQUIRED');
  }
  const startingBalanceUsd = finiteNumber(config.startingBalanceUsd)
    ? config.startingBalanceUsd : 50000;
  const leverage = finiteNumber(config.leverage) ? config.leverage : 30;
  if (!(startingBalanceUsd > 0)) {
    throw new Error('PAIRED_STARTING_BALANCE_INVALID');
  }
  if (!(leverage > 0)) {
    throw new Error('PAIRED_LEVERAGE_INVALID');
  }
  const cost = { ...DEFAULT_COST_MODEL, ...(config.costModel || {}) };
  for (const [k, v] of Object.entries(cost)) {
    if (!finiteNumber(v) || (k !== 'swapUsdPerLotPerNight' && v < 0)) {
      throw new Error(`PAIRED_COST_MODEL_INVALID:${k}`);
    }
  }

  const pip = market.spec.pip;
  const pipValue = cost.pipValueUsdPerLot;
  const contractPerLot = market.spec.contractSize; // USD-quoted pairs.
  const rng = mulberry32(finiteNumber(config.slippageSeed)
    ? config.slippageSeed : market.seed);

  const ledger = createAttributionLedger();
  const championIdentity = defineEngineIdentity({
    engineCode: 'V1-CHAMPION-MIRROR',
    modelVersion: 'm1-tactical-candidate-v1',
    strategyCode: 'M1-TACTICAL',
    generation: 1,
    executionAuthority: 'RESEARCH_SHADOW',
  });
  const challengerIdentity = defineEngineIdentity({
    engineCode: 'V2-CHALLENGER',
    modelVersion: 'v2-intelligence-engine-v1',
    strategyCode: 'V2-RESEARCH',
    generation: 1,
    executionAuthority: 'RESEARCH_SHADOW',
  });

  const engines = [
    {
      name: 'CHAMPION',
      policy: createEnginePolicy('CHAMPION', { engineIdentity: championIdentity, pip }),
      trades: [],
      equityCurve: [],
      balance: startingBalanceUsd,
      position: null,
      pendingEntry: null,
      pendingExit: null,
      tradeSeq: 0,
      features: createFeatureWindow({ pip }),
      snapshots: [],
      registrations: [],
    },
    {
      name: 'CHALLENGER',
      policy: createEnginePolicy('CHALLENGER', {
        engineIdentity: challengerIdentity,
        pip,
        // Experimental ablation arms only; default = frozen preset/policy.
        exitPreset: config && config.challengerExitPreset !== undefined
          ? config.challengerExitPreset : null,
        entryGateDirectionQuality: config
          ? config.challengerEntryGate : undefined,
        confidenceFloor: config
          ? config.challengerConfidenceFloor : undefined,
      }),
      trades: [],
      equityCurve: [],
      balance: startingBalanceUsd,
      position: null,
      pendingEntry: null,
      pendingExit: null,
      tradeSeq: 0,
      features: createFeatureWindow({ pip }),
      snapshots: [],
      registrations: [],
    },
  ];

  const abs = (v) => Math.abs(v);

  function fillPrice(basePrice, side) {
    const adverse = side === 'BUY' ? 1 : -1;
    return basePrice + adverse * (cost.spreadPips / 2 * pip +
      Math.abs(gaussianTail(rng)) * cost.slippagePips * pip);
  }

  function gaussianTail(rng_) {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng_();
    while (v === 0) v = rng_();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  const perSideCostUsd = (lots) => abs(cost.commissionUsdPerLotPerSide) * lots;
  const spreadCostUsd = (lots) => cost.spreadPips * pipValue * lots;

  function openPosition(engine, bar, entry) {
    const fillPriceValue = fillPrice(bar.open, entry.direction);
    const stopPrice = entry.direction === 'BUY'
      ? fillPriceValue - entry.stopDistance
      : fillPriceValue + entry.stopDistance;
    const targetPrice = entry.direction === 'BUY'
      ? fillPriceValue + entry.targetDistance
      : fillPriceValue - entry.targetDistance;
    const entrySlippageUsd = Math.abs(fillPriceValue - bar.open) *
      entry.lots * contractPerLot;
    engine.position = {
      tradeId: `${engine.name}-${market.seed}-${engine.tradeSeq}`,
      direction: entry.direction,
      lots: entry.lots,
      entryPrice: fillPriceValue,
      entryMid: bar.open,
      entryBar: bar.i,
      entryTs: bar.t,
      entryConfidence: entry.confidence,
      entryReason: entry.reason,
      stopDistance: entry.stopDistance,
      stopPrice,
      targetPrice,
      peakR: 0,
      troughR: 0,
      grossR: 0,
      barsHeld: 0,
      mfeR: 0,
      maeR: 0,
      stopIsLock: false,
      // Friction on entry: commission + half spread + slippage vs mid.
      entryCostUsd: perSideCostUsd(entry.lots) + spreadCostUsd(entry.lots) / 2 +
        entrySlippageUsd,
      swapAccruedUsd: 0,
      stopDistanceUsd: entry.stopDistance / pip * pipValue * entry.lots,
    };
    engine.balance -= engine.position.entryCostUsd;
  }

  function settlePosition(engine, exitPrice, exitMid, exitBar, reason) {
    const p = engine.position;
    // Accounting: gross at MID prices; friction as explicit cost lines
    // (commission + full spread + slippage both sides + swap). Fill prices
    // drive levels/realism, mids drive the ledger identity.
    const exitSlippageUsd = Math.abs(exitPrice - exitMid) * p.lots * contractPerLot;
    const exitCostUsd = perSideCostUsd(p.lots) + spreadCostUsd(p.lots) / 2 +
      exitSlippageUsd;
    const grossUsd = (exitMid - p.entryMid) * (p.direction === 'BUY' ? 1 : -1) *
      p.lots * contractPerLot;
    const netUsd = grossUsd - exitCostUsd - p.entryCostUsd - p.swapAccruedUsd;
    engine.balance += grossUsd - exitCostUsd - p.swapAccruedUsd;
    const grossR = (exitMid - p.entryMid) * (p.direction === 'BUY' ? 1 : -1) /
      p.stopDistance;
    const costsR = (p.entryCostUsd + exitCostUsd + p.swapAccruedUsd) /
      p.stopDistanceUsd;
    // MFE/MAE measured on closes plus the exit level itself.
    const exitGrossR = grossR;
    const mfeR = Math.max(p.mfeR, exitGrossR);
    const trade = {
      engine: engine.name,
      tradeId: p.tradeId,
      instrument: market.instrument,
      direction: p.direction,
      lots: p.lots,
      openedBar: p.entryBar,
      closedBar: exitBar.i,
      openedAt: new Date(p.entryTs).toISOString(),
      closedAt: new Date(exitBar.t).toISOString(),
      entryMid: p.entryMid,
      exitMid,
      entryPrice: p.entryPrice,
      exitPrice,
      stopDistance: p.stopDistance,
      grossUsd,
      netUsd,
      commissionUsd: perSideCostUsd(p.lots) * 2,
      spreadUsd: spreadCostUsd(p.lots),
      slippageUsd: (p.entryCostUsd - perSideCostUsd(p.lots) -
        spreadCostUsd(p.lots) / 2) + exitSlippageUsd,
      swapUsd: p.swapAccruedUsd,
      riskAmountUsd: p.stopDistanceUsd,
      grossR,
      costsR,
      netR: grossR - costsR,
      mfeR,
      maeR: p.maeR,
      barsHeld: p.barsHeld,
      entryConfidence: p.entryConfidence,
      exitReason: reason,
      settlementProvenance: 'SYNTHETIC_CAMPAIGN',
    };
    engine.trades.push(trade);
    // R5: immutable ledger registration under this engine's identity.
    // grossPnl is registered net of execution frictions (spread +
    // slippage) so that ledger netPnl == trade netUsd exactly: the
    // ledger stays the single source of truth (R6) for the dashboard.
    ledger.register({
      engineIdentity: engine === engines[0] ? championIdentity : challengerIdentity,
      tradeId: trade.tradeId,
      instrument: market.instrument,
      direction: trade.direction,
      lots: trade.lots,
      openedAt: trade.openedAt,
      closedAt: trade.closedAt,
      grossPnl: trade.grossUsd - trade.spreadUsd - trade.slippageUsd,
      commission: trade.commissionUsd,
      swap: trade.swapUsd,
      riskAmount: trade.riskAmountUsd,
      settlementProvenance: 'SYNTHETIC_CAMPAIGN',
    });
    engine.position = null;
  }

  let lastDay = null;

  for (let bi = 0; bi < market.bars.length; bi += 1) {
    const bar = market.bars[bi];

    for (const engine of engines) {
      // 1. Fill pending entry at this bar's open.
      if (engine.pendingEntry && engine.position === null) {
        openPosition(engine, bar, engine.pendingEntry);
      }
      engine.pendingEntry = null;
      // 2. Fill pending exit at this bar's open.
      if (engine.pendingExit && engine.position !== null) {
        const exitSide = engine.position.direction === 'BUY' ? 'SELL' : 'BUY';
        settlePosition(engine, fillPrice(bar.open, exitSide), bar.open, bar,
          engine.pendingExit.reason);
      }
      engine.pendingExit = null;
      // 3. Intra-bar stop / target (stop first when both touched).
      if (engine.position !== null) {
        const p = engine.position;
        const stopTouched = p.direction === 'BUY' ? bar.low <= p.stopPrice
          : bar.high >= p.stopPrice;
        const targetTouched = p.direction === 'BUY' ? bar.high >= p.targetPrice
          : bar.low <= p.targetPrice;
        if (stopTouched) {
          const stopFill = p.stopPrice - cost.slippagePips * pip *
            (p.direction === 'BUY' ? 1 : -1);
          settlePosition(engine, stopFill, p.stopPrice, bar,
            p.stopIsLock ? 'LOCK_TRAIL' : 'STOP_LOSS');
        } else if (targetTouched) {
          settlePosition(engine, p.targetPrice, p.targetPrice, bar, 'TARGET');
        }
      }
      // 4. Update excursion and time on the open position.
      if (engine.position !== null) {
        const p = engine.position;
        const closeR = (bar.close - p.entryPrice) * (p.direction === 'BUY' ? 1 : -1) /
          p.stopDistance;
        p.grossR = closeR;
        p.peakR = Math.max(p.peakR, closeR);
        p.troughR = Math.min(p.troughR, closeR);
        p.mfeR = p.peakR;
        p.maeR = p.troughR;
        p.barsHeld += 1;
        const day = Math.floor(bar.t / 86400);
        if (lastDay !== null && day !== lastDay) {
          const swapUsd = cost.swapUsdPerLotPerNight * p.lots;
          p.swapAccruedUsd += abs(swapUsd); // charged once, at settle
        }
      }
      // 5. Mark equity at close (multi-position valuation: one open
      //    position per engine, marked to the close).
      const openUsd = engine.position !== null
        ? (bar.close - engine.position.entryPrice) *
          (engine.position.direction === 'BUY' ? 1 : -1) *
          engine.position.lots * contractPerLot : 0;
      engine.equityCurve.push(engine.balance + openUsd);

      // 6. Decide on this bar's close (fills happen at the next open).
      const snapshot = engine.features.update(bar);
      if (snapshot) {
        engine.snapshots.push(snapshot);
        const decision = engine.policy.decide({
          bar,
          barIndex: bi,
          snapshot,
          position: engine.position,
          equityUsd: engine.equityCurve[engine.equityCurve.length - 1],
          lastClose: bar.close,
        });
        if (decision.registeredProbability) {
          engine.registrations.push(decision.registeredProbability);
        }
        if (engine.position === null && decision.entry) {
          engine.pendingEntry = decision.entry;
          engine.tradeSeq += 1;
        }
        if (engine.position !== null && decision.exit) {
          engine.pendingExit = decision.exit;
        }
        if (engine.position !== null && decision.stopUpdate !== null) {
          engine.position.stopPrice = decision.stopUpdate;
          engine.position.stopIsLock = true;
        }
      }
    }
    lastDay = Math.floor(bar.t / 86400);
  }

  // 7. Force-close remaining positions at the last close.
  const lastBar = market.bars[market.bars.length - 1];
  for (const engine of engines) {
    if (engine.position !== null) {
      const exitSide = engine.position.direction === 'BUY' ? 'SELL' : 'BUY';
      settlePosition(engine, fillPrice(lastBar.close, exitSide), lastBar.close,
        lastBar, 'HORIZON_CLOSE');
    }
    engine.equityCurve.push(engine.balance);
  }

  return Object.freeze({
    market: {
      instrument: market.instrument,
      scenario: market.scenario,
      seed: market.seed,
      nBars: market.nBars,
    },
    costModel: Object.freeze({ ...cost }),
    startingBalanceUsd,
    leverage,
    champion: Object.freeze({
      identity: championIdentity,
      trades: Object.freeze(engines[0].trades.map((t) => Object.freeze({ ...t }))),
      equityCurve: Object.freeze(engines[0].equityCurve.slice()),
      registrations: Object.freeze(engines[0].registrations.slice()),
      reversalEvents: Object.freeze([]),
    }),
    challenger: Object.freeze({
      identity: challengerIdentity,
      trades: Object.freeze(engines[1].trades.map((t) => Object.freeze({ ...t }))),
      equityCurve: Object.freeze(engines[1].equityCurve.slice()),
      registrations: Object.freeze(engines[1].registrations.slice()),
      reversalEvents: Object.freeze(engines[1].policy.reversalEvents()),
      exitPresetIsFrozen: engines[1].policy.exitPresetIsFrozen,
    }),
    ledger,
  });
}

module.exports = {
  DEFAULT_COST_MODEL,
  PAIRED_SIMULATOR_REFUSALS,
  runPairedReplay,
};
