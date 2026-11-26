'use strict';
// Local-only diagnostic. Never authenticates, connects to a database, or settles orders.
const fs = require('node:fs');
const { parseStatementInput, normalizeDecimals, economicKey } = require('./verify-closed-demo-statement-match.cjs');
const SUMMARY_HEADER = 'Deposit,Withdrawal,Total net,Equity,Unr. P&L,Realised P&L,Margin,Free margin,Margin level';

function cents(value) {
  const normalized = normalizeDecimals(value);
  if (normalized === null || !/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error('INVALID_USD_AMOUNT');
  }
  const negative = normalized.startsWith('-');
  const [whole, fraction = ''] = normalized.replace('-', '').split('.');
  return (negative ? -1n : 1n) * (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
}

function verifyStatementConsistency(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 2_000_000) {
    throw new Error('INVALID_STATEMENT_SIZE');
  }
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0] !== 'Deals') throw new Error('NATIVE_DEALS_EXPORT_REQUIRED');
  const deals = parseStatementInput(text);
  const summaryIndex = lines.indexOf('Summary');
  if (lines[summaryIndex + 1] !== SUMMARY_HEADER || lines[summaryIndex + 3] !== 'Balance' ||
      lines.length !== summaryIndex + 5) {
    throw new Error('UNSUPPORTED_SUMMARY_LAYOUT');
  }
  const summary = lines[summaryIndex + 2].split(',');
  if (summary.length !== 9) throw new Error('INVALID_SUMMARY_ROW');
  const [deposit, withdrawal, totalNet, equity, unrealised, realised, margin, freeMargin] =
    summary.slice(0, 8).map(cents);
  const balance = cents(lines[summaryIndex + 4]);
  const rows = lines.slice(2, summaryIndex - 1).map((line) => line.split(','));
  if (rows.length !== deals.length || rows.some((row) => row.length !== 8)) {
    throw new Error('DEAL_ROW_COUNT_MISMATCH');
  }
  const netAmounts = rows.map((row) => cents(row[6]));
  const balances = rows.map((row) => cents(row[7]));
  const total = netAmounts.reduce((sum, net) => sum + net, 0n);
  const differences = [];
  for (let i = 1; i < rows.length; i++) {
    if (balances[i] - balances[i - 1] !== netAmounts[i]) differences.push(i + 1);
  }
  const checks = {
    consecutiveDealBalancesAgree: differences.length === 0,
    lastDealBalanceAgrees: balances.at(-1) === balance,
    realisedSummaryAgrees: total === realised,
    equityIdentityAgrees: balance + unrealised === equity,
    freeMarginIdentityAgrees: equity - margin === freeMargin,
    fundingSummaryAgrees: deposit - withdrawal === totalNet,
  };
  return {
    readOnly: true,
    executionAuthority: 'NONE',
    brokerIdentityVerified: false,
    settlementProven: false,
    status: Object.values(checks).every(Boolean) ? 'ARITHMETIC_CONSISTENT' : 'REVIEW_REQUIRED',
    deals: deals.length,
    distinctEconomicKeys: new Set(deals.map(economicKey)).size,
    checks,
    consecutiveBalanceMismatchRows: differences,
    // Statement balances do not establish live broker state or absence of orders.
    statementShowsZeroMarginAndUnrealised: margin === 0n && unrealised === 0n,
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('ONE_LOCAL_STATEMENT_REQUIRED');
    const file = process.argv[2];
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 2_000_000) {
      throw new Error('INVALID_STATEMENT_SIZE');
    }
    const result = verifyStatementConsistency(fs.readFileSync(file, 'utf8'));
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'ARITHMETIC_CONSISTENT') process.exitCode = 10;
  } catch {
    console.error('Statement validation failed: unsupported or invalid statement.');
    process.exitCode = 2;
  }
}
module.exports = { verifyStatementConsistency };
