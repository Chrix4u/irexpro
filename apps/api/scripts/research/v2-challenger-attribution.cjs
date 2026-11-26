'use strict';
/**
 * V2 Champion-Challenger research contracts: immutable performance
 * attribution for isolated broker-connected DEMO engines.
 *
 * Research-only. This module never grants order authority, never touches
 * a broker or database, and only operates on synthetic or
 * separately-supplied offline data. It enforces the six DEMO-isolation
 * requirements of the V2 directive at the contract level:
 *   R1 account isolation, R2 engine identity, R3 position ownership,
 *   R4 equivalent starting conditions, R5 immutable attribution,
 *   R6 comparative dashboard (read-only projection of the ledger).
 */

const RESEARCH_AUTHORITIES = new Set(['NONE', 'RESEARCH_SHADOW']);

const nonEmptyString = (value) =>
  typeof value === 'string' && value.trim() !== '';

const finiteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * R2: define a research engine identity. The identity tuple
 * (engineCode, modelVersion, strategyCode, generation) is the unit of
 * attribution; generations are monotonic within a campaign and frozen at
 * pre-registration. Anything that could be confused with production or
 * broker authority is refused.
 */
function defineEngineIdentity(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('ENGINE_IDENTITY_REQUIRED');
  }
  const {
    engineCode, modelVersion, strategyCode, generation, executionAuthority,
  } = input;
  if (!nonEmptyString(engineCode) || !nonEmptyString(modelVersion) ||
      !nonEmptyString(strategyCode)) {
    throw new Error('ENGINE_IDENTITY_FIELDS_REQUIRED');
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error('ENGINE_IDENTITY_GENERATION_INVALID');
  }
  if (!RESEARCH_AUTHORITIES.has(executionAuthority)) {
    throw new Error(`ENGINE_IDENTITY_AUTHORITY_REFUSED:${String(executionAuthority)}`);
  }
  return Object.freeze({
    engineCode: engineCode.trim(),
    modelVersion: modelVersion.trim(),
    strategyCode: strategyCode.trim(),
    generation,
    executionAuthority,
  });
}

/**
 * R1: assert that two engine registrations are broker-account isolated:
 * distinct connection ids and distinct credential fingerprints. Shared
 * credentials are contamination by definition.
 */
function assertAccountIsolation(engineA, engineB) {
  const violations = [];
  const a = engineA || {};
  const b = engineB || {};
  if (!nonEmptyString(a.connectionId) || !nonEmptyString(b.connectionId)) {
    violations.push('CONNECTION_ID_MISSING');
  } else if (a.connectionId === b.connectionId) {
    violations.push('CONNECTION_ID_SHARED');
  }
  if (!nonEmptyString(a.credentialFingerprint) ||
      !nonEmptyString(b.credentialFingerprint)) {
    violations.push('CREDENTIAL_FINGERPRINT_MISSING');
  } else if (a.credentialFingerprint === b.credentialFingerprint) {
    violations.push('CREDENTIAL_FINGERPRINT_SHARED');
  }
  return Object.freeze({
    isolated: violations.length === 0,
    violations: Object.freeze(violations),
  });
}

/**
 * R4: assert equivalent starting conditions between the two engines:
 * same starting balance, leverage, instrument allowlist, cost basis,
 * session window, and campaign start within the declared alignment
 * tolerance. Any declared mismatch is a typed violation; equivalence is
 * never assumed silently.
 */
function assertEquivalentStartingConditions(engineA, engineB, options) {
  const toleranceMs = options && Number.isFinite(options.alignmentToleranceMs)
    ? options.alignmentToleranceMs : 0;
  const violations = [];
  const a = engineA || {};
  const b = engineB || {};
  const startedAt = (v) => {
    const t = v === null || v === undefined ? NaN : new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  };
  const aStart = startedAt(a.startedAt);
  const bStart = startedAt(b.startedAt);
  if (aStart === null || bStart === null) {
    violations.push('STARTED_AT_MISSING');
  } else if (Math.abs(aStart - bStart) > toleranceMs) {
    violations.push('STARTED_AT_OUTSIDE_ALIGNMENT_WINDOW');
  }
  if (!finiteNumber(a.startingBalance) || !finiteNumber(b.startingBalance) ||
      a.startingBalance !== b.startingBalance) {
    violations.push('STARTING_BALANCE_MISMATCH');
  }
  if (!finiteNumber(a.leverage) || !finiteNumber(b.leverage) ||
      a.leverage !== b.leverage) {
    violations.push('LEVERAGE_MISMATCH');
  }
  const list = (v) => Array.isArray(v) ? [...v].sort().join('|') : null;
  if (list(a.instruments) === null || list(a.instruments) !== list(b.instruments)) {
    violations.push('INSTRUMENT_ALLOWLIST_MISMATCH');
  }
  const cost = (v) => v && typeof v === 'object'
    ? JSON.stringify(v, Object.keys(v).sort()) : null;
  if (cost(a.costBasis) === null || cost(a.costBasis) !== cost(b.costBasis)) {
    violations.push('COST_BASIS_MISMATCH');
  }
  if (!nonEmptyString(a.sessionWindow) || a.sessionWindow !== b.sessionWindow) {
    violations.push('SESSION_WINDOW_MISMATCH');
  }
  return Object.freeze({
    equivalent: violations.length === 0,
    violations: Object.freeze(violations),
  });
}

