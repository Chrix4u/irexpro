'use strict';
/**
 * V2 Champion broker-confirmed evidence window (P4-0 documented-evidence
 * slice). Parses the sanitized Pepperstone statement fixture derived from
 * the operator upload (`statement-09_44 28.11.2026.csv`) and computes the
 * V1 champion's REAL performance statistics for the 2026-11-10 deal
 * window. Broker deal/order identifiers are replaced with synthetic
 * sequence IDs; all economic values are broker-confirmed and unchanged
 * (sanitization record: AI_ENGINE_V2_SENSITIVE_DATA_REMEDIATION_20261128.md).
 *
 * This is the ONLY real (broker-confirmed) performance data in the V2
 * track. It is a descriptive evidence record — never a profitability
 * claim, never mixed with synthetic results, and never used to calibrate
 * the challenger's parameters.
 */

const fs = require('node:fs');
const path = require('node:path');

const nonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

const EVIDENCE_FILE = 'fixtures/v2-broker-evidence-statement-09-20261110.csv';
const EVIDENCE_PROVENANCE = Object.freeze({
  source: 'operator upload statement-09_44 28.11.2026.csv (2026-11-28)',
  window: '2026-11-10 00:24:39 UTC .. 13:30:01 UTC',
  accountBalanceAtExport: 42404.16,
  // SHA-256 of the operator upload AS RECEIVED (CRLF line endings,
  // broker-native format). The committed fixture is line-ending
  // normalized to LF and identifier-sanitized per house convention;
  // economic content is otherwise byte-identical.
  originalUploadSha256: '174980af474cbc2f2a27eb937bc3ba00955b7d36765094de37a8b7cec895b261',
  normalization: 'CRLF -> LF line endings only (commit house convention); ' +
    'all deal values unchanged',
  sanitization: 'broker deal and order identifiers replaced with deterministic ' +
    'synthetic sequence IDs (DID-S#####, ORD-S#####); every economic field ' +
    '(symbol, direction, timestamps, prices, quantity, net USD, balance USD, ' +
    'summary block) is byte-identical to the operator upload; the real-to-' +
    'synthetic identifier mapping is retained offline by the operator and is ' +
    'never committed (see AI_ENGINE_V2_SENSITIVE_DATA_REMEDIATION_20261128.md)',
  note: 'deals section covers only the 10 Nov 2026 window while the ' +
    'summary block reflects the account state at the 28 Nov 2026 export.',
});

/** Pip size and quote currency conversion per instrument. */
const INSTRUMENT_CONVERSION = Object.freeze({
  EURUSD: Object.freeze({ pip: 0.0001, quote: 'USD' }),
  GBPUSD: Object.freeze({ pip: 0.0001, quote: 'USD' }),
  AUDUSD: Object.freeze({ pip: 0.0001, quote: 'AUD', convert: 'multiplyByPrice' }),
  USDJPY: Object.freeze({ pip: 0.01, quote: 'JPY', convert: 'divideByPrice' }),
  USDCHF: Object.freeze({ pip: 0.0001, quote: 'CHF', convert: 'divideByPrice' }),
});

function pnlUsdFromPoints(symbol, entry, exit, lots) {
  const spec = INSTRUMENT_CONVERSION[symbol];
  if (!spec) throw new Error(`EVIDENCE_INSTRUMENT_UNKNOWN:${String(symbol)}`);
  const direction = 1; // computed for BUY; caller flips sign for SELL
  const delta = (exit - entry) * direction;
  const quoteAmount = delta * lots * 100000;
  if (spec.convert === 'multiplyByPrice') return quoteAmount * exit;
  if (spec.convert === 'divideByPrice') return quoteAmount / exit;
  return quoteAmount;
}

