'use strict';

// Independent research artifact: Champion-Challenger DEMO-account isolation
// invariants (iRexPro AI V2 research). Pure logic over SYNTHETIC fixtures.
// No account identifiers, credentials, private datasets, database access,
// broker calls, order placement, deployment or trading authority.
//
// Purpose: encode the assignment amendment as executable invariants:
//   - isolated broker-connected Pepperstone cTrader DEMO accounts,
//   - separate engine identities (CHAMPION AI V1 vs CHALLENGER AI V2),
//   - independent position ownership (an engine may only act on its own
//     positions; cross-engine closes are rejected),
//   - equivalent starting conditions (balance, currency, leverage,
//     instruments, window, cost model) verified before any comparison,
//   - immutable performance attribution (append-only, SHA-bound decision
//     provenance, no mutation, no cross-account netting),
//   - a comparative dashboard emitted ONLY under verified equivalence.

function sha256ish(s) {
  // Deterministic stand-in for a real digest in research fixtures. NOT
  // cryptographic; production would bind a real SHA-256 of the frozen
  // decision record. Collisions here are irrelevant: fixtures are small.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return `fixture-${h.toString(16).padStart(8, '0')}`;
}

const ENGINE_ROLES = Object.freeze(['CHAMPION', 'CHALLENGER']);

function defineEngineIdentity(spec) {
  const errs = [];
  if (spec === null || typeof spec !== 'object') return { errors: ['identity: not an object'] };
  if (!ENGINE_ROLES.includes(spec.role)) errs.push('role must be CHAMPION or CHALLENGER');
  if (typeof spec.engineId !== 'string' || spec.engineId.length === 0) errs.push('engineId required');
  if (typeof spec.accountRef !== 'string' || spec.accountRef.length === 0) errs.push('accountRef required');
  if (typeof spec.accountCurrency !== 'string') errs.push('accountCurrency required');
  if (!(typeof spec.startingBalance === 'number' && spec.startingBalance > 0)) errs.push('startingBalance > 0 required');
  if (!(typeof spec.leverage === 'number' && spec.leverage > 0)) errs.push('leverage > 0 required');
  if (!Array.isArray(spec.instruments) || spec.instruments.length === 0) errs.push('instruments required');
  if (typeof spec.windowStart !== 'string') errs.push('windowStart required');
  if (typeof spec.windowEnd !== 'string') errs.push('windowEnd required');
  if (spec.accountType !== 'DEMO') errs.push('accountType must be DEMO');
  if (typeof spec.engineVersion !== 'string') errs.push('engineVersion required');
  if (typeof spec.decisionPolicySha !== 'string' || spec.decisionPolicySha.length === 0) errs.push('decisionPolicySha required');
  if (errs.length) return { errors: errs };
  return { identity: Object.freeze({ ...spec }) };
}

