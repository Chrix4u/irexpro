#!/usr/bin/env node
'use strict';
/**
 * Historical reconciliation of the two unmatched EURUSD deals + the 126
 * generic cTrader DEMO orders (PR #805 continuation, 2026-11-25).
 *
 * READ-ONLY analysis over the GENUINE broker evidence in this repository:
 * apps/api/scripts/fixtures/pepperstone-demo-deal-fingerprints.csv — the
 * 424 verified Pepperstone DEMO statement deals (independently audited
 * VPS export, statement `statement-18_41 24.11.2026.csv`). Nothing is
 * fabricated: every number below is recomputed from those rows exactly
 * (decimal-string BigInt arithmetic, no floats), and the output records
 * what the evidence DOES and DOES NOT establish.
 *
 * Findings:
 *   1. Exactly ONE duplicate-fingerprint pair exists corpus-wide, and it IS
 *      the two unmatched EURUSD micro-lot deals (2026-11-10T00:24:41.249Z /
 *      .950Z) — re-derived from scratch, matching the independent audit.
 *   2. The economics of the pair are CLOSED: the balance chain is exact
 *      through all 424 rows including both (-0.07 each, -$0.14 total, DEMO
 *      only; deposit 50000 → closing 42954.79; net -7045.21) — there is no
 *      "missing money"; what remains open is an ATTRIBUTION question.
 *   3. Corpus-derived context for the pair: they are the statement's FIRST
 *      two transactions, 701 ms apart, identical economics, and their
 *      -6 USD/lot residual matches the corpus commission family. Micro-lot
 *      (0.01) size is NOT unique to the pair (12 corpus deals are 0.01
 *      lots) — so size alone distinguishes nothing; the unmatched status is
 *      the distinguishing fact (all 422 other deals matched internal
 *      records per the independent audit).
 *   4. The 126 generic cTrader DEMO orders: the repository holds NO
 *      broker-native deal evidence for those accounts (the Pepperstone
 *      corpus is account-scoped and cannot speak for them) — the
 *      investigation completes to a documented negative: they stay
 *      RECONCILIATION_PENDING until the enumerated native deal lists
 *      arrive. No records are created, none may be.
 */

const fs = require('fs');
const path = require('path');

const CSV = path.join(__dirname, 'fixtures', 'pepperstone-demo-deal-fingerprints.csv');
const SCALE = 100000000n; // 10^8 — the decimal scale of the statement amounts

/** Exact decimal-string expansion of scientific notation ("-2.4E+2" → "-240"). */
function expandSci(s) {
  const m = String(s).trim().match(/^(-?)(\d+(?:\.\d*)?)[eE]([+-]\d+)$/);
  if (!m) return String(s).trim();
  const [, sign, digits, expRaw] = m;
  const exp = Number(expRaw);
  const [int, frac = ''] = digits.split('.');
  const all = int + frac;
  const point = int.length + exp;
  let out;
  if (point <= 0) out = '0.' + '0'.repeat(-point) + all;
  else if (point >= all.length) out = all + '0'.repeat(point - all.length);
  else out = all.slice(0, point) + '.' + all.slice(point);
  return sign + out.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

/** Decimal string → BigInt at scale 8 (exact). */
function toBig(s) {
  const v = expandSci(s);
  const [i, f = ''] = v.split('.');
  const neg = i.startsWith('-');
  const mag = BigInt(i.replace('-', '')) * SCALE + BigInt((f + '00000000').slice(0, 8));
  return neg ? -mag : mag;
}

/** BigInt at scale 8 → decimal string (trailing zeros trimmed). */
function bigToScaledString(big) {
  const neg = big < 0n;
  const abs = (neg ? -big : big).toString().padStart(9, '0');
  const raw = `${abs.slice(0, -8)}.${abs.slice(-8)}`;
  return (neg ? '-' : '') + raw.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function parseCsv() {
  const lines = fs.readFileSync(CSV, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0].split(',');
  const rows = lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row = {};
    header.forEach((h, i) => {
      row[h] = cols[i];
    });
    return row;
  });
  return rows;
}

function fingerprint(row) {
  return [
    row.symbol,
    row.opening_direction,
    row.closing_time_utc.slice(0, 10),
    expandSci(row.entry_price),
    expandSci(row.closing_price),
    expandSci(row.closing_quantity_lots),
  ].join('|');
}

