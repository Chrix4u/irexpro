'use strict';
/**
 * V2 comparative performance dashboard (P2-4, R6). A read-only projection
 * of the attribution ledger, the campaign metric blocks and the
 * broker-confirmed evidence window. Single code path: every number in the
 * HTML is derived from the objects passed in — the dashboard itself
 * computes nothing, so it cannot diverge from the ledger.
 *
 * Self-contained static HTML (inline CSS + inline SVG sparklines; no
 * scripts, no external assets) so an independent reviewer can open it
 * anywhere. Research-only.
 */

const fmt = (v, digits = 2) => (v === null || v === undefined || Number.isNaN(v)
  ? '—' : Number(v).toFixed(digits));
const pct = (v, digits = 1) => (v === null || v === undefined || Number.isNaN(v)
  ? '—' : `${(100 * v).toFixed(digits)}%`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

function sparklineSvg(series, color) {
  if (!Array.isArray(series) || series.length < 2) return '';
  const w = 260;
  const h = 40;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const points = series.map((v, i) => {
    const x = (i / (series.length - 1)) * w;
    const y = h - ((v - min) / span) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    `role="img" aria-label="equity sparkline"><polyline points="${points}" ` +
    `fill="none" stroke="${color}" stroke-width="1.5"/></svg>`;
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { font: 14px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  margin: 0; padding: 24px; background: #f6f7f9; color: #14171c; }
h1 { font-size: 19px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 28px 0 8px; border-bottom: 2px solid #d9dce1;
  padding-bottom: 4px; }
.banner { background: #14171c; color: #fff; padding: 8px 12px; border-radius: 6px;
  display: inline-block; margin: 6px 6px 0 0; font-size: 12px; }
.banner.warn { background: #8a2b13; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px;
  background: #fff; font-size: 12.5px; }
th, td { border: 1px solid #d9dce1; padding: 5px 8px; text-align: right; }
th { background: #eceef2; text-align: left; font-weight: 600; }
td:first-child, th:first-child { text-align: left; }
tr.champion td { background: #f2f6fa; }
tr.challenger td { background: #f6f2f4; }
.pos { color: #0d6a2f; } .neg { color: #9c2b13; }
.muted { color: #56606b; }
.note { font-size: 12px; color: #56606b; margin: 4px 0 12px; }
.panel { background: #fff; border: 1px solid #d9dce1; border-radius: 8px;
  padding: 12px 16px; margin: 10px 0; }
code { background: #eceef2; padding: 1px 4px; border-radius: 3px; }
.spark { vertical-align: middle; }
ul { margin: 6px 0; padding-left: 18px; }
`;

/**
 * Render the dashboard. inputs: { campaign, nullCampaign, edgeCampaign,
 * dominance, evidence, meta } — all produced by the harness modules.
 */
function renderComparativeDashboard(inputs) {
  if (!inputs || !inputs.campaign || !inputs.campaign.ledger) {
    throw new Error('DASHBOARD_INPUT_REQUIRED');
  }
  const { campaign, nullCampaign, edgeCampaign, dominance, evidence, meta } = inputs;
  const sides = [
    { key: 'champion', label: 'V1 Champion — simplified S1 mirror', cls: 'champion' },
    { key: 'challenger', label: 'V2 Challenger', cls: 'challenger' },
  ];

  const ledgerSummary = campaign.ledger.summarize();
  const ledgerRows = campaign.ledger.rows();
  const summaryBy = Object.fromEntries(ledgerSummary.map((s) =>
    [s.engineIdentity.engineCode, s]));

  const metricRows = [
    ['Settled trades', (m) => fmt(m.tradeCount, 0)],
    ['Win rate (Wilson 95%)', (m) => `${pct(m.performance.winRate)} [${pct(m.performance.winRateWilson95[0])}, ${pct(m.performance.winRateWilson95[1])}]`],
    ['Cost-adjusted expectancy (net R/trade)', (m) => fmt(m.performance.meanNetR, 3)],
    ['Profit factor', (m) => fmt(m.performance.profitFactor)],
    ['Total net (USD, ledger)', (m) => {
      const eng = m === campaign.champion ? 'V1-CHAMPION-MIRROR' : 'V2-CHALLENGER';
      return fmt(summaryBy[eng] ? summaryBy[eng].totalNetPnl : null);
    }],
    ['Entry discrimination AUC (z, settled trades — exit-confounded)', (m) => `${fmt(m.discrimination.auc, 4)} (z ${fmt(m.discrimination.z, 2)})`],
    ['Calibration ECE / Brier', (m) => m.calibration
      ? `${fmt(m.calibration.expectedCalibrationError, 4)} / ${fmt(m.calibration.brierScore, 4)}`
      : '—'],
    ['Exit efficiency: mean capture', (m) => pct(m.exitEfficiency.meanCapture)],
    ['Profit retention (capture of MFE)', (m) => pct(m.exitEfficiency.meanRetention)],
    ['Mean give-back (1 − capture)', (m) => pct(m.exitEfficiency.meanGiveback)],
    ['Loss cut ratio (|realized|/|MAE|)', (m) => fmt(m.exitEfficiency.meanLossCut, 3)],
    ['Dominant deficit channel', (m) => esc(m.decomposition.decomposition.dominant)],
    ['Loss-cut benefit (R)', (m) => fmt(m.decomposition.lossCutBenefitR, 1)],
    ['Drawdown: trade-level (R)', (m) => fmt(m.drawdown.tradeLevelMaxDDR, 1)],
    ['Drawdown: equity (USD)', (m) => fmt(m.drawdown.equityMaxDDUsd, 0)],
  ].map(([label, fn]) => {
    const cells = sides.map((s) => `<td class="${s.cls === 'champion' ? 'champion' : 'challenger'}">${fn(campaign[s.key])}</td>`).join('');
    return `<tr><th>${label}</th>${cells}</tr>`;
  }).join('');

  const exitReasonRows = Object.entries(
    campaign.challenger.exitEfficiency.exitReasons,
  ).map(([reason, s]) => {
    const champ = campaign.champion.exitEfficiency.exitReasons[reason];
    return `<tr><td>${esc(reason)}</td>` +
      `<td>${champ ? `${champ.count}` : '—'}</td>` +
      `<td>${champ ? fmt(champ.meanNetR, 3) : '—'}</td>` +
      `<td>${s.count}</td><td>${fmt(s.meanNetR, 3)}</td></tr>`;
  }).join('');

  const reliabilityRows = campaign.challenger.calibration
    ? campaign.challenger.calibration.reliability.map((b) => `<tr><td>bin ${b.bin} [${b.meanPredicted.toFixed(2)}]</td><td>${b.count}</td><td>${pct(b.meanPredicted)}</td><td>${pct(b.meanObserved)}</td><td>${pct(b.gap)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">no registrations</td></tr>';

  const notIncluded = '<h2>SECTION</h2><p class="note">not included in this render (input not supplied).</p>';
const evidenceBlock = evidence ? `
<h2>3 · V1 broker-confirmed evidence window (REAL data — not simulation)</h2>
<div class="panel">
<table>
<tr><th>Measure</th><th>Value (broker statement, 2026-11-10 window)</th></tr>
<tr><td>Deals in window</td><td>${evidence.dealCount}</td></tr>
<tr><td>Net USD (window)</td><td class="${evidence.netUsd < 0 ? 'neg' : 'pos'}">${fmt(evidence.netUsd)}</td></tr>
<tr><td>Win rate / profit factor</td><td>${pct(evidence.winRate)} / ${fmt(evidence.profitFactor)}</td></tr>
<tr><td>Expectancy per trade</td><td>${fmt(evidence.expectancyUsdPerTrade)} USD</td></tr>
<tr><td>Balance chain in window</td><td>${evidence.firstBalanceUsd} → ${evidence.lastBalanceUsd} (${evidence.chainBreaks.length} breaks)</td></tr>
<tr><td>Account state at export (28 Nov)</td><td>equity ${evidence.summaryEquityUsd} / balance ${evidence.summaryBalanceUsd}</td></tr>
<tr><td>Window-vs-account gap</td><td>${fmt(evidence.windowVsAccountGapUsd)} USD (window covers only the 10 Nov deals)</td></tr>
<tr><td>Verification</td><td>${['netTotalMatchesDeals', 'balanceChainContinuous', 'realizedMatches', 'duplicateDealIds']
    .map((k) => `${k}=${evidence.verification[k]}`).join('; ')}</td></tr>
<tr><td>Median implied friction</td><td>${fmt(evidence.medianImpliedFrictionPipsPerLot, 3)} pips/lot (theoretical mid P&amp;L vs broker Net)</td></tr>
<tr><td>Split-second EURUSD pair</td><td>${evidence.splitSecondPair ? esc(evidence.splitSecondPair.join(' + ')) + ' (prior investigation)' : '—'}</td></tr>
</table>
<p class="note">This is the V1 champion's only broker-confirmed performance datum in the V2 track.
No profitability claim of any kind is derived from it; it is reported exactly as the broker stated it.</p>
</div>` : notIncluded.replace('SECTION', '3 · V1 broker-confirmed evidence window (REAL data — not simulation)');

  const nullBlock = nullCampaign ? `
<h2>4 · Null-campaign calibration (framework validation, P3-1)</h2>
<table>
<tr><th>Comparison</th><th>Eligible replays</th><th>False positives</th><th>Rate (nominal 5%)</th></tr>
<tr><td>Champion expectancy</td><td>${nullCampaign.eligible.champion}</td><td>${nullCampaign.declared.champion}</td><td>${pct(nullCampaign.falsePositiveRate.champion)}</td></tr>
<tr><td>Challenger expectancy</td><td>${nullCampaign.eligible.challenger}</td><td>${nullCampaign.declared.challenger}</td><td>${pct(nullCampaign.falsePositiveRate.challenger)}</td></tr>
<tr><td>Paired win-rate (Newcombe)</td><td>${nullCampaign.eligible.paired}</td><td>${nullCampaign.declared.paired}</td><td>${pct(nullCampaign.falsePositiveRate.pairedWinRate)}</td></tr>
</table>
<p class="note">Pre-registered declaration: ${esc(nullCampaign.preRegisteredDeclaration)}. ${nullCampaign.replays} replays × ${nullCampaign.nBars} bars, EDGE_ZERO markets.</p>` : notIncluded.replace('SECTION', '4 · Null-campaign calibration (framework validation, P3-1)');

  const edgeRows = edgeCampaign ? edgeCampaign.campaigns.map((c) => `<tr>
<td>${fmt(c.plantedAuc)}</td><td>${fmt(c.verifiedPlantedAuc, 4)}</td><td>${fmt(c.meanMeasuredAuc, 4)}</td>
<td>${c.perClassN}</td><td>${c.trials}</td><td>${pct(c.detectionRate)}</td></tr>`).join('') : '';
  const edgeBlock = edgeCampaign ? `
<h2>5 · Known-edge detection power (framework validation, P3-2)</h2>
<table>
<tr><th>Planted AUC</th><th>Theoretical</th><th>Mean measured</th><th>n/class (own solver)</th><th>Trials</th><th>Detection rate (predicted 80%)</th></tr>
${edgeRows}
</table>` : notIncluded.replace('SECTION', '5 · Known-edge detection power (framework validation, P3-2)');

  const dominanceBlock = dominance ? `
<h2>6 · Exit-dominance attribution (P3-3)</h2>
<table>
<tr><th>Arm</th><th>Planted deficit (R)</th><th>Dominant channel</th><th>Attribution share (accept ≥ 90%)</th></tr>
<tr><td>Win truncation (controlled)</td><td>${fmt(dominance.controlledTruncation.plantedDeficitR, 0)}</td><td>${esc(dominance.controlledTruncation.dominant)}</td><td>${pct(dominance.controlledTruncation.attributionShare)}</td></tr>
<tr><td>Loss extension (controlled)</td><td>${fmt(dominance.controlledExtension.plantedDeficitR, 0)}</td><td>${esc(dominance.controlledExtension.dominant)}</td><td>${pct(dominance.controlledExtension.attributionShare)}</td></tr>
<tr><td>Paired simulator (observational)</td><td>—</td><td>${esc(dominance.observational.challengerDominantChannel)} (challenger) / ${esc(dominance.observational.championDominantChannel)} (champion)</td><td>${pct(dominance.observational.winTruncationShare)} WIN_TRUNCATION</td></tr>
</table>
<p class="note">${esc(dominance.lossExtensionNote)}</p>` : notIncluded.replace('SECTION', '6 · Exit-dominance attribution (P3-3)');

  const reversal = campaign.reversalDetection;
  const reversalBlock = reversal ? `
<h2>7 · Reversal detection (challenger gate vs regime ground truth — one-to-one matching)</h2>
<table>
<tr><th>Ground-truth points</th><th>Gate events</th><th>True positives</th><th>False alarms</th><th>Repeated observations</th><th>Precision</th><th>Recall</th><th>Median latency (bars)</th></tr>
<tr><td>${reversal.groundTruthPoints}</td><td>${reversal.events}</td><td>${reversal.truePositives}</td><td>${reversal.falseAlarms}</td><td>${reversal.repeatedObservations}</td><td>${fmt(reversal.precision, 3)}</td><td>${fmt(reversal.recall, 3)}</td><td>${fmt(reversal.medianDetectionLatencyBars, 0)}</td></tr>
</table>
<p class="note">${esc(reversal.methodology)} Negative latency = the event fired before the planted reversal. Repeated
observations of an already-matched reversal are counted as repeated, NOT as new true positives; precision counts
them as detections that failed to produce a new match.</p>` : notIncluded.replace('SECTION', '7 · Reversal detection (challenger gate vs regime ground truth — one-to-one matching)');

  const ei = campaign.entryIntelligence;
  const eiAbst = ei && ei.challengerAbstention;
  const entryIntelligenceBlock = ei ? `
<h2>7b · Entry intelligence on common prediction opportunities (primary entry metric)</h2>
<table>
<tr><th>Common opportunities</th><th>Shared-score AUC (z)</th><th>Challenger abstained</th><th>Taken win rate</th><th>Abstained win rate</th><th>Difference (95% CI)</th></tr>
<tr><td>${ei.commonOpportunities}</td>
<td>${ei.sharedScoreDiscrimination ? `${fmt(ei.sharedScoreDiscrimination.auc, 4)} (z ${fmt(ei.sharedScoreDiscrimination.z, 2)})` : '—'}</td>
<td>${eiAbst ? eiAbst.abstainedCount : '—'}</td>
<td>${eiAbst ? pct(eiAbst.takenWinRate) : '—'}</td>
<td>${eiAbst ? pct(eiAbst.abstainedWinRate) : '—'}</td>
<td>${eiAbst ? (eiAbst.winRateDifference.confidence95
    ? `[${pct(eiAbst.winRateDifference.confidence95[0])}, ${pct(eiAbst.winRateDifference.confidence95[1])}]`
    : 'typed refusal (insufficient sample)') : '—'}</td></tr>
</table>
<p class="note">${esc(ei.outcomeDefinition)}. ${esc(ei.note)}</p>` : notIncluded.replace('SECTION', '7b · Entry intelligence on common prediction opportunities (primary entry metric)');

  const equitySparks = sides.map((s) => {
    const curve = campaign[s.key].equityCurve;
    return `<tr class="${s.cls === 'champion' ? 'champion' : 'challenger'}"><th>${esc(s.label)}</th><td>${sparklineSvg(curve, s.cls === 'champion' ? '#1d4ed8' : '#8a2b13')}</td></tr>`;
  }).join('');

  const metaBlock = meta || {};
  const ledgerTotals = ledgerSummary.map((s) =>
    `<tr><td>${esc(s.engineIdentity.engineCode)}</td><td>${s.tradeCount}</td><td>${fmt(s.totalNetPnl)}</td><td>${fmt(s.totalCommission)}</td><td>${fmt(s.totalSwap)}</td><td>${fmt(s.netPerLot)}</td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<title>iRexPro V2 Challenger — comparative evaluation dashboard</title>
<style>${CSS}</style></head>
<body>
<h1>iRexPro AI Engine V2 — Champion–Challenger comparative evaluation</h1>
<p class="muted">${esc(metaBlock.generatedFor || 'offline evaluation harness')} · ${esc(metaBlock.branch || '')} · seed ${esc(String(campaign.market.seed))}</p>
<span class="banner">OFFLINE SIMULATION</span><span class="banner">RESEARCH-ONLY</span>
<span class="banner warn">CHAMPION SIDE = SIMPLIFIED S1 MIRROR — NOT THE DEPLOYED V1 CHAMPION</span>
<span class="banner warn">SYNTHETIC RESULTS ARE NOT EVIDENCE OF PROFITABILITY</span>
<span class="banner warn">V2 NOT PROMOTED TO LIVE</span>

<h2>1 · Constraint compliance and comparison semantics</h2>
<div class="panel"><ul>
<li>Champion side fidelity (<code>${campaign.comparisonSemantics ? esc(campaign.comparisonSemantics.championSide) : 'SIMPLIFIED_S1_MIRROR'}</code>): the paired campaign runs a RESEARCH MIRROR of S1 (9-term composite, B1 confidence, fixed stop/target geometry, fixed 0.2 lot) — NOT the complete deployed V1 Champion (M1 orchestration, six-pair routing, reliability gates, calibration layers, X1..X6 exits). All campaign deltas are mirror-relative.</li>
<li>The only actual deployed-V1 performance datum is the broker-confirmed evidence window in section 3 (single day, descriptive only).</li>
<li>V1 champion baseline frozen (policy mirror hash-pinned; exits are hard stop/target only).</li>
<li>All engine identities carry execution authority <code>RESEARCH_SHADOW</code>; no order authority exists in the research stack.</li>
<li>Execution costs calibrated to the broker evidence window (median implied friction ${evidence ? fmt(evidence.medianImpliedFrictionPipsPerLot, 3) : '—'} pips/lot); every cost is charged, never waived.</li>
<li>Attribution ledger is append-only, duplicate-refusing; the dashboard is a read-only projection of it (R6).</li>
</ul></div>

<h2>2 · Paired campaign — seven metric families</h2>
<table>
<tr><th>Metric family</th><th>${sides[0].label}</th><th>${sides[1].label}</th></tr>
${metricRows}
</table>
<table><tr><th>Engine</th><th>Equity (mark-to-market)</th></tr>${equitySparks}</table>
<h3>Exit-reason decomposition (EI-1 reasons)</h3>
<table><tr><th>Reason</th><th>Champion count</th><th>Champion mean net R</th><th>Challenger count</th><th>Challenger mean net R</th></tr>${exitReasonRows}</table>
<h3>Challenger calibration reliability</h3>
<table><tr><th>Bin</th><th>Count</th><th>Mean predicted</th><th>Mean observed</th><th>Gap</th></tr>${reliabilityRows}</table>
${evidenceBlock}
${nullBlock}
${edgeBlock}
${dominanceBlock}
${reversalBlock}
${entryIntelligenceBlock}

<h2>8 · Attribution ledger summary (single source of truth)</h2>
<table><tr><th>Engine</th><th>Trades</th><th>Total net (USD)</th><th>Commission (USD)</th><th>Swap (USD)</th><th>Net per lot</th></tr>${ledgerTotals}</table>
<p class="note">${ledgerRows.length} frozen rows; every dashboard figure above is derived from these rows and the campaign metric objects. Provenance: SYNTHETIC_CAMPAIGN for simulation rows; the broker evidence block is the only real-data section.</p>

<h2>9 · Evidential limits (binding)</h2>
<div class="panel"><ul>
<li>All engine comparisons run on deterministic synthetic markets; they validate the measurement machinery and paired policy deltas — nothing more.</li>
<li>The only broker-confirmed performance datum is the V1 evidence window above; it is negative and is reported as-is.</li>
<li>No out-of-sample, walk-forward or broker-confirmed evaluation of the challenger exists yet; no profitability claim is made or implied.</li>
<li>P5 (broker-connected DEMO) remains blocked on independent architecture review; nothing here provisions or connects a broker.</li>
</ul></div>

<h2>10 · Reproduction</h2>
<div class="panel"><p>
<code>node --test apps/api/scripts/research/v2-*.test.cjs</code> (CI-verified)<br>
<code>node apps/api/scripts/research/v2-demo-evaluation-run.cjs --seed ${esc(String(campaign.market.seed))}</code> (regenerates this dashboard byte-identically)<br>
Market: ${esc(campaign.market.scenario)} · ${campaign.market.nBars} bars · instrument ${esc(campaign.market.instrument)} · costs frozen in <code>v2-paired-engine-simulator.cjs</code>
</p></div>
</body></html>`;
}

module.exports = { renderComparativeDashboard };