/** Equivalence of starting conditions between champion and challenger. */
function verifyEquivalentConditions(a, b) {
  const checks = [
    ['startingBalance', a.startingBalance === b.startingBalance],
    ['accountCurrency', a.accountCurrency === b.accountCurrency],
    ['leverage', a.leverage === b.leverage],
    ['instruments', a.instruments.length === b.instruments.length && a.instruments.every((x) => b.instruments.includes(x))],
    ['windowStart', new Date(a.windowStart).getTime() === new Date(b.windowStart).getTime()],
    ['windowEnd', new Date(a.windowEnd).getTime() === new Date(b.windowEnd).getTime()],
    ['accountType', a.accountType === b.accountType && a.accountType === 'DEMO'],
    ['costModel', JSON.stringify(a.costModel || {}) === JSON.stringify(b.costModel || {})],
    ['accountIsolation', a.accountRef !== b.accountRef],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  return { equivalent: failed.length === 0, failed };
}

/**
 * Append-only attribution ledger. Each fill record binds ONE engine identity
 * and ONE account; mutation, duplicate attribution of the same fill, and
 * cross-engine closes are rejected and recorded as audit failures.
 */
function createAttributionLedger() {
  const fills = [];
  const rejections = [];

  function validateFill(f) {
    const errs = [];
    if (f === null || typeof f !== 'object') return ['fill: not an object'];
    if (typeof f.fillId !== 'string' || !f.fillId) errs.push('fillId required');
    if (typeof f.engineId !== 'string' || !f.engineId) errs.push('engineId required');
    if (typeof f.accountRef !== 'string' || !f.accountRef) errs.push('accountRef required');
    if (typeof f.tradeId !== 'string' || !f.tradeId) errs.push('tradeId required');
    if (typeof f.instrument !== 'string' || !f.instrument) errs.push('instrument required');
    if (!['BUY', 'SELL'].includes(f.direction)) errs.push('direction BUY/SELL required');
    if (typeof f.openedAt !== 'string') errs.push('openedAt required');
    if (typeof f.closedAt !== 'string') errs.push('closedAt required');
    if (typeof f.realizedNetAfterCost !== 'number' || !Number.isFinite(f.realizedNetAfterCost)) errs.push('realizedNetAfterCost required');
    if (typeof f.exitType !== 'string' || !f.exitType) errs.push('exitType required');
    if (typeof f.decisionProvenance !== 'string' || !f.decisionProvenance) errs.push('decisionProvenance required');
    return errs;
  }

  return {
    /** Append a settled fill. Rejects duplicates and cross-account mixing. */
    appendFill(f) {
      const errs = validateFill(f);
      if (errs.length) { rejections.push({ fillId: f && f.fillId, reason: 'INVALID_FILL', errors: errs }); return { accepted: false, reason: 'INVALID_FILL', errors: errs }; }
      if (fills.some((x) => x.fillId === f.fillId)) {
        rejections.push({ fillId: f.fillId, reason: 'DUPLICATE_FILL_ATTRIBUTION' });
        return { accepted: false, reason: 'DUPLICATE_FILL_ATTRIBUTION' };
      }
      // Fill's account must match its engine's registered account.
      const owner = this._accountsByEngine.get(f.engineId);
      if (owner && owner !== f.accountRef) {
        rejections.push({ fillId: f.fillId, reason: 'ENGINE_ACCOUNT_MISMATCH', expected: owner, actual: f.accountRef });
        return { accepted: false, reason: 'ENGINE_ACCOUNT_MISMATCH' };
      }
      fills.push({ ...f, decisionProvenanceSha: sha256ish(f.decisionProvenance), appendedAt: 'LEDGER_TIME' });
      return { accepted: true };
    },

    /** Cross-engine close attempt: an engine may only act on its own trade. */
    requestClose({ engineId, tradeId }) {
      const fill = fills.find((x) => x.tradeId === tradeId && !x._closed);
      if (!fill) return { allowed: false, reason: 'UNKNOWN_OR_CLOSED_TRADE' };
      if (fill.engineId !== engineId) {
        rejections.push({ tradeId, reason: 'CROSS_ENGINE_CLOSE_REJECTED', attemptingEngine: engineId, owningEngine: fill.engineId });
        return { allowed: false, reason: 'CROSS_ENGINE_CLOSE_REJECTED' };
      }
      return { allowed: true, tradeId, engineId };
    },

    registerEngineAccount(engineId, accountRef) {
      this._accountsByEngine.set(engineId, accountRef);
    },
    _accountsByEngine: new Map(),

    /** Attempts to mutate an existing attribution are always rejected. */
    tryMutate(fillId, patch) {
      rejections.push({ fillId, reason: 'IMMUTABLE_ATTRIBUTION', attemptedPatch: patch });
      return { accepted: false, reason: 'IMMUTABLE_ATTRIBUTION' };
    },

    rejections: rejections,
    fills: fills,

    /** Per-engine performance attribution; accounts are NEVER netted together. */
    attributionByEngine() {
      const byEngine = new Map();
      for (const f of fills) {
        if (!byEngine.has(f.engineId)) byEngine.set(f.engineId, { engineId: f.engineId, accountRef: f.accountRef, trades: 0, netAfterCost: 0, wins: 0, losses: 0 });
        const e = byEngine.get(f.engineId);
        e.trades += 1;
        e.netAfterCost += f.realizedNetAfterCost;
        if (f.realizedNetAfterCost > 0) e.wins += 1; else if (f.realizedNetAfterCost < 0) e.losses += 1;
      }
      return [...byEngine.values()];
    },
  };
}

/**
 * Comparative dashboard. Requires: equivalence verified, both engines have
 * at least one settled fill, and zero unresolved cross-engine actions. Emits
 * paired metrics WITHOUT declaring a winner when sample sufficiency is unmet.
 */
function comparativeReport(championIdentity, challengerIdentity, ledger, sufficiency) {
  const equiv = verifyEquivalentConditions(championIdentity, challengerIdentity);
  const attribution = ledger.attributionByEngine();
  const champ = attribution.find((a) => a.engineId === championIdentity.engineId);
  const chall = attribution.find((a) => a.engineId === challengerIdentity.engineId);
  const blockers = [];
  if (!equiv.equivalent) blockers.push({ kind: 'STARTING_CONDITIONS_NOT_EQUIVALENT', failed: equiv.failed });
  if (!champ || champ.trades === 0) blockers.push({ kind: 'CHAMPION_NO_SETTLED_FILLS' });
  if (!chall || chall.trades === 0) blockers.push({ kind: 'CHALLENGER_NO_SETTLED_FILLS' });
  const crossEngine = ledger.rejections.filter((r) => r.reason === 'CROSS_ENGINE_CLOSE_REJECTED');
  if (crossEngine.length) blockers.push({ kind: 'CROSS_ENGINE_ACTIONS_REJECTED', count: crossEngine.length });
  const immutable = ledger.rejections.filter((r) => r.reason === 'IMMUTABLE_ATTRIBUTION');
  if (immutable.length) blockers.push({ kind: 'IMMUTABILITY_ENFORCED', count: immutable.length });
  if (sufficiency && (!champ || !chall || champ.trades < sufficiency.minTrades || chall.trades < sufficiency.minTrades)) {
    blockers.push({ kind: 'INSUFFICIENT_SAMPLE', required: sufficiency.minTrades });
  }
  if (blockers.length) {
    return { emitted: false, blockers, equivalence: equiv };
  }
  return {
    emitted: true,
    equivalence: equiv,
    champion: champ,
    challenger: chall,
    paired: {
      netAfterCostDelta: champ.netAfterCost - chall.netAfterCost,
      note: 'Paired difference is descriptive until the pre-registered sufficiency and significance protocol is met; no winner is declared here.',
    },
  };
}

module.exports = {
  defineEngineIdentity,
  verifyEquivalentConditions,
  createAttributionLedger,
  comparativeReport,
  sha256ish,
};
