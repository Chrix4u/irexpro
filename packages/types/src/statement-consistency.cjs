'use strict';
// Pure statement evidence functions shared by CLI and local browser validation.
// No network, disk, account access, or settlement authority.
function decimalToScaled(value, scale) {
  const s = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const [i = '0', f = ''] = s.replace('-', '').split('.');
  if (/[1-9]/.test(f.slice(scale))) return null;
  const frac = (f + '0'.repeat(scale)).slice(0, scale);
  const v = BigInt(i || '0') * 10n ** BigInt(scale) + BigInt(frac || '0');
  return negative ? -v : v;
}

function compareDecimal(a, b, scale = 8) {
  const x = decimalToScaled(a, scale);
  const y = decimalToScaled(b, scale);
  if (x === null || y === null) return null;
  return x < y ? -1 : x > y ? 1 : 0;
}

function normalizeDecimals(value) {
  if (value === null || value === undefined) return null;
  let s = String(value).replace(/\u00a0/g, '').trim();
  // Statement exports may encode exact decimal amounts in scientific notation.
  // Expand the coefficient as text; never round through a floating-point value.
  const scientific = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(s);
  if (scientific) {
    const [, sign, whole, fraction = '', exponent] = scientific;
    const shift = Number(exponent);
    if (!Number.isSafeInteger(shift) || Math.abs(shift) > 100) return null;
    const digits = whole + fraction;
    const point = whole.length + shift;
    s = sign + (point <= 0 ? '0.' + '0'.repeat(-point) + digits :
      point >= digits.length ? digits + '0'.repeat(point - digits.length) :
      digits.slice(0, point) + '.' + digits.slice(point));
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return null;
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const [i, f = ''] = body.split('.');
  const int = i.replace(/^0+(?=\d)/, '') || '0';
  const frac = (f || '').replace(/0+$/, '');
  const norm = frac.length ? `${int}.${frac}` : int;
  return (negative && (norm !== '0')) ? `-${norm}` : norm;
}

// ─── statement fingerprint parsing ──────────────────────────────────────────
function parseFingerprints(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('EMPTY_FINGERPRINT_CSV');
  const header = lines[0].split(',').map((h) => h.trim());
  const need = [
    'symbol',
    'opening_direction',
    'closing_time_utc',
    'entry_price',
    'closing_price',
    'closing_quantity_lots',
  ];
  const idx = {};
  for (const name of need) {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`MISSING_FINGERPRINT_COLUMN:${name}`);
    idx[name] = i;
  }
  const netIdx = header.indexOf('net_usd');
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const day = String(cells[idx.closing_time_utc] || '').slice(0, 10); // YYYY-MM-DD
    const row = {
      symbol: (cells[idx.symbol] || '').trim(),
      openingDirection: (cells[idx.opening_direction] || '').trim().toUpperCase(),
      closingDirection: (cells[idx.symbol] ? '' : ''),
      day,
      entry: normalizeDecimals(cells[idx.entry_price]),
      exit: normalizeDecimals(cells[idx.closing_price]),
      lots: normalizeDecimals(cells[idx.closing_quantity_lots]),
      net: netIdx >= 0 ? normalizeDecimals(cells[netIdx]) : null,
      raw: line,
    };
    row.closingDirection = row.openingDirection === 'BUY' ? 'SELL' : 'BUY';
    if (!row.symbol || !['BUY', 'SELL'].includes(row.openingDirection) || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || row.entry === null || row.exit === null || row.lots === null) {
      throw new Error(`UNPARSEABLE_FINGERPRINT_ROW:${line.slice(0, 120)}`);
    }
    rows.push(row);
  }
  return rows;
}

// cTrader UTC Deals export. Strictly translate the supported unquoted layout
// into the existing fingerprint schema; never derive a deal from a balance row.
// Reject unsupported formats instead of silently omitting economic evidence.
function parseStatementInput(csvText) {
  const text = csvText.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== 'Deals') return parseFingerprints(text);
  const expected = 'Symbol,Opening direction,Closing time (UTC+0),Entry price,Closing price,Closing quantity,Net USD,Balance USD';
  if (lines[1]?.trim() !== expected) throw new Error('UNSUPPORTED_DEALS_HEADER');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const output = ['symbol,opening_direction,closing_time_utc,entry_price,closing_price,closing_quantity_lots,net_usd'];
  let total = 0n;
  let foundTotal = false;
  let foundSummary = false;
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line === 'Summary') {
      foundSummary = true;
      break;
    }
    const cells = line.split(',').map((cell) => cell.trim());
    if (cells.length !== 8) throw new Error('INVALID_DEALS_ROW');
    if (cells.slice(0, 6).every((cell) => cell === '') && cells[7] === '') {
      const net = decimalToScaled(normalizeDecimals(cells[6]), 8);
      if (foundTotal || net === null || net !== total) throw new Error('DEALS_TOTAL_MISMATCH');
      foundTotal = true;
      continue;
    }
    if (foundTotal) throw new Error('UNEXPECTED_DEAL_AFTER_TOTAL');
    const [symbol, side, timestamp, entryRaw, exitRaw, quantity, netRaw, balanceRaw] = cells;
    const date = /^(\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(timestamp);
    const qty = /^(\d+(?:\.\d+)?)\s+Lots?$/.exec(quantity);
    if (!date || !qty || !/^[A-Z0-9._-]+$/.test(symbol) || !['BUY', 'SELL'].includes(side.toUpperCase())) {
      throw new Error('INVALID_DEAL_FORMAT');
    }
    const [, day, month, year, hour, minute, second, millis] = date;
    const monthIndex = months.indexOf(month);
    if (monthIndex < 0) throw new Error('INVALID_DEAL_UTC_TIMESTAMP');
    const iso = year + '-' + String(monthIndex + 1).padStart(2, '0') + '-' + day +
      'T' + hour + ':' + minute + ':' + second + '.' + millis + 'Z';
    const parsed = new Date(iso);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== iso) throw new Error('INVALID_DEAL_UTC_TIMESTAMP');
    const [entry, exit, lots, net, balance] = [entryRaw, exitRaw, qty[1], netRaw, balanceRaw].map(normalizeDecimals);
    if ([entry, exit, lots, net, balance].some((value) => value === null) ||
      [entry, exit, lots].some((value) => compareDecimal(value, '0') !== 1)) throw new Error('INVALID_DEAL_ECONOMICS');
    const scaledNet = decimalToScaled(net, 8);
    if (scaledNet === null) throw new Error('INVALID_DEAL_NET');
    total += scaledNet;
    output.push([symbol, side, iso, entry, exit, lots, net].join(','));
  }
  if (!foundTotal || !foundSummary || output.length < 2) throw new Error('INCOMPLETE_DEALS_SECTION');
  return parseFingerprints(output.join('\n'));
}

function economicKey(row) {
  return [row.symbol, row.openingDirection, row.day, row.entry, row.exit, row.lots].join('|');
}

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
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > 2_000_000) {
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


module.exports = {
  decimalToScaled, compareDecimal, normalizeDecimals, parseFingerprints,
  parseStatementInput, economicKey, verifyStatementConsistency,
};