/**
 * R3 + R5: append-only attribution ledger. Rows are deep-frozen on insert;
 * duplicate trade ids are refused across the whole ledger (position
 * ownership is per engine: one trade id may never appear under two
 * engine identities). Broker-confirmed settlement fields are carried as
 * provenance-labeled values and never re-derived here.
 */
function createAttributionLedger() {
  const rows = [];
  const seenTradeIds = new Map(); // tradeId -> engine identity key

  const identityKey = (identity) =>
    `${identity.engineCode}|${identity.modelVersion}|${identity.strategyCode}|${identity.generation}`;

  function register(input) {
    if (!input || typeof input !== 'object') {
      throw new Error('ATTRIBUTION_ROW_REQUIRED');
    }
    const identity = input.engineIdentity;
    if (!identity || !RESEARCH_AUTHORITIES.has(identity.executionAuthority)) {
      throw new Error('ATTRIBUTION_IDENTITY_INVALID');
    }
    if (!nonEmptyString(input.tradeId)) {
      throw new Error('ATTRIBUTION_TRADE_ID_REQUIRED');
    }
    const existing = seenTradeIds.get(input.tradeId);
    if (existing !== undefined) {
      throw new Error(existing === identityKey(identity)
        ? `ATTRIBUTION_DUPLICATE_TRADE_ID:${input.tradeId}`
        : `ATTRIBUTION_CROSS_ENGINE_CONTAMINATION:${input.tradeId}`);
    }
    const openedAt = new Date(input.openedAt).getTime();
    const closedAt = new Date(input.closedAt).getTime();
    if (!Number.isFinite(openedAt) || !Number.isFinite(closedAt) ||
        closedAt < openedAt) {
      throw new Error('ATTRIBUTION_TIMESTAMPS_INVALID');
    }
    if (!nonEmptyString(input.instrument)) {
      throw new Error('ATTRIBUTION_INSTRUMENT_REQUIRED');
    }
    if (!['BUY', 'SELL'].includes(input.direction)) {
      throw new Error('ATTRIBUTION_DIRECTION_INVALID');
    }
    if (!finiteNumber(input.lots) || input.lots <= 0) {
      throw new Error('ATTRIBUTION_LOTS_INVALID');
    }
    ['grossPnl', 'commission', 'swap'].forEach((field) => {
      if (!finiteNumber(input[field])) {
        throw new Error(`ATTRIBUTION_${field.toUpperCase()}_INVALID`);
      }
    });
    const commission = input.commission;
    const swap = input.swap;
    const netPnl = input.grossPnl - Math.abs(commission) - Math.abs(swap);
    const riskAmount = finiteNumber(input.riskAmount) && input.riskAmount > 0
      ? input.riskAmount : null;
    const rMultiple = riskAmount !== null ? netPnl / riskAmount : null;
    const row = Object.freeze({
      engineIdentity: Object.freeze({ ...identity }),
      tradeId: input.tradeId,
      instrument: input.instrument,
      direction: input.direction,
      lots: input.lots,
      openedAt: input.openedAt,
      closedAt: input.closedAt,
      grossPnl: input.grossPnl,
      commission,
      swap,
      netPnl,
      riskAmount,
      rMultiple,
      settlementProvenance: nonEmptyString(input.settlementProvenance)
        ? input.settlementProvenance : 'UNVERIFIED',
    });
    seenTradeIds.set(input.tradeId, identityKey(identity));
    rows.push(row);
    return row;
  }

  /** R6: comparative summary is a read-only projection of the ledger. */
  function summarize() {
    const byEngine = new Map();
    for (const row of rows) {
      const key = identityKey(row.engineIdentity);
      if (!byEngine.has(key)) {
        byEngine.set(key, {
          engineIdentity: row.engineIdentity,
          tradeCount: 0, wins: 0, losses: 0, flats: 0,
          totalNetPnl: 0, totalGrossPnl: 0,
          totalCommission: 0, totalSwap: 0, totalLots: 0,
        });
      }
      const agg = byEngine.get(key);
      agg.tradeCount += 1;
      agg.totalNetPnl += row.netPnl;
      agg.totalGrossPnl += row.grossPnl;
      agg.totalCommission += Math.abs(row.commission);
      agg.totalSwap += Math.abs(row.swap);
      agg.totalLots += row.lots;
      if (row.netPnl > 0) agg.wins += 1;
      else if (row.netPnl < 0) agg.losses += 1;
      else agg.flats += 1;
    }
    return Object.freeze(
      [...byEngine.values()].map((agg) => Object.freeze({
        ...agg,
        winRate: agg.tradeCount > 0 ? agg.wins / agg.tradeCount : null,
        netPerLot: agg.totalLots > 0 ? agg.totalNetPnl / agg.totalLots : null,
      })),
    );
  }

  const ledger = Object.freeze({
    register,
    summarize,
    count: () => rows.length,
    rows: () => rows.map((row) => row), // copies; ledger rows themselves are frozen
  });
  return ledger;
}

module.exports = {
  defineEngineIdentity,
  assertAccountIsolation,
  assertEquivalentStartingConditions,
  createAttributionLedger,
};
