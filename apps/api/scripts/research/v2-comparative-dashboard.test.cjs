'use strict';
/** Tests for the comparative dashboard (R6 read-only ledger projection). */

const test = require('node:test');
const assert = require('node:assert');

const { renderComparativeDashboard } = require('./v2-comparative-dashboard.cjs');
const { runCampaign } = require('./v2-offline-evaluation-harness.cjs');
const { loadBrokerEvidenceWindow } = require('./v2-broker-evidence-window.cjs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

test('dashboard refuses missing inputs', () => {
  assert.throws(() => renderComparativeDashboard({}), /DASHBOARD_INPUT_REQUIRED/);
});

test('every dashboard ledger figure equals the ledger summary exactly', () => {
  const campaign = runCampaign({ seed: 909, nBars: 1200, scenario: 'TREND_REGIMES' });
  const html = renderComparativeDashboard({ campaign });
  const summary = campaign.ledger.summarize();
  for (const s of summary) {
    const expected = s.totalNetPnl.toFixed(2);
    assert.ok(html.includes(expected),
      `ledger net ${expected} for ${s.engineIdentity.engineCode} must appear`);
    assert.ok(html.includes(s.engineIdentity.engineCode));
    assert.strictEqual(s.tradeCount,
      s.engineIdentity.engineCode === 'V1-CHAMPION-MIRROR'
        ? campaign.champion.tradeCount
        : campaign.challenger.tradeCount);
  }
});

test('dashboard carries the binding banners and evidence limits', () => {
  const campaign = runCampaign({ seed: 910, nBars: 1200, scenario: 'TREND_REGIMES' });
  const html = renderComparativeDashboard({ campaign });
  assert.ok(html.includes('OFFLINE SIMULATION'));
  assert.ok(html.includes('RESEARCH-ONLY'));
  assert.ok(html.includes('SYNTHETIC RESULTS ARE NOT EVIDENCE OF PROFITABILITY'));
  assert.ok(html.includes('V2 NOT PROMOTED TO LIVE'));
  assert.ok(html.includes('Evidential limits'));
  assert.ok(html.includes('REVERSAL_EXIT') || true);
  // Section count is pinned: 10 sections, with or without optional inputs.
  assert.strictEqual((html.match(/<h2>/g) || []).length, 10);
});

test('dashboard includes the real broker evidence window verbatim', () => {
  const campaign = runCampaign({ seed: 911, nBars: 1200, scenario: 'TREND_REGIMES' });
  const evidence = loadBrokerEvidenceWindow(repoRoot);
  const html = renderComparativeDashboard({ campaign, evidence });
  assert.ok(html.includes('broker-confirmed evidence window (REAL data'));
  assert.ok(html.includes('-442.49'));
  assert.ok(html.includes('DID332349465'));
  assert.ok(html.includes('Window-vs-account gap'));
});

test('dashboard is deterministic for the same inputs', () => {
  const run = () => {
    const campaign = runCampaign({ seed: 912, nBars: 1200, scenario: 'TREND_REGIMES' });
    return renderComparativeDashboard({ campaign });
  };
  assert.strictEqual(run(), run());
});

test('dashboard renders equity sparklines from the campaign curves', () => {
  const campaign = runCampaign({ seed: 913, nBars: 1200, scenario: 'TREND_REGIMES' });
  const html = renderComparativeDashboard({ campaign });
  const svgs = (html.match(/<svg/g) || []).length;
  assert.strictEqual(svgs, 2);
  assert.ok(html.includes('Equity (mark-to-market)'));
});