/** Parse the statement file and compute the evidence record. */
function loadBrokerEvidenceWindow(repoRoot, fileName) {
  const file = nonEmptyString(fileName) ? fileName : EVIDENCE_FILE;
  const absolute = path.join(repoRoot, 'apps/api/scripts/research', file);
  if (!fs.existsSync(absolute)) {
    throw new Error(`EVIDENCE_FILE_NOT_FOUND:${file}`);
  }
  const text = fs.readFileSync(absolute, 'utf8');
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines[0] !== 'Deals') {
    throw new Error('EVIDENCE_STATEMENT_FORMAT_UNKNOWN');
  }
  const header = lines[1].split(',');
  const deals = [];
  let windowNetTotal = null;
  let summaryEquity = null;
  let summaryRealised = null;
  let summaryBalance = null;
  for (let i = 2; i < lines.length; i += 1) {
    const cols = lines[i].split(',');
    if (cols[0] === 'Deals') continue;
    if (cols[0] === '') {
      // Total row: ,,,,,,,,,-442.49,
      if (cols.length >= 11 && cols[9] !== '') windowNetTotal = Number(cols[9]);
      continue;
    }
    if (cols[0] === 'Summary') {
      // lines[i+1] is the summary header; lines[i+2] the values row.
      const values = lines[i + 2] ? lines[i + 2].split(',') : null;
      if (values && values.length >= 9) {
        summaryEquity = Number(values[3].replace(/\s/g, ''));
        summaryRealised = Number(values[5].replace(/\s/g, ''));
      }
      i += 2;
      continue;
    }
    if (cols[0] === 'Balance') {
      summaryBalance = Number(lines[i + 1].replace(/\s/g, ''));
      i += 1;
      continue;
    }
    if (cols.length >= 11 && cols[0].startsWith('DID')) {
      const deal = {
        dealId: cols[0],
        orderId: cols[1],
        symbol: cols[2],
        direction: cols[3],
        openedAt: cols[4],
        closedAt: cols[5],
        entryPrice: Number(cols[6]),
        closingPrice: Number(cols[7]),
        lots: Number(cols[8].replace(/\s/g, '').replace('Lots', '')),
        netUsd: Number(cols[9]),
        balanceUsd: Number((cols[10] || '').replace(/\s/g, '')),
      };
      if (!Number.isFinite(deal.entryPrice) || !Number.isFinite(deal.netUsd) ||
          !Number.isFinite(deal.lots) || deal.lots <= 0) {
        throw new Error(`EVIDENCE_DEAL_MALFORMED:${cols[0]}`);
      }
      deals.push(deal);
    }
  }
  if (deals.length === 0) {
    throw new Error('EVIDENCE_DEALS_EMPTY');
  }

  // Duplicate-deal guard (same discipline as the attribution ledger).
  const seen = new Set();
  for (const d of deals) {
    if (seen.has(d.dealId)) {
      throw new Error(`EVIDENCE_DUPLICATE_DEAL_ID:${d.dealId}`);
    }
    seen.add(d.dealId);
  }

  const netSum = deals.reduce((s, d) => s + d.netUsd, 0);
  const wins = deals.filter((d) => d.netUsd > 0);
  const losses = deals.filter((d) => d.netUsd < 0);
  const grossWin = wins.reduce((s, d) => s + d.netUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, d) => s + d.netUsd, 0));

  // Balance-chain continuity inside the window (row i balance = row i-1
  // balance + row i net).
  const chainBreaks = [];
  for (let i = 1; i < deals.length; i += 1) {
    const expected = deals[i - 1].balanceUsd + deals[i].netUsd;
    if (Math.abs(expected - deals[i].balanceUsd) > 0.005) {
      chainBreaks.push({ index: i, dealId: deals[i].dealId,
        expected, observed: deals[i].balanceUsd });
    }
  }

  // Implied round-turn friction per lot, in pips, per deal:
  // theoretical mid P&L vs the broker's Net USD.
  const impliedFrictionPips = deals.map((d) => {
    const theoretical = pnlUsdFromPoints(
      d.symbol, d.entryPrice, d.closingPrice, d.lots,
    ) * (d.direction === 'Buy' ? 1 : -1);
    const pip = INSTRUMENT_CONVERSION[d.symbol].pip;
    // USD value of one pip for one lot, converted at the closing price.
    const pipValuePerLot = Math.abs(
      pnlUsdFromPoints(d.symbol, d.closingPrice, d.closingPrice + pip, 1));
    const frictionUsd = theoretical - d.netUsd;
    return { dealId: d.dealId, symbol: d.symbol,
      frictionPipsPerLot: pipValuePerLot > 0
        ? frictionUsd / pipValuePerLot / d.lots : null };
  }).map((x) => x.frictionPipsPerLot);
  const sortedFriction = impliedFrictionPips.slice().sort((a, b) => a - b);

  // The previously-investigated split-second EURUSD pair.
  const splitSecondPair = deals.length >= 2 &&
    deals[0].symbol === 'EURUSD' && deals[1].symbol === 'EURUSD' &&
    deals[0].openedAt === deals[1].openedAt
    ? Object.freeze([deals[0].dealId, deals[1].dealId]) : null;

  return Object.freeze({
    provenance: EVIDENCE_PROVENANCE,
    file,
    dealCount: deals.length,
    deals: Object.freeze(deals.map((d) => Object.freeze(d))),
    netUsd: netSum,
    windowNetTotalRow: windowNetTotal,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / deals.length,
    grossWinUsd: grossWin,
    grossLossUsd: grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    expectancyUsdPerTrade: netSum / deals.length,
    firstBalanceUsd: deals[0].balanceUsd - deals[0].netUsd,
    lastBalanceUsd: deals[deals.length - 1].balanceUsd,
    chainBreaks: Object.freeze(chainBreaks),
    windowVsAccountGapUsd: summaryBalance !== null
      ? summaryBalance - deals[deals.length - 1].balanceUsd : null,
    summaryEquityUsd: summaryEquity,
    summaryRealisedUsd: summaryRealised,
    summaryBalanceUsd: summaryBalance,
    medianImpliedFrictionPipsPerLot: sortedFriction.length > 0
      ? sortedFriction[Math.floor(sortedFriction.length / 2)] : null,
    splitSecondPair,
    verification: Object.freeze({
      netTotalMatchesDeals: windowNetTotal !== null &&
        Math.abs(windowNetTotal - netSum) < 0.005,
      balanceChainContinuous: chainBreaks.length === 0,
      realizedMatches: summaryRealised !== null &&
        Math.abs(summaryRealised - netSum) < 0.005,
      duplicateDealIds: false,
    }),
  });
}

module.exports = {
  EVIDENCE_FILE,
  EVIDENCE_PROVENANCE,
  INSTRUMENT_CONVERSION,
  loadBrokerEvidenceWindow,
};
