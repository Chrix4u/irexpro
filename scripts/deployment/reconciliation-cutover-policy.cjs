'use strict';

/**
 * Pure, fail-closed policy for READ-ONLY cutover evidence.
 * No external calls, broker actions, database writes or user identifiers.
 * Broker-side truth and restart-safe scheduler guarantees remain independent
 * mandatory gates even if all internal counters reach zero.
 */
function evaluateReconciliationEvidence(evidence, clock = new Date()) {
  const issues = [];
  const add = (condition, reason) => { if (condition) issues.push(reason); };
  if (!evidence || typeof evidence !== 'object' || !evidence.trade) {
    return { passed: false, issues: ['Read-only reconciliation evidence missing'] };
  }
  const rows = Array.isArray(evidence.orders) ? evidence.orders : null;
  const discrepancies = Array.isArray(evidence.discrepancies) ? evidence.discrepancies : null;
  const runs = Array.isArray(evidence.stateRuns) ? evidence.stateRuns : null;
  if (!rows || !discrepancies || !runs) {
    return { passed: false, issues: ['Missing order, discrepancy or state-run evidence'] };
  }
  const count = v => Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : NaN;
  const nonclosed = count(evidence.trade.nonclosed);
  const noClosedAt = count(evidence.trade.unclosed);
  add(!Number.isFinite(nonclosed) || !Number.isFinite(noClosedAt),
      'Invalid trade-ledger counters');
  add(nonclosed > 0 || noClosedAt > 0, 'One or more trade-ledger rows are not conclusively closed');
  const unresolved = rows.reduce((n, r) => n + count(r.n), 0);
  add(!Number.isFinite(unresolved), 'Invalid unresolved-order counters');
  add(unresolved > 0, 'Broker-associated orders remain unresolved in the order ledger');
  const open = discrepancies.reduce((n, r) => n + count(r.n), 0);
  add(!Number.isFinite(open), 'Invalid open-discrepancy counters');
  add(open > 0, 'Open broker/state discrepancies remain, including unknown execution outcomes');
  for (const r of runs) {
    const createdAt = r.last_run_at && new Date(r.last_run_at);
    const fresh = createdAt instanceof Date &&
      !Number.isNaN(createdAt.getTime()) &&
      clock.getTime() - createdAt.getTime() >= 0 &&
      clock.getTime() - createdAt.getTime() <= 15 * 60_000;
    add(!fresh, 'State reconciliation evidence is absent, stale or in the future');
    add(r.status !== 'COMPLETED' && r.status !== 'COMPLETED_WITH_WARNINGS',
        'Latest state reconciliation has not completed');
    add(count(r.provider_positions_seen) > 0,
        'Provider positions were visible during a state reconciliation sweep');
    add(count(r.errors) > 0, 'State reconciliation reported processing errors');
    add(!Number.isFinite(count(r.errors)) || !Number.isFinite(count(r.provider_positions_seen)),
        'Invalid reconciliation-run counters');
  }
  if (rows.length > 0 && runs.length === 0) {
    issues.push('Pending-order connections have no state reconciliation evidence');
  }
  const kinds = Object.create(null);
  for (const r of discrepancies) {
    const name = String(r.type || 'UNKNOWN');
    kinds[name] = (kinds[name] || 0) + count(r.n);
  }
  return {
    passed: issues.length === 0,
    issues: [...new Set(issues)],
    summary: {
      unclosedTrades: noClosedAt,
      nonclosedTrades: nonclosed,
      unresolvedOrders: unresolved,
      openDiscrepancies: open,
      unresolvedExecutionDiscrepancies: kinds.UNRESOLVED_EXECUTION_RESULT || 0,
      externalPositionClosureDiscrepancies: kinds.POSITION_CLOSED_EXTERNALLY || 0,
      stateRunConnectionsChecked: runs.length,
    },
  };
}

module.exports = { evaluateReconciliationEvidence };
