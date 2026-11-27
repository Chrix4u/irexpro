'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  RELIABILITY_GATE_CONTRACT,
  RELIABILITY_GATES,
  CORPUS,
  RL1_PREREGISTERED,
  RL1_SURFACES,
  RL1_REFUSALS,
  validateReliabilityGateContract,
  verifyReliabilityGatePaths,
  verifyOrchestrationSeams,
  summarizeReliabilityGateContract,
  buildReliabilityMatrix,
  evaluateCorpusRecord,
  applyReliabilityContract,
  mirrorG1,
} = require('./v2-reliability-gate-contract.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const clone = (contract) => JSON.parse(JSON.stringify(contract));
const gate = (key) => clone(RELIABILITY_GATE_CONTRACT).gates.find((g) => g.key === key);
const record = (id) => clone(RELIABILITY_GATE_CONTRACT).corpus.find((r) => r.id === id);

test('the committed contract validates and reconciles with the audit claim of nine reliability gates', () => {
  assert.equal(validateReliabilityGateContract(RELIABILITY_GATE_CONTRACT), true);
  const summary = summarizeReliabilityGateContract(RELIABILITY_GATE_CONTRACT);
  assert.equal(summary.artifact, 'v2-reliability-gate-contract-v1');
  assert.equal(summary.gates.length, 9);
  assert.equal(summary.corpus.size, 12);
  assert.equal(summary.corpus.disagreementCount, 10);
  assert.equal(summary.corpus.controlCount, 2);
  assert.equal(summary.corpus.distinctPatterns, 12);
  assert.equal(summary.rl1.name, 'RL-1');
  assert.equal(summary.rl1.extractionSeams, 3);
});

test('every mapped gate file exists and still carries its pinned constants (drift detector)', () => {
  const result = verifyReliabilityGatePaths(RELIABILITY_GATE_CONTRACT, REPO_ROOT);
  assert.equal(result.verified, result.total);
  assert.equal(result.total, 9);
  // The ladders the audit calls out are content-anchored, not just paths.
  const ladders = RELIABILITY_GATES.filter((g) => g.sampleFloor !== null).map((g) => g.sampleFloor);
  assert.deepEqual([...ladders].sort((a, b) => a - b), [3, 3, 3, 5, 6, 6, 8, 20]);
});

test('extraction-seam anchors: scheduler and collector still invoke the gates where SEAM-1 is pinned', () => {
  const result = verifyOrchestrationSeams(REPO_ROOT);
  assert.equal(result.verified, result.total);
  assert.equal(result.total, 2);
});

test('G1 inventory pins the asymmetric admission ladder with verified lines', () => {
  const g1 = gate('reliability.g1-m1-route-pair-side');
  assert.deepEqual(
    g1.constants.map((x) => `${x.name}:${x.value}:${x.line}`),
    [
      'M1_RELIABILITY_MIN_SAMPLES:5:6', 'M1_RELIABILITY_EARLY_LOSS_BRAKE_SAMPLES:3:7',
      'M1_RELIABILITY_EARLY_TRANSITION_LOSS_BRAKE_SAMPLES:2:8', 'M1_RELIABILITY_RECENT_PAYOFF_SAMPLES:5:9',
      'M1_RELIABILITY_RECENT_AVERAGE_R_FLOOR:-0.1:10', 'M1_RELIABILITY_MAX_SAMPLES:20:11',
      'M1_RELIABILITY_CARRY_FORWARD_DAYS:7:12', 'M1_RELIABILITY_EARLY_LOSS_COOLDOWN_MINUTES:180:15',
    ],
  );
  assert.equal(g1.authority, 'ADMISSION_GATE');
  assert.ok(g1.predicate.some((p) => p.includes('l.223-378')));
  assert.ok(g1.notes.includes('INSUFFICIENT_EVIDENCE') || g1.role.includes('INSUFFICIENT_EVIDENCE'));
});

test('G2/G3/G4 inventory pins the scout ladder divergence (min 3/6, PF 1.5 vs 2.0, degradation all-vs-sum)', () => {
  const g2 = gate('reliability.g2-shadow-pair-side-micro');
  const g3 = gate('reliability.g3-meaningful-scout');
  const g4 = gate('reliability.g4-provisional-scout');
  assert.equal(g2.constants.find((c) => c.name === 'M1_SHADOW_MICRO_MIN_SAMPLES').value, 3);
  assert.equal(g2.constants.find((c) => c.name === 'M1_SHADOW_MICRO_MIN_PROFIT_FACTOR').value, 1.5);
  assert.equal(g3.constants.find((c) => c.name === 'M1_MEANINGFUL_SCOUT_MIN_SAMPLES').value, 6);
  assert.equal(g3.constants.find((c) => c.name === 'M1_MEANINGFUL_SCOUT_MIN_PROFIT_FACTOR').value, 1.5);
  assert.equal(g4.constants.find((c) => c.name === 'M1_PROVISIONAL_SCOUT_MIN_PROFIT_FACTOR').value, 2.0);
  assert.equal(g4.constants.find((c) => c.name === 'M1_PROVISIONAL_SCOUT_MATURE_SAMPLE_FLOOR').value, 6);
  assert.equal(g4.constants.find((c) => c.name === 'M1_PROVISIONAL_SCOUT_LOT_CAP').value, 0.05);
  // The two degradation predicates differ: G2 all-<=0, G3/G4 sum <= 0.
  assert.ok(g2.predicate.join(' ').includes('last 3 all netR <= 0'));
  assert.ok(g3.predicate.join(' ').includes('recent-3 sum <= 0'));
  assert.ok(g4.predicate.join(' ').includes('MATURE_EVIDENCE_AVAILABLE'));
});

test('G5/G6/G9 inventory pins the paper-tier floors (20/8 episodes, PF 1.0/1.15, maxDD 0.12, shadow PF 0.75)', () => {
  const g5 = gate('reliability.g5-paper-route');
  const g6 = gate('reliability.g6-paper-scout-realised-payoff');
  const g9 = gate('reliability.g9-paper-requalification-shadow');
  assert.deepEqual(
    g5.constants.map((x) => `${x.name}:${x.value}:${x.line}`),
    [
      'PAPER_TREND_ROUTE_RELIABILITY_MIN_EPISODES:20:4', 'PAPER_TREND_ROUTE_RELIABILITY_MIN_PROFIT_FACTOR:1:5',
      'PAPER_TREND_ROUTE_RELIABILITY_MAX_DRAWDOWN:0.12:6', 'PAPER_REVERSAL_ROUTE_RELIABILITY_MIN_EPISODES:8:8',
      'PAPER_TREND_PAIR_SIDE_RELIABILITY_MIN_EPISODES:8:12',
      'PAPER_REALISED_CONTINUATION_ROUTE_RELIABILITY_MIN_TRADES:20:369',
    ],
  );
  assert.equal(g6.constants.find((c) => c.name === 'PAPER_SCOUT_REALISED_PAYOFF_SHADOW_PF').value, 0.75);
  assert.equal(g9.constants.find((c) => c.name === 'PAPER_RESEARCH_REQUALIFICATION_MIN_PROFIT_FACTOR').value, 1.15);
  assert.equal(g9.authority, 'SHADOW_NONE');
});

test('G7/G8 inventory pins the composition veto vocabulary and the advisory-only overlay', () => {
  const g7 = gate('reliability.g7-demo-profitability-composition');
  const g8 = gate('reliability.g8-pepperstone-advisory-quality');
  assert.deepEqual(g7.constants, []); // no numeric floors — reason-code composition
  assert.equal(g7.authority, 'COMPOSITION_VETO');
  assert.ok(g7.notes.includes('2 of G1'));
  assert.equal(g8.constants.find((c) => c.name === 'advisoryFloor').value, 0.2);
  assert.equal(g8.constants.find((c) => c.name === 'advisoryFloor').line, 155); // inline literal
  assert.equal(g8.authority, 'ADVISORY_ONLY');
});

test('the frozen corpus verdict matrix matches the committed expectations record for record', () => {
  const matrix = buildReliabilityMatrix(CORPUS);
  for (const row of matrix.rows) {
    for (const evaluation of row.evaluations) {
      assert.equal(evaluation.match, true, `${row.id}.${evaluation.gate}${evaluation.label ? `[${evaluation.label}]` : ''}`);
    }
  }
});

test('RL-D07 is the composition-gap exemplar: G1 refuses at a 60% win rate while G7 reports executable', () => {
  const row = evaluateCorpusRecord(record('RL-D07'));
  const g1 = row.evaluations.find((e) => e.gate === 'g1');
  const g7 = row.evaluations.find((e) => e.gate === 'g7');
  assert.equal(g1.ok, false);
  assert.equal(g1.reason, 'NEGATIVE_EXPECTANCY');
  assert.equal(g7.ok, true);
  assert.equal(g7.reason, 'NO_BLOCKERS');
  // Win rate is 3/5 = 60% — the gate ignores it; expectancy is -0.104R.
  const d1 = mirrorG1(record('RL-D07').input.g1);
  assert.equal(d1.wins / (d1.wins + d1.losses), 0.6);
  assert.ok(d1.averageRealizedR < 0);
});

test('RL-D08 is the provability-asymmetry exemplar: same economics, one missing riskAtStop fail-closes G1', () => {
  const row = evaluateCorpusRecord(record('RL-D08'));
  const g1 = row.evaluations.find((e) => e.gate === 'g1');
  const g2 = row.evaluations.find((e) => e.gate === 'g2');
  assert.equal(g1.ok, false);
  assert.equal(g1.reason, 'PAYOFF_EVIDENCE_INCOMPLETE');
  assert.equal(g2.ok, true);
});

test('RL-D10/D11 prove the 180-minute cooldown semantics in the gate and in the composition layer', () => {
  const d10 = evaluateCorpusRecord(record('RL-D10'));
  assert.deepEqual(d10.evaluations.map((e) => e.reason), ['EARLY_LOSS_STREAK', 'EARLY_LOSS_STREAK_RECOVERY_CANARY']);
  const d11 = evaluateCorpusRecord(record('RL-D11'));
  assert.equal(d11.evaluations[0].ok, false);
  assert.equal(d11.evaluations[0].reason, 'M1_DEMO_RELIABILITY_EARLY_LOSS_STREAK+M1_DEMO_EARLY_TRANSITION_PAIR_SIDE_DEGRADED');
  assert.equal(d11.evaluations[1].ok, true);
  assert.equal(d11.evaluations[1].reason, 'NO_BLOCKERS');
});

test('RL-D12 proves the authority gradient: G8 cuts risk to exactly 0.595 and can never veto', () => {
  const row = evaluateCorpusRecord(record('RL-D12'));
  const g8 = row.evaluations.find((e) => e.gate === 'g8');
  assert.equal(g8.ok, true); // riskReduced
  assert.equal(g8.reason, 'M5_AGAINST_SIDE+RECENT_SAME_PAIR_ROUTE_SIDE_NET_LOSING');
  const summary = summarizeReliabilityGateContract(RELIABILITY_GATE_CONTRACT);
  assert.equal(summary.corpus.confirmations.g8, 1);
  const applied = applyReliabilityContract({ surface: 'ADVISORY', ...record('RL-D12').input.g8 });
  assert.equal(applied.decisions.g8.riskFraction, 0.595);
  assert.equal(applied.decisions.g8.vetoCapable, false);
  assert.equal(applied.executionAuthority, 'NONE');
});

test('tampering with corpus inputs is a typed verdict-mismatch refusal', () => {
  const tampered = clone(RELIABILITY_GATE_CONTRACT);
  tampered.corpus[0].input.outcomes[0].netR = -1; // RL-D01 G2 would stop admitting
  assert.throws(() => validateReliabilityGateContract(tampered), /RELIABILITY_VERDICT_MISMATCH/);
});

test('tampering with corpus expectations is a typed verdict-mismatch refusal', () => {
  const tampered = clone(RELIABILITY_GATE_CONTRACT);
  tampered.corpus[5].evaluations[0].expected.ok = true; // RL-D06 control: G2 refuses
  assert.throws(() => validateReliabilityGateContract(tampered), /RELIABILITY_VERDICT_MISMATCH/);
});

test('dropping a corpus record is a typed count-mismatch refusal', () => {
  const tampered = clone(RELIABILITY_GATE_CONTRACT);
  tampered.corpus.pop();
  assert.throws(() => validateReliabilityGateContract(tampered), /RELIABILITY_COUNT_MISMATCH/);
});

test('adding a tenth gate is a typed count-mismatch refusal', () => {
  const tampered = clone(RELIABILITY_GATE_CONTRACT);
  tampered.gates.push(clone(tampered.gates[0]));
  assert.throws(() => validateReliabilityGateContract(tampered), /RELIABILITY_COUNT_MISMATCH/);
});

test('corrupting corpus statistics is a typed statistics-mismatch refusal', () => {
  const tampered = clone(RELIABILITY_GATE_CONTRACT);
  tampered.corpusExpectations.confirmations.g2 = 6;
  assert.throws(() => validateReliabilityGateContract(tampered), /RELIABILITY_STATISTICS_MISMATCH/);
});

const executedInput = () => ({
  surface: 'EXECUTED',
  route: 'M1_TREND_CONTINUATION',
  instrument: 'EURUSD',
  direction: 'BUY',
  currentPolicyVersion: 'm1-tactical-v1',
  evaluatedAt: '2026-11-27T10:00:00.000Z',
  evidenceRows: [0, 1, 2, 3, 4].map((i) => ({
    route: 'M1_TREND_CONTINUATION',
    instrument: 'EURUSD',
    direction: 'BUY',
    policyVersion: 'm1-tactical-v1',
    realisedPnl: 20,
    riskAtStop: 100,
    closedAt: new Date(Date.parse('2026-11-27T10:00:00.000Z') - (60 - i * 5) * 60000).toISOString(),
  })),
});

test('RL-1 EXECUTED surface maps the G1 ladder onto verdicts with authority NONE', () => {
  const eligible = applyReliabilityContract(executedInput());
  assert.equal(eligible.verdict, 'ELIGIBLE');
  assert.equal(eligible.proposedAuthority, 'FULL');
  assert.equal(eligible.executionAuthority, 'NONE');

  const flagged = applyReliabilityContract({
    ...executedInput(),
    evidenceRows: [
      ...executedInput().evidenceRows.slice(0, 5),
      {
        route: 'M1_TREND_CONTINUATION', instrument: 'EURUSD', direction: 'BUY',
        policyVersion: 'm1-tactical-v1', realisedPnl: -30, riskAtStop: 100,
        maxFavorablePnl: 55, profitGiveback: 60,
        closedAt: '2026-11-27T09:50:00.000Z',
      },
    ],
  });
  assert.equal(flagged.verdict, 'ELIGIBLE_FLAGGED');

  const refused = applyReliabilityContract({
    ...executedInput(),
    evidenceRows: executedInput().evidenceRows.map((row, i) => ({
      ...row,
      realisedPnl: i < 3 ? 20 : -60,
    })),
  });
  assert.equal(refused.verdict, 'REFUSED');
  assert.equal(refused.proposedAuthority, 'NONE');
  assert.equal(refused.decisions.g1.reason, 'NEGATIVE_EXPECTANCY');
});

test('RL-1 SCOUT_SHADOW surface applies the sample ladder (COLD -> SCOUT provisional -> MATURE handoff)', () => {
  const cold = applyReliabilityContract({
    surface: 'SCOUT_SHADOW',
    route: 'M1_EARLY_TRANSITION',
    evaluatedAt: '2026-11-27T10:00:00.000Z',
    outcomes: [0.3, 0.2].map((netR, i) => ({
      observedAt: new Date(Date.parse('2026-11-27T10:00:00.000Z') - (300 - i * 60) * 60000).toISOString(),
      netR,
    })),
  });
  assert.equal(cold.tier, 'COLD');
  assert.equal(cold.verdict, 'COLD_START');
  assert.equal(cold.proposedAuthority, 'NONE');

  const scout = applyReliabilityContract({ surface: 'SCOUT_SHADOW', ...record('RL-D01').input });
  assert.equal(scout.tier, 'SCOUT');
  assert.equal(scout.verdict, 'ELIGIBLE');
  assert.equal(scout.proposedAuthority, 'PROVISIONAL_LOT_0_05');

  const meaningful = applyReliabilityContract({ surface: 'SCOUT_SHADOW', ...record('RL-D03').input });
  assert.equal(meaningful.tier, 'MATURE_HANDOFF');
  assert.equal(meaningful.verdict, 'ELIGIBLE'); // the meaningful rung governs at n >= 6
  assert.equal(meaningful.proposedAuthority, 'FULL');
  assert.equal(meaningful.decisions.g3.reason, 'POSITIVE_MEANINGFUL_EXPECTANCY');
  assert.equal(meaningful.decisions.g4.reason, 'MATURE_EVIDENCE_AVAILABLE'); // handoff recorded

  const degraded = applyReliabilityContract({ surface: 'SCOUT_SHADOW', ...record('RL-D05').input });
  assert.equal(degraded.tier, 'MATURE_HANDOFF');
  assert.equal(degraded.verdict, 'HANDOFF_MATURE'); // scouts stop answering; G3 refuses
  assert.equal(degraded.proposedAuthority, 'NONE');
  assert.equal(degraded.decisions.g3.reason, 'RECENT_MEANINGFUL_DEGRADATION');
});

test('RL-1 PAPER_SLEEVE and COMPOSITION surfaces degrade authority, never grant it', () => {
  const reduced = applyReliabilityContract({
    surface: 'PAPER_SLEEVE',
    payoff: record('RL-D04').input.g6,
    requalification: record('RL-D04').input.g9,
  });
  assert.equal(reduced.verdict, 'RISK_REDUCED');
  assert.equal(reduced.proposedAuthority, 'REDUCED_LOT_0_05');
  assert.equal(reduced.decisions.g6.state, 'REDUCED');

  const composition = applyReliabilityContract({ surface: 'COMPOSITION', ...record('RL-D11').input.after });
  assert.equal(composition.verdict, 'ELIGIBLE');
  assert.equal(composition.proposedAuthority, 'FULL');
  assert.equal(composition.executionAuthority, 'NONE');
});

test('RL-1 typed refusals are fail-closed', () => {
  assert.throws(() => applyReliabilityContract({ surface: 'ORDER_BOOK' }),
    /RELIABILITY_UNSUPPORTED_SURFACE/);
  assert.throws(() => applyReliabilityContract({ ...executedInput(), instrument: undefined }),
    /RELIABILITY_INPUT_REQUIRED: EXECUTED.instrument/);
  assert.throws(() => applyReliabilityContract({
    surface: 'SCOUT_SHADOW', route: 'M1_EARLY_TRANSITION',
    evaluatedAt: '2026-11-27T10:00:00.000Z',
    outcomes: [{ observedAt: '2026-11-27T09:00:00.000Z', netR: 'not-a-number' }],
  }), /RELIABILITY_INPUT_OUT_OF_RANGE: SCOUT_SHADOW.outcomes\[\].netR/);
  assert.throws(() => applyReliabilityContract({
    surface: 'PAPER_SLEEVE',
    payoff: { closedTrades: 10, grossProfit: -5, grossLoss: 0, netPnl: -5 },
  }), /RELIABILITY_INPUT_OUT_OF_RANGE: PAPER_SLEEVE.payoff.gross/);
  assert.throws(() => applyReliabilityContract({
    surface: 'ADVISORY', route: 'CONFIRMED_REVERSAL', m1Route: 'M1_CONFIRMED_REVERSAL',
    expertState: 'ADMITTED', m5Direction: 'SIDEWAYS', h1Direction: 'NEUTRAL',
  }), /RELIABILITY_INPUT_OUT_OF_RANGE: ADVISORY.m5Direction/);
  assert.deepEqual(RL1_SURFACES.length, 5);
  assert.ok(RL1_REFUSALS.includes('RELIABILITY_INPUT_REQUIRED'));
  assert.equal(RL1_PREREGISTERED.sampleLadder.meaningful, 6);
  assert.equal(RL1_PREREGISTERED.scoutFloors.profitFactor, 2.0);
});