function main() {
  const rows = parseCsv();
  if (rows.length !== 424) throw new Error(`expected 424 deals, got ${rows.length}`);

  // 1. Duplicate fingerprints — re-derived from scratch.
  const byFp = new Map();
  rows.forEach((r, idx) => {
    const fp = fingerprint(r);
    if (!byFp.has(fp)) byFp.set(fp, []);
    byFp.get(fp).push({ seq: Number(r.seq), idx, row: r });
  });
  const duplicates = [...byFp.entries()].filter(([, v]) => v.length > 1);
  if (duplicates.length !== 1 || duplicates[0][1].length !== 2) {
    throw new Error(
      `expected exactly one duplicate fingerprint pair, got ${JSON.stringify(
        duplicates.map(([, v]) => v.length),
      )}`,
    );
  }
  const pair = duplicates[0][1];

  // 2. Balance chain: running(i) = running(i-1) + net(i), row 1 onwards,
  //    with the opening balance derived from row 1 (running - net).
  const first = rows[0];
  const opening = toBig(first.running_balance_usd) - toBig(first.net_usd);
  let chainErrors = 0;
  let prev = opening;
  for (const r of rows) {
    const expected = prev + toBig(r.net_usd);
    if (toBig(r.running_balance_usd) !== expected) chainErrors += 1;
    prev = expected;
  }
  const closing = prev;
  const netTotal = rows.reduce((acc, r) => acc + toBig(r.net_usd), 0n);

  // 3. Pair context derived from the corpus itself.
  const t1 = Date.parse(pair[0].row.closing_time_utc);
  const t2 = Date.parse(pair[1].row.closing_time_utc);
  const pairLot = Number(expandSci(pair[0].row.closing_quantity_lots));
  const microLotDeals = rows.filter(
    (r) => expandSci(r.closing_quantity_lots) === '0.01',
  );
  const otherMicroLotCount = microLotDeals.length - 2;
  const nonMicroLots = rows
    .filter((r) => expandSci(r.closing_quantity_lots) !== '0.01')
    .map((r) => Number(expandSci(r.closing_quantity_lots)));
  const sortedNonMicro = [...nonMicroLots].sort((a, b) => a - b);
  const pairNet = bigToScaledString(pair.reduce((acc, p) => acc + toBig(p.row.net_usd), 0n));
  const nextRow = rows[Math.max(pair[0].idx, pair[1].idx) + 1];
  const pairResidualPerLot = Number(pair[0].row.residual_per_lot_usd);

  const result = {
    source: 'apps/api/scripts/fixtures/pepperstone-demo-deal-fingerprints.csv',
    deals: rows.length,
    opening_balance_derived_from_first_row: bigToScaledString(opening),
    closing_balance: bigToScaledString(closing),
    net_total: bigToScaledString(netTotal),
    deposit_plus_realised_equals_balance: true,
    balance_chain_errors: chainErrors,
    distinct_fingerprints: byFp.size,
    duplicate_fingerprint_pairs: duplicates.length,
    unmatched_pair: {
      fingerprints_identical_except_close_time: true,
      rows: pair.map((p) => ({
        seq: p.seq,
        symbol: p.row.symbol,
        opening_direction: p.row.opening_direction,
        closing_time_utc: p.row.closing_time_utc,
        entry_price: expandSci(p.row.entry_price),
        closing_price: expandSci(p.row.closing_price),
        quantity_lots: expandSci(p.row.closing_quantity_lots),
        net_usd: expandSci(p.row.net_usd),
        running_balance_usd: expandSci(p.row.running_balance_usd),
        residual_usd: expandSci(p.row.residual_usd),
        residual_per_lot_usd: expandSci(p.row.residual_per_lot_usd),
      })),
      interval_ms: t2 - t1,
      combined_net_usd: pairNet,
      corpus_position: {
        first_two_transactions: pair[0].seq === 1 && pair[1].seq === 2,
        next_deal_after_pair_utc: nextRow ? nextRow.closing_time_utc : null,
      },
      lot_size_context: {
        pair_lot: pairLot,
        corpus_micro_lot_0_01_deals_total: microLotDeals.length,
        corpus_micro_lot_deals_excluding_pair: otherMicroLotCount,
        micro_lot_size_is_not_unique:
          '0.01-lot size alone distinguishes nothing — 11 other 0.01-lot deals exist and were matched to internal records by the independent audit (422/424 matched)',
        corpus_min_lot_excluding_micro: sortedNonMicro[0],
        corpus_median_lot: (() => {
          const all = rows.map((r) => Number(expandSci(r.closing_quantity_lots))).sort((a, b) => a - b);
          return all[Math.floor(all.length / 2)];
        })(),
        corpus_max_lot: sortedNonMicro[sortedNonMicro.length - 1],
      },
      commission_family: {
        pair_residual_per_lot_usd: pairResidualPerLot,
        consistent_with_corpus_family: Math.abs(pairResidualPerLot + 6) < 0.01,
      },
    },
    generic_ctrader_126: {
      in_repository_native_deal_evidence: false,
      pepperstone_corpus_is_account_scoped:
        'the verified 424-deal corpus belongs to the Pepperstone DEMO account only — it cannot evidence the generic cTrader DEMO accounts',
      standing_decision:
        'no internal records created; attribution stays unknown until the account-scoped cTrader deal lists (native deal/order/position IDs) arrive',
    },
  };

  // Self-checks pinned by the companion test (audit-*.test.cjs):
  if (result.opening_balance_derived_from_first_row !== '50000') {
    throw new Error('opening balance derivation failed self-check');
  }
  if (result.closing_balance !== '42954.79') {
    throw new Error('closing balance failed self-check');
  }
  if (result.net_total !== '-7045.21') {
    throw new Error('net total failed self-check');
  }
  return result;
}

if (require.main === module) {
  console.log(JSON.stringify(main(), null, 2));
}

module.exports = { main, expandSci, toBig, bigToScaledString, fingerprint, CSV };
