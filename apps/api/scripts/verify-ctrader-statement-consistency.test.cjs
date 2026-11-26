'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyStatementConsistency } = require('./verify-ctrader-statement-consistency.cjs');

const fixture = [
  'Deals',
  'Symbol,Opening direction,Closing time (UTC+0),Entry price,Closing price,Closing quantity,Net USD,Balance USD',
  'EURUSD,Buy,03 Jan 2026 12:00:00.001,1.10,1.20,1.25\u00a0Lots,12.34,1\u00a0000.00',
  'GBPUSD,Sell,03 Jan 2026 13:00:00.002,1.20,1.10,0.5\u00a0Lots,-2.34,997.66',
  ',,,,,,10.00,',
  '',
  'Summary',
  'Deposit,Withdrawal,Total net,Equity,Unr. P&L,Realised P&L,Margin,Free margin,Margin level',
  '1000.00,12.34,987.66,997.66,0.00,10.00,0.00,997.66,—',
  '',
  'Balance',
  '997.66',
].join('\r\n');

test('consistent native USD statement does not confer settlement or account identity proof', () => {
  const report = verifyStatementConsistency(fixture);
  assert.equal(report.status, 'ARITHMETIC_CONSISTENT');
  assert.equal(report.deals, 2);
  assert.equal(report.brokerIdentityVerified, false);
  assert.equal(report.settlementProven, false);
  assert.equal(report.executionAuthority, 'NONE');
  assert.equal(report.statementShowsZeroMarginAndUnrealised, true);
});

test('one-cent differences in consecutive balances are visible', () => {
  const report = verifyStatementConsistency(fixture.replace('1\u00a0000.00', '1\u00a0000.01'));
  assert.equal(report.status, 'REVIEW_REQUIRED');
  assert.deepEqual(report.consecutiveBalanceMismatchRows, [2]);
});

test('summary differences are distinct from deal balance discrepancies', () => {
  const report = verifyStatementConsistency(fixture.replace('987.66,997.66,0.00,10.00,0.00,997.66', '987.66,997.66,0.00,10.01,0.00,997.66'));
  assert.equal(report.checks.realisedSummaryAgrees, false);
  assert.equal(report.checks.consecutiveDealBalancesAgree, true);
});

test('incomplete and unsupported statements fail closed', () => {
  assert.throws(() => verifyStatementConsistency(fixture.replace('Balance\r\n997.66', '')), /UNSUPPORTED_SUMMARY_LAYOUT/);
  assert.throws(() => verifyStatementConsistency(fixture.replace('10.00,\r\n', '10.01,\r\n')), /DEALS_TOTAL_MISMATCH/);
  assert.throws(() => verifyStatementConsistency(fixture.replace('997.66,—', '997.661,—')), /INVALID_USD_AMOUNT/);
});
